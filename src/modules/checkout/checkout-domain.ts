export type AmountCalculation =
  { ok: true; amountMinor: number } | { ok: false; reason: 'amount_out_of_range' };

export function calculateLineTotal(unitPriceMinor: number, quantity: number): AmountCalculation {
  const amountMinor = unitPriceMinor * quantity;
  return Number.isSafeInteger(amountMinor) && amountMinor >= 0
    ? { ok: true, amountMinor }
    : { ok: false, reason: 'amount_out_of_range' };
}

export function calculateOrderTotal(lineTotals: readonly number[]): AmountCalculation {
  let amountMinor = 0;
  for (const lineTotal of lineTotals) {
    amountMinor += lineTotal;
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      return { ok: false, reason: 'amount_out_of_range' };
    }
  }
  return { ok: true, amountMinor };
}
