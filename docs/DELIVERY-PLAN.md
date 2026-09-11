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

**Current status (2026-09-11): Verified.** ADRs are present and Redocly validation
passes.

## Gate 1: reproducible platform foundation

Create the application manifest, Dockerfile, Compose stack, `.env.example`,
configuration validation, PostgreSQL migrations, development seed, structured
logging, request ID, safe errors, CORS, body limits, graceful shutdown, liveness,
and readiness.

**Exit:** a clean checkout starts with one documented command and migrations/seed
produce buyer and seller demo accounts without production secrets.

**Current status (2026-09-11): Verified.** A no-cache production image build and
an isolated empty-volume bootstrap completed migrations, seed, liveness,
readiness, and public seeded-catalog access successfully.

## Gate 2: identity and default-deny authorization

Implement registration, login, refresh, logout, `/me`, salted scrypt, server-side
opaque sessions, rotation/reuse detection, role capability checks, ownership
helpers, and layered rate limits.

**Exit:** authentication success/failure, logout, refresh reuse, mass revocation,
and default-deny tests pass.

**Current status (2026-09-11): Verified.** Authentication success/failure, logout,
refresh reuse, mass revocation through `auth_version`, default-deny behavior,
progressive-delay rules, and the distributed identity hard limit are covered.

## Gate 3: public catalog and seller ownership

Implement product migration/repository, allow-listed filters/sort, stable cursor,
product create/update with explicit DTOs and optimistic versioning, and seller-
scoped order query skeleton.

**Exit:** SQL-injection boundary, pagination, N+1/query-count, mass-assignment,
version-conflict, and cross-seller tests pass.

**Current status (2026-09-11): Verified.** Every listed Gate 3 exit check has a
passing PostgreSQL-backed integration test.

## Gate 4: cart and transactional checkout

Implement active-cart versioning, cart item commands, durable idempotency, sorted
conditional stock decrement, parent/seller orders, immutable item snapshots,
payment reference, audit records, and cart consumption.

**Exit:** rollback, last-unit concurrency, same-key concurrency, different-key
same-cart, amount boundary, and buyer ownership tests pass against PostgreSQL.

**Current status (2026-09-11): Verified.** Last-unit concurrency, same-key retry,
different-key same-cart protection, buyer ownership, multi-item rollback,
amount-boundary rollback, and reuse of one key with a different request are
covered against PostgreSQL.

## Gate 5: signed payment webhook

Implement raw-body capture, HMAC verification, timestamp window, durable event
identity/payload hash, amount/currency verification, monotonic state machine, and
auditing.

**Exit:** valid, forged, altered, stale, duplicate, conflicting duplicate, and
out-of-order cases pass.

**Current status (2026-09-11): Verified.** Valid, duplicate-identical,
altered-body, stale, conflicting duplicate event ID, and illegal terminal
transition cases are covered through the HTTP and PostgreSQL boundary.

## Gate 6: submission and defense readiness

Run formatter, linter, unit/integration suite, clean Docker rebuild, OpenAPI-route
conformance, log-redaction checks, and a manual walkthrough. Replace planned
threat-model references with exact files/functions. Complete README trade-offs,
two-week plan, actual time, and AI verification disclosure.

**Exit:** another person can run and test the API in under ten minutes, and the
candidate can trace session, checkout, stock, and webhook flows without relying
on generated explanations.

**Current status (2026-09-11): Verified.** Type-checking, linting, formatting,
OpenAPI syntax linting, a no-cache production build, an empty-volume Compose
bootstrap, 9 unit tests, and 25 integration tests pass. Automated route/OpenAPI
registration, log redaction, health endpoints, and the full buyer/seller happy
path are covered.

## Suggested commit sequence

1. `docs: define system, API, threat model, and ADR baseline`
2. `chore: add reproducible service and database foundation`
3. `feat: implement revocable identity sessions`
4. `feat: add catalog and seller ownership boundaries`
5. `feat: implement transactional idempotent checkout`
6. `feat: verify and process payment webhooks`
7. `test: prove concurrency, idempotency, and authorization`
8. `docs: finalize security evidence and runbook`
