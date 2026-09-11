import { setTimeout as delay } from 'node:timers/promises';

import type { Pool, PoolClient } from 'pg';

import { appendAudit } from '../audit/audit-repository.js';
import type { AppConfig } from '../../platform/config.js';
import { canonicalFingerprint, randomReference } from '../../platform/crypto.js';
import { withTransaction } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { calculateLineTotal, calculateOrderTotal } from './checkout-domain.js';

interface CheckoutInput {
  buyerId: string;
  cartId: string;
  cartVersion: number;
  idempotencyKey: string;
  requestId: string;
}

interface CheckoutBody {
  order_id: string;
  order_status: 'pending_payment';
  payment_reference: string;
  total: { amount_minor: number; currency: 'IDR' };
  created_at: string;
}

interface CheckoutSuccess {
  kind: 'success';
  body: CheckoutBody;
  replayed: boolean;
}

interface CheckoutFailure {
  kind: 'failure';
  error: AppError;
}

type CheckoutOutcome = CheckoutSuccess | CheckoutFailure;

interface IdempotencyRow {
  request_fingerprint: string;
  status: 'processing' | 'completed';
  response_status: number | null;
  response_body: CheckoutBody | { error: { status: number; code: string; message: string } } | null;
}

interface CheckoutItem {
  product_id: string;
  quantity: string;
}

interface LockedProduct {
  id: string;
  seller_id: string;
  seller_name: string;
  name: string;
  price_minor: string;
  currency: 'IDR';
}

export class CheckoutService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  async checkout(input: CheckoutInput): Promise<CheckoutSuccess> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const outcome = await this.checkoutAttempt(input);
        if (outcome.kind === 'failure') throw outcome.error;
        return outcome;
      } catch (error) {
        if (isRetryableTransactionError(error) && attempt < 2) {
          await delay(15 + Math.floor(Math.random() * 35));
          continue;
        }
        throw error;
      }
    }
    throw new AppError(503, 'CHECKOUT_UNAVAILABLE', 'Checkout is temporarily unavailable');
  }

  private async checkoutAttempt(input: CheckoutInput): Promise<CheckoutOutcome> {
    const fingerprint = canonicalFingerprint({
      cart_id: input.cartId,
      cart_version: input.cartVersion,
    });

    return withTransaction(this.pool, this.config.databaseLockTimeoutMs, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO idempotency_records
           (actor_user_id, operation, idempotency_key, request_fingerprint,
            status, expires_at)
         VALUES ($1, 'checkout', $2, $3, 'processing', now() + interval '24 hours')
         ON CONFLICT (actor_user_id, operation, idempotency_key) DO NOTHING
         RETURNING id`,
        [input.buyerId, input.idempotencyKey, fingerprint],
      );

      if (!inserted.rows[0]) {
        const existingResult = await client.query<IdempotencyRow>(
          `SELECT request_fingerprint, status, response_status, response_body
             FROM idempotency_records
            WHERE actor_user_id = $1
              AND operation = 'checkout'
              AND idempotency_key = $2
            FOR UPDATE`,
          [input.buyerId, input.idempotencyKey],
        );
        const existing = existingResult.rows[0];
        if (!existing) throw new Error('Idempotency conflict resolved without a record');
        if (existing.request_fingerprint !== fingerprint) {
          return {
            kind: 'failure',
            error: new AppError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency key was already used with another request',
            ),
          };
        }
        if (existing.status !== 'completed' || !existing.response_body) {
          return {
            kind: 'failure',
            error: new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Checkout is still processing'),
          };
        }
        if ('error' in existing.response_body) {
          const stored = existing.response_body.error;
          return {
            kind: 'failure',
            error: new AppError(stored.status, stored.code, stored.message),
          };
        }
        return { kind: 'success', body: existing.response_body, replayed: true };
      }

      await client.query('SAVEPOINT checkout_work');
      try {
        const body = await this.createOrder(client, input);
        await client.query(
          `UPDATE idempotency_records
              SET status = 'completed', response_status = 201,
                  response_body = $4::jsonb, updated_at = now()
            WHERE actor_user_id = $1 AND operation = 'checkout' AND idempotency_key = $2
              AND request_fingerprint = $3`,
          [input.buyerId, input.idempotencyKey, fingerprint, JSON.stringify(body)],
        );
        await client.query('RELEASE SAVEPOINT checkout_work');
        return { kind: 'success', body, replayed: false };
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode >= 500) throw error;
        await client.query('ROLLBACK TO SAVEPOINT checkout_work');
        const stored = {
          error: { status: error.statusCode, code: error.code, message: error.message },
        };
        await client.query(
          `UPDATE idempotency_records
              SET status = 'completed', response_status = $4,
                  response_body = $5::jsonb, updated_at = now()
            WHERE actor_user_id = $1 AND operation = 'checkout' AND idempotency_key = $2
              AND request_fingerprint = $3`,
          [
            input.buyerId,
            input.idempotencyKey,
            fingerprint,
            error.statusCode,
            JSON.stringify(stored),
          ],
        );
        await client.query('RELEASE SAVEPOINT checkout_work');
        return { kind: 'failure', error };
      }
    });
  }

  private async createOrder(client: PoolClient, input: CheckoutInput): Promise<CheckoutBody> {
    const cartResult = await client.query<{ id: string; version: number; status: string }>(
      `SELECT id, version, status
         FROM carts
        WHERE id = $1 AND buyer_id = $2
        FOR UPDATE`,
      [input.cartId, input.buyerId],
    );
    const cart = cartResult.rows[0];
    if (!cart) throw new AppError(404, 'CART_NOT_FOUND', 'Cart not found');
    if (cart.status !== 'active') {
      throw new AppError(409, 'CART_ALREADY_CHECKED_OUT', 'Cart was already checked out');
    }
    if (cart.version !== input.cartVersion) {
      throw new AppError(409, 'CART_VERSION_CONFLICT', 'Cart version has changed');
    }

    const itemResult = await client.query<CheckoutItem>(
      `SELECT product_id, quantity
         FROM cart_items
        WHERE cart_id = $1
        ORDER BY product_id`,
      [cart.id],
    );
    if (itemResult.rows.length === 0) {
      throw new AppError(409, 'EMPTY_CART', 'Cart has no items');
    }

    const lockedProducts: Array<LockedProduct & { quantity: number; lineTotal: number }> = [];
    for (const item of itemResult.rows) {
      const quantity = Number(item.quantity);
      const productResult = await client.query<LockedProduct>(
        `UPDATE products p
            SET stock_quantity = p.stock_quantity - $2,
                version = p.version + 1,
                updated_at = now()
           FROM sellers s
          WHERE p.id = $1
            AND s.id = p.seller_id
            AND p.status = 'active'
            AND s.status = 'active'
            AND p.stock_quantity >= $2
          RETURNING p.id, p.seller_id, s.name AS seller_name, p.name,
                    p.price_minor, p.currency`,
        [item.product_id, quantity],
      );
      const product = productResult.rows[0];
      if (!product) {
        throw new AppError(409, 'OUT_OF_STOCK', 'One or more products are unavailable');
      }
      const lineTotal = calculateLineTotal(Number(product.price_minor), quantity);
      if (!lineTotal.ok) {
        throw new AppError(409, 'AMOUNT_OUT_OF_RANGE', 'Order amount is outside supported range');
      }
      lockedProducts.push({ ...product, quantity, lineTotal: lineTotal.amountMinor });
    }

    const total = calculateOrderTotal(lockedProducts.map((item) => item.lineTotal));
    if (!total.ok) {
      throw new AppError(409, 'AMOUNT_OUT_OF_RANGE', 'Order amount is outside supported range');
    }

    const orderResult = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO orders (buyer_id, cart_id, total_minor, currency)
       VALUES ($1, $2, $3, 'IDR')
       RETURNING id, created_at`,
      [input.buyerId, cart.id, total.amountMinor],
    );
    const order = orderResult.rows[0]!;

    const grouped = new Map<string, { sellerName: string; items: typeof lockedProducts }>();
    for (const product of lockedProducts) {
      const group = grouped.get(product.seller_id) ?? {
        sellerName: product.seller_name,
        items: [],
      };
      group.items.push(product);
      grouped.set(product.seller_id, group);
    }

    for (const [sellerId, group] of grouped) {
      const subtotal = group.items.reduce((sum, item) => sum + item.lineTotal, 0);
      const sellerOrderResult = await client.query<{ id: string }>(
        `INSERT INTO seller_orders
           (order_id, seller_id, seller_name_snapshot, subtotal_minor, currency)
         VALUES ($1, $2, $3, $4, 'IDR')
         RETURNING id`,
        [order.id, sellerId, group.sellerName, subtotal],
      );
      const sellerOrderId = sellerOrderResult.rows[0]!.id;
      for (const item of group.items) {
        await client.query(
          `INSERT INTO order_items
             (seller_order_id, product_id, product_name_snapshot, unit_price_minor,
              quantity, line_total_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'IDR')`,
          [
            sellerOrderId,
            item.id,
            item.name,
            Number(item.price_minor),
            item.quantity,
            item.lineTotal,
          ],
        );
      }
    }

    const paymentReference = randomReference('pay');
    await client.query(
      `INSERT INTO payments (order_id, payment_reference, amount_minor, currency)
       VALUES ($1, $2, $3, 'IDR')`,
      [order.id, paymentReference, total.amountMinor],
    );
    await client.query(
      `UPDATE carts
          SET status = 'checked_out', checked_out_at = now(), updated_at = now()
        WHERE id = $1`,
      [cart.id],
    );
    await appendAudit(client, {
      actorUserId: input.buyerId,
      action: 'checkout.order_create',
      targetType: 'order',
      targetId: order.id,
      outcome: 'success',
      requestId: input.requestId,
      safeMetadata: { cart_id: cart.id, amount_minor: total.amountMinor, currency: 'IDR' },
    });

    return {
      order_id: order.id,
      order_status: 'pending_payment',
      payment_reference: paymentReference,
      total: { amount_minor: total.amountMinor, currency: 'IDR' },
      created_at: order.created_at.toISOString(),
    };
  }
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === '40P01' || error.code === '40001';
}
