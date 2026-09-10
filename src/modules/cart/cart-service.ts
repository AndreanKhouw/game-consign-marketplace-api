import type { Pool, PoolClient } from 'pg';

import type { AppConfig } from '../../platform/config.js';
import { withTransaction } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';

interface CartRow {
  id: string;
  version: number;
  status: 'active' | 'checked_out';
}

interface CartItemRow {
  product_id: string;
  name: string;
  quantity: string;
  price_minor: string;
  currency: 'IDR';
}

export class CartService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  async addItem(buyerId: string, productId: string, quantity: number) {
    return withTransaction(this.pool, this.config.databaseLockTimeoutMs, async (client) => {
      const product = await client.query<{ id: string }>(
        `SELECT p.id
           FROM products p
           JOIN sellers s ON s.id = p.seller_id AND s.status = 'active'
          WHERE p.id = $1 AND p.status = 'active'`,
        [productId],
      );
      if (!product.rows[0]) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');

      const cartResult = await client.query<CartRow>(
        `INSERT INTO carts (buyer_id)
         VALUES ($1)
         ON CONFLICT (buyer_id) WHERE status = 'active'
         DO UPDATE SET updated_at = carts.updated_at
         RETURNING id, version, status`,
        [buyerId],
      );
      const cart = cartResult.rows[0]!;

      const itemResult = await client.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (cart_id, product_id)
         DO UPDATE SET
           quantity = cart_items.quantity + EXCLUDED.quantity,
           updated_at = now()
         WHERE cart_items.quantity + EXCLUDED.quantity <= 100
         RETURNING quantity`,
        [cart.id, productId, quantity],
      );
      if (itemResult.rowCount !== 1) {
        throw new AppError(409, 'CART_QUANTITY_LIMIT', 'Cart item quantity would exceed 100');
      }

      await client.query(
        `UPDATE carts
            SET version = version + 1, updated_at = now()
          WHERE id = $1`,
        [cart.id],
      );
      return this.getCart(client, cart.id);
    });
  }

  private async getCart(client: PoolClient, cartId: string) {
    const cartResult = await client.query<CartRow>(
      'SELECT id, version, status FROM carts WHERE id = $1',
      [cartId],
    );
    const cart = cartResult.rows[0]!;
    const items = await client.query<CartItemRow>(
      `SELECT ci.product_id, p.name, ci.quantity, p.price_minor, p.currency
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = $1
        ORDER BY ci.product_id`,
      [cartId],
    );
    return {
      id: cart.id,
      version: cart.version,
      status: cart.status,
      items: items.rows.map((item) => ({
        product_id: item.product_id,
        name: item.name,
        quantity: Number(item.quantity),
        current_price: { amount_minor: Number(item.price_minor), currency: item.currency },
      })),
    };
  }
}
