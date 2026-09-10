# Documentation-First Delivery Scenario

This scenario turns the assessment into reviewable gates. The implementation
follows this sequence; each exit statement remains a proof checklist rather than
an automatic claim that every desirable regression test exists.

## Gate 0: accept the design baseline

**Inputs:** assessment, system design, ERD, OpenAPI, threat model, ADRs.

**Decisions to confirm:**

- runtime/framework;
- PostgreSQL and Redis usage;
- parent order plus seller sub-orders;
- IDR-only first slice;
- document unpaid-order stock as residual risk versus implementing reservation
  expiry.

**Exit:** decisions are recorded in ADRs and the OpenAPI document passes syntax
validation.

## Gate 1: reproducible platform foundation

Create the application manifest, Dockerfile, Compose stack, `.env.example`,
configuration validation, PostgreSQL migrations, development seed, structured
logging, request ID, safe errors, CORS, body limits, graceful shutdown, liveness,
and readiness.

**Exit:** a clean checkout starts with one documented command and migrations/seed
produce buyer and seller demo accounts without production secrets.

## Gate 2: identity and default-deny authorization

Implement registration, login, refresh, logout, `/me`, salted scrypt, server-side
opaque sessions, rotation/reuse detection, role capability checks, ownership
helpers, and layered rate limits.

**Exit:** authentication success/failure, logout, refresh reuse, mass revocation,
and default-deny tests pass.

## Gate 3: public catalog and seller ownership

Implement product migration/repository, allow-listed filters/sort, stable cursor,
product create/update with explicit DTOs and optimistic versioning, and seller-
scoped order query skeleton.

**Exit:** SQL-injection boundary, pagination, N+1/query-count, mass-assignment,
version-conflict, and cross-seller tests pass.

## Gate 4: cart and transactional checkout

Implement active-cart versioning, cart item commands, durable idempotency, sorted
conditional stock decrement, parent/seller orders, immutable item snapshots,
payment reference, audit records, and cart consumption.

**Exit:** rollback, last-unit concurrency, same-key concurrency, different-key
same-cart, amount boundary, and buyer ownership tests pass against PostgreSQL.

## Gate 5: signed payment webhook

Implement raw-body capture, HMAC verification, timestamp window, durable event
identity/payload hash, amount/currency verification, monotonic state machine, and
auditing.

**Exit:** valid, forged, altered, stale, duplicate, conflicting duplicate, and
out-of-order cases pass.

## Gate 6: submission and defense readiness

Run formatter, linter, unit/integration suite, clean Docker rebuild, OpenAPI-route
conformance, log-redaction checks, and a manual walkthrough. Replace planned
threat-model references with exact files/functions. Complete README trade-offs,
two-week plan, actual time, and AI verification disclosure.

**Exit:** another person can run and test the API in under ten minutes, and the
candidate can trace session, checkout, stock, and webhook flows without relying
on generated explanations.

## Suggested commit sequence

1. `docs: define system, API, threat model, and ADR baseline`
2. `chore: add reproducible service and database foundation`
3. `feat: implement revocable identity sessions`
4. `feat: add catalog and seller ownership boundaries`
5. `feat: implement transactional idempotent checkout`
6. `feat: verify and process payment webhooks`
7. `test: prove concurrency, idempotency, and authorization`
8. `docs: finalize security evidence and runbook`
