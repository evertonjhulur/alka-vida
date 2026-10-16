/**
 * Everton's round of 15 Oct 2026.
 *
 *   - Rounds: money the driver did not split goes to the oldest open invoice
 *     first; with only this delivery's invoice open, it goes there.
 *   - Stock count: dated to an earlier day, applied as it is saved, with what
 *     moved since carried forward.
 *   - Portal: an order's own page, standing orders changed from Order History.
 *   - The audit log can be read back, admin only.
 *   - A counter sale's receipt is a sales receipt: items, totals, payment.
 *   - Statements narrowed to several invoice states at once.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop, saveStopAllocation } from '../src/services/delivery.ts';
import { settleRoute, getSettlementReview } from '../src/services/settlement.ts';
import { counterSale } from '../src/services/counter.ts';
import { recordCount, stockSnapshot } from '../src/services/audits.ts';
import { issueMaterial } from '../src/services/inventory.ts';
import { myOrderDetail, myScheduleDetail } from '../src/services/portal.ts';
import { startOwnSchedule, updateOwnSchedule } from '../src/services/recurring.ts';
import { listAuditLog, auditLogFilters } from '../src/services/auditlog.ts';
import { renderReceiptPdf } from '../src/services/paperwork.ts';
import { getStatement } from '../src/services/ledger.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

let n = 0;
const customer = async () => (await f.db.one<{ id: string }>(
  `INSERT INTO customers (name, phone, email, price_tier_id, delivery_address, delivery_zone, payment_terms)
   VALUES ($1, '876-555-0100', '', $2, '1 Test Rd, Kingston', 'Kingston', 'Net 30') RETURNING id`,
  [`Fifteenth ${++n}`, f.tierId],
)).id;

function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let out = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    let body: string;
    try { body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const h of body.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1], 'hex').toString('latin1');
    out += '\n';
  }
  return out;
}

const ledgerOf = (id: string) => f.db.one<{ balance_cents: string; status: string }>(
  `SELECT balance_cents, status FROM invoice_ledger WHERE invoice_id = $1`, [id]);

async function deliveredWithCash(customerId: string, date: string, cash: number) {
  const order = await createOrder(f.db, f.office, {
    customerId, deliveryMode: 'Delivery', requestedDeliveryDate: date,
    lines: [{ productId: f.casedProductId, cases: 1 }],
  });
  const stops = await stopsOf(f.db, order.deliverySheetId!);
  const stop = stops.find((s) => s.order_id === order.id) ?? stops[stops.length - 1];
  const r = await markStop(f.db, f.driver, {
    stopId: stop.id, outcome: 'Delivered', paymentReceived: cash > 0, paymentMethod: 'Cash', paymentAmountCents: cash,
  });
  return { order, stopId: stop.id, invoiceId: r.invoiceId!, sheetId: order.deliverySheetId! };
}

describe('Rounds: unsplit money goes to the oldest open invoice first', () => {
  test('an older unpaid invoice is paid before this delivery', async () => {
    const c = await customer();
    const old = await counterSale(f.db, f.office, { customerId: c, lines: [{ productId: f.casedProductId, cases: 1 }] });
    assert.ok(Number(old.balanceCents) > 0, 'the counter sale was left unpaid');
    const owedOld = Number(old.balanceCents);
    const d = await deliveredWithCash(c, '2026-05-04', owedOld + 50_000);

    const review = await getSettlementReview(f.db, d.sheetId);
    const row = review.stops.find((s) => s.stopId === d.stopId)!;
    assert.equal(row.allocations.length, 0, 'the driver split nothing');
    assert.equal(row.autoApplied[0].invoiceId, old.invoiceId, 'the review says the oldest goes first');
    assert.equal(row.autoApplied[0].amountCents, owedOld);

    await settleRoute(f.db, f.admin, d.sheetId, { actualCashCents: review.totalCollectedCents });
    assert.equal((await ledgerOf(old.invoiceId)).status, 'Paid');
    const now = await ledgerOf(d.invoiceId);
    const total = (await f.db.one<{ t: string }>(`SELECT grand_total_cents::text t FROM invoices WHERE id = $1`, [d.invoiceId])).t;
    assert.equal(Number(now.balance_cents), Number(total) - 50_000, 'the rest went to this delivery');
    const unattached = await f.db.query(`SELECT 1 FROM payments WHERE customer_id = $1 AND invoice_id IS NULL`, [c]);
    assert.equal(unattached.length, 0, 'nothing left floating on the account');
  });

  test('with only this delivery open, the money goes to this delivery', async () => {
    const c = await customer();
    const d = await deliveredWithCash(c, '2026-05-05', 30_000);
    await settleRoute(f.db, f.admin, d.sheetId, { actualCashCents: 30_000, complete: false });
    const paid = await f.db.query<{ invoice_id: string | null; amount_cents: string }>(
      `SELECT invoice_id, amount_cents FROM payments WHERE customer_id = $1`, [c]);
    assert.equal(paid.length, 1);
    assert.equal(paid[0].invoice_id, d.invoiceId);
    assert.equal(Number(paid[0].amount_cents), 30_000);
  });

  test('the driver\'s own split stands; only the rest goes oldest first; overflow stays on account', async () => {
    const c = await customer();
    const a = await counterSale(f.db, f.office, { customerId: c, lines: [{ productId: f.casedProductId, cases: 1 }] });
    const d = await deliveredWithCash(c, '2026-05-06', 0);
    const owedNew = Number((await ledgerOf(d.invoiceId)).balance_cents);
    // A payment stop on the same customer with more than everything owed.
    await f.db.query(`UPDATE delivery_stops SET payment_received = true, payment_method = 'Cash', payment_amount_cents = $2 WHERE id = $1`,
      [d.stopId, owedNew + Number(a.balanceCents) + 10_000]);
    await saveStopAllocation(f.db, f.office, d.stopId, [{ invoiceId: d.invoiceId, amountCents: owedNew }]);
    await settleRoute(f.db, f.admin, d.sheetId, { actualCashCents: 0, complete: false });
    assert.equal((await ledgerOf(d.invoiceId)).status, 'Paid');
    assert.equal((await ledgerOf(a.invoiceId)).status, 'Paid');
    const left = await f.db.query<{ amount_cents: string }>(
      `SELECT amount_cents FROM payments WHERE customer_id = $1 AND invoice_id IS NULL`, [c]);
    assert.equal(left.length, 1);
    assert.equal(Number(left[0].amount_cents), 10_000);
  });
});

describe('Stock count: dated, applied on save, later movements carried forward', () => {
  let capId: string;
  before(async () => {
    capId = (await f.db.one<{ id: string }>(
      `INSERT INTO raw_materials (name, unit_of_measure, quantity_on_hand, category) VALUES ('Count cap', 'pcs', 0, 'Cap') RETURNING id`,
    )).id;
    await f.db.query(
      `INSERT INTO material_batches (raw_material_id, unit_cost_cents, quantity_received, quantity_remaining) VALUES ($1, 10, 1000, 1000)`, [capId]);
    await f.db.query(`UPDATE raw_materials SET quantity_on_hand = 1000 WHERE id = $1`, [capId]);
  });

  test('a count saved with apply changes stock straight away, office user included', async () => {
    const r = await recordCount(f.db, f.office, {
      itemType: 'RawMaterial', itemId: capId, countedQty: 990, notes: '10 short', apply: true,
    });
    assert.equal(r.applied, true);
    assert.equal(r.adjusted, -10);
    const m = await f.db.one<{ q: string }>(`SELECT quantity_on_hand::text q FROM raw_materials WHERE id = $1`, [capId]);
    assert.equal(Number(m.q), 990);
    const a = await f.db.one<{ status: string }>(`SELECT status FROM inventory_audits WHERE id = $1`, [r.id]);
    assert.equal(a.status, 'Reconciled');
  });

  test('a count dated yesterday is measured then, and today\'s movement is kept', async () => {
    const today = (await f.db.one<{ d: string }>(`SELECT business_today()::text d`)).d;
    const yesterday = (await f.db.one<{ d: string }>(`SELECT (business_today() - 1)::text d`)).d;
    // Pretend everything so far happened before yesterday's close.
    await f.db.query(`UPDATE inventory_transactions SET txn_date = txn_date - interval '3 days' WHERE item_id = $1`, [capId]);
    // Today 40 go out.
    await issueMaterial(f.db, f.office, { rawMaterialId: capId, quantity: 40, reason: 'used today' });
    const snap = await stockSnapshot(f.db, yesterday);
    assert.equal(snap.asAt, yesterday);
    assert.equal(snap.rawMaterials.find((x) => x.id === capId)!.onHand, 990, 'as at yesterday\'s close');

    // Yesterday's floor count found 980: 10 short of the 990 held then.
    const r = await recordCount(f.db, f.office, {
      itemType: 'RawMaterial', itemId: capId, countedQty: 980, notes: 'counted last night', countDate: yesterday, apply: true,
    });
    assert.equal(r.systemQty, 990);
    assert.equal(r.discrepancy, -10);
    const m = await f.db.one<{ q: string }>(`SELECT quantity_on_hand::text q FROM raw_materials WHERE id = $1`, [capId]);
    assert.equal(Number(m.q), 940, '980 counted, less the 40 used today');
    const a = await f.db.one<{ audit_date: string }>(`SELECT audit_date::text FROM inventory_audits WHERE id = $1`, [r.id]);
    assert.equal(a.audit_date, yesterday);
    assert.notEqual(yesterday, today);
  });

  test('a count cannot be dated in the future', async () => {
    const tomorrow = (await f.db.one<{ d: string }>(`SELECT (business_today() + 1)::text d`)).d;
    await assert.rejects(recordCount(f.db, f.office, {
      itemType: 'RawMaterial', itemId: capId, countedQty: 940, countDate: tomorrow, apply: true,
    }), /future/);
  });
});

describe('Portal: an order\'s page and standing orders from Order History', () => {
  test('the order page has lines, totals and address, and is the customer\'s only', async () => {
    const c = await customer();
    const o = await createOrder(f.db, f.office, {
      customerId: c, deliveryMode: 'Delivery', requestedDeliveryDate: '2026-12-01',
      lines: [{ productId: f.casedProductId, cases: 3 }],
    });
    const d = await myOrderDetail(f.db, c, o.id) as unknown as {
      lines: Array<{ line_total_cents: string; cases: number }>; grand_total_cents: string; address: { line: string | null };
    };
    assert.equal(d.lines.length, 1);
    assert.equal(Number(d.lines[0].cases), 3);
    assert.equal(Number(d.grand_total_cents), o.grandTotalCents);
    assert.match(d.address.line ?? '', /Test Rd/);
    await assert.rejects(myOrderDetail(f.db, f.otherCustomerId, o.id), /could not be found/);
  });

  test('a standing order can be changed: how often and the next date', async () => {
    const c = await customer();
    const o = await createOrder(f.db, f.office, {
      customerId: c, deliveryMode: 'Delivery', requestedDeliveryDate: '2026-12-02',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const actor = { id: f.admin.id, name: 'Customer', role: 'customer' as const };
    await startOwnSchedule(f.db, actor, c, o.id, { pattern: 'Weekly' });
    await updateOwnSchedule(f.db, actor, c, o.id, { pattern: 'Monthly', nextDeliveryDate: '2027-01-02' });
    const s = await myScheduleDetail(f.db, c, o.id) as unknown as { pattern: string; next_delivery_date: string };
    assert.equal(s.pattern, 'Monthly');
    assert.equal(s.next_delivery_date, '2027-01-02');
    await assert.rejects(updateOwnSchedule(f.db, actor, c, o.id, { nextDeliveryDate: '2020-01-01' }), /passed/);
    await assert.rejects(updateOwnSchedule(f.db, actor, f.otherCustomerId, o.id, { pattern: 'Weekly' }), /could not be found/);
  });
});

describe('Audit log', () => {
  test('reads back what was done, filtered, admin only', async () => {
    const all = await listAuditLog(f.db, f.admin, { limit: 500 });
    assert.ok(all.rows.length > 0);
    const orders = await listAuditLog(f.db, f.admin, { types: ['CustomerOrder'], actions: ['create'] });
    assert.ok(orders.rows.length > 0 && orders.rows.every((r) => r.entity_type === 'CustomerOrder' && r.action === 'create'));
    const counts = await listAuditLog(f.db, f.admin, { q: 'count cap' });
    assert.ok(counts.rows.some((r) => r.entity_type === 'InventoryAudit'), 'found by a word in the label, any case');
    const page = await listAuditLog(f.db, f.admin, { limit: 2 });
    assert.equal(page.rows.length, 2);
    assert.equal(page.more, true);
    const next = await listAuditLog(f.db, f.admin, { limit: 2, before: String(page.rows[1].ts) });
    assert.ok(next.rows.every((r) => String(r.ts) < String(page.rows[1].ts)));
    const filters = await auditLogFilters(f.db, f.admin);
    assert.ok(filters.types.includes('CustomerOrder'));
    await assert.rejects(listAuditLog(f.db, f.office, {}));
  });
});

describe('Counter sale receipt', () => {
  test('is a sales receipt with the items, totals and payment', async () => {
    const c = await customer();
    const s = await counterSale(f.db, f.office, {
      customerId: c, lines: [{ productId: f.casedProductId, cases: 2 }], method: 'Cash', amountPaidCents: 276_000,
    });
    const ids = (await f.db.query<{ id: string }>(`SELECT id FROM payments WHERE invoice_id = $1`, [s.invoiceId])).map((r) => r.id);
    const doc = await renderReceiptPdf(f.db, ids);
    const text = pdfText(doc.pdf);
    assert.match(text, /SALES RECEIPT/);
    assert.match(text, /2 cs/);
    assert.match(text, /Subtotal/);
    assert.match(text, /GCT 15%/);
    assert.match(text, /Paid by Cash/);
    assert.match(text, /Paid in full/);
    assert.doesNotMatch(text, /APPLIED TO/);
  });

  test('a payment on account still gets the ordinary receipt', async () => {
    const c = await customer();
    const p = await f.db.one<{ id: string }>(
      `INSERT INTO payments (customer_id, amount_cents, method, status, receipt_number) VALUES ($1, 5000, 'Cash', 'Confirmed', 'RCT-T15') RETURNING id`, [c]);
    const text = pdfText((await renderReceiptPdf(f.db, [p.id])).pdf);
    assert.match(text, /APPLIED TO/);
  });
});

describe('Statement: several invoice states at once', () => {
  test('"Open,Paid" narrows to both', async () => {
    const c = await customer();
    await counterSale(f.db, f.office, { customerId: c, lines: [{ productId: f.casedProductId, cases: 1 }] });
    await counterSale(f.db, f.office, { customerId: c, lines: [{ productId: f.casedProductId, cases: 1 }], method: 'Cash', amountPaidCents: 138_000 });
    const both = await getStatement(f.db, c, { status: 'Open,Paid' });
    assert.deepEqual(both.statuses, ['Open', 'Paid']);
    assert.equal(both.entries.filter((e) => e.type === 'Invoice').length, 2);
    const open = await getStatement(f.db, c, { status: 'Open' });
    assert.equal(open.entries.filter((e) => e.type === 'Invoice').length, 1);
  });
});
