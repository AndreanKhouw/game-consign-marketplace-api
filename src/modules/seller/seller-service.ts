import type { Pool } from 'pg';

import { appendAudit } from '../audit/audit-repository.js';
import type { AppConfig } from '../../platform/config.js';
import { withTransaction } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { decodeCursor, encodeCursor } from '../../platform/pagination.js';

interface ProductInput {
  name: string;
  description?: string;
  category: string;
  imageUrl?: string;
  priceMinor: number;
  stockQuantity: number;
}

interface ProductUpdate {
  expectedVersion: number;
  name?: string;
  description?: string;
  category?: string;
  imageUrl?: string;
  priceMinor?: number;
  stockAdjustment?: number;
}

interface ProductRow {
  id: string;
  seller_id: string;
  seller_name: string;
  name: string;
  description: string;
  category: string;
  image_url: string | null;
  price_minor: string;
  currency: 'IDR';
  stock_quantity: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export class SellerService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  async createProduct(
    sellerId: string,
    actorUserId: string,
    input: ProductInput,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    validateImageUrl(input.imageUrl);
    return withTransaction(this.pool, this.config.databaseLockTimeoutMs, async (client) => {
      const result = await client.query<ProductRow>(
        `WITH inserted AS (
           INSERT INTO products
             (seller_id, name, description, category, image_url, price_minor, stock_quantity)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *
         )
         SELECT i.*, s.name AS seller_name FROM inserted i JOIN sellers s ON s.id = i.seller_id`,
        [
          sellerId,
          input.name.trim(),
          input.description?.trim() ?? '',
          input.category.trim(),
          input.imageUrl ?? null,
          input.priceMinor,
          input.stockQuantity,
        ],
      );
      const row = result.rows[0]!;
      await appendAudit(client, {
        actorUserId,
        action: 'catalog.product_create',
        targetType: 'product',
        targetId: row.id,
        outcome: 'success',
        requestId,
      });
      return mapSellerProduct(row);
    });
  }

  async updateProduct(
    productId: string,
    sellerId: string,
    actorUserId: string,
    input: ProductUpdate,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    validateImageUrl(input.imageUrl);
    return withTransaction(this.pool, this.config.databaseLockTimeoutMs, async (client) => {
      const currentResult = await client.query<{
        version: number;
        price_minor: string;
        stock_quantity: string;
      }>(
        `SELECT version, price_minor, stock_quantity
           FROM products
          WHERE id = $1 AND seller_id = $2
          FOR UPDATE`,
        [productId, sellerId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
      if (current.version !== input.expectedVersion) {
        throw new AppError(409, 'VERSION_CONFLICT', 'Product version has changed');
      }
      const nextStock = Number(current.stock_quantity) + (input.stockAdjustment ?? 0);
      if (nextStock < 0 || nextStock > 1_000_000) {
        throw new AppError(409, 'INVALID_STOCK_ADJUSTMENT', 'Stock adjustment is not valid');
      }

      const result = await client.query<ProductRow>(
        `UPDATE products p
            SET name = COALESCE($3, p.name),
                description = COALESCE($4, p.description),
                category = COALESCE($5, p.category),
                image_url = CASE WHEN $6::boolean THEN $7 ELSE p.image_url END,
                price_minor = COALESCE($8, p.price_minor),
                stock_quantity = p.stock_quantity + $9,
                version = p.version + 1,
                updated_at = now()
           FROM sellers s
          WHERE p.id = $1 AND p.seller_id = $2 AND s.id = p.seller_id
          RETURNING p.*, s.name AS seller_name`,
        [
          productId,
          sellerId,
          input.name?.trim() ?? null,
          input.description?.trim() ?? null,
          input.category?.trim() ?? null,
          Object.hasOwn(input, 'imageUrl'),
          input.imageUrl ?? null,
          input.priceMinor ?? null,
          input.stockAdjustment ?? 0,
        ],
      );
      const row = result.rows[0]!;
      await appendAudit(client, {
        actorUserId,
        action: 'catalog.product_update',
        targetType: 'product',
        targetId: productId,
        outcome: 'success',
        requestId,
        safeMetadata: {
          old_price_minor: Number(current.price_minor),
          new_price_minor: Number(row.price_minor),
          stock_adjustment: input.stockAdjustment ?? 0,
        },
      });
      return mapSellerProduct(row);
    });
  }

  async listOrders(sellerId: string, cursorRaw: string | undefined, limit: number) {
    const cursor = decodeCursor<{ created_at: string; id: string }>(cursorRaw);
    const values: unknown[] = [sellerId];
    let cursorCondition = '';
    if (cursor) {
      if (typeof cursor.created_at !== 'string' || typeof cursor.id !== 'string') {
        throw new AppError(400, 'INVALID_CURSOR', 'Pagination cursor is invalid');
      }
      values.push(cursor.created_at, cursor.id);
      cursorCondition = 'AND (so.created_at, so.id) < ($2::timestamptz, $3::uuid)';
    }
    values.push(limit + 1);
    const limitParameter = `$${values.length}`;
    const result = await this.pool.query<{
      id: string;
      seller_id: string;
      seller_name_snapshot: string;
      status: string;
      subtotal_minor: string;
      currency: 'IDR';
      created_at: Date;
      items: Array<{
        id: string;
        product_id: string;
        product_name: string;
        unit_price_minor: string;
        quantity: string;
        line_total_minor: string;
        currency: 'IDR';
      }>;
    }>(
      `SELECT so.id, so.seller_id, so.seller_name_snapshot, so.status,
              so.subtotal_minor, so.currency, so.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', oi.id,
                'product_id', oi.product_id,
                'product_name', oi.product_name_snapshot,
                'unit_price_minor', oi.unit_price_minor,
                'quantity', oi.quantity,
                'line_total_minor', oi.line_total_minor,
                'currency', oi.currency
              ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]'::jsonb) AS items
         FROM seller_orders so
         LEFT JOIN order_items oi ON oi.seller_order_id = so.id
        WHERE so.seller_id = $1 ${cursorCondition}
        GROUP BY so.id
        ORDER BY so.created_at DESC, so.id DESC
        LIMIT ${limitParameter}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        seller_id: row.seller_id,
        seller_name: row.seller_name_snapshot,
        status: row.status,
        subtotal: { amount_minor: Number(row.subtotal_minor), currency: row.currency },
        items: row.items.map((item) => ({
          id: item.id,
          product_id: item.product_id,
          product_name: item.product_name,
          unit_price: { amount_minor: Number(item.unit_price_minor), currency: item.currency },
          quantity: Number(item.quantity),
          line_total: { amount_minor: Number(item.line_total_minor), currency: item.currency },
        })),
        created_at: row.created_at.toISOString(),
      })),
      next_cursor:
        hasMore && last
          ? encodeCursor({ created_at: last.created_at.toISOString(), id: last.id })
          : null,
      has_more: hasMore,
    };
  }
}

function validateImageUrl(imageUrl: string | undefined): void {
  if (!imageUrl) return;
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new AppError(400, 'INVALID_IMAGE_URL', 'image_url must be an HTTPS URL');
  }
}

function mapSellerProduct(row: ProductRow): Record<string, unknown> {
  return {
    id: row.id,
    seller_id: row.seller_id,
    seller_name: row.seller_name,
    name: row.name,
    description: row.description,
    category: row.category,
    image_url: row.image_url,
    price: { amount_minor: Number(row.price_minor), currency: row.currency },
    stock_quantity: Number(row.stock_quantity),
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
