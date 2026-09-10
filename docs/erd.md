# Entity Relationship Diagram

Status: **Implemented** by `migrations/001_initial.sql`; this diagram is the
review-oriented view of the executable PostgreSQL schema.

```mermaid
erDiagram
    USERS ||--o{ USER_ROLES : has
    USERS ||--o{ SESSION_FAMILIES : owns
    SESSION_FAMILIES ||--o{ ACCESS_TOKENS : issues
    SESSION_FAMILIES ||--o{ REFRESH_TOKENS : rotates

    USERS ||--o| SELLERS : operates
    SELLERS ||--o{ PRODUCTS : owns

    USERS ||--o{ CARTS : owns
    CARTS ||--o{ CART_ITEMS : contains
    PRODUCTS ||--o{ CART_ITEMS : references

    CARTS ||--o| ORDERS : checked_out_as
    USERS ||--o{ ORDERS : purchases
    ORDERS ||--o{ SELLER_ORDERS : splits_into
    SELLERS ||--o{ SELLER_ORDERS : fulfills
    SELLER_ORDERS ||--o{ ORDER_ITEMS : contains
    PRODUCTS ||--o{ ORDER_ITEMS : snapshots

    ORDERS ||--|| PAYMENTS : paid_by
    PAYMENTS ||--o{ PAYMENT_EVENTS : receives

    USERS ||--o{ IDEMPOTENCY_RECORDS : scopes
    USERS ||--o{ AUDIT_LOGS : acts

    USERS {
      uuid id PK
      text email_normalized UK
      text password_hash
      text display_name
      text status
      int auth_version
      timestamptz created_at
      timestamptz updated_at
    }

    USER_ROLES {
      uuid user_id FK
      text role
      timestamptz created_at
    }

    SESSION_FAMILIES {
      uuid id PK
      uuid user_id FK
      int auth_version
      timestamptz expires_at
      timestamptz revoked_at
      text revoke_reason
      timestamptz created_at
    }

    ACCESS_TOKENS {
      uuid id PK
      uuid session_family_id FK
      bytea token_hash UK
      timestamptz expires_at
      timestamptz revoked_at
      timestamptz created_at
    }

    REFRESH_TOKENS {
      uuid id PK
      uuid session_family_id FK
      bytea token_hash UK
      uuid replaced_by_id FK
      timestamptz used_at
      timestamptz expires_at
      timestamptz created_at
    }

    SELLERS {
      uuid id PK
      uuid owner_user_id FK
      text name
      text status
      timestamptz created_at
    }

    PRODUCTS {
      uuid id PK
      uuid seller_id FK
      text name
      text description
      text category
      bigint price_minor
      char currency
      bigint stock_quantity
      int version
      text status
      timestamptz created_at
      timestamptz updated_at
    }

    CARTS {
      uuid id PK
      uuid buyer_id FK
      text status
      int version
      timestamptz created_at
      timestamptz updated_at
      timestamptz checked_out_at
    }

    CART_ITEMS {
      uuid cart_id FK
      uuid product_id FK
      bigint quantity
      timestamptz created_at
      timestamptz updated_at
    }

    ORDERS {
      uuid id PK
      uuid buyer_id FK
      uuid cart_id FK
      text status
      bigint total_minor
      char currency
      timestamptz created_at
      timestamptz updated_at
    }

    SELLER_ORDERS {
      uuid id PK
      uuid order_id FK
      uuid seller_id FK
      text seller_name_snapshot
      text status
      bigint subtotal_minor
      char currency
      timestamptz created_at
    }

    ORDER_ITEMS {
      uuid id PK
      uuid seller_order_id FK
      uuid product_id FK
      text product_name_snapshot
      bigint unit_price_minor
      bigint quantity
      bigint line_total_minor
      char currency
      timestamptz created_at
    }

    PAYMENTS {
      uuid id PK
      uuid order_id FK
      text payment_reference UK
      text status
      bigint amount_minor
      char currency
      timestamptz created_at
      timestamptz updated_at
    }

    PAYMENT_EVENTS {
      uuid id PK
      uuid payment_id FK
      text provider_event_id UK
      bytea payload_hash
      text event_status
      timestamptz provider_occurred_at
      timestamptz received_at
      timestamptz processed_at
    }

    IDEMPOTENCY_RECORDS {
      uuid id PK
      uuid actor_user_id FK
      text operation
      text idempotency_key
      bytea request_fingerprint
      text status
      int response_status
      jsonb response_body
      timestamptz expires_at
      timestamptz created_at
      timestamptz updated_at
    }

    AUDIT_LOGS {
      bigint id PK
      uuid actor_user_id FK
      text action
      text target_type
      uuid target_id
      text outcome
      uuid request_id
      jsonb safe_metadata
      timestamptz created_at
    }
```

## Required constraints not fully expressible in the diagram

- Partial unique index: one `active` cart per buyer.
- Unique `(cart_id, product_id)` for cart items.
- Unique `orders.cart_id`.
- Unique `(order_id, seller_id)` for seller orders.
- Unique `(actor_user_id, operation, idempotency_key)`.
- Unique `(user_id, role)`.
- Checks: price and stock are non-negative; quantities are positive; supported
  currency is `IDR`; totals are non-negative.
- Foreign key `refresh_tokens.replaced_by_id` references another refresh token and
  cannot point to itself.

The migration implements indexes derived from the catalog, ownership, session,
checkout, payment-event, idempotency, and audit query shapes.
