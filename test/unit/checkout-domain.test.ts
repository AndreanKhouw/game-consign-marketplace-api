import { describe, expect, it } from 'vitest';

import {
  calculateLineTotal,
  calculateOrderTotal,
} from '../../src/modules/checkout/checkout-domain.js';

describe('checkout money rules', () => {
  it('calculates exact integer line and order totals', () => {
    expect(calculateLineTotal(125_000, 3)).toEqual({ ok: true, amountMinor: 375_000 });
    expect(calculateOrderTotal([375_000, 25_000])).toEqual({
      ok: true,
      amountMinor: 400_000,
    });
  });

  it('rejects totals outside the JavaScript safe-integer boundary', () => {
    expect(calculateLineTotal(Number.MAX_SAFE_INTEGER, 2)).toEqual({
      ok: false,
      reason: 'amount_out_of_range',
    });
    expect(calculateOrderTotal([Number.MAX_SAFE_INTEGER, 1])).toEqual({
      ok: false,
      reason: 'amount_out_of_range',
    });
  });
});
