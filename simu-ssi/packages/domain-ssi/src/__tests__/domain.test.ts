import { createSsiDomain } from '../index';

describe('SSI domain core rules', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('triggers automatic evacuation after delay when no ack is received', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true });
    domain.activateDm('ZF1');

    expect(domain.snapshot.cmsi.status).toBe('EVAC_PENDING');
    jest.advanceTimersByTime(1000);
    expect(domain.snapshot.cmsi.status).toBe('EVAC_ACTIVE');
    if (domain.snapshot.cmsi.status === 'EVAC_ACTIVE') {
      expect(domain.snapshot.cmsi.manual).toBe(false);
    }
  });

  it('suspends evacuation when ack occurs before deadline', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true });
    domain.activateDm('ZF2');
    domain.acknowledgeProcess('trainer');
    jest.advanceTimersByTime(1000);
    expect(domain.snapshot.cmsi.status).toBe('EVAC_SUSPENDED');
  });

  it('allows manual evacuation start and stop', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true });
    domain.startManualEvacuation('drill');
    expect(domain.snapshot.cmsi.status).toBe('EVAC_ACTIVE');
    domain.stopManualEvacuation('completed');
    expect(domain.snapshot.cmsi.status).toBe('SAFE_HOLD');
  });

  it('blocks system reset when a manual call point is latched', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true });
    domain.activateDm('ZF3');
    const resetResult = domain.trySystemReset();
    expect(resetResult).toEqual({ ok: false, reason: 'DM_NOT_RESET' });
    domain.resetDm('ZF3');
    const okReset = domain.trySystemReset();
    expect(okReset).toEqual({ ok: true });
  });
});
