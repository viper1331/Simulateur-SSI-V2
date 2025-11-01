import EventEmitter from 'eventemitter3';

export type CmsiState =
  | { status: 'IDLE' }
  | { status: 'EVAC_PENDING'; zoneId: string; deadline: number }
  | { status: 'EVAC_ACTIVE'; manual: boolean; startedAt: number; zoneId?: string }
  | { status: 'EVAC_SUSPENDED'; zoneId: string; deadline: number; remainingMs: number }
  | { status: 'SAFE_HOLD'; enteredAt: number };

export interface DomainConfig {
  evacOnDmDelayMs: number;
  processAckRequired: boolean;
  evacOnDai: boolean;
}

export interface ProcessAckState {
  isAcked: boolean;
  ackedBy?: string;
  ackedAt?: number;
  clearedAt?: number;
}

export interface ManualCallPointState {
  zoneId: string;
  isLatched: boolean;
  lastActivatedAt?: number;
  lastResetAt?: number;
}

export interface AutomaticDetectorState {
  zoneId: string;
  isActive: boolean;
  lastActivatedAt?: number;
  lastResetAt?: number;
}

export interface DomainSnapshot {
  cmsi: CmsiState;
  ugaActive: boolean;
  localAudibleActive: boolean;
  dasApplied: boolean;
  manualEvacuation: boolean;
  manualEvacuationReason?: string;
  processAck: ProcessAckState;
  dmLatched: Record<string, ManualCallPointState>;
  daiActivated: Record<string, AutomaticDetectorState>;
}

export type DomainEventMap = {
  'state.update': DomainSnapshot;
  'events.append': DomainLogEvent;
  'timer.ticked': { deadline: number; remainingMs: number };
};

export type DomainLogEvent = {
  ts: number;
  source:
    | 'SDI_DAI'
    | 'SDI_DM'
    | 'CMSI'
    | 'UGA'
    | 'DAS'
    | 'POWER'
    | 'TRAINER'
    | 'TRAINEE'
    | 'MANUAL';
  message: string;
  details?: Record<string, unknown>;
};

type TimerHandle = ReturnType<typeof setTimeout> | undefined;

type DomainEmitter = EventEmitter<DomainEventMap>;

export interface SsiDomain {
  readonly emitter: DomainEmitter;
  readonly snapshot: DomainSnapshot;
  updateConfig(config: Partial<DomainConfig>): void;
  activateDm(zoneId: string): void;
  resetDm(zoneId: string): void;
  activateDai(zoneId: string): void;
  resetDai(zoneId: string): void;
  acknowledgeProcess(ackedBy: string): void;
  clearProcessAck(): void;
  silenceAudibleAlarm(): void;
  startManualEvacuation(reason?: string): void;
  stopManualEvacuation(reason?: string): void;
  trySystemReset(): { ok: true } | { ok: false; reason: 'DM_NOT_RESET' };
}

export function createSsiDomain(initialConfig: DomainConfig): SsiDomain {
  const emitter: DomainEmitter = new EventEmitter();
  const dmLatched = new Map<string, ManualCallPointState>();
  const daiActivated = new Map<string, AutomaticDetectorState>();
  let cmsi: CmsiState = { status: 'IDLE' };
  let ugaActive = false;
  let localAudibleActive = false;
  let dasApplied = false;
  let manualEvacuation = false;
  let manualEvacuationReason: string | undefined;
  let processAck: ProcessAckState = { isAcked: false };
  let timerHandle: TimerHandle;

  let config: DomainConfig = { ...initialConfig };

  const emitSnapshot = () => {
    const snapshot: DomainSnapshot = {
      cmsi,
      ugaActive,
      localAudibleActive,
      dasApplied,
      manualEvacuation,
      manualEvacuationReason,
      processAck: { ...processAck },
      dmLatched: Object.fromEntries(
        Array.from(dmLatched.entries()).map(([zoneId, state]) => [zoneId, { ...state }]),
      ),
      daiActivated: Object.fromEntries(
        Array.from(daiActivated.entries()).map(([zoneId, state]) => [zoneId, { ...state }]),
      ),
    };
    emitter.emit('state.update', snapshot);
  };

  const log = (event: DomainLogEvent) => {
    emitter.emit('events.append', event);
  };

  const clearTimer = () => {
    if (timerHandle) {
      clearTimeout(timerHandle);
      timerHandle = undefined;
    }
  };

  const scheduleDeadline = (zoneId: string, delay: number) => {
    clearTimer();
    const deadline = Date.now() + delay;
    cmsi = { status: 'EVAC_PENDING', zoneId, deadline };
    log({
      ts: Date.now(),
      source: 'CMSI',
      message: 'Évacuation imminente',
      details: { zoneId, deadline, event: 'EVAC_PENDING' },
    });
    emitSnapshot();

    timerHandle = setTimeout(() => {
      timerHandle = undefined;
      if (cmsi.status !== 'EVAC_PENDING' || cmsi.zoneId !== zoneId) {
        return;
      }
      enterEvacActive({ manual: false, zoneId });
    }, delay);
  };

  const enterEvacActive = ({ manual, zoneId }: { manual: boolean; zoneId?: string }) => {
    clearTimer();
    cmsi = { status: 'EVAC_ACTIVE', manual, startedAt: Date.now(), zoneId };
    manualEvacuation = manual;
    ugaActive = true;
    localAudibleActive = true;
    dasApplied = true;
    log({
      ts: Date.now(),
      source: manual ? 'MANUAL' : 'CMSI',
      message: manual ? 'Évacuation manuelle déclenchée' : 'Évacuation automatique en cours',
      details: { manual, zoneId, event: manual ? 'MANUAL_EVAC_STARTED' : 'AUTOMATIC_EVAC_STARTED' },
    });
    emitSnapshot();
  };

  const enterSafeHold = () => {
    clearTimer();
    cmsi = { status: 'SAFE_HOLD', enteredAt: Date.now() };
    manualEvacuation = false;
    manualEvacuationReason = undefined;
    ugaActive = false;
    localAudibleActive = false;
    dasApplied = false;
    log({
      ts: Date.now(),
      source: 'CMSI',
      message: 'Système en maintien de sécurité en attente de réarmement',
      details: { event: 'SAFE_HOLD' },
    });
    emitSnapshot();
  };

  const tryResetToIdle = () => {
    if (dmLatched.size > 0) {
      return { ok: false as const, reason: 'DM_NOT_RESET' as const };
    }
    clearTimer();
    cmsi = { status: 'IDLE' };
    manualEvacuation = false;
    manualEvacuationReason = undefined;
    ugaActive = false;
    localAudibleActive = false;
    dasApplied = false;
    processAck = { isAcked: false };
    daiActivated.clear();
    log({ ts: Date.now(), source: 'CMSI', message: 'Système réinitialisé à l\'état de veille', details: { event: 'SYSTEM_RESET' } });
    emitSnapshot();
    return { ok: true as const };
  };

  const domain: SsiDomain = {
    emitter,
    get snapshot() {
      return {
        cmsi,
        ugaActive,
        dasApplied,
        localAudibleActive,
        manualEvacuation,
        manualEvacuationReason,
        processAck,
        dmLatched: Object.fromEntries(dmLatched),
        daiActivated: Object.fromEntries(daiActivated),
      } as DomainSnapshot;
    },
    updateConfig(partial) {
      config = { ...config, ...partial };
      emitSnapshot();
    },
    activateDm(zoneId) {
      const now = Date.now();
      const existing = dmLatched.get(zoneId);
      const state: ManualCallPointState = {
        zoneId,
        isLatched: true,
        lastActivatedAt: now,
        lastResetAt: existing?.lastResetAt,
      };
      dmLatched.set(zoneId, state);
      log({
        ts: now,
        source: 'SDI_DM',
        message: 'Déclencheur manuel maintenu',
        details: { zoneId, event: 'DM_LATCHED' },
      });
      scheduleDeadline(zoneId, config.evacOnDmDelayMs);
    },
    activateDai(zoneId) {
      const now = Date.now();
      const entry: AutomaticDetectorState = {
        zoneId,
        isActive: true,
        lastActivatedAt: now,
        lastResetAt: daiActivated.get(zoneId)?.lastResetAt,
      };
      daiActivated.set(zoneId, entry);
      log({
        ts: now,
        source: 'SDI_DAI',
        message: 'Détecteur automatique déclenché',
        details: { zoneId, event: 'DAI_TRIGGERED' },
      });
      if (config.evacOnDai) {
        enterEvacActive({ manual: false, zoneId });
      } else {
        localAudibleActive = true;
        emitSnapshot();
      }
    },
    resetDm(zoneId) {
      const entry = dmLatched.get(zoneId);
      if (!entry) {
        return;
      }
      const now = Date.now();
      dmLatched.set(zoneId, {
        ...entry,
        isLatched: false,
        lastResetAt: now,
      });
      dmLatched.delete(zoneId);
      log({ ts: now, source: 'SDI_DM', message: 'Déclencheur manuel réarmé', details: { zoneId, event: 'DM_RESET' } });
      emitSnapshot();
    },
    resetDai(zoneId) {
      const entry = daiActivated.get(zoneId);
      if (!entry) {
        return;
      }
      const now = Date.now();
      daiActivated.set(zoneId, {
        ...entry,
        isActive: false,
        lastResetAt: now,
      });
      daiActivated.delete(zoneId);
      log({ ts: now, source: 'SDI_DAI', message: 'Détecteur automatique réarmé', details: { zoneId, event: 'DAI_RESET' } });
      if (daiActivated.size === 0) {
        localAudibleActive = false;
      }
      emitSnapshot();
    },
    acknowledgeProcess(ackedBy) {
      const now = Date.now();
      processAck = { isAcked: true, ackedBy, ackedAt: now };
      log({
        ts: now,
        source: 'TRAINER',
        message: 'Accusé de réception reçu',
        details: { ackedBy, event: 'PROCESS_ACK' },
      });
      if (cmsi.status === 'EVAC_PENDING') {
        const remainingMs = Math.max(0, cmsi.deadline - now);
        clearTimer();
        cmsi = { status: 'EVAC_SUSPENDED', zoneId: cmsi.zoneId, deadline: cmsi.deadline, remainingMs };
        log({
          ts: now,
          source: 'CMSI',
          message: 'Évacuation suspendue après accusé de réception',
          details: { zoneId: cmsi.zoneId, remainingMs, event: 'EVAC_SUSPENDED' },
        });
        emitSnapshot();
      }
    },
    clearProcessAck() {
      const now = Date.now();
      processAck = { isAcked: false, clearedAt: now };
      log({ ts: now, source: 'TRAINER', message: 'Accusé de réception annulé', details: { event: 'PROCESS_ACK_CLEARED' } });
      emitSnapshot();
    },
    silenceAudibleAlarm() {
      if (!ugaActive && !localAudibleActive) {
        return;
      }
      const now = Date.now();
      ugaActive = false;
      localAudibleActive = false;
      log({ ts: now, source: 'TRAINEE', message: 'Signal sonore coupé', details: { event: 'AUDIBLE_SILENCED' } });
      emitSnapshot();
    },
    startManualEvacuation(reason) {
      manualEvacuationReason = reason;
      enterEvacActive({ manual: true });
    },
    stopManualEvacuation(reason) {
      const now = Date.now();
      manualEvacuationReason = reason;
      manualEvacuation = false;
      ugaActive = false;
      dasApplied = false;
      cmsi = { status: 'SAFE_HOLD', enteredAt: now };
      log({
        ts: now,
        source: 'MANUAL',
        message: 'Évacuation manuelle arrêtée',
        details: { reason, event: 'MANUAL_EVAC_STOPPED' },
      });
      emitSnapshot();
    },
    trySystemReset() {
      if (dmLatched.size > 0) {
        return { ok: false as const, reason: 'DM_NOT_RESET' as const };
      }
      return tryResetToIdle();
    },
  };

  emitSnapshot();

  return domain;
}
