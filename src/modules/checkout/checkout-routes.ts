import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../platform/errors.js';
import type { CheckoutService } from './checkout-service.js';

export function registerCheckoutRoutes(app: FastifyInstance, checkout: CheckoutService): void {
  app.post(
    '/v1/checkout',
    {
      config: {
        roles: ['buyer'],
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: {
        headers: Type.Object(
          {
            'idempotency-key': Type.String({
              minLength: 16,
              maxLength: 128,
              pattern: '^[A-Za-z0-9._:-]+$',
            }),
          },
          { additionalProperties: true },
        ),
        body: Type.Object(
          {
            cart_id: Type.String({ format: 'uuid' }),
            cart_version: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      if (!request.auth) throw new AppError(401, 'INVALID_SESSION', 'Session is invalid');
      const body = request.body as { cart_id: string; cart_version: number };
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string') {
        throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
      }
      const result = await checkout.checkout({
        buyerId: request.auth.userId,
        cartId: body.cart_id,
        cartVersion: body.cart_version,
        idempotencyKey: key,
        requestId: request.id,
      });
      reply.header('Idempotency-Replayed', result.replayed);
      return reply.code(201).send(result.body);
    },
  );
}
