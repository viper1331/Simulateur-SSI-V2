import { describe, it, expect } from 'vitest';
import { defaultRules, evaluateScore } from '../index';

describe('scoring', () => {
  it('computes score with default rules', () => {
    const score = evaluateScore(
      [
        { id: '1', ts: Date.now(), type: 'PROCESS_ACK' },
        { id: '2', ts: Date.now(), type: 'MANUAL_EVAC_STOP' },
      ],
      defaultRules,
    );
    expect(score).toBeGreaterThan(0);
  });
});
