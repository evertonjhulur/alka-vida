/**
 * End of day (Everton, 27 Oct 2026): one report for any day, on screen and as
 * a printable PDF, with
 *   1. sales for the day - invoices dated that day (total, by product, by
 *      customer, delivered vs collected/counter), credit notes, and what was
 *      delivered to weekly/monthly customers and is not invoiced yet;
 *   2. money collected - every payment dated that day, by method and by who
 *      took it, against the cash handed in at settlement;
 *   3. rounds and bottles - each round that day: stops delivered / not
 *      delivered / not done, 5-gallon bottles out and empties back;
 *   4. orders taken that day, and what is booked for the next day.
 *
 * Read only. The figures follow the same rules as the Sales and Rounds
 * reports (services/reports.ts), so they agree with them.
 */

import PDFDocument from 'pdfkit';
import type { Db } from '../db/index.ts';
import { num } from './core.ts';
import { RuleViolation, addDays } from '@alka/shared';
import { notYetInvoiced, roundsReport } from './reports.ts';
import { qtyWords } from './documents.ts';

const NET = `(i.subtotal_cents - CASE WHEN i.discount_status = 'Approved' THEN i.discount_amount_cents ELSE 0 END)`;
const SALE = `NOT i.is_credit_note AND i.lifecycle <> 'Cancelled' AND NOT i.is_opening_balance AND i.invoice_date = $1::date`;

export async function endOfDay(db: Db, day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw new RuleViolation('choose a day');
  const tomorrow = addDays(day, 1);

  /* 1. Sales */
  const invoices = await db.query<Record<string, unknown>>(
    `SELECT i.id, i.invoice_number, i.customer_id, c.name AS customer, ${NET} AS net,
            i.gct_cents, i.grand_total_cents, l.amount_paid_cents, l.balance_cents, l.status, i.cycle,
            ds.zone, o.delivery_mode, o.recorded_late, o.order_numbers
     FROM invoices i
     JOIN customers c ON c.id = i.customer_id
     JOIN invoice_ledger l ON l.invoice_id = i.id
     LEFT JOIN LATERAL (
       SELECT d.zone FROM delivery_stops st JOIN delivery_sheets d ON d.id = st.delivery_sheet_id
        WHERE st.invoice_id = i.id LIMIT 1) ds ON true
     LEFT JOIN LATERAL (
       SELECT MIN(co.delivery_mode) AS delivery_mode, bool_or(co.recorded_late) AS recorded_late,
              string_agg(co.order_number, ', ' ORDER BY co.order_number) AS order_numbers
       FROM invoice_orders io JOIN customer_orders co ON co.id = io.order_id WHERE io.invoice_id = i.id) o ON true
     WHERE ${SALE}
     ORDER BY i.invoice_number`, [day]);
  const how = (r: Record<string, unknown>) => (r.cycle ? `${r.cycle} invoice`
    : r.zone ? `Delivered · ${r.zone}`
      : r.delivery_mode === 'Counter' ? 'Counter sale'
        : r.delivery_mode === 'Pickup' ? 'Collected'
          : r.recorded_late ? 'Delivered (recorded later)' : 'Other');
  const sales = invoices.map((r) => ({
    invoiceId: r.id as string, number: r.invoice_number as string, customerId: r.customer_id as string,
    customer: r.customer as string, how: how(r), orders: (r.order_numbers as string) ?? null,
    netCents: num(r.net), gctCents: num(r.gct_cents), totalCents: num(r.grand_total_cents),
    paidCents: num(r.amount_paid_cents), balanceCents: num(r.balance_cents), status: r.status as string,
  }));

  const byProduct = (await db.query<Record<string, unknown>>(
    `SELECT pr.id, pr.name, pr.bottles_per_case,
            COALESCE(SUM(li.cases),0)::int AS cases, COALESCE(SUM(li.loose_bottles),0)::int AS bottles,
            COALESCE(SUM(li.line_total_cents),0)::bigint AS cents
     FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id JOIN products pr ON pr.id = li.product_id
     WHERE ${SALE}
     GROUP BY pr.id, pr.name, pr.bottles_per_case ORDER BY cents DESC`, [day]))
    .map((r) => ({ name: r.name as string, bottlesPerCase: num(r.bottles_per_case), cases: num(r.cases), bottles: num(r.bottles), cents: num(r.cents) }));

  const credits = (await db.query<Record<string, unknown>>(
    `SELECT i.id, i.invoice_number, c.name AS customer, li.invoice_number AS against,
            ABS(i.subtotal_cents) - ABS(i.discount_amount_cents) AS net, ABS(i.grand_total_cents) AS total, i.notes
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     LEFT JOIN invoices li ON li.id = i.linked_invoice_id
     WHERE i.is_credit_note AND i.credit_status = 'Approved' AND i.lifecycle <> 'Cancelled' AND i.invoice_date = $1::date
     ORDER BY i.invoice_number`, [day]))
    .map((r) => ({ invoiceId: r.id as string, number: r.invoice_number as string, customer: r.customer as string,
      against: (r.against as string) ?? null, netCents: num(r.net), totalCents: num(r.total), reason: (r.notes as string) ?? null }));

  const waiting = await notYetInvoiced(db, day, day);
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const invoicedNet = sum(sales, (s) => s.netCents);
  const invoicedGross = sum(sales, (s) => s.totalCents);
  const creditNet = sum(credits, (c) => c.netCents);
  const creditGross = sum(credits, (c) => c.totalCents);
  const byHow = new Map<string, { how: string; count: number; netCents: number }>();
  for (const s of sales) {
    const k = s.how.startsWith('Delivered ·') ? 'Delivered on a round' : s.how;
    const g = byHow.get(k) ?? { how: k, count: 0, netCents: 0 };
    g.count += 1; g.netCents += s.netCents; byHow.set(k, g);
  }

  /* 2. Money */
  const payRows = await db.query<Record<string, unknown>>(
    `SELECT p.id, p.amount_cents, p.method, p.status, p.is_reversal, p.receipt_number, p.reference,
            c.name AS customer, i.invoice_number,
            COALESCE(du.name, d.driver_name) AS driver, d.zone, cu.name AS taken_by,
            to_char(p.payment_date AT TIME ZONE 'America/Jamaica', 'HH12:MI am') AS at
     FROM payments p
     JOIN customers c ON c.id = p.customer_id
     LEFT JOIN invoices i ON i.id = p.invoice_id
     LEFT JOIN delivery_stops st ON st.id = p.delivery_stop_id
     LEFT JOIN delivery_sheets d ON d.id = COALESCE(p.delivery_sheet_id, st.delivery_sheet_id)
     LEFT JOIN users du ON du.id = d.assigned_driver_id
     LEFT JOIN users cu ON cu.id = p.created_by_id
     WHERE business_date(p.payment_date) = $1::date
     ORDER BY p.payment_date`, [day]);
  const payments = payRows.map((r) => ({
    id: r.id as string, amountCents: num(r.amount_cents), method: r.method as string,
    confirmed: r.status === 'Confirmed', reversal: !!r.is_reversal,
    receipt: (r.receipt_number as string) ?? null, reference: (r.reference as string) ?? null,
    customer: r.customer as string, invoice: (r.invoice_number as string) ?? null,
    takenBy: r.zone ? `${(r.driver as string) ?? 'Driver'} · ${r.zone} round` : ((r.taken_by as string) ?? 'Office'),
    onRound: !!r.zone, at: (r.at as string) ?? '',
  }));
  const group = (key: (p: typeof payments[number]) => string) => {
    const m = new Map<string, { label: string; count: number; cents: number }>();
    for (const p of payments) {
      const k = key(p);
      const g = m.get(k) ?? { label: k, count: 0, cents: 0 };
      if (!p.reversal) g.count += 1;
      g.cents += p.amountCents; m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.cents - a.cents);
  };

  /* 3. Rounds and bottles */
  const rounds = await roundsReport(db, day, day);

  /* 4. Orders */
  const orderRows = (where: string) => db.query<Record<string, unknown>>(
    `SELECT o.id, o.order_number, c.name AS customer, c.delivery_zone, o.delivery_mode, o.source, o.status,
            o.requested_delivery_date::text AS for_day, o.grand_total_cents, o.parent_recurring_id IS NOT NULL AS standing,
            (SELECT string_agg(
                      CASE WHEN p.bottles_per_case > 0 AND l.cases > 0 THEN l.cases || ' cs ' ELSE '' END
                      || CASE WHEN l.loose_bottles > 0 THEN l.loose_bottles || ' ' ELSE '' END
                      || regexp_replace(p.name, '^Alka Vida\\s+', '', 'i'), ', ' ORDER BY p.name)
               FROM order_line_items l JOIN products p ON p.id = l.product_id WHERE l.order_id = o.id) AS items
     FROM customer_orders o JOIN customers c ON c.id = o.customer_id
     WHERE ${where}
     ORDER BY c.delivery_zone NULLS LAST, c.name`, [day, tomorrow]);
  const mapOrder = (r: Record<string, unknown>) => ({
    orderId: r.id as string, number: r.order_number as string, customer: r.customer as string,
    zone: (r.delivery_zone as string) ?? null, mode: r.delivery_mode as string,
    source: r.standing ? 'Standing order' : r.source === 'Portal' ? 'Customer portal' : 'Office',
    status: r.status as string, forDay: (r.for_day as string) ?? null, totalCents: num(r.grand_total_cents),
    items: (r.items as string) ?? '',
  });
  const taken = (await orderRows(`business_date(o.created_at) = $1::date AND o.parent_recurring_id IS NULL AND o.delivery_mode <> 'Counter' AND NOT o.recorded_late AND $2::date IS NOT NULL`)).map(mapOrder);
  const booked = (await orderRows(`o.requested_delivery_date = $2::date AND o.status <> 'Cancelled' AND o.delivery_mode <> 'Counter' AND $1::date IS NOT NULL`)).map(mapOrder);

  return {
    day, tomorrow,
    sales: {
      invoices: sales, byProduct, byHow: [...byHow.values()], credits, notInvoiced: waiting,
      totals: {
        invoices: sales.length, customers: new Set(sales.map((s) => s.customerId)).size,
        invoicedNetCents: invoicedNet, invoicedGrossCents: invoicedGross,
        creditNetCents: creditNet, creditGrossCents: creditGross,
        netAfterCreditsCents: invoicedNet - creditNet, grossAfterCreditsCents: invoicedGross - creditGross,
        notInvoicedNetCents: waiting.netCents, notInvoicedGrossCents: waiting.grossCents,
        totalSalesNetCents: invoicedNet - creditNet + waiting.netCents,
        totalSalesGrossCents: invoicedGross - creditGross + waiting.grossCents,
        paidOnTheseCents: sum(sales, (s) => s.paidCents),
        stillOwedOnTheseCents: sum(sales, (s) => Math.max(s.balanceCents, 0)),
      },
    },
    money: {
      payments,
      byMethod: group((p) => p.method),
      byWho: group((p) => p.takenBy),
      confirmedCents: sum(payments.filter((p) => p.confirmed), (p) => p.amountCents),
      provisionalCents: sum(payments.filter((p) => !p.confirmed), (p) => p.amountCents),
      totalCents: sum(payments, (p) => p.amountCents),
    },
    rounds,
    orders: { taken, booked },
  };
}

/* ------------------------------------------------------------------ */
/* The PDF                                                              */
/* ------------------------------------------------------------------ */

const BLUE = '#0E76BC';
const INK = '#1F2937';
const SOFT = '#4B5563';
const MUTED = '#6B7280';
const RULE = '#C9D3DD';
const HEAD_BG = '#EAF3FB';
const R = 'Helvetica';
const B = 'Helvetica-Bold';
const L = 36;
const W = 540;
const BOTTOM = 750;

const cash = (cents: number) => {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${neg ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-JM')}.${String(abs % 100).padStart(2, '0')}`;
};
const longDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
};
const short = (n: string) => n.replace(/^Alka Vida\s+/i, '');

type Col = { label: string; w: number; right?: boolean };

export async function renderEndOfDayPdf(db: Db, day: string): Promise<{ filename: string; pdf: Buffer }> {
  const r = await endOfDay(db, day);
  const doc = new PDFDocument({ size: 'LETTER', margin: L, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  let y = 36;
  doc.font(R).fontSize(8).fillColor(MUTED).text(`Alka Vida · printed ${new Date().toLocaleString('en-GB', { timeZone: 'America/Jamaica', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
    L + W - 220, 40, { width: 220, align: 'right' });
  doc.font(B).fontSize(17).fillColor(BLUE).text('End of day', L, y);
  doc.font(R).fontSize(10).fillColor(SOFT).text(longDay(r.day), L, doc.y + 2);
  y = doc.y + 16;

  const need = (h: number) => { if (y + h > BOTTOM) { doc.addPage(); y = 40; } };
  const heading = (t: string) => {
    need(40);
    doc.font(B).fontSize(12).fillColor(BLUE).text(t, L, y);
    y = doc.y + 4;
    doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.8).strokeColor(BLUE).stroke();
    y += 6;
  };
  const line = (label: string, value: string, bold = false) => {
    need(16);
    doc.font(bold ? B : R).fontSize(9.5).fillColor(INK).text(label, L, y, { width: W - 140 });
    doc.text(value, L + W - 140, y, { width: 140, align: 'right' });
    y += 15;
  };
  const note = (t: string) => {
    need(14);
    doc.font(R).fontSize(8).fillColor(MUTED).text(t, L, y, { width: W });
    y = doc.y + 6;
  };
  const table = (cols: Col[], rows: string[][], total?: string[]) => {
    const head = () => {
      doc.save().rect(L, y, W, 16).fill(HEAD_BG).restore();
      let x = L;
      doc.font(B).fontSize(7.5).fillColor(INK);
      for (const c of cols) { doc.text(c.label, x + 3, y + 4, { width: c.w - 6, align: c.right ? 'right' : 'left' }); x += c.w; }
      y += 16;
    };
    need(34); head();
    const draw = (cells: string[], bold: boolean) => {
      doc.font(bold ? B : R).fontSize(8);
      const h = Math.max(...cols.map((c, i) => doc.heightOfString(cells[i] ?? '', { width: c.w - 6 }))) + 6;
      if (y + h > BOTTOM) { doc.addPage(); y = 40; head(); }
      let x = L;
      doc.fillColor(INK);
      cols.forEach((c, i) => { doc.font(bold ? B : R).fontSize(8).text(cells[i] ?? '', x + 3, y + 3, { width: c.w - 6, align: c.right ? 'right' : 'left' }); x += c.w; });
      y += h;
      doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.4).strokeColor(RULE).stroke();
    };
    for (const row of rows) draw(row, false);
    if (total) draw(total, true);
    y += 8;
  };

  /* 1. Sales */
  const t = r.sales.totals;
  heading('1. Sales');
  line(`Invoiced, before GCT (${t.invoices} invoice${t.invoices === 1 ? '' : 's'}, ${t.customers} customer${t.customers === 1 ? '' : 's'})`, cash(t.invoicedNetCents));
  if (r.sales.credits.length) line(`Less ${r.sales.credits.length} credit note${r.sales.credits.length === 1 ? '' : 's'}, before GCT`, cash(-t.creditNetCents));
  line('Net sales invoiced, before GCT', cash(t.netAfterCreditsCents), true);
  line('Net sales invoiced, with GCT', cash(t.grossAfterCreditsCents));
  if (r.sales.notInvoiced.deliveries) {
    line(`Delivered to weekly/monthly customers, not invoiced yet (${r.sales.notInvoiced.deliveries})`, cash(t.notInvoicedNetCents));
    line('Total sales for the day, before GCT', cash(t.totalSalesNetCents), true);
  }
  line('Paid so far on these invoices', cash(t.paidOnTheseCents));
  line('Still owed on these invoices', cash(t.stillOwedOnTheseCents));
  y += 4;
  if (r.sales.byHow.length) {
    table([{ label: 'How it was sold', w: 300 }, { label: 'Invoices', w: 100, right: true }, { label: 'Before GCT', w: 140, right: true }],
      r.sales.byHow.map((h) => [h.how, String(h.count), cash(h.netCents)]));
  }
  if (r.sales.byProduct.length) {
    table([{ label: 'Product', w: 300 }, { label: 'Quantity', w: 100, right: true }, { label: 'Before discount and GCT', w: 140, right: true }],
      r.sales.byProduct.map((p) => [short(p.name), qtyWords(p.bottlesPerCase, p.cases, p.bottles), cash(p.cents)]));
  }
  if (r.sales.invoices.length) {
    table([{ label: 'Invoice', w: 70 }, { label: 'Customer', w: 150 }, { label: 'How', w: 110 }, { label: 'Before GCT', w: 70, right: true },
      { label: 'Total', w: 70, right: true }, { label: 'Still owed', w: 70, right: true }],
    r.sales.invoices.map((s) => [s.number, s.customer, s.how, cash(s.netCents), cash(s.totalCents), s.balanceCents > 0 ? cash(s.balanceCents) : 'paid']),
    ['', `${r.sales.invoices.length} invoices`, '', cash(t.invoicedNetCents), cash(t.invoicedGrossCents), cash(t.stillOwedOnTheseCents)]);
  } else note('No invoices dated this day.');
  if (r.sales.credits.length) {
    table([{ label: 'Credit note', w: 80 }, { label: 'Customer', w: 160 }, { label: 'Against / why', w: 200 }, { label: 'Total', w: 100, right: true }],
      r.sales.credits.map((c) => [c.number, c.customer, [c.against, c.reason].filter(Boolean).join(' · '), cash(-c.totalCents)]));
  }
  if (r.sales.notInvoiced.items.length) {
    table([{ label: 'Not invoiced yet', w: 90 }, { label: 'Customer', w: 160 }, { label: 'What went', w: 290 }],
      r.sales.notInvoiced.items.map((d) => [`${d.orderNumber}`, `${d.customer} (${d.cycle.toLowerCase()})`,
        d.lines.map((l) => `${qtyWords(l.bottlesPerCase, l.cases, l.bottles)} ${short(l.name)}`).join(', ')]));
    note('These go on the customer\'s weekly or monthly invoice, dated the last day of the week or month.');
  }

  /* 2. Money */
  const m = r.money;
  heading('2. Money collected');
  line('Received and confirmed', cash(m.confirmedCents), true);
  if (m.provisionalCents) line('Recorded on rounds, not settled yet', cash(m.provisionalCents));
  y += 4;
  if (m.payments.length) {
    table([{ label: 'Method', w: 300 }, { label: 'Payments', w: 100, right: true }, { label: 'Amount', w: 140, right: true }],
      m.byMethod.map((g) => [g.label, String(g.count), cash(g.cents)]));
    table([{ label: 'Taken by', w: 300 }, { label: 'Payments', w: 100, right: true }, { label: 'Amount', w: 140, right: true }],
      m.byWho.map((g) => [g.label, String(g.count), cash(g.cents)]));
    table([{ label: 'Time', w: 50 }, { label: 'Customer', w: 140 }, { label: 'Method', w: 70 }, { label: 'Receipt / invoice', w: 110 },
      { label: 'Taken by', w: 100 }, { label: 'Amount', w: 70, right: true }],
    m.payments.map((p) => [p.at, p.customer, p.method + (p.reversal ? ' (reversed)' : ''), [p.receipt, p.invoice].filter(Boolean).join(' · ') || 'on account',
      p.takenBy + (p.confirmed ? '' : ' · not settled'), cash(p.amountCents)]),
    ['', `${m.payments.length} payments`, '', '', '', cash(m.totalCents)]);
  } else note('No payments dated this day.');

  /* 3. Rounds */
  const rt = r.rounds.totals;
  heading('3. Rounds and bottles');
  if (r.rounds.rounds.length) {
    table([{ label: 'Round', w: 100 }, { label: 'Driver', w: 90 }, { label: 'Stops', w: 90, right: true }, { label: 'Recorded', w: 70, right: true },
      { label: 'Handed in', w: 90, right: true }, { label: 'Bottles out / back', w: 100, right: true }],
    r.rounds.rounds.map((x) => [x.zone, x.driver ?? '-',
      `${x.delivered} of ${x.stops}${x.missed ? `, ${x.missed} not del.` : ''}${x.pending ? `, ${x.pending} not done` : ''}`,
      cash(x.recordedCents),
      x.handedInCents === null ? 'not settled' : `${cash(x.handedInCents)}${x.cashVarianceCents ? `\n${x.cashVarianceCents < 0 ? 'short' : 'over'} ${cash(Math.abs(x.cashVarianceCents))}` : ''}`,
      `${x.fullOut} / ${x.emptiesCounted ?? x.emptiesRecorded}`]),
    ['', '', `${rt.delivered} of ${rt.stops}`, cash(rt.recordedCents), cash(rt.handedInCents),
      `${r.rounds.rounds.reduce((a, x) => a + x.fullOut, 0)} / ${r.rounds.rounds.reduce((a, x) => a + (x.emptiesCounted ?? x.emptiesRecorded), 0)}`]);
    note('Recorded = what drivers entered at the stops. Handed in = what was counted at settlement.');
  } else note('No rounds this day.');

  /* 4. Orders */
  heading('4. Orders');
  const orderTable = (rows: typeof r.orders.taken, withFor: boolean) => table(
    [{ label: 'Order', w: 65 }, { label: 'Customer', w: 135 }, { label: withFor ? 'For' : 'Zone', w: 75 }, { label: 'Items', w: 185 }, { label: 'From', w: 80 }],
    rows.map((o) => [o.number, o.customer, withFor ? (o.mode === 'Pickup' ? 'collect ' : '') + (o.forDay ?? '-') : (o.zone ?? (o.mode === 'Pickup' ? 'collect' : '-')), o.items, o.source]));
  doc.font(B).fontSize(9.5).fillColor(INK).text(`Taken today: ${r.orders.taken.length}`, L, y); y = doc.y + 4;
  if (r.orders.taken.length) orderTable(r.orders.taken, true); else note('No new orders taken.');
  need(30);
  doc.font(B).fontSize(9.5).fillColor(INK).text(`Booked for ${longDay(r.tomorrow)}: ${r.orders.booked.length}`, L, y); y = doc.y + 4;
  if (r.orders.booked.length) orderTable(r.orders.booked, false); else note('Nothing booked yet.');

  // Page numbers.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // the footer sits below the margin; without this it starts a new page
    doc.font(R).fontSize(7.5).fillColor(MUTED)
      .text(`End of day · ${r.day} · page ${i + 1} of ${range.count}`, L, 762, { width: W, align: 'right', lineBreak: false });
  }
  doc.end();
  return { filename: `end-of-day-${r.day}.pdf`, pdf: await finished };
}
