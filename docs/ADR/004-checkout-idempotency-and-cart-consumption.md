# ADR-004: Checkout Idempotency and Cart Consumption

Status: **Accepted**

## Context

Clients, load balancers, and users retry requests. Two identical requests can
arrive simultaneously, and a malicious client can retry the same cart with a
different idempotency key.

## Options considered

1. Cache idempotency responses in Redis.
2. Check for an order before creating one.
3. Persist a database idempotency record and separately constrain cart use.

## Decision

Persist idempotency in PostgreSQL with a unique key scoped by actor and operation,
a canonical request fingerprint, processing state, and stored response. The
checkout request includes `cart_id` and `cart_version`.

Create the idempotency result, order, stock changes, and cart state change within
one transaction. Add a unique constraint on `orders.cart_id` and lock the cart so
different keys still cannot consume it twice.

## Consequences

- Simultaneous identical requests converge on one durable result.
- A key reused with a different request returns a stable conflict.
- Terminal success and client-error outcomes may be retained; transient failures
  that roll back remain retryable.
- Long-running external payment calls cannot occur in the checkout transaction.
- Cleanup of expired records needs a retention job, but durable financial/order
  references remain independently unique.
