import type { Pool } from 'pg';

import { decodeCursor, encodeCursor } from '../../platform/pagination.js';
import { AppError } from '../../platform/errors.js';
import { canonicalFingerprint } from '../../platform/crypto.js';

export type ProductSort = 'created_at_desc' | 'price_asc' | 'price_desc';

export interface ProductQuery {
  q?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  sort: ProductSort;
  cursor?: string;
  limit: number;
}

export interface ProductView {
  id: string;
  seller_id: string;
  seller_name: string;
  name: string;
  description: string;
  category: string;
  image_url: string | null;
  price: { amount_minor: number; currency: 'IDR' };
  stock_quantity: number;
  version: number;
  created_at: string;
  updated_at: string;
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

interface ProductCursor {
  sort: ProductSort;
  value: string | number;
  id: string;
  filter: string;
}

export class CatalogRepository {
  constructor(private readonly pool: Pool) {}

  async list(query: ProductQuery): Promise<{
    items: ProductView[];
    next_cursor: string | null;
    has_more: boolean;
  }> {
    const conditions = ["p.status = 'active'"];
    const values: unknown[] = [];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (query.q) conditions.push(`p.name ILIKE '%' || ${add(query.q)} || '%'`);
    if (query.category) conditions.push(`p.category = ${add(query.category)}`);
    if (query.minPrice !== undefined) conditions.push(`p.price_minor >= ${add(query.minPrice)}`);
    if (query.maxPrice !== undefined) conditions.push(`p.price_minor <= ${add(query.maxPrice)}`);

    const cursor = decodeCursor<ProductCursor>(query.cursor);
    const filterFingerprint = canonicalFingerprint({
      q: query.q ?? null,
      category: query.category ?? null,
      min_price: query.minPrice ?? null,
      max_price: query.maxPrice ?? null,
    });
    if (cursor) {
      if (
        cursor.sort !== query.sort ||
        cursor.filter !== filterFingerprint ||
        typeof cursor.id !== 'string'
      ) {
        throw new AppError(400, 'INVALID_CURSOR', 'Cursor does not match the selected sort');
      }
      if (query.sort === 'created_at_desc') {
        conditions.push(
          `(p.created_at, p.id) < (${add(cursor.value)}::timestamptz, ${add(cursor.id)}::uuid)`,
        );
      } else if (query.sort === 'price_asc') {
        conditions.push(
          `(p.price_minor, p.id) > (${add(cursor.value)}::bigint, ${add(cursor.id)}::uuid)`,
        );
      } else {
        conditions.push(
          `(p.price_minor, p.id) < (${add(cursor.value)}::bigint, ${add(cursor.id)}::uuid)`,
        );
      }
    }

    const ordering: Record<ProductSort, string> = {
      created_at_desc: 'p.created_at DESC, p.id DESC',
      price_asc: 'p.price_minor ASC, p.id ASC',
      price_desc: 'p.price_minor DESC, p.id DESC',
    };
    const limitParameter = add(query.limit + 1);
    const result = await this.pool.query<ProductRow>(
      `SELECT p.id, p.seller_id, s.name AS seller_name, p.name, p.description,
              p.category, p.image_url, p.price_minor, p.currency,
              p.stock_quantity, p.version, p.created_at, p.updated_at
         FROM products p
         JOIN sellers s ON s.id = p.seller_id AND s.status = 'active'
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${ordering[query.sort]}
        LIMIT ${limitParameter}`,
      values,
    );

    const hasMore = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            sort: query.sort,
            value:
              query.sort === 'created_at_desc'
                ? last.created_at.toISOString()
                : Number(last.price_minor),
            id: last.id,
            filter: filterFingerprint,
          })
        : null;

    return { items: rows.map(mapProduct), next_cursor: nextCursor, has_more: hasMore };
  }

  async findActive(productId: string): Promise<ProductView | undefined> {
    const result = await this.pool.query<ProductRow>(
      `SELECT p.id, p.seller_id, s.name AS seller_name, p.name, p.description,
              p.category, p.image_url, p.price_minor, p.currency,
              p.stock_quantity, p.version, p.created_at, p.updated_at
         FROM products p
         JOIN sellers s ON s.id = p.seller_id AND s.status = 'active'
        WHERE p.id = $1 AND p.status = 'active'`,
      [productId],
    );
    const row = result.rows[0];
    return row ? mapProduct(row) : undefined;
  }
}

export function mapProduct(row: ProductRow): ProductView {
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
