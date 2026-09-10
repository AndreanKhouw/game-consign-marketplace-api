# ADR-003: PostgreSQL and Relational Data Model

Status: **Accepted**

## Context

The system needs transactions, row-level concurrency, ownership joins, durable
idempotency, unique provider events, relational history, and enforceable
constraints.

## Options considered

1. Document database with application-enforced relationships.
2. SQLite for implementation simplicity.
3. PostgreSQL as the authoritative store.

## Decision

Use PostgreSQL 16. Keep a normalized mutable model for users, products, carts,
sessions, and payments. Store immutable product, seller, and money snapshots on
order records. Represent money as `BIGINT` minor units with an explicit currency.

Database constraints protect ownership relationships, uniqueness, positive
quantities, non-negative stock/amounts, one active cart, one order per cart, one
seller sub-order per seller, and durable command/event identity.

## Consequences

- Transactions and integrity rules are colocated with the authoritative data.
- Schema changes require migrations and deployment discipline.
- PostgreSQL-specific locking behavior is an intentional dependency.
- Redis may accelerate sessions/rate limits, but cannot replace durable database
  uniqueness for stock or money effects.
- IDR-only support is a first-slice assumption; adding currencies requires a
  deliberate rounding and allocation policy.
