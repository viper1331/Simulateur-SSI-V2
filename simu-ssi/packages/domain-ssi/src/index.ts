import EventEmitter from 'eventemitter3';

export type CmsiState =
  | { status: 'IDLE' }
  | { status: 'EVAC_PENDING'; zoneId: string; deadline: number; suspendFlag: boolean }
  | { status: 'EVAC_ACTIVE'; manual: boolean; startedAt: number; zoneId?: string }
  | { status: 'EVAC_SUSPENDED'; zoneId: string; deadline: number }
  | { status: 'SAFE_HOLD'; enteredAt: number };

export interface DomainConfig {
  evacOnDmDelayMs: number;
  processAckRequired: boolean;
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

export interface DomainSnapshot {
  cmsi: CmsiState;
  ugaActive: boolean;
  dasApplied: boolean;
  manualEvacuation: boolean;
  manualEvacuationReason?: string;
  processAck: ProcessAckState;
  dmLatched: Record<string, ManualCallPointState>;
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
  acknowledgeProcess(ackedBy: string): void;
  clearProcessAck(): void;
  startManualEvacuation(reason?: string): void;
  stopManualEvacuation(reason?: string): void;
  trySystemReset(): { ok: true } | { ok: false; reason: 'DM_NOT_RESET' };
}

export function createSsiDomain(initialConfig: DomainConfig): SsiDomain {
  const emitter: DomainEmitter = new EventEmitter();
  const dmLatched = new Map<string, ManualCallPointState>();
  let cmsi: CmsiState = { status: 'IDLE' };
  let ugaActive = false;
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
      dasApplied,
      manualEvacuation,
      manualEvacuationReason,
      processAck: { ...processAck },
      dmLatched: Object.fromEntries(
        Array.from(dmLatched.entries()).map(([zoneId, state]) => [zoneId, { ...state }]),
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
    cmsi = { status: 'EVAC_PENDING', zoneId, deadline, suspendFlag: false };
    log({
      ts: Date.now(),
      source: 'CMSI',
      message: 'Evacuation pending',
      details: { zoneId, deadline },
    });
    emitSnapshot();

    timerHandle = setTimeout(() => {
      timerHandle = undefined;
      if (cmsi.status !== 'EVAC_PENDING' || cmsi.zoneId !== zoneId) {
        return;
      }
      if (cmsi.suspendFlag) {
        cmsi = { status: 'EVAC_SUSPENDED', zoneId, deadline };
        log({
          ts: Date.now(),
          source: 'CMSI',
          message: 'Evacuation suspended after acknowledgement',
          details: { zoneId },
        });
        emitSnapshot();
      } else {
        enterEvacActive({ manual: false, zoneId });
      }
    }, delay);
  };

  const enterEvacActive = ({ manual, zoneId }: { manual: boolean; zoneId?: string }) => {
    clearTimer();
    cmsi = { status: 'EVAC_ACTIVE', manual, startedAt: Date.now(), zoneId };
    manualEvacuation = manual;
    ugaActive = true;
    dasApplied = true;
    log({
      ts: Date.now(),
      source: manual ? 'MANUAL' : 'CMSI',
      message: manual ? 'Manual evacuation started' : 'Automatic evacuation active',
      details: { manual, zoneId },
    });
    emitSnapshot();
  };

  const enterSafeHold = () => {
    clearTimer();
    cmsi = { status: 'SAFE_HOLD', enteredAt: Date.now() };
    manualEvacuation = false;
    manualEvacuationReason = undefined;
    ugaActive = false;
    dasApplied = false;
    log({
      ts: Date.now(),
      source: 'CMSI',
      message: 'System in safe hold awaiting reset',
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
    dasApplied = false;
    processAck = { isAcked: false };
    log({ ts: Date.now(), source: 'CMSI', message: 'System reset to idle' });
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
        manualEvacuation,
        manualEvacuationReason,
        processAck,
        dmLatched: Object.fromEntries(dmLatched),
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
        message: 'Manual call point latched',
        details: { zoneId },
      });
      scheduleDeadline(zoneId, config.evacOnDmDelayMs);
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
      log({ ts: now, source: 'SDI_DM', message: 'Manual call point reset', details: { zoneId } });
      emitSnapshot();
    },
    acknowledgeProcess(ackedBy) {
      const now = Date.now();
      processAck = { isAcked: true, ackedBy, ackedAt: now };
      log({
        ts: now,
        source: 'TRAINER',
        message: 'Process acknowledgement received',
        details: { ackedBy },
      });
      if (cmsi.status === 'EVAC_PENDING') {
        cmsi = { ...cmsi, suspendFlag: true };
        emitSnapshot();
      }
    },
    clearProcessAck() {
      const now = Date.now();
      processAck = { isAcked: false, clearedAt: now };
      log({ ts: now, source: 'TRAINER', message: 'Process acknowledgement cleared' });
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
        message: 'Manual evacuation stopped',
        details: { reason },
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
