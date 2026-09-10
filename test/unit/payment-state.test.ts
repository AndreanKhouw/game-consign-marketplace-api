import { describe, expect, it } from 'vitest';

import { decidePaymentTransition } from '../../src/modules/payment/payment-state.js';

describe('payment state machine', () => {
  it('applies terminal outcomes from pending', () => {
    expect(decidePaymentTransition('pending', 'paid')).toEqual({
      kind: 'apply',
      orderStatus: 'paid',
    });
    expect(decidePaymentTransition('pending', 'failed')).toEqual({
      kind: 'apply',
      orderStatus: 'payment_failed',
    });
  });

  it('treats an already-applied outcome as a no-op', () => {
    expect(decidePaymentTransition('paid', 'paid')).toEqual({ kind: 'noop' });
    expect(decidePaymentTransition('failed', 'failed')).toEqual({ kind: 'noop' });
  });

  it('rejects movement between terminal outcomes', () => {
    expect(decidePaymentTransition('paid', 'failed')).toEqual({ kind: 'reject' });
    expect(decidePaymentTransition('failed', 'paid')).toEqual({ kind: 'reject' });
  });
});
