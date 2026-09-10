# ADR-002: PostgreSQL Conditional Stock Update

Status: **Accepted**

## Context

Concurrent buyers may attempt to purchase the final unit. A separate read-then-
write sequence can oversell. Multi-item checkout also needs all-or-nothing
behavior and predictable locking.

## Options considered

1. Application mutex or Redis distributed lock.
2. Optimistic product-version check followed by retry.
3. `SELECT ... FOR UPDATE` followed by decrement.
4. Atomic conditional `UPDATE ... WHERE stock_quantity >= requested`.

## Decision

Use a PostgreSQL transaction and atomic conditional update for each product.
Process product IDs in sorted order. Absence of a returned row means inactive,
missing, or insufficient stock and aborts the whole checkout.

Also increment the product version so seller inventory edits can use optimistic
concurrency. Retry deadlock/serialization failures only as a bounded retry of the
complete idempotent command.

## Consequences

- PostgreSQL itself arbitrates concurrent stock changes.
- No additional distributed-lock dependency is needed for correctness.
- Multi-row checkout can still deadlock without deterministic ordering.
- Integration tests must use real PostgreSQL connections; SQLite and mocks do not
  prove the chosen guarantee.
- An inventory reservation/expiry system remains a separate future workflow.
