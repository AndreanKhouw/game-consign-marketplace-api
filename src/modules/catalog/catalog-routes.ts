import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../platform/errors.js';
import type { ProductSort } from './catalog-repository.js';
import type { CatalogRepository } from './catalog-repository.js';

const Uuid = Type.String({ format: 'uuid' });

export function registerCatalogRoutes(app: FastifyInstance, catalog: CatalogRepository): void {
  app.get(
    '/v1/products',
    {
      config: { authMode: 'public', rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        querystring: Type.Object(
          {
            q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            category: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
            min_price: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 })),
            max_price: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 })),
            sort: Type.Optional(
              Type.Union([
                Type.Literal('created_at_desc'),
                Type.Literal('price_asc'),
                Type.Literal('price_desc'),
              ]),
            ),
            cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const query = request.query as {
        q?: string;
        category?: string;
        min_price?: number;
        max_price?: number;
        sort?: ProductSort;
        cursor?: string;
        limit?: number;
      };
      if (
        query.min_price !== undefined &&
        query.max_price !== undefined &&
        query.min_price > query.max_price
      ) {
        throw new AppError(400, 'INVALID_PRICE_RANGE', 'min_price must not exceed max_price');
      }
      return catalog.list({
        ...(query.q ? { q: query.q.trim() } : {}),
        ...(query.category ? { category: query.category.trim() } : {}),
        ...(query.min_price !== undefined ? { minPrice: query.min_price } : {}),
        ...(query.max_price !== undefined ? { maxPrice: query.max_price } : {}),
        sort: query.sort ?? 'created_at_desc',
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit ?? 20,
      });
    },
  );

  app.get(
    '/v1/products/:product_id',
    {
      config: { authMode: 'public' },
      schema: {
        params: Type.Object({ product_id: Uuid }, { additionalProperties: false }),
      },
    },
    async (request) => {
      const { product_id: productId } = request.params as { product_id: string };
      const product = await catalog.findActive(productId);
      if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
      return product;
    },
  );
}
