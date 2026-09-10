# Game Consign Marketplace API

A hardened marketplace backend implemented for the Senior Backend Engineer
technical assessment. The core slice is complete and runs as a TypeScript/Fastify
modular monolith backed by PostgreSQL 16 and Redis 7.

## Run locally

Requirements: Docker Desktop with Linux containers and Docker Compose v2.

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Wait until `api` is healthy, then open `http://localhost:3000/health/ready`.
PostgreSQL is exposed on host port `15432` to avoid common conflicts while all
containers use `postgres:5432` internally. Redis is exposed on `6379`.

Development-only seed accounts:

| Role            | Email                 | Password                     |
| --------------- | --------------------- | ---------------------------- |
| Buyer           | `buyer@example.test`  | `Buyer-Test-Password-2026!`  |
| Seller          | `seller@example.test` | `Seller-Test-Password-2026!` |
| Admin seed only | `admin@example.test`  | `Admin-Test-Password-2026!`  |

Run all tests, including real-PostgreSQL concurrency tests:

```powershell
docker compose --profile test run --rm test
```

Run local static checks with Node/pnpm:

```powershell
pnpm check
pnpm build
```

The complete HTTP contract and examples are in [openapi.yaml](openapi.yaml).

## Architecture

The application is a modular monolith. Identity, catalog, seller, cart,
checkout, payment, audit, and platform concerns have separate route, service,
and repository boundaries, while one PostgreSQL transaction can still protect
stock, cart consumption, order creation, payment creation, idempotency, and
audit writes atomically. This keeps operational complexity proportional to the
assessment while preserving seams for a later service split.

PostgreSQL is authoritative for durable security, money, stock, and duplicate
protection. Redis holds distributed rate-limit counters only; it is not the
source of truth for orders, sessions, inventory, or payment events. Money is
stored as signed 64-bit integer IDR minor units. Product IDs are locked/updated
in deterministic order, and each stock decrement is conditional on sufficient
stock. A parent order splits into seller-scoped sub-orders with immutable item,
seller, price, and currency snapshots.

Key design evidence:

- [System design](docs/SYSTEM-DESIGN.md)
- [ERD and database constraints](docs/erd.md)
- [Evidence and decision ledger](docs/EVIDENCE-LEDGER.md)
- [Threat model](docs/THREAT-MODEL.md)
- [Architecture decisions](docs/ADR/)

## Security strategy

### Authentication and sessions

Passwords use Node's salted `scrypt` with `N=32768`, `r=8`, `p=1`, a random
16-byte salt, and a 64 MiB memory ceiling. Login uses one generic public error
and performs dummy password verification for unknown accounts. Access and
refresh credentials are random 256-bit opaque tokens; only SHA-256 lookup hashes
are persisted. Access tokens live for 10 minutes and are sent as bearer tokens.
Refresh tokens live for 14 days in an `HttpOnly`, `Secure` in production,
`SameSite=Lax` cookie. Rotation is transactional, reuse revokes the complete
session family, and logout invalidates current access immediately.

Bearer access keeps authenticated mutations outside ambient cookie authority,
reducing CSRF exposure. Refresh/logout additionally enforce the configured
Origin. Access tokens kept in SPA memory remain exposed to successful in-page
XSS, so CSP, dependency hygiene, output encoding, and avoiding persistent browser
storage remain required client controls.

### Authorization and input boundaries

Authentication is default-deny: a route is public only when its route config
explicitly says so. Roles grant capabilities but ownership predicates protect
objects. Seller updates include both seller and product identity; buyer order
reads include both buyer and order identity. Non-owned records return 404.
TypeBox schemas reject unknown or oversized input, mutable DTOs are allow-lists,
dynamic sort values map to internal SQL fragments, and every value is passed as
a PostgreSQL parameter. Image URLs are stored as references and are never fetched
by the API.

### Transactions, abuse, and payment callbacks

Checkout uses a durable scoped idempotency record with a request fingerprint and
stored response. The buyer cart is locked and consumed once, `orders.cart_id` is
unique, and conditional product updates prevent negative stock under concurrency.
No network request occurs inside the checkout transaction. Payment callbacks
authenticate `timestamp + "." + exact_raw_body` with HMAC-SHA256 and constant-time
comparison, reject timestamps outside five minutes, verify amount/currency, and
deduplicate durable provider event IDs before a monotonic state transition.

Global per-IP limits are combined with Redis-backed per-user, normalized-identity,
refresh-token, and endpoint limits. Login/register apply a progressive delay
before the hard threshold, avoiding a long-lived account lock that could become
a victim-targeted denial of service. Body size, page size, query choices,
statement time, lock wait, and connection-pool size are bounded.

### Secrets, logs, and operations

Only development placeholders are committed in `.env.example`; production
secrets belong in a secret manager and should be rotated independently.
Authorization, cookie, token, password, and HMAC headers are redacted from
structured logs. Each request receives a UUID request ID in logs, errors, and
`X-Request-ID`. Sensitive state changes append audit rows. Liveness checks the
process; readiness checks PostgreSQL and Redis. Shutdown drains HTTP work before
closing dependency pools.

## Time-box trade-offs and intentionally cut scope

- Cart addition does not reserve stock. Stock is decremented at checkout as the
  assessment requests, so an abandoned unpaid order can strand inventory.
- Cancellation, reservation expiry, refunds, fulfillment, shipment, tax,
  commission, advanced search, partner auth, and admin APIs are excluded.
- The payment gateway is simulated; webhook verification and failure semantics
  are real, but there is no outbound provider call or reconciliation worker.
- IDR is the only currency. Multi-currency rounding and allocation rules are not
  invented without product requirements.
- Catalog substring search is intentionally simple. A trigram/full-text index
  should follow measured query plans and representative catalog volume.
- Redis-backed limits currently fail requests if Redis is unavailable. A
  production deployment should define endpoint-specific fail-open/fail-closed
  behavior and local emergency caps.

These cuts preserve depth in session revocation, object authorization,
concurrency, idempotency, and signed webhooks instead of adding shallow bonus
endpoints.

## If I had two more weeks

1. Add expiring stock reservations with idempotent consume/release, a worker,
   payment-race handling, and inventory reconciliation.
2. Add an outbound payment adapter with deadlines, provider idempotency keys,
   bounded backoff, circuit breaking, and a payment reconciliation job.
3. Expand negative-path coverage for mass assignment, input boundaries,
   idempotency-key payload conflicts, transaction rollback, buyer-to-buyer IDOR,
   illegal payment transitions, rate limits, and log redaction.
4. Add route/OpenAPI conformance tests, production-like catalog data, and
   `EXPLAIN (ANALYZE, BUFFERS)` evidence for critical queries.
5. Add a transactional outbox before notifications or cross-service events, plus
   metrics and alerts for lock waits, deadlocks, pool saturation, webhook lag,
   and stuck payments.
6. Define production RPO/RTO, backup-restore drills, retention/deletion policy,
   secret rotation, least-privilege database roles, and deployment runbooks.

## Actual effort

Approximately **11 active hours** across design/documentation, implementation,
testing, security hardening, and environment troubleshooting. This was
reconstructed from the working session rather than a dedicated timer and should
be corrected by the candidate if their own tracked time differs.

## AI assistant usage

An AI assistant was used to analyze the assessment, surface ambiguities and
failure modes, draft design/ADR/OpenAPI documentation, scaffold implementation,
review security boundaries, and propose tests. It was not used to copy another
repository.

Generated work was verified by reading the resulting code and contracts, running
TypeScript type-checking, ESLint, Prettier, Redocly OpenAPI validation, a
production build, a clean Docker Compose build, PostgreSQL migration/seed, and
the complete containerized test suite. The executable proof includes 50
concurrent checkout attempts for one unit, same-key and different-key duplicate
checkout behavior, cross-seller authorization, refresh reuse/logout revocation,
and valid/forged/stale/duplicate payment webhook cases. The candidate remains
responsible for understanding and defending every submitted line.
