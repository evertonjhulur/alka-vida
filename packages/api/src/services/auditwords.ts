/**
 * The audit log in plain words (Everton, 27 Oct 2026: "the audit log
 * descriptions are vague and not truly explanative").
 *
 * Every audit row keeps what the code knew when it happened - often only
 * ids. Here each row is turned into one sentence a person can read: who the
 * customer was, which invoice and receipt, which round and day, how much, by
 * what method, why. Ids are looked up in one batch per kind of record, so a
 * page of 200 rows costs a handful of queries. The stored row is never
 * changed; this is read-time only.
 */

import type { Queryable } from '../db/index.ts';
import { num } from './core.ts';

type Row = {
  id: string; ts: string; user_name: string; action: string; entity_type: string;
  entity_id: string | null; entity_label: string | null; details: Record<string, unknown> | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const cash = (c: unknown) => {
  const n = Math.round(Number(c) || 0);
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-JM')}.${String(abs % 100).padStart(2, '0')}`;
};
const dayWords = (iso: unknown) => {
  const s = String(iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(`${s}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
const businessDay = (ts: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Jamaica' }).format(new Date(ts));

interface Lookups {
  payment: Map<string, { receipt: string | null; amount: number; method: string; customer: string; invoice: string | null;
    day: string; reversal: boolean; kind: string | null; round: string | null }>;
  sheet: Map<string, string>;
  sheetNotes: Map<string, string>;
  stop: Map<string, { order: string | null; customer: string; round: string }>;
  invoice: Map<string, { number: string; customer: string }>;
  order: Map<string, { number: string; customer: string }>;
  customer: Map<string, string>;
  approval: Map<string, { type: string; label: string | null; customer: string | null }>;
  product: Map<string, string>;
}

/** Every id the page mentions, looked up once. */
async function lookups(db: Queryable, rows: Row[]): Promise<Lookups> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.entity_type === type && isId(r.entity_id)).map((r) => r.entity_id as string))];
  // Every id held anywhere in the details (nested lists included), by its key.
  const found = new Map<string, Set<string>>();
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 4 || v === null || v === undefined) return;
    if (isId(v)) { if (!found.has(key)) found.set(key, new Set()); found.get(key)!.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
  };
  for (const r of rows) walk(r.details, '', 0);
  const detailIds = (...keys: string[]) => [...new Set(keys.flatMap((k) => [...(found.get(k) ?? [])]))];
  const paymentIds = [...new Set([...ids('Payment'), ...detailIds('reversesPaymentId', 'replacedPaymentId', 'newPaymentId')])];
  const sheetIds = [...new Set([...ids('DeliverySheet'), ...rows.filter((r) => r.entity_type === 'DeliverySheet' && isId(r.entity_label)).map((r) => r.entity_label as string)])];
  const stopIds = [...new Set([...ids('DeliveryStop'), ...detailIds('paymentStop', 'paymentOnlyStop')])];
  const invoiceIds = [...new Set([...ids('Invoice'), ...detailIds('invoiceId', 'linkedInvoiceId', 'creditNoteId')])];
  const orderIds = [...new Set([...ids('CustomerOrder'), ...detailIds('orderId', 'addedOrderId', 'entityId'),
    ...rows.filter((r) => r.entity_type === 'DeliveryStop' && isId(r.entity_label)).map((r) => r.entity_label as string)])];
  const customerIds = [...new Set([...ids('Customer'), ...detailIds('customerId', 'newCustomerId')])];
  const approvalIds = ids('ApprovalRequest');
  const productIds = detailIds('productId');

  const q = async <T>(list: string[], sql: string) => (list.length ? db.query<T>(sql, [list]) : Promise.resolve([] as T[]));
  const [pays, sheets, stops, invs, ords, custs, apprs, prods] = await Promise.all([
    q<Record<string, unknown>>(paymentIds,
      `SELECT p.id, p.receipt_number, p.amount_cents, p.method, c.name AS customer, i.invoice_number,
              business_date(p.payment_date)::text AS day, p.is_reversal, p.kind,
              CASE WHEN d.id IS NOT NULL THEN d.zone || ' round, ' || to_char(d.delivery_date, 'Dy DD Mon') END AS round
       FROM payments p JOIN customers c ON c.id = p.customer_id
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN delivery_stops st ON st.id = p.delivery_stop_id
       LEFT JOIN delivery_sheets d ON d.id = COALESCE(p.delivery_sheet_id, st.delivery_sheet_id)
       WHERE p.id = ANY($1::uuid[])`),
    q<Record<string, unknown>>(sheetIds,
      `SELECT id, zone || ' round, ' || to_char(delivery_date, 'Dy DD Mon') AS label,
              concat_ws(E'\\n', NULLIF(settlement_notes, ''), NULLIF(bottle_settle_notes, '')) AS notes
       FROM delivery_sheets WHERE id = ANY($1::uuid[])`),
    q<Record<string, unknown>>(stopIds,
      `SELECT st.id, st.order_ref, c.name AS customer, d.zone || ' round, ' || to_char(d.delivery_date, 'Dy DD Mon') AS round
       FROM delivery_stops st JOIN customers c ON c.id = st.customer_id JOIN delivery_sheets d ON d.id = st.delivery_sheet_id
       WHERE st.id = ANY($1::uuid[])`),
    q<Record<string, unknown>>(invoiceIds,
      `SELECT i.id, i.invoice_number, c.name AS customer FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ANY($1::uuid[])`),
    q<Record<string, unknown>>(orderIds,
      `SELECT o.id, o.order_number, c.name AS customer FROM customer_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ANY($1::uuid[])`),
    q<Record<string, unknown>>(customerIds, `SELECT id, name FROM customers WHERE id = ANY($1::uuid[])`),
    q<Record<string, unknown>>(approvalIds,
      `SELECT a.id, a.request_type, a.entity_label, c.name AS customer FROM approval_requests a
       LEFT JOIN customers c ON c.id = a.customer_id WHERE a.id = ANY($1::uuid[])`),
    q<Record<string, unknown>>(productIds, `SELECT id, name FROM products WHERE id = ANY($1::uuid[])`),
  ]);
  return {
    payment: new Map(pays.map((p) => [p.id as string, {
      receipt: (p.receipt_number as string) ?? null, amount: num(p.amount_cents), method: p.method as string,
      customer: p.customer as string, invoice: (p.invoice_number as string) ?? null, day: p.day as string,
      reversal: !!p.is_reversal, kind: (p.kind as string) ?? null, round: (p.round as string) ?? null,
    }])),
    sheet: new Map(sheets.map((s) => [s.id as string, s.label as string])),
    sheetNotes: new Map(sheets.filter((s) => s.notes).map((s) => [s.id as string, s.notes as string])),
    stop: new Map(stops.map((s) => [s.id as string, { order: (s.order_ref as string) ?? null, customer: s.customer as string, round: s.round as string }])),
    invoice: new Map(invs.map((i) => [i.id as string, { number: i.invoice_number as string, customer: i.customer as string }])),
    order: new Map(ords.map((o) => [o.id as string, { number: o.order_number as string, customer: o.customer as string }])),
    customer: new Map(custs.map((c) => [c.id as string, c.name as string])),
    approval: new Map(apprs.map((a) => [a.id as string, { type: a.request_type as string, label: (a.entity_label as string) ?? null, customer: (a.customer as string) ?? null }])),
    product: new Map(prods.map((p) => [p.id as string, p.name as string])),
  };
}

const REQUEST_WORDS: Record<string, string> = {
  SameDayOrder: 'same-day order', SpecialDayOrder: 'order for a day that is not theirs', Discount: 'discount',
  CreditNote: 'credit note', PaymentChange: 'payment change', StopCorrection: 'delivery correction',
};

/** One sentence for one row. Never throws: a row it cannot word gets a plain fallback. */
function sentence(r: Row, L: Lookups): string {
  const d = (r.details ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const why = d.reason ? ` Reason: "${String(d.reason)}".` : '';
  const inv = (id: unknown) => (isId(id) ? L.invoice.get(id)?.number ?? 'an invoice' : null);
  const cust = (id: unknown) => (isId(id) ? L.customer.get(id) ?? 'a customer' : null);
  const pay = r.entity_id ? L.payment.get(r.entity_id) : undefined;
  const payName = (p?: { receipt: string | null; amount: number; method: string }) =>
    p ? `${p.receipt ? `${p.receipt} ` : ''}(${cash(p.amount)} ${p.method.toLowerCase()})` : 'a payment';
  const loggedDay = businessDay(r.ts);
  const datedNote = (day: string | null | undefined) => (day && day !== loggedDay ? ` Dated ${dayWords(day)}.` : '');

  switch (r.entity_type) {
    case 'Payment': {
      if (r.action === 'pay') {
        const to = pay?.invoice ? `against invoice ${pay.invoice}` : 'on account (not against an invoice)';
        const from = pay?.round ? ` from the ${pay.round} settlement` : '';
        return `Payment ${payName(pay)} from ${pay?.customer ?? cust(d.customerId) ?? 'a customer'} recorded ${to}${from}.${datedNote(pay?.day)}`
          + (d.reference ? ` Reference ${d.reference}.` : '');
      }
      if (d.reversesPaymentId) {
        const orig = L.payment.get(d.reversesPaymentId);
        return `Reversed payment ${payName(orig)} from ${orig?.customer ?? pay?.customer ?? 'a customer'}${orig?.invoice ? ` on invoice ${orig.invoice}` : ''}; the original stays on record beside the reversal.${why}`;
      }
      if (d.applied) {
        return `${cash(d.amountCents)} of ${pay?.customer ?? 'the customer'}'s money on account (${pay?.receipt ?? 'payment'}) put against invoice ${d.invoiceNumber ?? inv(d.invoiceId)}`
          + (d.applied === 'split' ? `; ${cash(d.leftUnattachedCents)} stays on account.` : '.');
      }
      if (d.movedToCredit) {
        return `Payment ${payName(pay)} taken off ${d.from ?? 'its invoice'} and left on ${pay?.customer ?? 'the customer'}'s account as credit.${why}`;
      }
      if (d.receiptEmailedTo) return `Receipt ${r.entity_label ?? ''} emailed to ${d.receiptEmailedTo}.`;
      if (d.before && d.after && ('customerId' in d.before || 'invoiceId' in d.before)) {
        const side = (s: Record<string, unknown>) => `${cust(s.customerId) ?? ''}${s.invoiceId ? `, invoice ${inv(s.invoiceId)}` : ', on account'}`;
        return `Payment ${payName(pay)} moved from ${side(d.before)} to ${side(d.after)}.${why}`;
      }
      if (d.changes) {
        const ch = Object.entries(d.changes as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => (/Cents$/.test(k) ? `${k.replace(/Cents$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()} ${cash(v)}`
            : `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${isId(v) ? (inv(v) ?? cust(v) ?? '') : String(v)}`));
        return `Payment ${payName(pay)} for ${pay?.customer ?? 'a customer'} changed: ${ch.join(', ') || 'details'}.${why}`;
      }
      break;
    }
    case 'DeliverySheet': {
      const round = (r.entity_id && L.sheet.get(r.entity_id)) || (isId(r.entity_label) ? L.sheet.get(r.entity_label) : r.entity_label) || 'a round';
      if (r.action === 'finalize') {
        const v = num(d.cashVarianceCents);
        return `Settled the ${round}: ${d.paymentsCreated ?? 0} payment${Number(d.paymentsCreated) === 1 ? '' : 's'} posted to customers' accounts; `
          + `cash expected ${cash(d.expectedCashCents)}, counted ${cash(d.actualCashCents)}`
          + (v ? ` (${v < 0 ? 'short' : 'over'} ${cash(Math.abs(v))}, the driver's to explain).` : ' (balanced).')
          + (d.bottleVariance ? ` Bottles ${Number(d.bottleVariance) < 0 ? 'short' : 'over'} by ${Math.abs(Number(d.bottleVariance))}.` : '')
          + (d.notes || d.bottleNotes
            ? (d.notes ? ` Notes: "${String(d.notes).replace(/\s*\n\s*/g, '; ')}".` : '')
              + (d.bottleNotes ? ` Bottle notes: "${String(d.bottleNotes).replace(/\s*\n\s*/g, '; ')}".` : '')
            // Settled before notes were logged: the round's notes as they are now.
            : (r.entity_id && L.sheetNotes.get(r.entity_id) ? ` Notes: "${L.sheetNotes.get(r.entity_id)!.replace(/\s*\n\s*/g, '; ')}".` : ''));
      }
      if (r.action === 'delete') return `Deleted the ${r.entity_label ?? 'round'} round.${Array.isArray(d.ordersBackToWaiting) && d.ordersBackToWaiting.length ? ` Orders back to waiting: ${d.ordersBackToWaiting.join(', ')}.` : ''}`;
      if (d.assignedDriverId || d.driverName) return `${d.driverName ?? 'A driver'} assigned to the ${round}.`;
      if (d.unassigned) return `Driver taken off the ${round}.`;
      if (d.started) return `The ${round} was started.`;
      if (d.addedOrderId) { const o = L.order.get(d.addedOrderId); return `Order ${o?.number ?? ''} (${o?.customer ?? 'a customer'}) added to the ${round} by hand.`; }
      if (d.resequenced || d.order) return `The stop order on the ${round} was changed.`;
      if (d.paymentOnlyStop) return `Payment-only stop recorded for ${r.entity_label}: ${cash(d.amountCents)} ${String(d.method ?? '').toLowerCase()}, nothing delivered. It counts once the round is settled.`;
      if (d.collectPaymentStop) return `"Collect payment" stop planned for ${r.entity_label}.`;
      if (d.loaded) return `Truck loading ${d.reloaded ? 're-logged' : 'logged'} for the ${round}${Array.isArray(d.loaders) && d.loaders.length ? `, loaded by ${d.loaders.join(', ')}` : ''}.`;
      if (d.loadAddition) return `Goods added to the load of the ${round}, waiting for the driver to confirm.`;
      if (d.driverConfirmedAddition) return `The driver confirmed goods added to the load of the ${round}.`;
      if (d.cancelledAddition) return `Goods added to the load of the ${round} were taken back off.`;
      if (d.collectionId || d.kind) return `${d.kind ?? ''} collection on the ${round}: ${String(d.status ?? '').toLowerCase()}${d.emptiesCount ? `, ${d.emptiesCount} empties` : ''}.`;
      break;
    }
    case 'DeliveryStop': {
      const st = r.entity_id ? L.stop.get(r.entity_id) : undefined;
      const order = st?.order ?? (isId(r.entity_label) ? L.order.get(r.entity_label)?.number : r.entity_label) ?? 'a stop';
      const who = st?.customer ?? (isId(r.entity_label) ? L.order.get(r.entity_label)?.customer : null) ?? 'the customer';
      const where = st?.round ? ` on the ${st.round}` : '';
      if (r.action === 'deliver') {
        const money = Number(d.paymentAmountCents) > 0 ? `; ${cash(d.paymentAmountCents)} ${String(d.paymentMethod ?? '').toLowerCase()} taken (counts once the round is settled)` : '; no payment taken';
        return `${d.outcome ?? 'Recorded'}: ${order} for ${who}${where}${d.invoiceId ? `; invoice ${inv(d.invoiceId)} raised` : ''}${money}.`;
      }
      if (d.paymentAfterDelivery) return `Payment after delivery recorded for ${order} (${who})${where}: ${cash(d.amountCents)} ${String(d.method ?? '').toLowerCase()}, counts once the round is settled.`;
      if (d.provisionalAllocation) {
        const parts = (d.provisionalAllocation as Array<Record<string, unknown>>).map((a) => `${cash(a.amountCents)} to ${inv(a.invoiceId) ?? 'account'}`);
        return `The driver split the money taken at ${order} (${who})${where}: ${parts.join(', ') || 'nothing'}.`;
      }
      if (d.adjustedAllocation) {
        const parts = (d.adjustedAllocation as Array<Record<string, unknown>>).map((a) => `${cash(a.amountCents)} to ${inv(a.invoiceId) ?? 'account'}`);
        return `At settlement, the money taken at ${order} (${who})${where} was split: ${parts.join(', ') || 'nothing'}.`;
      }
      if (d.removedFromRoute) return `${order} (${who}) taken off the round${where ? `: ${st?.round}` : ''}.`;
      if (d.before && d.changes) return `Delivery at ${order} (${who})${where} corrected after settlement by ${d.correctedBy ?? r.user_name}.${why}`;
      if ('bottlesWas' in d) return `5-gallon bottles at ${order} (${who}) changed from ${d.bottlesWas} to ${d.bottlesNow}.${why}`;
      break;
    }
    case 'Invoice': {
      const number = r.entity_label ?? (r.entity_id ? L.invoice.get(r.entity_id)?.number : null) ?? 'an invoice';
      const who = (r.entity_id && L.invoice.get(r.entity_id)?.customer) || cust(d.customerId) || 'a customer';
      if (r.action === 'create') {
        if (d.isCreditNote || d.autoGenerated) return `Credit note ${number} for ${who}: ${cash(Math.abs(Number(d.amountCents)))}${d.linkedInvoiceId ? ` against ${inv(d.linkedInvoiceId)}` : ''}.${why}`;
        if (d.openingBalance) return `Balance ${number} brought across from QuickBooks for ${who}: ${cash(d.amountCents)}.`;
        return `Invoice ${number} raised for ${who}: ${cash(d.grandTotalCents)}.`;
      }
      if (d.lifecycle === 'Cancelled' || d.voided) return `Invoice ${number} (${who}) ${d.voided ? 'voided' : 'cancelled'}.${why}`;
      if (d.lifecycle === 'Sent') return `Invoice ${number} (${who}) marked as sent.`;
      if (d.emailedTo) return `Invoice ${number} emailed to ${d.emailedTo}.`;
      if (d.before && d.after) {
        const b = d.before; const a = d.after; const parts: string[] = [];
        if (b.grandTotalCents !== a.grandTotalCents) parts.push(`total ${cash(b.grandTotalCents)} → ${cash(a.grandTotalCents)}`);
        if (b.invoiceDate && b.invoiceDate !== a.invoiceDate) parts.push(`date ${dayWords(b.invoiceDate)} → ${dayWords(a.invoiceDate)}`);
        if ((b.dueDate ?? null) !== (a.dueDate ?? null)) parts.push(`due ${dayWords(b.dueDate) || 'none'} → ${dayWords(a.dueDate) || 'none'}`);
        if ('openingReference' in a && b.openingReference !== a.openingReference) parts.push(`QuickBooks no. ${b.openingReference ?? 'none'} → ${a.openingReference ?? 'none'}`);
        return `Invoice ${number} (${who}) changed: ${parts.join('; ') || 'products or prices'}${d.creditNoteId ? `; credit note ${inv(d.creditNoteId)} raised for what was paid above the new total` : ''}.${why}`;
      }
      if (d.approvedInline) return `Discount of ${d.discountPercent}% given on invoice ${number} (${who}).`;
      break;
    }
    case 'CustomerOrder': {
      const o = r.entity_id ? L.order.get(r.entity_id) : undefined;
      const number = r.entity_label ?? o?.number ?? 'an order';
      const who = o?.customer ?? cust(d.customerId) ?? 'a customer';
      if (r.action === 'create') {
        const bits = [d.grandTotalCents !== undefined ? cash(d.grandTotalCents) : '', d.deliveryMode ? String(d.deliveryMode).toLowerCase() : '',
          d.recordedLate || d.deliveredOn ? `recorded for ${dayWords(d.deliveredOn)}` : ''].filter(Boolean);
        return `Order ${number} ${d.recordedLate || d.deliveredOn ? 'entered' : 'taken'} for ${who}${bits.length ? `: ${bits.join(', ')}` : ''}.`;
      }
      if (d.sameDayDecision || d.specialDayDecision) {
        const dec = d.sameDayDecision ?? d.specialDayDecision;
        return `${d.sameDayDecision ? 'Same-day' : 'Special-day'} request for ${number} (${who}): ${String(dec).toLowerCase()}`
          + (d.alreadyDelivered ? ' - it had already been delivered, so nothing was moved.' : d.deliveryDate ? `, for ${dayWords(d.deliveryDate)}.` : '.');
      }
      if (d.dateRequestSettled) return `${number} (${who}): ${d.dateRequestSettled}; its waiting request was settled as approved.`;
      if (d.status === 'Cancelled') return `Order ${number} (${who}) cancelled${d.cancelledByCustomer ? ' by the customer' : ''}.${why}`;
      if (d.emailedConfirmationTo) return `Confirmation of ${number} emailed to ${d.emailedConfirmationTo}.`;
      if ('markedReady' in d) return `Order ${number} (${who}) marked ${d.markedReady ? 'ready' : 'not ready'}.`;
      if (d.startedSchedule) return `${number} (${who}) made a standing order, ${String(d.pattern ?? '').toLowerCase()}, next ${dayWords(d.nextDeliveryDate)}.`;
      if ('recurrencePaused' in d) return `Standing order ${number} (${who}) ${d.recurrencePaused ? 'paused' : 'restarted'}.`;
      if (d.endedSchedule) return `Standing order ${number} (${who}) ended.${why}`;
      if (d.stockBack) return `Delivery of ${number} (${who}) undone: order cancelled, goods back on the shelf.${why}`;
      if ('grandTotalCents' in d) {
        const moved = d.deliveryDateTo ? ` Delivery moved${d.deliveryDateFrom ? ` from ${dayWords(d.deliveryDateFrom)}` : ''} to ${dayWords(d.deliveryDateTo)}`
          + (d.roundTo ? ` (now on the ${d.roundTo}${d.roundFrom ? `, off the ${d.roundFrom}` : ''}).` : '.') : '';
        return `Order ${number} (${who}) changed: total ${cash(d.grandTotalCents)}.${moved}`;
      }
      break;
    }
    case 'ApprovalRequest': {
      const a = r.entity_id ? L.approval.get(r.entity_id) : undefined;
      const what = REQUEST_WORDS[a?.type ?? r.entity_label ?? ''] ?? (a?.type ?? r.entity_label ?? 'request');
      if (d.decision) return `${d.decision} the ${what} request for ${a?.label ?? ''}${a?.customer ? ` (${a.customer})` : ''}.${d.reviewNotes ? ` Note: "${d.reviewNotes}".` : ''}`;
      break;
    }
    case 'Customer': {
      const name = r.entity_label ?? (r.entity_id ? L.customer.get(r.entity_id) : null) ?? 'a customer';
      if (r.action === 'create') return d.from === 'customer upload' ? `Customer ${name} brought in from the customer upload.` : `Customer ${name} added.`;
      break;
    }
    default: break;
  }
  return '';
}

/** What the record column should say, instead of an id. */
function recordLabel(r: Row, L: Lookups): string | null {
  const id = r.entity_id ?? '';
  switch (r.entity_type) {
    case 'Payment': { const p = L.payment.get(id); return p ? `${p.receipt ?? 'Payment'} · ${p.customer}` : (isId(r.entity_label) ? null : r.entity_label); }
    case 'DeliverySheet': return L.sheet.get(id) ?? (isId(r.entity_label) ? L.sheet.get(r.entity_label as string) ?? null : r.entity_label);
    case 'DeliveryStop': { const st = L.stop.get(id); return st ? `${st.order ?? 'Stop'} · ${st.customer}` : (isId(r.entity_label) ? L.order.get(r.entity_label as string)?.number ?? null : r.entity_label); }
    case 'Invoice': { const i = L.invoice.get(id); return i ? `${i.number} · ${i.customer}` : r.entity_label; }
    case 'CustomerOrder': { const o = L.order.get(id); return o ? `${o.number} · ${o.customer}` : r.entity_label; }
    case 'ApprovalRequest': { const a = L.approval.get(id); return a ? `${REQUEST_WORDS[a.type] ?? a.type}: ${a.label ?? ''}` : r.entity_label; }
    default: return isId(r.entity_label) ? null : r.entity_label;
  }
}

/** Adds `summary` (a sentence) and `record` (a readable label) to each row. */
export async function describeAuditRows<T extends Row>(db: Queryable, rows: T[]): Promise<Array<T & { summary: string; record: string | null }>> {
  let L: Lookups;
  try { L = await lookups(db, rows); } catch { return rows.map((r) => ({ ...r, summary: '', record: r.entity_label })); }
  return rows.map((r) => {
    let s = ''; let rec: string | null = r.entity_label;
    try { s = sentence(r, L); } catch { s = ''; }
    try { rec = recordLabel(r, L); } catch { rec = r.entity_label; }
    return { ...r, summary: s, record: rec };
  });
}
