import { describe, it, expect } from 'vitest';
import { SsiSdk } from '../index';

describe('SsiSdk', () => {
  it('constructs with base url', () => {
    const sdk = new SsiSdk('http://localhost:4500');
    expect(sdk).toBeTruthy();
  });
});
