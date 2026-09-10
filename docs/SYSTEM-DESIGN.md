# System Design

Status: **Accepted and implemented**

## 1. Scope and actors

The system is a modular-monolith marketplace API consumed by untrusted web and
mobile clients. It supports four actor classes:

- `guest`: public catalog reads only;
- `buyer`: session management, cart, checkout, and own-order reads;
- `seller`: product management and seller-scoped order reads;
- `admin`: seeded identity only in the core slice; no admin API is implemented.

Partner server-to-server access is documented as a distinct future trust model
and must never reuse buyer sessions or a secret embedded in a first-party client.

## 2. Assumptions and non-goals

### Accepted assumptions

- A buyer has one active cart at a time.
- A cart may contain products from multiple sellers.
- One checkout creates a parent order/payment and one seller order per seller.
- Cart operations do not reserve inventory.
- Checkout receives `cart_id` and `cart_version`; cart mutations increment the
  version.
- Product price and availability at checkout are authoritative. Cart price is
  display-only.
- The first slice supports IDR only and stores amounts as integer minor units.
- Product images are externally hosted references; the API never fetches them.
- Seller and admin users are created by seed data because role provisioning is
  outside the supplied contract.

### Explicit non-goals

- Cancellation, refund, fulfillment, shipment, tax, marketplace commission, and
  advanced search.
- Event publication or notifications; therefore no transactional outbox is
  required in the first slice.
- Cache for public catalog reads until measured load justifies invalidation
  complexity.

## 3. Module boundaries

```text
HTTP boundary
  -> application command/query
      -> domain rules
          -> repository / transaction port
              -> PostgreSQL

Modules:
  identity       users, roles, sessions, refresh rotation
  catalog        public product reads
  seller         seller-owned product commands and order reads
  cart           active-cart commands and versioning
  checkout       idempotency, inventory decrement, order creation
  payment        webhook authentication and payment state transitions
  audit          append-only records for sensitive actions
  platform       request ID, errors, limits, health, shutdown
```

HTTP and persistence types do not cross into domain rules. Cross-module writes
are coordinated by an application-level unit of work; individual modules do not
write another module's tables directly outside that orchestration.

## 4. Trust boundaries

```text
Untrusted SPA/mobile
  -> TLS / reverse proxy
    -> CORS, body limit, rate limit, request ID
      -> authentication (default deny)
        -> object authorization
          -> validated application command
            -> PostgreSQL transaction

Payment gateway
  -> raw-body size limit
    -> timestamp window + HMAC verification
      -> schema validation
        -> idempotent state transition
```

No client-supplied price, total, owner ID, role, payment state, or order state is
trusted.

## 5. Session design

The implemented session uses high-entropy opaque tokens:

- Access token TTL: 10 minutes; returned in the login/refresh body and stored in
  SPA memory or OS-protected mobile storage.
- Refresh token TTL: 14 days; sent as an `HttpOnly`, `Secure`, `SameSite=Lax`
  cookie scoped to `/v1/auth`.
- Only SHA-256 token hashes are persisted. Random 256-bit token entropy makes a
  fast lookup hash appropriate; passwords use salted scrypt with `N=32768`,\n `r=8`, `p=1`, and a 64 MiB memory ceiling.
- Refresh rotates inside a transaction. A consumed token points to its successor.
- Reuse of a consumed refresh token revokes the complete session family.
- Logout revokes the session family server-side and clears the refresh cookie.
- Password or privilege changes revoke every session family for the user.

Authenticated application calls use an `Authorization: Bearer` access token, so
ambient cookies do not authorize checkout or seller mutations. Refresh and logout
also enforce an allowed `Origin`; deployment should keep the SPA and API under
the same registrable site. A truly cross-site deployment requires
`SameSite=None`, HTTPS, and an explicit CSRF token.

Strict refresh reuse detection can log out a user when two tabs refresh at the
same instant. Clients must implement single-flight refresh. A short successor
grace window is deliberately deferred and recorded as a UX/security trade-off.

## 6. Authorization model

- Every route requires authentication unless marked public in the route
  definition and OpenAPI.
- Role checks grant capability; they do not grant object ownership.
- Seller mutation predicates include both product ID and authenticated seller ID.
- Buyer order predicates include both order ID and authenticated buyer ID.
- Non-owned resources return `404` to reduce object enumeration.
- Request DTOs explicitly allow mutable fields. Persistence entities are never
  populated directly from request bodies.
- A seller order read returns only that seller's items and the minimum buyer data
  needed by the defined workflow.

## 7. Checkout transaction

The authoritative checkout transaction runs as follows:

1. Insert or acquire the idempotency record scoped by buyer and operation.
2. If a completed record exists, return its stored status/body. If its request
   fingerprint differs, return `409 IDEMPOTENCY_KEY_REUSED`.
3. Lock the buyer-owned cart and verify `active` state and expected version.
4. Load non-empty cart items and sort product IDs before writes.
5. For each product, execute an atomic conditional decrement:

   ```sql
   UPDATE products
      SET stock_quantity = stock_quantity - :quantity,
          version = version + 1,
          updated_at = now()
    WHERE id = :product_id
      AND status = 'active'
      AND stock_quantity >= :quantity
   RETURNING seller_id, name, price_minor, currency;
   ```

6. Any missing result aborts the complete transaction with an out-of-stock
   domain error.
7. Create the parent order, seller orders, immutable item snapshots, and payment
   record/reference.
8. Mark the cart `checked_out` and store the final idempotent response.
9. Commit.

Products are processed in deterministic ID order to reduce deadlock risk. A
bounded transaction retry may handle PostgreSQL deadlock/serialization errors,
because the complete command is durably idempotent.

`orders.cart_id` is unique, preventing a second order even when a caller uses a
different idempotency key. No network call is made while the database transaction
is open.

## 8. Payment processing

The simulated gateway callback sends an event ID, payment reference, status,
amount, currency, and occurrence time. It also sends a Unix timestamp and
HMAC-SHA256 signature over:

```text
timestamp + "." + exact_raw_request_body
```

Processing order:

1. Enforce compressed/decompressed body limits.
2. Read raw bytes before JSON parsing.
3. Reject timestamps outside a documented five-minute window.
4. Decode and compare the calculated/provided MAC with a constant-time primitive.
5. Validate the event schema and amount/currency against the payment record.
6. Insert the gateway event under a durable unique provider event ID.
7. Lock payment/order, apply a valid monotonic transition, and append audit data.
8. Duplicate identical events return success without a second effect. Reuse of
   an event ID with a different payload is rejected.

Core transitions are:

```text
pending -> paid
pending -> failed
paid    -> paid    (duplicate/no-op)
failed  -> failed  (duplicate/no-op)
```

`paid -> failed` and `failed -> paid` are rejected pending manual reconciliation.

## 9. Inventory and unpaid-order limitation

The assessment requires stock decrement at checkout but makes cancellation and
stock return optional. Consequently, a checkout that is never paid can strand
stock. The core implementation will expose this honestly as residual risk unless
an expiration worker is explicitly added.

A production extension would use expiring inventory reservations:

```text
available -> reserved at checkout -> consumed on payment
                              \----> released on expiry/failure
```

That extension requires a worker, retry-safe release, payment/reservation race
handling, and reconciliation; it must not be represented as a trivial timer.

## 10. API conventions

- JSON uses English `snake_case` names and enum values.
- Times are RFC 3339 UTC instants.
- IDs are UUIDs; cursors are opaque.
- Errors use `application/problem+json` with stable `code` and `request_id`.
- Every response includes `X-Request-ID`.
- Collection limits are bounded; the server rejects unknown sort values.
- Cursor pagination uses a unique ID tie-breaker and binds the cursor to the
  selected filter/sort definition.
- Mutations reject unknown request properties.

## 11. Database invariants

The schema must enforce, at minimum:

- unique normalized email;
- one active cart per buyer;
- one cart item per product;
- positive cart/order quantity;
- non-negative price and stock;
- one order per cart;
- one seller order per `(order, seller)`;
- globally unique payment reference and gateway event ID;
- unique scoped idempotency key;
- foreign keys for every same-database relationship.

Order item names, seller identity, unit prices, currency, and calculated totals
are immutable snapshots. Product edits or archival cannot alter historical
orders.

## 12. Rate limiting and resource protection

Implemented initial limits are configuration, not hard-coded business rules:

- general public API: distributed per-IP counters;
- login/register: per-IP plus normalized-identity hash with progressive delay;
- refresh: per-IP plus session family;
- checkout: per-user plus per-IP;
- webhook: per-source plus global circuit protection after signature validation.

Redis executes atomic counters across pods. The trusted-proxy list is explicit;
arbitrary `X-Forwarded-For` values are ignored. Sensitive endpoints fail closed
or use a conservative local fallback when Redis is unavailable, while catalog
reads may fail open under an emergency local cap.

Request body, query length, array length, page size, database statement time,
transaction time, and lock wait are bounded. The database connection pool is
smaller than the PostgreSQL connection budget.

## 13. Logging, audit, and privacy

- The server generates a UUID request ID unless an inbound value passes strict
  length and character validation.
- Authorization, cookies, passwords, tokens, HMAC signatures, and payment data
  are redacted before structured logging.
- Failed logins store a keyed email fingerprint rather than a plaintext email.
- Price changes, authentication failures, session revocation/reuse, checkout,
  and payment transitions append audit records.
- Production PostgreSQL storage is encrypted at rest by infrastructure; TLS and
  least-privilege credentials protect data in transit and access.
- Audit and payment records are retained according to an explicit production
  policy; the assessment implementation will document but not invent a legal
  retention duration.

## 14. Operations

- `/health/live` reports process/event-loop health only.
- `/health/ready` verifies that required stores accept requests with short
  timeouts.
- Graceful shutdown stops accepting new requests, drains in-flight requests, and
  then closes database/Redis pools within a bounded deadline.
- Schema migration is a deployment step protected from concurrent runners; seed
  data is development/test-only.
- Network calls have connection and request deadlines, bounded retries with
  jitter, and no retries for non-idempotent operations without a provider key.

## 15. Proof plan

Integration tests use the real PostgreSQL transaction and locking behavior:

1. Fifty or more simultaneous attempts for one remaining unit produce exactly
   one successful checkout, zero remaining stock, and one order.
2. Simultaneous checkouts with the same idempotency key return one order result.
3. Different idempotency keys against the same cart still produce one order.
4. Seller A cannot mutate Seller B's product and Buyer A cannot read Buyer B's
   order.
5. Valid webhook succeeds; altered body, wrong signature, stale timestamp, reused
   event ID with different body, and illegal transition cannot change payment.
6. Refresh rotation, strict reuse detection, logout, and mass revocation invalidate
   the expected sessions.
7. Transaction failure on any line item rolls back stock decrements and order
   writes.

## 16. Scale path

Start with one modular application, PostgreSQL primary, and Redis. Scale stateless
API replicas horizontally while preserving distributed rate/session state.

Only introduce a read replica when measured catalog/report reads harm writes;
partition append-only audit/payment-event history only when retention and table
size justify it; split services/databases only when independent deployment or
compliance outweighs distributed-consistency cost. Sharding and event sourcing
are not justified by the available workload evidence.
