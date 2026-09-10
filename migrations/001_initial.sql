CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email_normalized = lower(btrim(email_normalized))),
  CHECK (char_length(email_normalized) BETWEEN 3 AND 254),
  CHECK (char_length(display_name) BETWEEN 1 AND 100)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('buyer', 'seller', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sellers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_version integer NOT NULL CHECK (auth_version >= 1),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);

CREATE INDEX session_families_user_active_idx
  ON session_families (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_family_id uuid NOT NULL REFERENCES session_families(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX access_tokens_family_active_idx
  ON access_tokens (session_family_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_family_id uuid NOT NULL REFERENCES session_families(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  replaced_by_id uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  used_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (replaced_by_id IS NULL OR replaced_by_id <> id)
);

CREATE INDEX refresh_tokens_family_idx
  ON refresh_tokens (session_family_id, expires_at);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 50),
  image_url text CHECK (image_url IS NULL OR char_length(image_url) <= 2048),
  price_minor bigint NOT NULL CHECK (price_minor BETWEEN 0 AND 1000000000000),
  currency char(3) NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  stock_quantity bigint NOT NULL CHECK (stock_quantity BETWEEN 0 AND 1000000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_active_created_idx
  ON products (created_at DESC, id DESC) WHERE status = 'active';
CREATE INDEX products_active_price_asc_idx
  ON products (price_minor ASC, id ASC) WHERE status = 'active';
CREATE INDEX products_active_price_desc_idx
  ON products (price_minor DESC, id DESC) WHERE status = 'active';
CREATE INDEX products_active_category_created_idx
  ON products (category, created_at DESC, id DESC) WHERE status = 'active';
CREATE INDEX products_seller_idx
  ON products (seller_id, created_at DESC, id DESC);

CREATE TABLE carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'checked_out')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  checked_out_at timestamptz,
  CHECK ((status = 'active' AND checked_out_at IS NULL)
    OR (status = 'checked_out' AND checked_out_at IS NOT NULL))
);

CREATE UNIQUE INDEX carts_one_active_per_buyer_idx
  ON carts (buyer_id) WHERE status = 'active';

CREATE TABLE cart_items (
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cart_id uuid NOT NULL UNIQUE REFERENCES carts(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'payment_failed')),
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 0 AND 9000000000000000),
  currency char(3) NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_buyer_created_idx
  ON orders (buyer_id, created_at DESC, id DESC);

CREATE TABLE seller_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
  seller_name_snapshot text NOT NULL,
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'payment_failed')),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor BETWEEN 0 AND 9000000000000000),
  currency char(3) NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seller_id)
);

CREATE INDEX seller_orders_seller_created_idx
  ON seller_orders (seller_id, created_at DESC, id DESC);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_order_id uuid NOT NULL REFERENCES seller_orders(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name_snapshot text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 1000000000000),
  quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  line_total_minor bigint NOT NULL CHECK (line_total_minor BETWEEN 0 AND 9000000000000000),
  currency char(3) NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_order_id, product_id),
  CHECK (line_total_minor = unit_price_minor * quantity)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  payment_reference text NOT NULL UNIQUE
    CHECK (char_length(payment_reference) BETWEEN 16 AND 100),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9000000000000000),
  currency char(3) NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider_event_id text NOT NULL UNIQUE
    CHECK (char_length(provider_event_id) BETWEEN 8 AND 128),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  event_status text NOT NULL CHECK (event_status IN ('paid', 'failed')),
  provider_occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  response_status integer CHECK (response_status BETWEEN 200 AND 499),
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, operation, idempotency_key),
  CHECK ((status = 'processing' AND response_status IS NULL AND response_body IS NULL)
    OR (status = 'completed' AND response_status IS NOT NULL AND response_body IS NOT NULL))
);

CREATE INDEX idempotency_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
  target_type text NOT NULL CHECK (char_length(target_type) BETWEEN 1 AND 100),
  target_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  request_id uuid NOT NULL,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_target_idx
  ON audit_logs (target_type, target_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx
  ON audit_logs (actor_user_id, created_at DESC);
