import EventEmitter from 'eventemitter3';

import type { ScenarioDefinition } from '@simu-ssi/sdk';
import type { SsiDomain } from '@simu-ssi/domain-ssi';
import { ScenarioRunner } from '../scenario-runner';

jest.mock('../manual-call-points', () => ({
  recordManualCallPointActivation: jest.fn(),
  recordManualCallPointReset: jest.fn(),
}));

const manualCallPointMocks = jest.requireMock('../manual-call-points') as {
  recordManualCallPointActivation: jest.Mock;
  recordManualCallPointReset: jest.Mock;
};

const waitForAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

function createDomainStub(): SsiDomain {
  const emitter = new EventEmitter();
  return {
    emitter,
    snapshot: {} as never,
    activateDm: jest.fn(),
    resetDm: jest.fn(),
    activateDai: jest.fn(),
    resetDai: jest.fn(),
    startManualEvacuation: jest.fn(),
    stopManualEvacuation: jest.fn(),
    acknowledgeProcess: jest.fn(),
    clearProcessAck: jest.fn(),
    silenceAudibleAlarm: jest.fn(),
    trySystemReset: jest.fn(() => ({ ok: true as const })),
    updateConfig: jest.fn(),
  } as unknown as SsiDomain;
}

function createScenario(events: ScenarioDefinition['events']): ScenarioDefinition {
  return {
    id: 'scenario-1',
    name: 'Test',
    events,
    topology: undefined,
    manualResettable: undefined,
    evacuationAudio: undefined,
  };
}

describe('ScenarioRunner out-of-service handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manualCallPointMocks.recordManualCallPointActivation.mockResolvedValue(undefined);
    manualCallPointMocks.recordManualCallPointReset.mockResolvedValue(false);
  });

  it('skips DM trigger events when the zone is out of service', async () => {
    const domain = createDomainStub();
    const runner = new ScenarioRunner(domain, {
      isZoneOutOfService: jest.fn(() => true),
    });
    const scenario = createScenario([
      { id: 'event-1', type: 'DM_TRIGGER', zoneId: 'zf1', offset: 0 },
    ]);

    runner.run(scenario);
    await waitForAsync();

    expect(domain.activateDm).not.toHaveBeenCalled();
    expect(manualCallPointMocks.recordManualCallPointActivation).not.toHaveBeenCalled();
    runner.stop('idle');
  });

  it('executes DM trigger events when the zone is available', async () => {
    const domain = createDomainStub();
    const runner = new ScenarioRunner(domain, {
      isZoneOutOfService: jest.fn(() => false),
    });
    const scenario = createScenario([
      { id: 'event-1', type: 'DM_TRIGGER', zoneId: 'ZF1', offset: 0 },
    ]);

    runner.run(scenario);
    await waitForAsync();

    expect(domain.activateDm).toHaveBeenCalledWith('ZF1');
    expect(manualCallPointMocks.recordManualCallPointActivation).toHaveBeenCalledWith('ZF1');
    runner.stop('idle');
  });

  it('ignores sequence entries for out-of-service zones', async () => {
    const domain = createDomainStub();
    type ZoneCheck = NonNullable<ConstructorParameters<typeof ScenarioRunner>[1]>['isZoneOutOfService'];
    const isZoneOutOfService = jest
      .fn<ReturnType<NonNullable<ZoneCheck>>, Parameters<NonNullable<ZoneCheck>>>()
      .mockImplementation((_kind, zoneId) => zoneId === 'ZF2');
    const runner = new ScenarioRunner(domain, { isZoneOutOfService });
    const scenario = createScenario([
      {
        id: 'event-1',
        type: 'DAI_TRIGGER',
        zoneId: 'ZF1',
        offset: 0,
        // @ts-expect-error - intentionally invalid sequence entry to ensure it is ignored
        sequence: [{ zoneId: 'ZF2', delay: 0 }],
      },
    ]);

    runner.run(scenario);
    await waitForAsync();

    expect(domain.activateDai).toHaveBeenCalledTimes(1);
    expect(domain.activateDai).toHaveBeenCalledWith('ZF1');
    runner.stop('idle');
  });

  it('skips sequence entries targeting out-of-service devices', async () => {
    const domain = createDomainStub();
    const runner = new ScenarioRunner(domain, {
      isDeviceOutOfService: (deviceId) => deviceId === 'dm-2',
    });
    const scenario = createScenario([
      {
        id: 'event-1',
        type: 'DM_TRIGGER',
        zoneId: 'ZF1',
        offset: 0,
        sequence: [
          { deviceId: 'dm-1', delay: 0 },
          { deviceId: 'dm-2', delay: 0 },
        ],
      },
    ]);
    scenario.topology = {
      plan: undefined,
      zones: [],
      devices: [
        { id: 'dm-1', kind: 'DM', zoneId: 'ZF1' },
        { id: 'dm-2', kind: 'DM', zoneId: 'ZF1' },
      ],
    };

    runner.run(scenario);
    await waitForAsync();

    expect(domain.activateDm).toHaveBeenCalledTimes(1);
    expect(domain.activateDm).toHaveBeenCalledWith('ZF1', { deviceId: 'dm-1' });
    expect(manualCallPointMocks.recordManualCallPointActivation).toHaveBeenCalledTimes(1);
    expect(manualCallPointMocks.recordManualCallPointActivation).toHaveBeenCalledWith('ZF1');
    runner.stop('idle');
  });

  it('delays orchestrated events to the earliest sequence step when general offset is zero', async () => {
    jest.useFakeTimers();
    try {
      const domain = createDomainStub();
      const runner = new ScenarioRunner(domain);
      const scenario: ScenarioDefinition = {
        id: 'scenario-2',
        name: 'Séquence',
        events: [
          {
            id: 'event-1',
            type: 'DM_TRIGGER',
            zoneId: 'ZF1',
            offset: 0,
            sequence: [{ deviceId: 'dm-1', delay: 5 }],
          },
        ],
        topology: {
          plan: undefined,
          zones: [],
          devices: [{ id: 'dm-1', kind: 'DM', zoneId: 'ZF1' }],
        },
        manualResettable: undefined,
        evacuationAudio: undefined,
      };

      runner.run(scenario);

      expect(runner.state.currentEventIndex).toBe(-1);
      expect(domain.activateDm).not.toHaveBeenCalled();

      jest.advanceTimersByTime(4000);
      await Promise.resolve();

      expect(runner.state.currentEventIndex).toBe(-1);
      expect(domain.activateDm).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(runner.state.currentEventIndex).toBe(0);
      expect(domain.activateDm).toHaveBeenCalledTimes(1);
      expect(domain.activateDm).toHaveBeenCalledWith('ZF1', { deviceId: 'dm-1' });

      runner.stop('idle');
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports sequence progress as steps are executed', async () => {
    jest.useFakeTimers();
    try {
      const domain = createDomainStub();
      const runner = new ScenarioRunner(domain);
      const scenario: ScenarioDefinition = {
        id: 'scenario-3',
        name: 'Séquence multi-déclencheurs',
        events: [
          {
            id: 'event-1',
            type: 'DM_TRIGGER',
            zoneId: 'ZF1',
            offset: 0,
            sequence: [
              { deviceId: 'dm-1', delay: 0 },
              { deviceId: 'dm-2', delay: 5 },
            ],
          },
        ],
        topology: {
          plan: undefined,
          zones: [],
          devices: [
            { id: 'dm-1', kind: 'DM', zoneId: 'ZF1' },
            { id: 'dm-2', kind: 'DM', zoneId: 'ZF1' },
          ],
        },
        manualResettable: undefined,
        evacuationAudio: undefined,
      };

      runner.run(scenario);

      expect(runner.state.sequenceProgress?.['event-1']).toBe(0);

      jest.advanceTimersByTime(0);
      await Promise.resolve();

      expect(runner.state.sequenceProgress?.['event-1']).toBe(1);

      jest.advanceTimersByTime(5000);
      await Promise.resolve();

      expect(runner.state.sequenceProgress?.['event-1']).toBe(2);

      runner.stop('idle');
    } finally {
      jest.useRealTimers();
    }
  });
});
