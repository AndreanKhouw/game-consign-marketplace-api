import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../platform/errors.js';
import type { PaymentService } from './payment-service.js';

export function registerPaymentRoutes(app: FastifyInstance, payment: PaymentService): void {
  app.post(
    '/v1/webhooks/payment',
    {
      config: {
        authMode: 'webhook',
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
      schema: {
        headers: Type.Object(
          {
            'x-payment-signature': Type.String({ pattern: '^[0-9a-fA-F]{64}$' }),
            'x-payment-timestamp': Type.String({ pattern: '^[0-9]{10,12}$' }),
          },
          { additionalProperties: true },
        ),
        body: Type.Object(
          {
            provider_event_id: Type.String({ minLength: 8, maxLength: 128 }),
            payment_reference: Type.String({ minLength: 16, maxLength: 100 }),
            status: Type.Union([Type.Literal('paid'), Type.Literal('failed')]),
            amount: Type.Object(
              {
                amount_minor: Type.Integer({ minimum: 0, maximum: 9_000_000_000_000_000 }),
                currency: Type.Literal('IDR'),
              },
              { additionalProperties: false },
            ),
            occurred_at: Type.String({ format: 'date-time' }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      if (!request.rawBody) {
        throw new AppError(500, 'RAW_BODY_UNAVAILABLE', 'Webhook cannot be verified');
      }
      const headers = request.headers as Record<string, string | string[] | undefined>;
      const signature = headers['x-payment-signature'];
      const timestamp = headers['x-payment-timestamp'];
      if (typeof signature !== 'string' || typeof timestamp !== 'string') {
        throw new AppError(401, 'INVALID_WEBHOOK', 'Webhook authentication failed');
      }
      const body = request.body as {
        provider_event_id: string;
        payment_reference: string;
        status: 'paid' | 'failed';
        amount: { amount_minor: number; currency: 'IDR' };
        occurred_at: string;
      };
      return payment.processWebhook({
        event: {
          providerEventId: body.provider_event_id,
          paymentReference: body.payment_reference,
          status: body.status,
          amountMinor: body.amount.amount_minor,
          currency: body.amount.currency,
          occurredAt: body.occurred_at,
        },
        rawBody: request.rawBody,
        timestamp,
        signature,
        requestId: request.id,
      });
    },
  );
}
