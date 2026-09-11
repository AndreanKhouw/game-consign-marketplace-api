import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { CatalogRepository } from '../../src/modules/catalog/catalog-repository.js';
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
  it('returns the same public error for a wrong password and an unknown account', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'buyer@example.test', password: 'definitely-wrong' },
    });
    const unknownAccount = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `unknown-${randomUUID()}@example.test`, password: 'definitely-wrong' },
    });

    for (const response of [wrongPassword, unknownAccount]) {
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string; detail: string }>()).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        detail: 'Email or password is invalid',
      });
    }

    const sessions = await pool.query<{ count: string }>('SELECT count(*) FROM session_families');
    expect(Number(sessions.rows[0]!.count)).toBe(0);
  });

  it('denies unauthenticated access when a route is not explicitly public', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('INVALID_SESSION');
  });

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

  it('invalidates every existing session after an auth-version change', async () => {
    const login = await loginAs('buyer@example.test', 'Buyer-Test-Password-2026!');
    await pool.query(
      `UPDATE users
          SET auth_version = auth_version + 1, updated_at = now()
        WHERE email_normalized = 'buyer@example.test'`,
    );

    const access = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: login.refreshCookie, origin: ALLOWED_ORIGIN },
    });

    expect(access.statusCode).toBe(401);
    expect(refresh.statusCode).toBe(401);
  });

  it('enforces the hard per-identity login limit', async () => {
    const email = `limited-${randomUUID()}@example.test`;
    const responses = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email, password: 'invalid-password' },
        }),
      );
    }

    expect(responses.slice(0, 10).every((response) => response.statusCode === 401)).toBe(true);
    expect(responses[10]!.statusCode).toBe(429);
    expect(responses[10]!.json<{ code: string }>().code).toBe('RATE_LIMITED');
  });
});

describe('buyer order authorization', () => {
  it('returns an order to its buyer but hides it from another buyer', async () => {
    const [ownerFixture, otherFixture] = await createCheckoutFixtures(2, LAST_UNIT_PRODUCT_ID);
    const checkout = new CheckoutService(pool, config);
    const result = await checkout.checkout({
      buyerId: ownerFixture!.buyerId,
      cartId: ownerFixture!.cartId,
      cartVersion: 1,
      idempotencyKey: `buyer-order-${randomUUID()}`,
      requestId: randomUUID(),
    });
    const owner = await loginAs(
      `concurrent-${ownerFixture!.buyerId}@example.test`,
      'Buyer-Test-Password-2026!',
    );
    const otherBuyer = await loginAs(
      `concurrent-${otherFixture!.buyerId}@example.test`,
      'Buyer-Test-Password-2026!',
    );

    const ownOrder = await app.inject({
      method: 'GET',
      url: `/v1/orders/${result.body.order_id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(ownOrder.statusCode).toBe(200);
    expect(ownOrder.json<{ id: string }>().id).toBe(result.body.order_id);

    const hiddenOrder = await app.inject({
      method: 'GET',
      url: `/v1/orders/${result.body.order_id}`,
      headers: { authorization: `Bearer ${otherBuyer.accessToken}` },
    });
    expect(hiddenOrder.statusCode).toBe(404);
    expect(hiddenOrder.json<{ code: string }>().code).toBe('ORDER_NOT_FOUND');
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

  it('rejects mass-assignment fields without changing product ownership or price', async () => {
    const login = await loginAs('seller@example.test', 'Seller-Test-Password-2026!');
    const before = await pool.query<{
      seller_id: string;
      price_minor: string;
      version: number;
    }>('SELECT seller_id, price_minor, version FROM products WHERE id = $1', [
      LAST_UNIT_PRODUCT_ID,
    ]);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/seller/products/${LAST_UNIT_PRODUCT_ID}`,
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: {
        expected_version: before.rows[0]!.version,
        price: { amount_minor: 1, currency: 'IDR' },
        seller_id: randomUUID(),
        status: 'archived',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
    const after = await pool.query<{
      seller_id: string;
      price_minor: string;
      version: number;
    }>('SELECT seller_id, price_minor, version FROM products WHERE id = $1', [
      LAST_UNIT_PRODUCT_ID,
    ]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('rejects a stale product version without applying the second update', async () => {
    const login = await loginAs('seller@example.test', 'Seller-Test-Password-2026!');
    const before = await pool.query<{ version: number; stock_quantity: string }>(
      'SELECT version, stock_quantity FROM products WHERE id = $1',
      [LAST_UNIT_PRODUCT_ID],
    );
    const staleVersion = before.rows[0]!.version;

    const firstUpdate = await app.inject({
      method: 'PATCH',
      url: `/v1/seller/products/${LAST_UNIT_PRODUCT_ID}`,
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: { expected_version: staleVersion, stock_adjustment: 0 },
    });
    expect(firstUpdate.statusCode).toBe(200);
    expect(firstUpdate.json<{ version: number }>().version).toBe(staleVersion + 1);

    const staleUpdate = await app.inject({
      method: 'PATCH',
      url: `/v1/seller/products/${LAST_UNIT_PRODUCT_ID}`,
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: {
        expected_version: staleVersion,
        stock_adjustment: 1,
      },
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json<{ code: string }>().code).toBe('VERSION_CONFLICT');

    const after = await pool.query<{ version: number; stock_quantity: string }>(
      'SELECT version, stock_quantity FROM products WHERE id = $1',
      [LAST_UNIT_PRODUCT_ID],
    );
    expect(after.rows[0]).toEqual({
      version: staleVersion + 1,
      stock_quantity: before.rows[0]!.stock_quantity,
    });
  });
});

describe('catalog query safety and pagination', () => {
  it('treats SQL injection text as a search value instead of executable SQL', async () => {
    const injection = "' OR 1=1 --";
    const response = await app.inject({
      method: 'GET',
      url: `/v1/products?q=${encodeURIComponent(injection)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toEqual([]);
    const products = await pool.query<{ count: string }>('SELECT count(*) FROM products');
    expect(Number(products.rows[0]!.count)).toBeGreaterThan(0);
  });

  it('paginates deterministically without duplicates and binds cursors to filters', async () => {
    const seller = await pool.query<{ id: string }>(
      `SELECT s.id
         FROM sellers s
         JOIN users u ON u.id = s.owner_user_id
        WHERE u.email_normalized = 'seller@example.test'`,
    );
    const category = `pagination-${randomUUID()}`;
    const productIds = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query(
      `INSERT INTO products
         (id, seller_id, name, category, price_minor, stock_quantity)
       VALUES
         ($1, $4, 'Pagination 100', $5, 100, 1),
         ($2, $4, 'Pagination 200', $5, 200, 1),
         ($3, $4, 'Pagination 300', $5, 300, 1)`,
      [...productIds, seller.rows[0]!.id, category],
    );

    try {
      const baseUrl = `/v1/products?category=${encodeURIComponent(category)}&sort=price_asc&limit=2`;
      const firstResponse = await app.inject({ method: 'GET', url: baseUrl });
      expect(firstResponse.statusCode).toBe(200);
      const first = firstResponse.json<{
        items: Array<{ id: string; price: { amount_minor: number } }>;
        next_cursor: string | null;
        has_more: boolean;
      }>();
      expect(first.items.map((item) => item.price.amount_minor)).toEqual([100, 200]);
      expect(first.has_more).toBe(true);
      expect(first.next_cursor).toEqual(expect.any(String));

      const secondResponse = await app.inject({
        method: 'GET',
        url: `${baseUrl}&cursor=${encodeURIComponent(first.next_cursor!)}`,
      });
      expect(secondResponse.statusCode).toBe(200);
      const second = secondResponse.json<{
        items: Array<{ id: string; price: { amount_minor: number } }>;
        next_cursor: string | null;
        has_more: boolean;
      }>();
      expect(second.items.map((item) => item.price.amount_minor)).toEqual([300]);
      expect(second.has_more).toBe(false);
      expect(second.next_cursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);

      const mismatchedFilter = await app.inject({
        method: 'GET',
        url: `/v1/products?category=other&sort=price_asc&limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`,
      });
      expect(mismatchedFilter.statusCode).toBe(400);
      expect(mismatchedFilter.json<{ code: string }>().code).toBe('INVALID_CURSOR');
    } finally {
      await pool.query('DELETE FROM products WHERE id = ANY($1::uuid[])', [productIds]);
    }
  });

  it('uses one catalog query for both small and multi-item result sets', async () => {
    const catalog = new CatalogRepository(pool);
    const querySpy = vi.spyOn(pool, 'query');

    try {
      const single = await catalog.list({ sort: 'created_at_desc', limit: 1 });
      expect(single.items).toHaveLength(1);
      expect(querySpy).toHaveBeenCalledTimes(1);

      querySpy.mockClear();
      const multiple = await catalog.list({ sort: 'created_at_desc', limit: 100 });
      expect(multiple.items.length).toBeGreaterThan(1);
      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy.mockRestore();
    }
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

  it('rolls back every stock change when one item is unavailable', async () => {
    const sellerId = await getSeedSellerId();
    const availableId = '00000000-0000-4000-8000-000000000101';
    const unavailableId = 'ffffffff-ffff-4fff-8fff-fffffffff101';
    await pool.query('DELETE FROM products WHERE id = ANY($1::uuid[])', [
      [availableId, unavailableId],
    ]);
    await pool.query(
      `INSERT INTO products
         (id, seller_id, name, category, price_minor, stock_quantity)
       VALUES
         ($1, $3, 'Available rollback item', 'rollback', 1000, 5),
         ($2, $3, 'Unavailable rollback item', 'rollback', 1000, 0)`,
      [availableId, unavailableId, sellerId],
    );
    const [fixture] = await createCheckoutFixtures(1, availableId);
    await pool.query('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, 1)', [
      fixture!.cartId,
      unavailableId,
    ]);

    try {
      const checkout = new CheckoutService(pool, config);
      await expect(
        checkout.checkout({
          buyerId: fixture!.buyerId,
          cartId: fixture!.cartId,
          cartVersion: 1,
          idempotencyKey: `rollback-${randomUUID()}`,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });

      const state = await pool.query<{ id: string; stock_quantity: string }>(
        'SELECT id, stock_quantity FROM products WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[availableId, unavailableId]],
      );
      expect(state.rows.map((row) => Number(row.stock_quantity))).toEqual([5, 0]);
      const orders = await pool.query<{ count: string }>(
        'SELECT count(*) FROM orders WHERE cart_id = $1',
        [fixture!.cartId],
      );
      expect(Number(orders.rows[0]!.count)).toBe(0);
    } finally {
      await pool.query('DELETE FROM carts WHERE id = $1', [fixture!.cartId]);
      await pool.query('DELETE FROM products WHERE id = ANY($1::uuid[])', [
        [availableId, unavailableId],
      ]);
    }
  });

  it('rolls back checkout when the aggregate amount exceeds the safe integer boundary', async () => {
    const sellerId = await getSeedSellerId();
    const category = `amt-${randomUUID()}`;
    const products = await pool.query<{ id: string }>(
      `INSERT INTO products (seller_id, name, category, price_minor, stock_quantity)
       SELECT $1, 'Boundary item ' || n, $2, 1000000000000, 100
         FROM generate_series(1, 91) AS n
       RETURNING id`,
      [sellerId, category],
    );
    const productIds = products.rows.map((row) => row.id);
    const [fixture] = await createCheckoutFixtures(1, productIds[0]!);
    await pool.query('UPDATE cart_items SET quantity = 100 WHERE cart_id = $1', [fixture!.cartId]);
    await pool.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity)
       SELECT $1, unnest($2::uuid[]), 100`,
      [fixture!.cartId, productIds.slice(1)],
    );

    try {
      const checkout = new CheckoutService(pool, config);
      await expect(
        checkout.checkout({
          buyerId: fixture!.buyerId,
          cartId: fixture!.cartId,
          cartVersion: 1,
          idempotencyKey: `amount-boundary-${randomUUID()}`,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });

      const state = await pool.query<{ stock: string; orders: string }>(
        `SELECT sum(stock_quantity)::text AS stock,
                (SELECT count(*) FROM orders WHERE cart_id = $1)::text AS orders
           FROM products WHERE category = $2`,
        [fixture!.cartId, category],
      );
      expect(Number(state.rows[0]!.stock)).toBe(9_100);
      expect(Number(state.rows[0]!.orders)).toBe(0);
    } finally {
      await pool.query('DELETE FROM carts WHERE id = $1', [fixture!.cartId]);
      await pool.query('DELETE FROM products WHERE category = $1', [category]);
    }
  });

  it('rejects one idempotency key reused with a different checkout request', async () => {
    await pool.query('UPDATE products SET stock_quantity = 5 WHERE id = $1', [
      LAST_UNIT_PRODUCT_ID,
    ]);
    const [fixture] = await createCheckoutFixtures(1, LAST_UNIT_PRODUCT_ID);
    const checkout = new CheckoutService(pool, config);
    const key = `payload-conflict-${randomUUID()}`;
    await checkout.checkout({
      buyerId: fixture!.buyerId,
      cartId: fixture!.cartId,
      cartVersion: 1,
      idempotencyKey: key,
      requestId: randomUUID(),
    });

    await expect(
      checkout.checkout({
        buyerId: fixture!.buyerId,
        cartId: fixture!.cartId,
        cartVersion: 2,
        idempotencyKey: key,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
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

  it('rejects a provider event ID reused with different signed content', async () => {
    const pending = await createPendingPayment();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const eventId = `evt_${randomUUID()}`;
    const firstBody = paymentEventBody(pending, eventId, 'paid');
    const first = await injectSignedWebhook(timestamp, firstBody);
    expect(first.statusCode).toBe(200);

    const conflictingBody = JSON.stringify({
      ...JSON.parse(firstBody),
      occurred_at: new Date(Date.now() + 1_000).toISOString(),
    });
    const conflict = await injectSignedWebhook(timestamp, conflictingBody);

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ code: string }>().code).toBe('PAYMENT_EVENT_CONFLICT');
    const events = await pool.query<{ count: string }>(
      'SELECT count(*) FROM payment_events WHERE provider_event_id = $1',
      [eventId],
    );
    expect(Number(events.rows[0]!.count)).toBe(1);
  });

  it('rejects a terminal payment reversal and rolls the event back', async () => {
    const pending = await createPendingPayment();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const paidEventId = `evt_${randomUUID()}`;
    const failedEventId = `evt_${randomUUID()}`;
    expect(
      (await injectSignedWebhook(timestamp, paymentEventBody(pending, paidEventId, 'paid')))
        .statusCode,
    ).toBe(200);

    const reversal = await injectSignedWebhook(
      timestamp,
      paymentEventBody(pending, failedEventId, 'failed'),
    );
    expect(reversal.statusCode).toBe(409);
    expect(reversal.json<{ code: string }>().code).toBe('ILLEGAL_PAYMENT_TRANSITION');

    const state = await pool.query<{
      payment_status: string;
      order_status: string;
      events: string;
    }>(
      `SELECT p.status AS payment_status, o.status AS order_status,
              (SELECT count(*) FROM payment_events WHERE provider_event_id = $2)::text AS events
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.payment_reference = $1`,
      [pending.payment_reference, failedEventId],
    );
    expect(state.rows[0]).toEqual({ payment_status: 'paid', order_status: 'paid', events: '0' });
  });
});

describe('route and operational readiness', () => {
  it('supports the complete route-level buyer and seller happy path', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);

    const seller = await loginAs('seller@example.test', 'Seller-Test-Password-2026!');
    const created = await app.inject({
      method: 'POST',
      url: '/v1/seller/products',
      headers: { authorization: `Bearer ${seller.accessToken}` },
      payload: {
        name: `Happy path ${randomUUID()}`,
        category: 'assessment-proof',
        price: { amount_minor: 125_000, currency: 'IDR' },
        stock_quantity: 2,
      },
    });
    expect(created.statusCode).toBe(201);
    const product = created.json<{ id: string }>();
    expect(
      (await app.inject({ method: 'GET', url: `/v1/products/${product.id}` })).statusCode,
    ).toBe(200);

    const buyerEmail = `happy-${randomUUID()}@example.test`;
    const buyerPassword = 'Happy-Path-Password-2026!';
    const registration = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: buyerEmail, password: buyerPassword, display_name: 'Happy Buyer' },
    });
    expect(registration.statusCode).toBe(202);
    const buyer = await loginAs(buyerEmail, buyerPassword);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${buyer.accessToken}` },
    });
    expect(me.statusCode).toBe(200);

    const cartResponse = await app.inject({
      method: 'POST',
      url: '/v1/cart/items',
      headers: { authorization: `Bearer ${buyer.accessToken}` },
      payload: { product_id: product.id, quantity: 1 },
    });
    expect(cartResponse.statusCode).toBe(200);
    const cart = cartResponse.json<{ id: string; version: number }>();
    const checkoutResponse = await app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: {
        authorization: `Bearer ${buyer.accessToken}`,
        'idempotency-key': `happy-path-${randomUUID()}`,
      },
      payload: { cart_id: cart.id, cart_version: cart.version },
    });
    expect(checkoutResponse.statusCode).toBe(201);

    const sellerOrders = await app.inject({
      method: 'GET',
      url: '/v1/seller/orders',
      headers: { authorization: `Bearer ${seller.accessToken}` },
    });
    expect(sellerOrders.statusCode).toBe(200);
    expect(
      sellerOrders
        .json<{ items: Array<{ items: Array<{ product_id: string }> }> }>()
        .items.some((order) => order.items.some((item) => item.product_id === product.id)),
    ).toBe(true);
  });

  it('has an executable Fastify route for every OpenAPI operation', async () => {
    const contract = await readFile(new URL('../../openapi.yaml', import.meta.url), 'utf8');
    const operations = extractOpenApiOperations(contract);
    expect(operations).toHaveLength(16);
    for (const operation of operations) {
      expect(
        app.hasRoute({
          method: operation.method,
          url: operation.path.replace(/\{([^}]+)\}/g, ':$1'),
        }),
        `${operation.method} ${operation.path} is documented but not registered`,
      ).toBe(true);
    }
  });

  it('redacts credentials and secrets from structured logs', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: unknown, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const isolatedApp = await buildApp(config, { loggerStream: stream });
    const secrets = {
      password: 'log-secret-password',
      access_token: 'log-secret-access',
      refresh_token: 'log-secret-refresh',
      authorization: 'Bearer log-secret-authorization',
      cookie: 'refresh_token=log-secret-cookie',
      signature: 'a'.repeat(64),
    };
    try {
      isolatedApp.log.info(
        {
          password: secrets.password,
          access_token: secrets.access_token,
          refresh_token: secrets.refresh_token,
          authorization: secrets.authorization,
          cookie: secrets.cookie,
          req: { headers: { 'x-payment-signature': secrets.signature } },
        },
        'redaction regression probe',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await isolatedApp.close();
    }

    const output = chunks.join('');
    for (const secret of Object.values(secrets)) expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
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

async function getSeedSellerId(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT s.id
       FROM sellers s
       JOIN users u ON u.id = s.owner_user_id
      WHERE u.email_normalized = 'seller@example.test'`,
  );
  return result.rows[0]!.id;
}

async function createPendingPayment(): Promise<{
  payment_reference: string;
  total: { amount_minor: number; currency: 'IDR' };
}> {
  await pool.query('UPDATE products SET stock_quantity = 5 WHERE id = $1', [LAST_UNIT_PRODUCT_ID]);
  const [fixture] = await createCheckoutFixtures(1, LAST_UNIT_PRODUCT_ID);
  const result = await new CheckoutService(pool, config).checkout({
    buyerId: fixture!.buyerId,
    cartId: fixture!.cartId,
    cartVersion: 1,
    idempotencyKey: `webhook-helper-${randomUUID()}`,
    requestId: randomUUID(),
  });
  return { payment_reference: result.body.payment_reference, total: result.body.total };
}

function paymentEventBody(
  pending: { payment_reference: string; total: { amount_minor: number; currency: 'IDR' } },
  eventId: string,
  status: 'paid' | 'failed',
): string {
  return JSON.stringify({
    provider_event_id: eventId,
    payment_reference: pending.payment_reference,
    status,
    amount: pending.total,
    occurred_at: new Date().toISOString(),
  });
}

function injectSignedWebhook(timestamp: string, body: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/payment',
    headers: {
      'content-type': 'application/json',
      'x-payment-timestamp': timestamp,
      'x-payment-signature': signWebhook(timestamp, body),
    },
    payload: body,
  });
}

function extractOpenApiOperations(source: string): Array<{
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
}> {
  const operations: Array<{
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    path: string;
  }> = [];
  let currentPath: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const path = /^ {2}(\/[^:]+):\s*$/.exec(line);
    if (path) {
      currentPath = path[1];
      continue;
    }
    const method = /^ {4}(get|post|patch|put|delete):\s*$/.exec(line);
    if (currentPath && method) {
      operations.push({
        method: method[1]!.toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        path: currentPath,
      });
    }
  }
  return operations;
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
