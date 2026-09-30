/**
 * Weekly and monthly invoicing (Everton's revisions, 30 Sep 2026, point 15).
 *
 * Some customers want ONE invoice a week or a month listing every delivery,
 * not an invoice at each one. For them (customers.invoice_cycle = Weekly or
 * Monthly) a delivery or collection raises no invoice: the goods are recorded
 * as delivered - the order's lines and the stop's lines say exactly what went
 * - and the delivery waits "on the account".
 *
 * When the week (Monday to Sunday) or the calendar month has closed, one real
 * invoice is raised for everything delivered in it, each line carrying the
 * date and order it came from. It is due ON RECEIPT (Everton's ruling), so
 * its due date is its invoice date. Money the driver collected in the
 * meantime is already on the account as an unattached payment, and is
 * applied to the new invoice straight away.
 *
 * Idempotent like the standing-order generator: a delivery is picked up only
 * while its stop has no invoice (or, for a collection, while the order has no
 * invoice), and raising sets that link in the same transaction.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessToday, num, requireRole } from './core.ts';
import { RuleViolation, cyclePeriod, computeLineTotal } from '@alka/shared';
import { createInvoice, type InvoiceLineInput } from './invoices.ts';
import { applyToInvoice } from './payments.ts';

export interface PendingDelivery {
  customerId: string;
  customerName: string;
  cycle: 'PerDelivery' | 'Weekly' | 'Monthly';
  kind: 'Delivery' | 'Collection';
  stopId: string | null;
  orderId: string;
  orderNumber: string;
  date: string;
  discountPercent: number;
  discountFixedCents: number;
  gctExempt: boolean;
  lines: Array<InvoiceLineInput & { productName: string; lineTotal: number; bottlesPerCase: number }>;
  subtotalCents: number;
}

/** Everything delivered or collected and not yet on an invoice. */
export async function pendingDeliveries(
  t: Queryable, customerId?: string | null,
): Promise<PendingDelivery[]> {
  const stops = await t.query<Record<string, unknown>>(
    `SELECT s.id AS stop_id, s.customer_id, c.name AS customer_name, c.invoice_cycle,
            o.id AS order_id, o.order_number, ds.delivery_date::text AS date,
            o.discount_percent, o.discount_fixed_cents, o.gct_exempt
     FROM delivery_stops s
     JOIN delivery_sheets ds ON ds.id = s.delivery_sheet_id
     JOIN customers c ON c.id = s.customer_id
     JOIN customer_orders o ON o.id = s.order_id
     WHERE s.stop_outcome = 'Delivered' AND s.invoice_id IS NULL
       AND ($1::uuid IS NULL OR s.customer_id = $1::uuid)
     ORDER BY ds.delivery_date, o.order_number`,
    [customerId ?? null],
  );
  const pickups = await t.query<Record<string, unknown>>(
    `SELECT NULL AS stop_id, o.customer_id, c.name AS customer_name, c.invoice_cycle,
            o.id AS order_id, o.order_number,
            COALESCE(o.fulfilled_on, o.requested_delivery_date, o.order_date)::text AS date,
            o.discount_percent, o.discount_fixed_cents, o.gct_exempt
     FROM customer_orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.delivery_mode = 'Pickup' AND o.status IN ('Delivered','Partially Delivered')
       AND NOT EXISTS (SELECT 1 FROM invoice_orders io WHERE io.order_id = o.id)
       AND ($1::uuid IS NULL OR o.customer_id = $1::uuid)
     ORDER BY 7, o.order_number`,
    [customerId ?? null],
  );

  const out: PendingDelivery[] = [];
  for (const r of [...stops, ...pickups]) {
    const lines = r.stop_id
      ? await t.query<Record<string, unknown>>(
          `SELECT sl.product_id, p.name, p.bottles_per_case, sl.cases, sl.loose_bottles,
                  oli.price_per_case_cents, oli.price_per_bottle_cents
           FROM delivery_stop_lines sl
           JOIN order_line_items oli ON oli.id = sl.order_line_id
           JOIN products p ON p.id = sl.product_id
           WHERE sl.stop_id = $1 AND sl.total_bottles > 0
           ORDER BY p.name`, [r.stop_id],
        )
      : await t.query<Record<string, unknown>>(
          `SELECT oli.product_id, p.name, p.bottles_per_case,
                  oli.delivered_cases AS cases, oli.delivered_loose AS loose_bottles,
                  oli.price_per_case_cents, oli.price_per_bottle_cents
           FROM order_line_items oli JOIN products p ON p.id = oli.product_id
           WHERE oli.order_id = $1 AND oli.delivered_total > 0
           ORDER BY p.name`, [r.order_id],
        );
    if (lines.length === 0) continue;
    const priced = lines.map((l) => {
      const bpc = num(l.bottles_per_case);
      const cases = num(l.cases);
      const loose = num(l.loose_bottles);
      const ppc = num(l.price_per_case_cents);
      const ppb = num(l.price_per_bottle_cents);
      return {
        productId: l.product_id as string,
        productName: l.name as string,
        bottlesPerCase: bpc,
        cases, looseBottles: loose,
        pricePerCaseCents: ppc, pricePerBottleCents: ppb,
        lineTotal: computeLineTotal({
          bottlesPerCase: bpc, cases, looseBottles: loose, pricePerCase: ppc, pricePerBottle: ppb,
        }),
        deliveredOn: r.date as string,
        orderId: r.order_id as string,
        reference: r.order_number as string,
      };
    });
    out.push({
      customerId: r.customer_id as string,
      customerName: r.customer_name as string,
      cycle: r.invoice_cycle as PendingDelivery['cycle'],
      kind: r.stop_id ? 'Delivery' : 'Collection',
      stopId: (r.stop_id as string) ?? null,
      orderId: r.order_id as string,
      orderNumber: r.order_number as string,
      date: r.date as string,
      discountPercent: num(r.discount_percent),
      discountFixedCents: num(r.discount_fixed_cents),
      gctExempt: !!r.gct_exempt,
      lines: priced,
      subtotalCents: priced.reduce((a, l) => a + l.lineTotal, 0),
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.orderNumber.localeCompare(b.orderNumber));
  return out;
}

export interface RaisedCycleInvoice {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  periodFrom: string;
  periodTo: string;
  deliveries: number;
  totalCents: number;
  appliedFromAccountCents: number;
}

/**
 * Raise the invoices that are due.
 *
 *   mode 'closed' (the automatic run): for Weekly/Monthly customers, one
 *     invoice per week/month that has finished. A delivery in the current,
 *     still-open period waits.
 *   mode 'now' (the office's "Invoice now" on one customer): everything
 *     waiting, on one invoice, whatever the period.
 *
 * A delivery that is waiting for a customer who has since gone back to
 * per-delivery invoicing is swept up by 'closed' too, so nothing is stranded.
 */
export async function raiseCycleInvoices(
  db: Db,
  actor: Actor,
  opts: { today?: string; customerId?: string | null; mode?: 'closed' | 'now' } = {},
): Promise<RaisedCycleInvoice[]> {
  requireRole(actor, 'admin', 'user');
  const today = opts.today ?? await businessToday(db);
  const mode = opts.mode ?? 'closed';

  const pending = await pendingDeliveries(db, opts.customerId ?? null);
  // Group: customer -> period key -> deliveries.
  const groups = new Map<string, { from: string; to: string; items: PendingDelivery[]; cycle: string | null }>();
  for (const p of pending) {
    let from: string; let to: string; let cycle: string | null;
    if (mode === 'now' || p.cycle === 'PerDelivery') {
      from = p.date; to = today; cycle = p.cycle === 'PerDelivery' ? null : p.cycle;
      const key = `${p.customerId}|all`;
      const g = groups.get(key);
      if (g) {
        g.items.push(p);
        if (p.date < g.from) g.from = p.date;
      } else groups.set(key, { from, to, items: [p], cycle });
      continue;
    }
    const period = cyclePeriod(p.date, p.cycle);
    if (period.to >= today) continue; // the week or month is still running
    ({ from, to } = period);
    cycle = p.cycle;
    const key = `${p.customerId}|${from}`;
    const g = groups.get(key);
    if (g) g.items.push(p); else groups.set(key, { from, to, items: [p], cycle });
  }

  const raised: RaisedCycleInvoice[] = [];
  for (const g of groups.values()) {
    const first = g.items[0];
    const made = await db.tx(async (t) => {
      // Re-check inside the transaction: another run may have got here first.
      const still = await pendingDeliveries(t, first.customerId);
      const ids = new Set(still.map((x) => `${x.stopId ?? ''}|${x.orderId}`));
      const items = g.items.filter((x) => ids.has(`${x.stopId ?? ''}|${x.orderId}`));
      if (items.length === 0) return null;

      // Each order's own discount, on what was actually delivered of it,
      // carried as one fixed amount on the invoice.
      let discount = 0;
      for (const it of items) {
        discount += it.discountFixedCents > 0
          ? Math.min(it.discountFixedCents, it.subtotalCents)
          : Math.round(it.subtotalCents * (it.discountPercent / 100));
      }
      const cust = await t.one<{ gct_exempt: boolean }>(
        `SELECT gct_exempt FROM customers WHERE id = $1`, [first.customerId],
      );
      const gctExempt = cust.gct_exempt || items.every((it) => it.gctExempt);

      // "Invoice now" covers up to today - or later, if a delivery went out
      // ahead of the day it was booked for.
      const latest = items.reduce((m, it) => (it.date > m ? it.date : m), today);
      const periodTo = mode === 'now' || g.cycle === null ? latest : g.to;
      const invoice = await createInvoice(t, actor, {
        customerId: first.customerId,
        orderIds: [...new Set(items.map((it) => it.orderId))],
        lines: items.flatMap((it) => it.lines),
        discountFixedCents: discount,
        gctExempt,
        invoiceDate: today,
        // Due on receipt.
        dueDate: today,
        cycle: (g.cycle as 'Weekly' | 'Monthly' | null) ?? null,
        periodFrom: g.from,
        periodTo,
        notes: `${items.length} ${items.length === 1 ? 'delivery' : 'deliveries'}, `
          + `${g.from} to ${periodTo}`,
      });
      for (const it of items) {
        if (it.stopId) {
          await t.query(`UPDATE delivery_stops SET invoice_id = $2 WHERE id = $1 AND invoice_id IS NULL`,
            [it.stopId, invoice.id]);
        }
      }
      await audit(t, actor, 'create', 'Invoice', invoice.id, invoice.invoiceNumber, {
        cycleInvoice: true, periodFrom: g.from, periodTo, deliveries: items.length,
      });
      return { invoice, items, periodTo };
    });
    if (!made) continue;

    // Money already on their account (driver cash, a transfer that arrived
    // first) goes against the new invoice at once. After the invoice has
    // committed, so it is never nested inside another transaction.
    let applied = 0;
    try {
      const r = await applyToInvoice(db, actor, { invoiceId: made.invoice.id });
      applied = r.appliedCents;
    } catch { /* nothing on account - normal */ }

    raised.push({
      invoiceId: made.invoice.id,
      invoiceNumber: made.invoice.invoiceNumber,
      customerId: first.customerId,
      customerName: first.customerName,
      periodFrom: g.from,
      periodTo: made.periodTo,
      deliveries: made.items.length,
      totalCents: made.invoice.grandTotalCents,
      appliedFromAccountCents: applied,
    });
  }
  return raised;
}

/** For the Invoices screen: who has deliveries waiting, and how much. */
export async function waitingSummary(db: Db) {
  const pending = await pendingDeliveries(db);
  const today = await businessToday(db);
  const by = new Map<string, {
    customerId: string; customerName: string; cycle: string;
    deliveries: number; subtotalCents: number; firstDate: string; lastDate: string;
    readyNow: boolean;
  }>();
  for (const p of pending) {
    const period = p.cycle === 'PerDelivery' ? null : cyclePeriod(p.date, p.cycle);
    const ready = !period || period.to < today;
    const cur = by.get(p.customerId);
    if (cur) {
      cur.deliveries += 1;
      cur.subtotalCents += p.subtotalCents;
      if (p.date < cur.firstDate) cur.firstDate = p.date;
      if (p.date > cur.lastDate) cur.lastDate = p.date;
      cur.readyNow = cur.readyNow || ready;
    } else {
      by.set(p.customerId, {
        customerId: p.customerId, customerName: p.customerName, cycle: p.cycle,
        deliveries: 1, subtotalCents: p.subtotalCents, firstDate: p.date, lastDate: p.date,
        readyNow: ready,
      });
    }
  }
  return [...by.values()].sort((a, b) => a.customerName.localeCompare(b.customerName));
}

/** Guard for the route: "Invoice now" needs something to invoice. */
export async function invoiceCustomerNow(db: Db, actor: Actor, customerId: string) {
  const r = await raiseCycleInvoices(db, actor, { customerId, mode: 'now' });
  if (r.length === 0) throw new RuleViolation('nothing is waiting to be invoiced for this customer');
  return r[0];
}
