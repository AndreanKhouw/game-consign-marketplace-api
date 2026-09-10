# Threat Model

Status: **Implemented baseline**. Evidence below distinguishes code-level
mitigation from executable proof; remaining proof gaps are stated explicitly.

## 1. Assets and trust boundaries

### Assets

- Password hashes, session tokens, user email, and role assignments.
- Product ownership, price, and available stock.
- Cart ownership and contents.
- Orders, immutable money snapshots, and payment state.
- Payment-webhook secret and provider event identity.
- Audit history and correlation identifiers.

### Entry points

- Unauthenticated catalog and identity endpoints.
- Authenticated buyer and seller endpoints.
- Refresh-token cookie endpoint.
- Public payment webhook authenticated by HMAC.
- Database, Redis, reverse proxy, and deployment configuration.

### Trust assumptions

- SPA/mobile code and all client input are untrusted.
- TLS terminates only at a trusted proxy; forwarded client IP is trusted only from
  configured proxy addresses.
- PostgreSQL and Redis are private network dependencies with least-privilege
  credentials.
- Payment-gateway identity is established by possession of the HMAC key, not by
  source IP alone.

## 2. OWASP API Security Top 10 (2023) mapping

| Risk                                                 | Implemented mitigation                                                                                                        | Code and proof evidence                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| API1 Broken Object Level Authorization               | Buyer/order and seller/product queries include authenticated owner IDs; non-owned objects return 404                          | `SellerService.updateProduct`, `OrderService.getBuyerOrder`, and cross-seller test in `test/integration/core.test.ts`     |
| API2 Broken Authentication                           | Salted scrypt, generic login failure with dummy verification, opaque tokens, rotation/reuse detection, server-side revocation | `src/platform/crypto.ts`, `IdentityService`, crypto unit test, refresh-reuse/logout integration tests                     |
| API3 Broken Object Property Level Authorization      | Strict TypeBox request DTOs reject unknown fields; repositories never bind request objects directly                           | Route schemas under `src/modules/*/*-routes.ts`; seller ownership integration test                                        |
| API4 Unrestricted Resource Consumption               | Body/page limits, distributed endpoint limits, statement/lock timeouts, bounded pools                                         | `buildApp` in `src/app.ts`, `loadConfig`, `registerLayeredRateLimit`; dedicated load thresholds remain a test gap         |
| API5 Broken Function Level Authorization             | Global default-deny hook plus explicit role requirements                                                                      | `registerAuthGuard` in `src/platform/auth-guard.ts` and route config declarations                                         |
| API6 Unrestricted Access to Sensitive Business Flows | Per-IP plus keyed identity/user/token counters; progressive login/register delay without durable victim lockout               | `registerLayeredRateLimit` in `src/platform/layered-rate-limit.ts`; dedicated limiter test remains planned                |
| API7 Server Side Request Forgery                     | Product image is validated/stored as a reference and no server fetch path exists                                              | Seller route schemas/repository and absence of outbound HTTP in catalog/seller modules                                    |
| API8 Security Misconfiguration                       | Explicit CORS, Helmet, redaction, safe error mapping, secret validation, and separate health endpoints                        | `buildApp`, `loadConfig`, and `registerErrorHandler`                                                                      |
| API9 Improper Inventory Management                   | Versioned `/v1` routes, maintained OpenAPI contract, locked dependency manifest                                               | `openapi.yaml`, `package.json`, Redocly validation; automated route-contract comparison remains planned                   |
| API10 Unsafe Consumption of APIs                     | Exact-raw-body HMAC, timestamp/amount/schema verification, durable event identity, monotonic transitions                      | `PaymentService.processWebhook`, `decidePaymentTransition`, crypto/payment-state unit tests, and webhook integration test |

## 3. Concrete attack scenarios

### Scenario A: seller changes another seller's price

**Attack:** An authenticated seller replaces the product UUID in a PATCH request
with a competitor's product UUID.

**Mitigation:** The mutation contains `WHERE product_id = ? AND seller_id = ?`
and a version predicate. No row returns a generic not-found result. Request DTOs
cannot set `seller_id`.

**Proof:** The cross-seller case in `test/integration/core.test.ts` confirms the
response fails and the target row is unchanged.

**Residual risk:** A database administrator or compromised application database
credential can bypass application authorization. Least privilege and database
auditing reduce but do not eliminate this risk.

### Scenario B: buyers race for the final unit

**Attack:** Many authenticated buyers concurrently submit checkout for a product
with one remaining unit.

**Mitigation:** PostgreSQL conditional decrement is executed inside the complete
checkout transaction. Products are processed in deterministic order and stock
has a non-negative constraint.

**Proof:** The real-PostgreSQL concurrency case in
`test/integration/core.test.ts` sends fifty simultaneous attempts, creates one
successful purchase, and leaves stock at zero.

**Residual risk:** Extreme hot-product contention can increase latency and exhaust
the database pool even while correctness holds. Checkout throttles, pool limits,
timeouts, and capacity monitoring are still required.

### Scenario C: duplicate and conflicting checkout requests

**Attack:** A client sends the same key concurrently, reuses a key with a different
request, or uses different keys against the same cart.

**Mitigation:** Durable unique scoped idempotency records include a canonical
request fingerprint and stored response. The cart is locked/consumed and
`orders.cart_id` is unique.

**Proof:** Integration tests prove simultaneous same-key retries return one order
and different keys cannot consume one cart twice. The different-payload 409 path
is implemented but remains a dedicated test gap.

**Residual risk:** A process crash can strand a separately committed `processing`
claim. The preferred implementation keeps claim and result in the checkout
transaction; if a lease is introduced, a stale-claim recovery procedure is
required.

### Scenario D: stolen refresh token is replayed

**Attack:** An attacker uses an older refresh token after the legitimate client
has rotated it.

**Mitigation:** Each refresh token is one-time use and linked to a session family.
Reuse revokes every access and refresh credential in the family and appends an
audit event.

**Proof:** The session lifecycle cases in `test/integration/core.test.ts` verify
refresh reuse revokes the successor family and logout immediately invalidates the
access token.

**Residual risk:** Strict detection may revoke a legitimate session after a
concurrent refresh from two tabs. Clients must single-flight refresh; a grace
window is deliberately not implemented initially.

### Scenario E: forged or replayed payment webhook

**Attack:** An attacker edits the amount/status, replays a captured webhook, or
sends conflicting status transitions.

**Mitigation:** HMAC covers timestamp and exact raw bytes, comparison is constant
time, old timestamps are rejected, event IDs are unique, payload hashes detect
conflicts, amount/currency must match, and payment transitions are monotonic.

**Proof:** The webhook integration case covers valid, duplicate-identical,
altered-signature, and stale events. Conflicting event-ID and illegal-transition
cases are implemented protections that still need dedicated regression tests.

**Residual risk:** A stolen webhook secret permits valid forgery until rotation.
Production needs secret-manager access control, rotation, monitoring, and gateway
reconciliation.

### Scenario F: account enumeration and credential stuffing

**Attack:** An attacker compares response status, body, or timing for existing and
unknown emails and repeatedly tries leaked passwords.

**Mitigation:** Registration uses a generic 202 response; login uses the same
public 401 and performs a dummy scrypt verification for unknown accounts.
Distributed per-IP and keyed identity limits apply progressive delay without a
global hard lockout.

**Proof:** The crypto unit test proves salted hashing/verification; identity
integration tests exercise public auth failures. A dedicated progressive-delay
and threshold test remains planned.

**Residual risk:** Perfect timing equality is not realistic across storage and
network paths. Email delivery behavior, if later added, also needs a non-
enumerating workflow.

### Scenario G: catalog query exhausts resources

**Attack:** An anonymous caller sends expensive wildcard searches, large limits,
and many connections.

**Mitigation:** Query and cursor lengths, page size, sort values, statement time,
and per-IP rate are bounded. Sort columns come from an internal allow-list.

**Proof:** Route schemas enforce the boundaries. Production-like catalog volume
and recorded `EXPLAIN (ANALYZE, BUFFERS)` plans remain planned work.

**Residual risk:** The initial substring search may still degrade as the catalog
grows. Trigram/full-text indexes are intentionally deferred until workload
evidence exists.

## 4. Yang belum aman

The following risks are intentionally not claimed as solved in the initial core:

1. **Abandoned unpaid orders can strand stock.** Cancellation/stock return is
   optional in the assessment. Production requires expiring reservations plus
   retry-safe release and reconciliation.
2. **No payment reconciliation job.** A valid payment whose webhook is never
   delivered can remain pending until manual intervention.
3. **No seller/admin provisioning workflow.** Seed identities are suitable only
   for assessment and local demonstration.
4. **No partial multi-seller refund or fulfillment model.** Parent and seller
   orders preserve a future boundary, but allocation and compensation rules are
   not implemented.
5. **No hardware-backed or multi-party protection for high-value admin actions.**
   Admin endpoints are excluded from the core slice.
6. **No tamper-evident external audit archive.** Database audit rows reduce
   accidental loss but a privileged database compromise can alter them.
7. **No formally selected legal retention/deletion policy.** The assessment lacks
   jurisdiction and company policy inputs.
8. **No availability guarantee under regional PostgreSQL/Redis failure.** Backup,
   restore, and failover need infrastructure targets for RPO/RTO.

These are documented limits, not permission to silently fail. Operational alerts
and manual reconciliation paths must be defined before production use.
