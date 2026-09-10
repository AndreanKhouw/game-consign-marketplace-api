# Evidence and Decision Ledger

This ledger separates assessment requirements, accepted decisions, executable
implementation evidence, and residual risks. Migrations, code, and tests now
supersede the original design-only baseline where they provide stronger evidence.

| Claim                                                                   | Status   | Evidence                                                | Confidence | Design impact                                                           |
| ----------------------------------------------------------------------- | -------- | ------------------------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| Guests can browse the catalog                                           | Current  | Assessment section 2.1.B                                | High       | Product reads are explicitly public                                     |
| Buyers can create one order from a cart and receive a payment reference | Current  | Assessment section 2.1.D                                | High       | Checkout owns the transaction boundary                                  |
| Checkout must decrement stock without overselling                       | Current  | Assessment sections 3.3 and 5                           | High       | PostgreSQL row-level atomic update and concurrency test                 |
| Checkout requires durable idempotency                                   | Current  | Assessment sections 3.3 and 5                           | High       | Unique scoped key, request fingerprint, stored result                   |
| Sellers can only mutate their own products                              | Current  | Assessment sections 2.1.C and 3.2                       | High       | Seller ownership is included in mutation predicates                     |
| Buyers can only read their own orders                                   | Current  | Assessment section 3.2                                  | High       | Buyer ownership is included in read predicates                          |
| One checkout may contain products from multiple sellers                 | Current  | Marketplace context; not explicitly resolved            | Medium     | Parent order plus one seller order per store                            |
| Checkout request identifies a cart and version                          | Current  | Needed to fingerprint mutable cart state                | Medium     | Prevents ambiguous retries after cart mutation                          |
| Cart does not reserve stock                                             | Current  | No reservation endpoint or worker in core scope         | Medium     | Stock is checked only at checkout; abandoned payment is a residual risk |
| IDR is the only supported currency in the first slice                   | Current  | Currency behavior is absent from assessment             | Medium     | Money uses signed 64-bit minor units plus currency code                 |
| Refresh token is carried in an HttpOnly cookie                          | Current  | Assessment requires an explicit client-storage decision | Medium     | Access token stays in memory; refresh/logout need CSRF controls         |
| Opaque access and refresh tokens are used                               | Current  | Immediate logout and mass revocation are required       | Medium     | Server-side session lookup; JWT algorithm risks are avoided             |
| PostgreSQL is the authoritative database                                | Current  | Required locking, constraints, and concurrency proof    | High       | Real PostgreSQL is also used by integration tests                       |
| TypeScript and Fastify are the runtime/framework                        | Current  | `package.json`, `src/app.ts`, and executable build      | High       | Runtime, HTTP boundary, build, and tests are implemented                |
| Seller/admin provisioning is seed-only                                  | Current  | No provisioning endpoint exists in the required scope   | High       | Prevents unrequested privilege-management surface                       |
| Shipping, tax, commission, refund, and fulfillment are excluded         | Accepted | No contract or calculation rules are provided           | High       | Must be named explicitly as first-slice non-goals                       |

## Accepted decisions and residual risk

1. Runtime/framework: TypeScript + Fastify.
2. Multi-seller strategy: parent order plus seller sub-orders.
3. First-slice currency: IDR only.
4. Unpaid-order behavior remains an accepted residual risk for the time-boxed
   core; production requires reservation expiry and reconciliation.
