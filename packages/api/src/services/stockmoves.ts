/**
 * Finished goods leaving with a sale (team feedback, 1 Oct 2026, point 12).
 *
 * Production has always added bottles to finished-goods stock, but nothing
 * took them off again when they were sold, so stock only ever went up and a
 * count was the only thing that ever brought it down. Now every delivery,
 * collection and counter sale takes off what actually left, and writes the
 * movement to the stock ledger so the count screen can explain the figure.
 *
 * Stock is allowed to go below zero rather than block a sale: a delivery
 * that has happened has happened, and a negative figure is the clearest
 * possible prompt to count.
 */

import type { Queryable } from '../db/index.ts';
import { num } from './core.ts';

export async function takeFinishedGoods(
  t: Queryable,
  lines: ReadonlyArray<{ productId: string; bottles: number }>,
  reference: string,
  note: string,
): Promise<void> {
  for (const l of lines) {
    const qty = Math.round(num(l.bottles));
    if (qty <= 0) continue;
    const p = await t.maybeOne<{ name: string }>(`SELECT name FROM products WHERE id = $1`, [l.productId]);
    if (!p) continue;
    await t.query(
      `INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, $2)
       ON CONFLICT (product_id) DO UPDATE
         SET quantity_on_hand = finished_goods_stock.quantity_on_hand + EXCLUDED.quantity_on_hand`,
      [l.productId, -qty],
    );
    await t.query(
      `INSERT INTO inventory_transactions
         (item_type, item_id, item_name, quantity, direction, reference, reference_type, notes)
       VALUES ('FinishedGoods',$1,$2,$3,'out',$4,'Sale',$5)`,
      [l.productId, p.name, qty, reference, note],
    );
  }
}

/** Bottles from what was delivered on an order's lines, per product. */
export async function deliveredBottles(
  t: Queryable, orderId: string,
): Promise<Array<{ productId: string; bottles: number; returnable: number }>> {
  const rows = await t.query<{ product_id: string; bottles: number; is_returnable: boolean }>(
    `SELECT oli.product_id, SUM(oli.delivered_total)::int AS bottles, bool_or(p.is_returnable) AS is_returnable
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1 GROUP BY oli.product_id`,
    [orderId],
  );
  return rows.map((r) => ({
    productId: r.product_id, bottles: num(r.bottles),
    returnable: r.is_returnable ? num(r.bottles) : 0,
  }));
}
