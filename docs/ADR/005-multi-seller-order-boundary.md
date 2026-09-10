# ADR-005: Parent Order with Seller Sub-orders

Status: **Accepted**

## Context

The assessment describes a marketplace and a seller order list, but does not say
whether a cart can contain products from multiple sellers. Restricting a cart to
one seller is simpler but is an unspoken product limitation.

## Options considered

1. Restrict each cart to one seller.
2. Create independent buyer orders/payments for every seller.
3. Create one buyer order/payment and a seller sub-order per seller.

## Decision

Use one parent order/payment for the buyer and one seller order for each seller in
the cart. Order items belong to a seller order and contain immutable product and
price snapshots. Seller APIs query seller orders by authenticated seller ID.

## Consequences

- Buyer payment remains a single aggregate transaction.
- Seller data isolation is explicit.
- Future cancellation, refund allocation, and fulfillment become more complex
  and require state-machine and amount-allocation rules.
- The first slice intentionally does not implement partial seller cancellation or
  refund.
