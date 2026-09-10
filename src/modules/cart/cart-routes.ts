import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../platform/errors.js';
import type { CartService } from './cart-service.js';

export function registerCartRoutes(app: FastifyInstance, cart: CartService): void {
  app.post(
    '/v1/cart/items',
    {
      config: { roles: ['buyer'] },
      schema: {
        body: Type.Object(
          {
            product_id: Type.String({ format: 'uuid' }),
            quantity: Type.Integer({ minimum: 1, maximum: 100 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      if (!request.auth) throw new AppError(401, 'INVALID_SESSION', 'Session is invalid');
      const body = request.body as { product_id: string; quantity: number };
      return cart.addItem(request.auth.userId, body.product_id, body.quantity);
    },
  );
}
