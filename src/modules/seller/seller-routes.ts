import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../platform/errors.js';
import type { AuthContext } from '../../types/fastify.js';
import type { SellerService } from './seller-service.js';

const Money = Type.Object(
  {
    amount_minor: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
    currency: Type.Literal('IDR'),
  },
  { additionalProperties: false },
);

export function registerSellerRoutes(app: FastifyInstance, seller: SellerService): void {
  app.post(
    '/v1/seller/products',
    {
      config: { roles: ['seller'] },
      schema: {
        body: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 200 }),
            description: Type.Optional(Type.String({ maxLength: 5000 })),
            category: Type.String({ minLength: 1, maxLength: 50 }),
            image_url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
            price: Money,
            stock_quantity: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const auth = requireSeller(request.auth);
      const body = request.body as {
        name: string;
        description?: string;
        category: string;
        image_url?: string;
        price: { amount_minor: number; currency: 'IDR' };
        stock_quantity: number;
      };
      const product = await seller.createProduct(
        auth.sellerId,
        auth.userId,
        {
          name: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          category: body.category,
          ...(body.image_url !== undefined ? { imageUrl: body.image_url } : {}),
          priceMinor: body.price.amount_minor,
          stockQuantity: body.stock_quantity,
        },
        request.id,
      );
      return reply.code(201).send(product);
    },
  );

  app.patch(
    '/v1/seller/products/:product_id',
    {
      config: { roles: ['seller'] },
      schema: {
        params: Type.Object({ product_id: Type.String({ format: 'uuid' }) }),
        body: Type.Object(
          {
            expected_version: Type.Integer({ minimum: 1 }),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            description: Type.Optional(Type.String({ maxLength: 5000 })),
            category: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
            image_url: Type.Optional(Type.String({ maxLength: 2048 })),
            price: Type.Optional(Money),
            stock_adjustment: Type.Optional(
              Type.Integer({ minimum: -1_000_000, maximum: 1_000_000 }),
            ),
          },
          { additionalProperties: false, minProperties: 2 },
        ),
      },
    },
    async (request) => {
      const auth = requireSeller(request.auth);
      const { product_id: productId } = request.params as { product_id: string };
      const body = request.body as {
        expected_version: number;
        name?: string;
        description?: string;
        category?: string;
        image_url?: string;
        price?: { amount_minor: number; currency: 'IDR' };
        stock_adjustment?: number;
      };
      return seller.updateProduct(
        productId,
        auth.sellerId,
        auth.userId,
        {
          expectedVersion: body.expected_version,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(Object.hasOwn(body, 'image_url') ? { imageUrl: body.image_url } : {}),
          ...(body.price ? { priceMinor: body.price.amount_minor } : {}),
          ...(body.stock_adjustment !== undefined
            ? { stockAdjustment: body.stock_adjustment }
            : {}),
        },
        request.id,
      );
    },
  );

  app.get(
    '/v1/seller/orders',
    {
      config: { roles: ['seller'] },
      schema: {
        querystring: Type.Object(
          {
            cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const auth = requireSeller(request.auth);
      const query = request.query as { cursor?: string; limit?: number };
      return seller.listOrders(auth.sellerId, query.cursor, query.limit ?? 20);
    },
  );
}

function requireSeller(auth: AuthContext | undefined) {
  if (!auth?.sellerId) throw new AppError(403, 'FORBIDDEN', 'Seller capability is missing');
  return { ...auth, sellerId: auth.sellerId };
}
