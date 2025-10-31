import EventEmitter from 'eventemitter3';
import type {
  ScenarioDefinition,
  ScenarioEvent,
  ScenarioRunnerSnapshot,
} from '@simu-ssi/sdk';
import type { DomainLogEvent, SsiDomain } from '@simu-ssi/domain-ssi';
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
}

export class ScenarioRunner {
  private readonly emitter = new EventEmitter<ScenarioRunnerEventMap>();
  private context?: ActiveScenarioContext;
  private snapshot: ScenarioRunnerSnapshot = { status: 'idle' };
  private readonly log = createLogger('ScenarioRunner');
  private readonly handleDomainEvent = (event: DomainLogEvent) => {
    if (!this.context) {
      return;
    }
    if (!this.context.awaitingSystemReset) {
      return;
    }
    this.log.debug('Domain event received while awaiting reset', {
      source: event.source,
      message: event.message,
    });
    if (event.source === 'CMSI' && event.message === 'System reset to idle') {
      this.stop('completed');
    }
  };

  constructor(private readonly domain: SsiDomain) {}

  get state(): ScenarioRunnerSnapshot {
    return this.snapshot;
  }

  on(event: 'scenario.update', handler: (snapshot: ScenarioRunnerSnapshot) => void) {
    this.emitter.on(event, handler);
  }

  off(event: 'scenario.update', handler: (snapshot: ScenarioRunnerSnapshot) => void) {
    this.emitter.off(event, handler);
  }

  run(scenario: ScenarioDefinition) {
    this.stop('stopped');

    const orderedEvents = [...scenario.events].sort((a, b) => a.offset - b.offset);
    const normalizedScenario: ScenarioDefinition = { ...scenario, events: orderedEvents };
    const startedAt = Date.now();
    this.domain.emitter.off('events.append', this.handleDomainEvent);
    this.domain.emitter.on('events.append', this.handleDomainEvent);
    this.log.info('Scenario run started', {
      scenarioId: scenario.id,
      eventCount: orderedEvents.length,
    });
    this.context = {
      scenario: normalizedScenario,
      startedAt,
      timeouts: [],
      currentEventIndex: -1,
      awaitingSystemReset: false,
    };

    this.updateSnapshot({
      status: 'running',
      scenario: normalizedScenario,
      startedAt,
      currentEventIndex: -1,
      nextEvent: orderedEvents[0] ?? null,
      awaitingSystemReset: false,
    });

    orderedEvents.forEach((event, index) => {
      const delay = Math.max(0, Math.round(event.offset * 1000));
      const handle = setTimeout(() => {
        this.executeEvent(index);
      }, delay);
      this.context?.timeouts.push(handle);
    });
  }

  stop(status: 'stopped' | 'idle' | 'completed' = 'stopped') {
    this.domain.emitter.off('events.append', this.handleDomainEvent);
    if (!this.context) {
      this.log.debug('Scenario stop requested with no active context', { status });
      if (status === 'idle') {
        this.updateSnapshot({ status: 'idle' });
      }
      return;
    }

    this.context.timeouts.forEach((timeout) => clearTimeout(timeout));
    const scenario = this.context.scenario;
    const startedAt = this.context.startedAt;
    this.context = undefined;
    this.log.info('Scenario stopped', {
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

  private executeEvent(index: number) {
    if (!this.context) {
      return;
    }
    const { scenario } = this.context;
    if (!scenario.events[index]) {
      this.log.warn('Attempted to execute missing scenario event', { index });
      return;
    }
    const event = scenario.events[index];

    if (event.type === 'SYSTEM_RESET') {
      this.context.awaitingSystemReset = true;
      this.log.info('Awaiting system reset after event', {
        index,
        eventType: event.type,
      });
    } else {
      try {
        this.dispatchEvent(event);
        this.log.debug('Scenario event dispatched', {
          eventType: event.type,
          index,
        });
      } catch (error) {
        this.log.error('Scenario event execution failed', { error: toError(error), eventType: event.type });
      }
    }

    this.context.currentEventIndex = index;
    const nextEvent = scenario.events[index + 1] ?? null;
    const awaitingReset = this.context.awaitingSystemReset;
    const status = nextEvent || awaitingReset ? 'running' : 'completed';
    this.updateSnapshot({
      status,
      scenario,
      startedAt: this.context.startedAt,
      endedAt: status === 'completed' ? Date.now() : undefined,
      currentEventIndex: index,
      nextEvent: awaitingReset ? event : nextEvent,
      awaitingSystemReset: awaitingReset,
    });

    if (status === 'completed') {
      this.context.timeouts.forEach((timeout) => clearTimeout(timeout));
      this.context = undefined;
      this.domain.emitter.off('events.append', this.handleDomainEvent);
      this.log.info('Scenario completed', {
        scenarioId: scenario.id,
      });
    }
  }

  private dispatchEvent(event: ScenarioEvent) {
    switch (event.type) {
      case 'DM_TRIGGER':
        this.domain.activateDm(event.zoneId);
        break;
      case 'DM_RESET':
        this.domain.resetDm(event.zoneId);
        break;
      case 'DAI_TRIGGER':
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
