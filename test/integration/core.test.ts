import { createHmac, randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { CheckoutService } from '../../src/modules/checkout/checkout-service.js';
import { loadConfig, type AppConfig } from '../../src/platform/config.js';
import { createDatabasePool } from '../../src/platform/database.js';
import type { AppError } from '../../src/platform/errors.js';
import { createRedis } from '../../src/platform/redis.js';

const LAST_UNIT_PRODUCT_ID = '10000000-0000-4000-8000-000000000002';
const ALLOWED_ORIGIN = 'http://localhost:5173';

let app: FastifyInstance;
let pool: Pool;
let redis: Redis;
let config: AppConfig;

beforeAll(async () => {
  config = { ...loadConfig(), nodeEnv: 'test', databasePoolMax: 60 };
  pool = createDatabasePool(config);
  redis = createRedis(config);
  await redis.connect();
  app = await buildApp(config);
});

beforeEach(async () => {
  await redis.flushdb();
  await pool.query(`
    TRUNCATE TABLE
      audit_logs,
      payment_events,
      idempotency_records,
      order_items,
      seller_orders,
      payments,
      orders,
      cart_items,
      carts,
      access_tokens,
      refresh_tokens,
      session_families
    RESTART IDENTITY
  `);
  await pool.query(
    `UPDATE products
        SET stock_quantity = CASE WHEN id = $1 THEN 1 ELSE 5 END,
            version = version + 1,
            status = 'active',
            updated_at = now()`,
    [LAST_UNIT_PRODUCT_ID],
  );
});

afterAll(async () => {
  await app.close();
  await redis.quit();
  await pool.end();
});

describe('identity session lifecycle', () => {
  it('revokes a session family when a rotated refresh token is reused', async () => {
    const login = await loginAs('buyer@example.test', 'Buyer-Test-Password-2026!');
    const firstRefresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: login.refreshCookie, origin: ALLOWED_ORIGIN },
    });
    expect(firstRefresh.statusCode).toBe(200);
    const rotated = firstRefresh.json<{ access_token: string }>();
    const nextCookie = extractRefreshCookie(firstRefresh.headers['set-cookie']);

    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: login.refreshCookie, origin: ALLOWED_ORIGIN },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json<{ code: string }>().code).toBe('REFRESH_TOKEN_REUSE');

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${rotated.access_token}` },
    });
    expect(me.statusCode).toBe(401);

    const successorRefresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: nextCookie, origin: ALLOWED_ORIGIN },
    });
    expect(successorRefresh.statusCode).toBe(401);
  });

  it('makes an access token unusable immediately after logout', async () => {
    const login = await loginAs('buyer@example.test', 'Buyer-Test-Password-2026!');
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        authorization: `Bearer ${login.accessToken}`,
        cookie: login.refreshCookie,
        origin: ALLOWED_ORIGIN,
      },
    });
    expect(logout.statusCode).toBe(204);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    expect(me.statusCode).toBe(401);
  });
});

describe('object-level seller authorization', () => {
  it('does not let seller A update seller B product', async () => {
    const sellerB = await ensureSecondSeller();
    const productId = randomUUID();
    await pool.query(
      `INSERT INTO products
         (id, seller_id, name, category, price_minor, stock_quantity)
       VALUES ($1, $2, 'Seller B Product', 'console_game', 100000, 3)`,
      [productId, sellerB],
    );
    const login = await loginAs('seller@example.test', 'Seller-Test-Password-2026!');

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/seller/products/${productId}`,
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: { expected_version: 1, price: { amount_minor: 1, currency: 'IDR' } },
    });

    expect(response.statusCode).toBe(404);
    const unchanged = await pool.query<{ price_minor: string }>(
      'SELECT price_minor FROM products WHERE id = $1',
      [productId],
    );
    expect(Number(unchanged.rows[0]!.price_minor)).toBe(100000);
  });
});

describe('checkout correctness under concurrency', () => {
  it('does not oversell the final unit under fifty concurrent checkouts', async () => {
    const fixtures = await createCheckoutFixtures(50, LAST_UNIT_PRODUCT_ID);
    const checkout = new CheckoutService(pool, config);

    const results = await Promise.allSettled(
      fixtures.map((fixture) =>
        checkout.checkout({
          buyerId: fixture.buyerId,
          cartId: fixture.cartId,
          cartVersion: 1,
          idempotencyKey: `checkout-${fixture.buyerId}`,
          requestId: randomUUID(),
        }),
      ),
    );

    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(49);
    expect(
      failures.every(
        (result) =>
          result.status === 'rejected' && (result.reason as AppError).code === 'OUT_OF_STOCK',
      ),
    ).toBe(true);

    const state = await pool.query<{ stock_quantity: string; order_count: string }>(
      `SELECT p.stock_quantity,
              (SELECT count(*) FROM order_items oi WHERE oi.product_id = p.id) AS order_count
         FROM products p WHERE p.id = $1`,
      [LAST_UNIT_PRODUCT_ID],
    );
    expect(Number(state.rows[0]!.stock_quantity)).toBe(0);
    expect(Number(state.rows[0]!.order_count)).toBe(1);
  });

  it('returns one order for simultaneous retries with the same key', async () => {
    await pool.query('UPDATE products SET stock_quantity = 10 WHERE id = $1', [
      LAST_UNIT_PRODUCT_ID,
    ]);
    const [fixture] = await createCheckoutFixtures(1, LAST_UNIT_PRODUCT_ID);
    const checkout = new CheckoutService(pool, config);
    const input = {
      buyerId: fixture!.buyerId,
      cartId: fixture!.cartId,
      cartVersion: 1,
      idempotencyKey: `same-key-${randomUUID()}`,
      requestId: randomUUID(),
    };

    const results = await Promise.all(Array.from({ length: 20 }, () => checkout.checkout(input)));
    expect(new Set(results.map((result) => result.body.order_id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);

    const count = await pool.query<{ count: string }>(
      'SELECT count(*) FROM orders WHERE cart_id = $1',
      [fixture!.cartId],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });

  it('consumes a cart once even when different keys are used', async () => {
    await pool.query('UPDATE products SET stock_quantity = 10 WHERE id = $1', [
      LAST_UNIT_PRODUCT_ID,
    ]);
    const [fixture] = await createCheckoutFixtures(1, LAST_UNIT_PRODUCT_ID);
    const checkout = new CheckoutService(pool, config);
    const base = {
      buyerId: fixture!.buyerId,
      cartId: fixture!.cartId,
      cartVersion: 1,
      requestId: randomUUID(),
    };

    const results = await Promise.allSettled([
      checkout.checkout({ ...base, idempotencyKey: `key-a-${randomUUID()}` }),
      checkout.checkout({ ...base, idempotencyKey: `key-b-${randomUUID()}` }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const state = await pool.query<{ stock_quantity: string; order_count: string }>(
      `SELECT p.stock_quantity,
              (SELECT count(*) FROM orders WHERE cart_id = $2) AS order_count
         FROM products p WHERE p.id = $1`,
      [LAST_UNIT_PRODUCT_ID, fixture!.cartId],
    );
    expect(Number(state.rows[0]!.stock_quantity)).toBe(9);
    expect(Number(state.rows[0]!.order_count)).toBe(1);
  });
});

describe('payment webhook verification and idempotency', () => {
  it('accepts a valid event once and rejects altered or stale requests', async () => {
    await pool.query('UPDATE products SET stock_quantity = 5 WHERE id = $1', [
      LAST_UNIT_PRODUCT_ID,
    ]);
    const [fixture] = await createCheckoutFixtures(1, LAST_UNIT_PRODUCT_ID);
    const checkout = new CheckoutService(pool, config);
    const result = await checkout.checkout({
      buyerId: fixture!.buyerId,
      cartId: fixture!.cartId,
      cartVersion: 1,
      idempotencyKey: `webhook-${randomUUID()}`,
      requestId: randomUUID(),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      provider_event_id: `evt_${randomUUID()}`,
      payment_reference: result.body.payment_reference,
      status: 'paid',
      amount: result.body.total,
      occurred_at: new Date().toISOString(),
    });
    const signature = signWebhook(timestamp, body);

    const valid = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/payment',
      headers: {
        'content-type': 'application/json',
        'x-payment-timestamp': timestamp,
        'x-payment-signature': signature,
      },
      payload: body,
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json<{ duplicate: boolean }>().duplicate).toBe(false);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/payment',
      headers: {
        'content-type': 'application/json',
        'x-payment-timestamp': timestamp,
        'x-payment-signature': signature,
      },
      payload: body,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json<{ duplicate: boolean }>().duplicate).toBe(true);

    const altered = body.replace('"status":"paid"', '"status":"failed"');
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/payment',
      headers: {
        'content-type': 'application/json',
        'x-payment-timestamp': timestamp,
        'x-payment-signature': signature,
      },
      payload: altered,
    });
    expect(forged.statusCode).toBe(401);

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3_600);
    const stale = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/payment',
      headers: {
        'content-type': 'application/json',
        'x-payment-timestamp': staleTimestamp,
        'x-payment-signature': signWebhook(staleTimestamp, body),
      },
      payload: body,
    });
    expect(stale.statusCode).toBe(401);

    const payment = await pool.query<{ status: string }>(
      'SELECT status FROM payments WHERE payment_reference = $1',
      [result.body.payment_reference],
    );
    expect(payment.rows[0]!.status).toBe('paid');
  });
});

async function loginAs(email: string, password: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return {
    accessToken: response.json<{ access_token: string }>().access_token,
    refreshCookie: extractRefreshCookie(response.headers['set-cookie']),
  };
}

function extractRefreshCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('Refresh cookie was not set');
  return value.split(';', 1)[0]!;
}

async function ensureSecondSeller(): Promise<string> {
  const password = await pool.query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE email_normalized = 'seller@example.test'",
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email_normalized, password_hash, display_name)
     VALUES ('seller-two@example.test', $1, 'Seller Two')
     ON CONFLICT (email_normalized) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [password.rows[0]!.password_hash],
  );
  await pool.query(
    `INSERT INTO user_roles (user_id, role) VALUES ($1, 'buyer'), ($1, 'seller')
     ON CONFLICT DO NOTHING`,
    [user.rows[0]!.id],
  );
  const seller = await pool.query<{ id: string }>(
    `INSERT INTO sellers (owner_user_id, name)
     VALUES ($1, 'Second Game Store')
     ON CONFLICT (owner_user_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [user.rows[0]!.id],
  );
  return seller.rows[0]!.id;
}

async function createCheckoutFixtures(count: number, productId: string) {
  const password = await pool.query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE email_normalized = 'buyer@example.test'",
  );
  const fixtures: Array<{ buyerId: string; cartId: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const buyerId = randomUUID();
    const cartId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email_normalized, password_hash, display_name)
       VALUES ($1, $2, $3, $4)`,
      [
        buyerId,
        `concurrent-${buyerId}@example.test`,
        password.rows[0]!.password_hash,
        `Buyer ${index}`,
      ],
    );
    await pool.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'buyer')", [buyerId]);
    await pool.query('INSERT INTO carts (id, buyer_id) VALUES ($1, $2)', [cartId, buyerId]);
    await pool.query('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, 1)', [
      cartId,
      productId,
    ]);
    fixtures.push({ buyerId, cartId });
  }
  return fixtures;
}

function signWebhook(timestamp: string, body: string): string {
  return createHmac('sha256', config.webhookHmacSecret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest('hex');
}
