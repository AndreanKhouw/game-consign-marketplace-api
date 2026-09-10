export type PaymentStatus = 'pending' | 'paid' | 'failed';
export type PaymentEventStatus = Exclude<PaymentStatus, 'pending'>;

export type PaymentTransition =
  { kind: 'apply'; orderStatus: 'paid' | 'payment_failed' } | { kind: 'noop' } | { kind: 'reject' };

export function decidePaymentTransition(
  current: PaymentStatus,
  requested: PaymentEventStatus,
): PaymentTransition {
  if (current === requested) return { kind: 'noop' };
  if (current !== 'pending') return { kind: 'reject' };
  return {
    kind: 'apply',
    orderStatus: requested === 'paid' ? 'paid' : 'payment_failed',
  };
}
