import { describe, expect, it } from 'vitest';

import { progressiveDelayMs } from '../../src/platform/layered-rate-limit.js';

describe('progressive identity throttling', () => {
  it('delays repeated attempts without delaying requests rejected at the hard limit', () => {
    expect(progressiveDelayMs(1, 10)).toBe(0);
    expect(progressiveDelayMs(3, 10)).toBe(0);
    expect(progressiveDelayMs(4, 10)).toBe(100);
    expect(progressiveDelayMs(9, 10)).toBe(600);
    expect(progressiveDelayMs(10, 10)).toBe(700);
    expect(progressiveDelayMs(11, 10)).toBe(0);
  });
});
