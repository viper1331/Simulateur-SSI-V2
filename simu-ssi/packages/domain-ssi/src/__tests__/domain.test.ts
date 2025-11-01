import { createSsiDomain } from '../index';

describe('SSI domain core rules', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('triggers automatic evacuation after delay when no ack is received', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: true });
    domain.activateDm('ZF1');

    expect(domain.snapshot.cmsi.status).toBe('EVAC_PENDING');
    jest.advanceTimersByTime(1000);
    expect(domain.snapshot.cmsi.status).toBe('EVAC_ACTIVE');
    if (domain.snapshot.cmsi.status === 'EVAC_ACTIVE') {
      expect(domain.snapshot.cmsi.manual).toBe(false);
    }
  });

  it('suspends evacuation and freezes the deadline when ack occurs before expiry', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: false });
    domain.activateDm('ZF2');
    domain.acknowledgeProcess('trainer');

    expect(domain.snapshot.cmsi.status).toBe('EVAC_SUSPENDED');
    if (domain.snapshot.cmsi.status === 'EVAC_SUSPENDED') {
      expect(domain.snapshot.cmsi.remainingMs).toBe(1000);
    }

    jest.advanceTimersByTime(1000);
    expect(domain.snapshot.cmsi.status).toBe('EVAC_SUSPENDED');
  });

  it('allows system reset after acknowledgement once devices are restored', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: false });
    domain.activateDm('ZF4');
    domain.acknowledgeProcess('trainer');
    domain.resetDm('ZF4');
    const resetResult = domain.trySystemReset();
    expect(resetResult).toEqual({ ok: true });
  });

  it('allows manual evacuation start and stop', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: false });
    domain.startManualEvacuation('drill');
    expect(domain.snapshot.cmsi.status).toBe('EVAC_ACTIVE');
    domain.stopManualEvacuation('completed');
    expect(domain.snapshot.cmsi.status).toBe('SAFE_HOLD');
  });

  it('blocks system reset when a manual call point is latched', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: false });
    domain.activateDm('ZF3');
    const resetResult = domain.trySystemReset();
    expect(resetResult).toEqual({ ok: false, reason: 'DM_NOT_RESET' });
    domain.resetDm('ZF3');
    const okReset = domain.trySystemReset();
    expect(okReset).toEqual({ ok: true });
  });

  it('immediately triggers evacuation when DAI requires it', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: true });
    domain.activateDai('ZF1');
    expect(domain.snapshot.cmsi.status).toBe('EVAC_ACTIVE');
    expect(domain.snapshot.daiActivated['ZF1']).toBeDefined();
  });

  it('sets CMSI to fire alarm when DAI triggers without evacuation', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: false });
    domain.activateDai('ZF1');

    expect(domain.snapshot.cmsi.status).toBe('FIRE_ALARM');
    if (domain.snapshot.cmsi.status === 'FIRE_ALARM') {
      expect(domain.snapshot.cmsi.zoneIds).toEqual(['ZF1']);
    }

    domain.resetDai('ZF1');
    expect(domain.snapshot.cmsi.status).toBe('IDLE');
  });

  it('retains multiple DM activations in the same zone until reset', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: true });
    domain.activateDm('ZF5', { deviceId: 'dm-1' });
    domain.activateDm('ZF5', { deviceId: 'dm-2' });

    const state = domain.snapshot.dmLatched['ZF5'];
    expect(state?.activeDeviceIds).toEqual(expect.arrayContaining(['dm-1', 'dm-2']));
    expect(state?.activeDeviceIds).toHaveLength(2);

    domain.resetDm('ZF5');
    expect(domain.snapshot.dmLatched['ZF5']).toBeUndefined();
  });

  it('retains multiple DAI activations in the same zone until reset', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: false });
    domain.activateDai('ZF6', { deviceId: 'dai-1' });
    domain.activateDai('ZF6', { deviceId: 'dai-2' });

    const state = domain.snapshot.daiActivated['ZF6'];
    expect(state?.activeDeviceIds).toEqual(expect.arrayContaining(['dai-1', 'dai-2']));
    expect(state?.activeDeviceIds).toHaveLength(2);

    expect(domain.snapshot.cmsi.status).toBe('FIRE_ALARM');
    if (domain.snapshot.cmsi.status === 'FIRE_ALARM') {
      expect(domain.snapshot.cmsi.zoneIds).toEqual(['ZF6']);
    }

    domain.resetDai('ZF6');
    expect(domain.snapshot.daiActivated['ZF6']).toBeUndefined();
  });

  it('clears active DAI automatically during system reset', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: true, evacOnDai: false });
    domain.activateDai('ZF2');
    const resetResult = domain.trySystemReset();
    expect(resetResult).toEqual({ ok: true });
    expect(domain.snapshot.daiActivated['ZF2']).toBeUndefined();
    expect(domain.snapshot.cmsi.status).toBe('IDLE');
  });

  it('activates a local audible signal on DAI pre-alarm that can be silenced', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: false, evacOnDai: false });
    domain.activateDai('ZF1');
    expect(domain.snapshot.localAudibleActive).toBe(true);
    expect(domain.snapshot.cmsi.status).toBe('FIRE_ALARM');
    domain.silenceAudibleAlarm();
    expect(domain.snapshot.localAudibleActive).toBe(false);
  });

  it('clears the local audible signal once all DAI are reset', () => {
    const domain = createSsiDomain({ evacOnDmDelayMs: 1000, processAckRequired: false, evacOnDai: false });
    domain.activateDai('ZF3');
    domain.silenceAudibleAlarm();
    expect(domain.snapshot.localAudibleActive).toBe(false);
    domain.activateDai('ZF3');
    expect(domain.snapshot.localAudibleActive).toBe(true);
    expect(domain.snapshot.cmsi.status).toBe('FIRE_ALARM');
    domain.resetDai('ZF3');
    expect(domain.snapshot.localAudibleActive).toBe(false);
    expect(domain.snapshot.cmsi.status).toBe('IDLE');
  });
});
