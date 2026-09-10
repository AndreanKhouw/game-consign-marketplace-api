import type { Pool } from 'pg';

import { appendAudit } from '../audit/audit-repository.js';
import type { AppConfig } from '../../platform/config.js';
import { sha256Hex, verifyHmacSha256 } from '../../platform/crypto.js';
import { withTransaction } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { decidePaymentTransition, type PaymentStatus } from './payment-state.js';

export interface PaymentEventInput {
  providerEventId: string;
  paymentReference: string;
  status: 'paid' | 'failed';
  amountMinor: number;
  currency: 'IDR';
  occurredAt: string;
}

export class PaymentService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  async processWebhook(input: {
    event: PaymentEventInput;
    rawBody: Buffer;
    timestamp: string;
    signature: string;
    requestId: string;
  }): Promise<{ received: true; duplicate: boolean }> {
    const timestampSeconds = Number(input.timestamp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > this.config.webhookToleranceSeconds
    ) {
      throw new AppError(401, 'INVALID_WEBHOOK', 'Webhook authentication failed');
    }
    if (
      !verifyHmacSha256(
        this.config.webhookHmacSecret,
        input.timestamp,
        input.rawBody,
        input.signature,
      )
    ) {
      throw new AppError(401, 'INVALID_WEBHOOK', 'Webhook authentication failed');
    }

    const occurredAt = new Date(input.event.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new AppError(400, 'VALIDATION_FAILED', 'occurred_at must be a valid timestamp');
    }
    const payloadHash = sha256Hex(input.rawBody);

    return withTransaction(this.pool, this.config.databaseLockTimeoutMs, async (client) => {
      const paymentResult = await client.query<{
        id: string;
        order_id: string;
        status: PaymentStatus;
        amount_minor: string;
        currency: 'IDR';
      }>(
        `SELECT id, order_id, status, amount_minor, currency
           FROM payments
          WHERE payment_reference = $1
          FOR UPDATE`,
        [input.event.paymentReference],
      );
      const payment = paymentResult.rows[0];
      if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment reference not found');
      if (
        Number(payment.amount_minor) !== input.event.amountMinor ||
        payment.currency !== input.event.currency
      ) {
        throw new AppError(
          409,
          'PAYMENT_AMOUNT_MISMATCH',
          'Payment amount or currency does not match',
        );
      }

      const eventInsert = await client.query<{ id: string }>(
        `INSERT INTO payment_events
           (payment_id, provider_event_id, payload_hash, event_status, provider_occurred_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider_event_id) DO NOTHING
         RETURNING id`,
        [payment.id, input.event.providerEventId, payloadHash, input.event.status, occurredAt],
      );
      if (!eventInsert.rows[0]) {
        const existing = await client.query<{ payload_hash: string; payment_id: string }>(
          `SELECT payload_hash, payment_id
             FROM payment_events
            WHERE provider_event_id = $1`,
          [input.event.providerEventId],
        );
        const row = existing.rows[0];
        if (!row || row.payload_hash !== payloadHash || row.payment_id !== payment.id) {
          throw new AppError(
            409,
            'PAYMENT_EVENT_CONFLICT',
            'Provider event ID was reused with different content',
          );
        }
        return { received: true, duplicate: true };
      }

      const transition = decidePaymentTransition(payment.status, input.event.status);
      if (transition.kind === 'reject') {
        throw new AppError(
          409,
          'ILLEGAL_PAYMENT_TRANSITION',
          'Payment status cannot move backwards',
        );
      }

      if (transition.kind === 'apply') {
        await client.query(`UPDATE payments SET status = $2, updated_at = now() WHERE id = $1`, [
          payment.id,
          input.event.status,
        ]);
        await client.query(`UPDATE orders SET status = $2, updated_at = now() WHERE id = $1`, [
          payment.order_id,
          transition.orderStatus,
        ]);
        await client.query(
          `UPDATE seller_orders SET status = $2, updated_at = now() WHERE order_id = $1`,
          [payment.order_id, transition.orderStatus],
        );
        await appendAudit(client, {
          action: 'payment.status_change',
          targetType: 'payment',
          targetId: payment.id,
          outcome: 'success',
          requestId: input.requestId,
          safeMetadata: {
            order_id: payment.order_id,
            from: 'pending',
            to: input.event.status,
            provider_event_id: input.event.providerEventId,
          },
        });
      }

      return { received: true, duplicate: false };
    });
  }
}
