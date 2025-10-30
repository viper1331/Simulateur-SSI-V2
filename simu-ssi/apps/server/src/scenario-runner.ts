import EventEmitter from 'eventemitter3';
import type { ScenarioDefinition, ScenarioEvent, ScenarioRunnerSnapshot } from '@simu-ssi/sdk';
import type { SsiDomain } from '@simu-ssi/domain-ssi';

interface ScenarioRunnerEventMap {
  'scenario.update': ScenarioRunnerSnapshot;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface ActiveScenarioContext {
  scenario: ScenarioDefinition;
  startedAt: number;
  timeouts: TimerHandle[];
  currentEventIndex: number;
}

export class ScenarioRunner {
  private readonly emitter = new EventEmitter<ScenarioRunnerEventMap>();
  private context?: ActiveScenarioContext;
  private snapshot: ScenarioRunnerSnapshot = { status: 'idle' };

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
    this.context = {
      scenario: normalizedScenario,
      startedAt,
      timeouts: [],
      currentEventIndex: -1,
    };

    this.updateSnapshot({
      status: 'running',
      scenario: normalizedScenario,
      startedAt,
      currentEventIndex: -1,
      nextEvent: orderedEvents[0] ?? null,
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
    if (!this.context) {
      if (status === 'idle') {
        this.updateSnapshot({ status: 'idle' });
      }
      return;
    }

    this.context.timeouts.forEach((timeout) => clearTimeout(timeout));
    const scenario = this.context.scenario;
    const startedAt = this.context.startedAt;
    this.context = undefined;
    this.updateSnapshot({
      status,
      scenario,
      startedAt,
      endedAt: Date.now(),
      currentEventIndex: this.snapshot.currentEventIndex,
      nextEvent: null,
    });
  }

  private executeEvent(index: number) {
    if (!this.context) {
      return;
    }
    const { scenario } = this.context;
    if (!scenario.events[index]) {
      return;
    }
    const event = scenario.events[index];

    try {
      this.dispatchEvent(event);
    } catch (error) {
      console.error('Scenario event execution failed', error);
    }

    this.context.currentEventIndex = index;
    const nextEvent = scenario.events[index + 1] ?? null;
    const status = nextEvent ? 'running' : 'completed';
    this.updateSnapshot({
      status,
      scenario,
      startedAt: this.context.startedAt,
      endedAt: status === 'completed' ? Date.now() : undefined,
      currentEventIndex: index,
      nextEvent,
    });

    if (status === 'completed') {
      this.context.timeouts.forEach((timeout) => clearTimeout(timeout));
      this.context = undefined;
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
      case 'SYSTEM_RESET': {
        const result = this.domain.trySystemReset();
        if (!result.ok) {
          console.warn('Scenario reset blocked', result.reason);
        }
        break;
      }
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
