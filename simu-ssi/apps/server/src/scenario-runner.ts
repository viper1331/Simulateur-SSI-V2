import EventEmitter from 'eventemitter3';
import type {
  ScenarioDefinition,
  ScenarioEvent,
  ScenarioEventSequenceEntry,
  ScenarioRunnerSnapshot,
  SiteDevice,
} from '@simu-ssi/sdk';
import type { DomainLogEvent, SsiDomain } from '@simu-ssi/domain-ssi';
import { recordManualCallPointActivation, recordManualCallPointReset } from './manual-call-points';
import { createLogger, toError } from './logger';

interface ScenarioRunnerEventMap {
  'scenario.update': ScenarioRunnerSnapshot;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface ActiveScenarioContext {
  scenario: ScenarioDefinition;
  startedAt: number;
  timeouts: TimerHandle[];
  currentEventIndex: number;
  awaitingSystemReset: boolean;
  manualReset: ManualResetContext;
  deviceLookup: Map<string, SiteDevice>;
  sequenceSteps: Map<number, ScenarioSequenceStep[]>;
}

interface ManualResetContext {
  mode: 'all' | 'custom';
  dmZones: Set<string>;
  daiZones: Set<string>;
}

interface ScenarioRunnerOptions {
  isZoneOutOfService?: (kind: 'DM' | 'DAI', zoneId: string) => boolean;
}

export class ScenarioRunner {
  private readonly emitter = new EventEmitter<ScenarioRunnerEventMap>();
  private context?: ActiveScenarioContext;
  private snapshot: ScenarioRunnerSnapshot = { status: 'idle' };
  private readonly log = createLogger('ScenarioRunner');
  private readonly options: ScenarioRunnerOptions;
  private readonly handleDomainEvent = (event: DomainLogEvent) => {
    if (!this.context) {
      return;
    }
    if (!this.context.awaitingSystemReset) {
      return;
    }
    this.log.debug("Événement de domaine reçu en attente de réinitialisation", {
      source: event.source,
      message: event.message,
    });
    if (event.source === 'CMSI' && event.message === 'System reset to idle') {
      this.stop('completed');
    }
  };

  constructor(private readonly domain: SsiDomain, options: ScenarioRunnerOptions = {}) {
    this.options = options;
  }

  get state(): ScenarioRunnerSnapshot {
    return this.snapshot;
  }

  on(event: 'scenario.update', handler: (snapshot: ScenarioRunnerSnapshot) => void) {
    this.emitter.on(event, handler);
  }

  off(event: 'scenario.update', handler: (snapshot: ScenarioRunnerSnapshot) => void) {
    this.emitter.off(event, handler);
  }

  preload(scenario: ScenarioDefinition) {
    this.stop('stopped');

    const orderedEvents = [...scenario.events].sort((a, b) => a.offset - b.offset);
    const normalizedScenario: ScenarioDefinition = { ...scenario, events: orderedEvents };

    this.log.info("Préchargement de scénario demandé", {
      scenarioId: scenario.id,
      eventCount: orderedEvents.length,
    });

    this.updateSnapshot({
      status: 'ready',
      scenario: normalizedScenario,
      startedAt: undefined,
      endedAt: undefined,
      currentEventIndex: -1,
      nextEvent: orderedEvents[0] ?? null,
      awaitingSystemReset: false,
    });
  }

  run(scenario: ScenarioDefinition) {
    this.stop('stopped');

    const orderedEvents = [...scenario.events].sort((a, b) => a.offset - b.offset);
    const normalizedScenario: ScenarioDefinition = { ...scenario, events: orderedEvents };
    const startedAt = Date.now();
    this.domain.emitter.off('events.append', this.handleDomainEvent);
    this.domain.emitter.on('events.append', this.handleDomainEvent);
    this.log.info("Exécution de scénario démarrée", {
      scenarioId: scenario.id,
      eventCount: orderedEvents.length,
    });
    const normalizeZoneList = (zones?: string[]) =>
      new Set(
        (zones ?? [])
          .map((zone) => zone.trim().toUpperCase())
          .filter((zone) => zone.length > 0),
      );

    const manualReset: ManualResetContext = scenario.manualResettable
      ? {
          mode: 'custom',
          dmZones: normalizeZoneList(scenario.manualResettable.dmZones),
          daiZones: normalizeZoneList(scenario.manualResettable.daiZones),
        }
      : {
          mode: 'all',
          dmZones: new Set<string>(),
          daiZones: new Set<string>(),
        };

    const deviceLookup = new Map<string, SiteDevice>();
    for (const device of normalizedScenario.topology?.devices ?? []) {
      deviceLookup.set(device.id, device);
    }
    const sequenceSteps = new Map<number, ScenarioSequenceStep[]>();

    this.context = {
      scenario: normalizedScenario,
      startedAt,
      timeouts: [],
      currentEventIndex: -1,
      awaitingSystemReset: false,
      manualReset,
      deviceLookup,
      sequenceSteps,
    };

    this.updateSnapshot({
      status: 'running',
      scenario: normalizedScenario,
      startedAt,
      currentEventIndex: -1,
      nextEvent: orderedEvents[0] ?? null,
      awaitingSystemReset: false,
    });

    const activeContext = this.context;
    if (!activeContext) {
      return;
    }

    orderedEvents.forEach((event, index) => {
      const delay = Math.max(0, Math.round(event.offset * 1000));
      const handle = setTimeout(() => {
        void this.executeEvent(index);
      }, delay);
      activeContext.timeouts.push(handle);

      const steps = this.normalizeSequence(event);
      activeContext.sequenceSteps.set(index, steps);
      for (const [sequenceIndex, step] of steps.entries()) {
        const sequenceDelay = Math.max(0, Math.round((event.offset + step.delay) * 1000));
        const sequenceHandle = setTimeout(() => {
          void this.executeSequenceEntry(event, step, index, sequenceIndex);
        }, sequenceDelay);
        activeContext.timeouts.push(sequenceHandle);
      }
    });
  }

  stop(status: 'stopped' | 'idle' | 'completed' = 'stopped') {
    this.domain.emitter.off('events.append', this.handleDomainEvent);
    if (!this.context) {
      this.log.debug("Arrêt de scénario demandé sans contexte actif", { status });
      if (this.snapshot.status === 'ready' && this.snapshot.scenario) {
        const scenario = this.snapshot.scenario;
        this.updateSnapshot({
          status,
          scenario,
          startedAt: undefined,
          endedAt: status === 'idle' ? undefined : Date.now(),
          currentEventIndex: -1,
          nextEvent: null,
          awaitingSystemReset: false,
        });
        return;
      }
      if (status === 'idle') {
        this.updateSnapshot({ status: 'idle' });
      }
      return;
    }

    this.context.timeouts.forEach((timeout) => clearTimeout(timeout));
    const scenario = this.context.scenario;
    const startedAt = this.context.startedAt;
    this.context = undefined;
    this.log.info("Scénario arrêté", {
      scenarioId: scenario.id,
      status,
    });
    this.updateSnapshot({
      status,
      scenario,
      startedAt,
      endedAt: Date.now(),
      currentEventIndex: this.snapshot.currentEventIndex,
      nextEvent: null,
      awaitingSystemReset: false,
    });
  }

  canManuallyReset(kind: 'DM' | 'DAI', zoneId: string): boolean {
    const context = this.context;
    if (!context) {
      return true;
    }
    const { manualReset } = context;
    if (manualReset.mode === 'all') {
      return true;
    }
    const normalizedZone = zoneId.trim().toUpperCase();
    if (kind === 'DM') {
      if (manualReset.dmZones.size === 0) {
        return true;
      }
      return manualReset.dmZones.has(normalizedZone);
    }
    if (kind === 'DAI') {
      if (manualReset.daiZones.size === 0) {
        return true;
      }
      return manualReset.daiZones.has(normalizedZone);
    }
    return true;
  }

  private async executeEvent(index: number) {
    if (!this.context) {
      return;
    }
    const { scenario } = this.context;
    if (!scenario.events[index]) {
      this.log.warn("Tentative d'exécution d'un événement de scénario manquant", { index });
      return;
    }
    const event = scenario.events[index];

    const sequenceSteps = this.context.sequenceSteps.get(index) ?? [];
    const orchestratedBySequence =
      sequenceSteps.length > 0 && this.resolveSequenceDeviceKind(event) !== null;

    if (event.type === 'SYSTEM_RESET') {
      this.context.awaitingSystemReset = true;
      this.log.info("En attente de réinitialisation du système après l'événement", {
        index,
        eventType: event.type,
      });
    } else if (orchestratedBySequence) {
      this.log.debug('Événement orchestré via séquence de dispositifs', {
        eventType: event.type,
        index,
        sequenceCount: sequenceSteps.length,
      });
    } else {
      try {
        await this.dispatchEvent(event);
        this.log.debug("Événement de scénario déclenché", {
          eventType: event.type,
          index,
        });
      } catch (error) {
        this.log.error("Échec de l'exécution de l'événement de scénario", { error: toError(error), eventType: event.type });
      }
    }

    this.context.currentEventIndex = index;
    const nextEvent = scenario.events[index + 1] ?? null;
    const awaitingReset = this.context.awaitingSystemReset;

    if (!nextEvent) {
      this.context.timeouts.forEach((timeout) => clearTimeout(timeout));
      this.context.timeouts = [];
      if (!awaitingReset) {
        this.log.info("Événements du scénario terminés, attente de l'arrêt manuel", {
          scenarioId: scenario.id,
        });
      }
    }

    const status: ScenarioRunnerSnapshot['status'] = 'running';
    this.updateSnapshot({
      status,
      scenario,
      startedAt: this.context.startedAt,
      endedAt: undefined,
      currentEventIndex: index,
      nextEvent: awaitingReset ? event : nextEvent,
      awaitingSystemReset: awaitingReset,
    });
  }

  private async dispatchEvent(event: ScenarioEvent) {
    switch (event.type) {
      case 'DM_TRIGGER':
        if (this.shouldSkipZoneTrigger('DM', event.zoneId, { eventType: event.type })) {
          return;
        }
        await recordManualCallPointActivation(event.zoneId);
        this.domain.activateDm(event.zoneId);
        break;
      case 'DM_RESET':
        await recordManualCallPointReset(event.zoneId);
        this.domain.resetDm(event.zoneId);
        break;
      case 'DAI_TRIGGER':
        if (this.shouldSkipZoneTrigger('DAI', event.zoneId, { eventType: event.type })) {
          return;
        }
        this.domain.activateDai(event.zoneId);
        break;
      case 'DAI_RESET':
        this.domain.resetDai(event.zoneId);
        break;
      case 'MANUAL_EVAC_START':
        this.domain.startManualEvacuation(event.reason);
        break;
      case 'MANUAL_EVAC_STOP':
        this.domain.stopManualEvacuation(event.reason);
        break;
      case 'PROCESS_ACK':
        this.domain.acknowledgeProcess(event.ackedBy ?? 'trainer');
        break;
      case 'PROCESS_CLEAR':
        this.domain.clearProcessAck();
        break;
      default:
        break;
    }
  }

  private normalizeSequence(event: ScenarioEvent): ScenarioSequenceStep[] {
    if (!this.context) {
      return [];
    }
    if (!('sequence' in event) || !Array.isArray(event.sequence) || event.sequence.length === 0) {
      return [];
    }
    const expectedKind = this.resolveSequenceDeviceKind(event);
    if (!expectedKind) {
      return [];
    }
    return event.sequence
      .map((entry) => this.normalizeSequenceEntry(entry, expectedKind))
      .filter((entry): entry is ScenarioSequenceStep => Boolean(entry))
      .sort((a, b) => a.delay - b.delay);
  }

  private normalizeSequenceEntry(
    entry: ScenarioEventSequenceEntry | undefined,
    expectedKind: 'DM' | 'DAI',
  ): ScenarioSequenceStep | undefined {
    if (!this.context || !entry) {
      return undefined;
    }
    const deviceId = entry.deviceId?.toString().trim();
    if (!deviceId) {
      return undefined;
    }
    const device = this.context.deviceLookup.get(deviceId);
    if (!device || !device.zoneId) {
      return undefined;
    }
    if (device.kind !== expectedKind) {
      return undefined;
    }
    const delay = Number.isFinite(entry.delay) && entry.delay >= 0 ? entry.delay : 0;
    return { deviceId, delay, device };
  }

  private resolveSequenceDeviceKind(event: ScenarioEvent): 'DM' | 'DAI' | null {
    switch (event.type) {
      case 'DM_TRIGGER':
      case 'DM_RESET':
        return 'DM';
      case 'DAI_TRIGGER':
      case 'DAI_RESET':
        return 'DAI';
      default:
        return null;
    }
  }

  private async executeSequenceEntry(
    event: ScenarioEvent,
    step: ScenarioSequenceStep,
    parentIndex: number,
    sequenceIndex: number,
  ) {
    if (!this.context) {
      return;
    }
    const zoneId = step.device.zoneId?.toUpperCase();
    if (!zoneId) {
      return;
    }
    try {
      switch (event.type) {
        case 'DM_TRIGGER':
          if (
            this.shouldSkipZoneTrigger('DM', zoneId, {
              eventType: event.type,
              sequenceIndex,
            })
          ) {
            return;
          }
          await recordManualCallPointActivation(zoneId);
          this.domain.activateDm(zoneId);
          break;
        case 'DM_RESET':
          await recordManualCallPointReset(zoneId);
          this.domain.resetDm(zoneId);
          break;
        case 'DAI_TRIGGER':
          if (
            this.shouldSkipZoneTrigger('DAI', zoneId, {
              eventType: event.type,
              sequenceIndex,
            })
          ) {
            return;
          }
          this.domain.activateDai(zoneId);
          break;
        case 'DAI_RESET':
          this.domain.resetDai(zoneId);
          break;
        default:
          return;
      }
      this.log.debug('Déclenchement de séquence exécuté', {
        parentIndex,
        sequenceIndex,
        parentType: event.type,
        zoneId,
        deviceId: step.deviceId,
      });
    } catch (error) {
      this.log.error("Échec de l'exécution d'un déclenchement de séquence", {
        error: toError(error),
        parentType: event.type,
        sequenceIndex,
        zoneId,
      });
    }
  }

  private shouldSkipZoneTrigger(
    kind: 'DM' | 'DAI',
    zoneId: string,
    metadata: { eventType: ScenarioEvent['type']; sequenceIndex?: number },
  ): boolean {
    const normalizedZone = zoneId.trim().toUpperCase();
    if (!normalizedZone) {
      return false;
    }
    if (!this.isZoneOutOfService(kind, normalizedZone)) {
      return false;
    }
    this.log.info('Déclenchement de scénario ignoré pour un dispositif hors service', {
      ...metadata,
      kind,
      zoneId: normalizedZone,
    });
    return true;
  }

  private isZoneOutOfService(kind: 'DM' | 'DAI', zoneId: string): boolean {
    const callback = this.options.isZoneOutOfService;
    if (!callback) {
      return false;
    }
    try {
      return callback(kind, zoneId);
    } catch (error) {
      this.log.error('Échec de la vérification hors service pour une zone', {
        error: toError(error),
        kind,
        zoneId,
      });
      return false;
    }
  }

  private updateSnapshot(next: ScenarioRunnerSnapshot) {
    if (next.status === 'idle') {
      this.snapshot = { status: 'idle' };
    } else {
      this.snapshot = {
        ...this.snapshot,
        ...next,
      };
    }
    this.emitter.emit('scenario.update', this.snapshot);
  }
}
