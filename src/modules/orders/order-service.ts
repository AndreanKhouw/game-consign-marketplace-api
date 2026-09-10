import type { Pool } from 'pg';

import { AppError } from '../../platform/errors.js';

interface OrderRow {
  id: string;
  status: string;
  total_minor: string;
  currency: 'IDR';
  created_at: Date;
  updated_at: Date;
  payment_reference: string;
  payment_status: string;
  payment_amount_minor: string;
  seller_orders: Array<{
    id: string;
    seller_id: string;
    seller_name: string;
    status: string;
    subtotal_minor: string;
    currency: 'IDR';
    created_at: string;
    items: Array<{
      id: string;
      product_id: string;
      product_name: string;
      unit_price_minor: string;
      quantity: string;
      line_total_minor: string;
      currency: 'IDR';
    }>;
  }>;
}

export class OrderService {
  constructor(private readonly pool: Pool) {}

  async getBuyerOrder(orderId: string, buyerId: string) {
    const result = await this.pool.query<OrderRow>(
      `SELECT o.id, o.status, o.total_minor, o.currency, o.created_at, o.updated_at,
              p.payment_reference, p.status AS payment_status,
              p.amount_minor AS payment_amount_minor,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', so.id,
                  'seller_id', so.seller_id,
                  'seller_name', so.seller_name_snapshot,
                  'status', so.status,
                  'subtotal_minor', so.subtotal_minor,
                  'currency', so.currency,
                  'created_at', so.created_at,
                  'items', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', oi.id,
                      'product_id', oi.product_id,
                      'product_name', oi.product_name_snapshot,
                      'unit_price_minor', oi.unit_price_minor,
                      'quantity', oi.quantity,
                      'line_total_minor', oi.line_total_minor,
                      'currency', oi.currency
                    ) ORDER BY oi.id)
                    FROM order_items oi WHERE oi.seller_order_id = so.id
                  ), '[]'::jsonb)
                ) ORDER BY so.id)
                FROM seller_orders so WHERE so.order_id = o.id
              ), '[]'::jsonb) AS seller_orders
         FROM orders o
         JOIN payments p ON p.order_id = o.id
        WHERE o.id = $1 AND o.buyer_id = $2`,
      [orderId, buyerId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    return {
      id: row.id,
      status: row.status,
      total: { amount_minor: Number(row.total_minor), currency: row.currency },
      seller_orders: row.seller_orders.map((sellerOrder) => ({
        id: sellerOrder.id,
        seller_id: sellerOrder.seller_id,
        seller_name: sellerOrder.seller_name,
        status: sellerOrder.status,
        subtotal: {
          amount_minor: Number(sellerOrder.subtotal_minor),
          currency: sellerOrder.currency,
        },
        items: sellerOrder.items.map((item) => ({
          id: item.id,
          product_id: item.product_id,
          product_name: item.product_name,
          unit_price: { amount_minor: Number(item.unit_price_minor), currency: item.currency },
          quantity: Number(item.quantity),
          line_total: { amount_minor: Number(item.line_total_minor), currency: item.currency },
        })),
        created_at: new Date(sellerOrder.created_at).toISOString(),
      })),
      payment: {
        payment_reference: row.payment_reference,
        status: row.payment_status,
        amount: { amount_minor: Number(row.payment_amount_minor), currency: row.currency },
      },
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}
