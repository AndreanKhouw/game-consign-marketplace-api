import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../platform/errors.js';
import type { OrderService } from './order-service.js';

export function registerOrderRoutes(app: FastifyInstance, orders: OrderService): void {
  app.get(
    '/v1/orders/:order_id',
    {
      config: { roles: ['buyer'] },
      schema: {
        params: Type.Object(
          { order_id: Type.String({ format: 'uuid' }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      if (!request.auth) throw new AppError(401, 'INVALID_SESSION', 'Session is invalid');
      const { order_id: orderId } = request.params as { order_id: string };
      return orders.getBuyerOrder(orderId, request.auth.userId);
    },
  );
}
