/**
 * The audit log in plain words, money taken today keeps its real time, and
 * settlement flags cash already taken at the office (Everton, 27 Oct 2026).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop } from '../src/services/delivery.ts';
import { receivePayment, reversePayment } from '../src/services/payments.ts';
import { getSettlementReview, settleRoute } from '../src/services/settlement.ts';
import { listAuditLog } from '../src/services/auditlog.ts';
import { roundsReport } from '../src/services/reports.ts';
import { getSheet } from '../src/services/delivery.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => {
  f = await setupFixture();
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 1000)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 1000`, [f.fiveGalProductId]);
});
after(async () => { await f.close(); });

describe('Audit words and the double-count check', () => {
  test('cash taken at the office for an order, then collected again by the driver', async () => {
    const day = addDays(businessToday(), 1);
    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: day, lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }] });
    // As the New order screen does with "Now": today's date.
    const p = await receivePayment(f.db, f.office, { customerId: f.customerId, amountCents: 103_500, method: 'Cash',
      paymentDate: businessToday(), orderId: o.id } as never);
    const when = await f.db.one<{ secs: number }>(
      `SELECT EXTRACT(EPOCH FROM (now() - payment_date))::int AS secs FROM payments WHERE id = $1`, [p.paymentIds[0]]);
    assert.ok(Math.abs(Number(when.secs)) < 120, 'dated now, not at noon');

    const st = await f.db.one<{ id: string; delivery_sheet_id: string }>(`SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [o.id]);
    await markStop(f.db, f.driver, { stopId: st.id, outcome: 'Delivered', paymentReceived: true, paymentMethod: 'Cash', paymentAmountCents: 103_500 } as never);
    const review = await getSettlementReview(f.db, st.delivery_sheet_id);
    const row = review.stops.find((s) => s.stopId === st.id)!;
    assert.equal(row.paidBeforeCents, 103_500, 'the office payment is shown beside the driver\'s');
    assert.equal(row.collectedCents, 103_500);
    // Once the office payment is reversed it no longer shows as counted twice (28 Oct 2026).
    await reversePayment(f.db, f.admin, p.paymentIds[0], 'counted twice');
    const again = (await getSettlementReview(f.db, st.delivery_sheet_id)).stops.find((s) => s.stopId === st.id)!;
    assert.equal(again.paidBeforeCents, 0, 'a reversed office payment is not shown');
    assert.deepEqual(again.paidBeforeReceipts, []);
    assert.equal(again.expectedCents, 103_500, 'the driver collects the full amount again');
    await settleRoute(f.db, f.office, st.delivery_sheet_id, { actualCashCents: 103_500 });

    const log = await listAuditLog(f.db, f.admin, { from: businessToday(), limit: 100 });
    const rows = log.rows as Array<{ entity_type: string; action: string; summary: string; record: string | null }>;
    const pay = rows.find((r) => r.entity_type === 'Payment' && r.action === 'pay')!;
    assert.match(pay.summary, /Payment RCT-\d+ \(\$1,035\.00 cash\) from .+ recorded/);
    const deliver = rows.find((r) => r.entity_type === 'DeliveryStop' && r.action === 'deliver')!;
    assert.match(deliver.summary, new RegExp(`Delivered: ${o.orderNumber} for .+ on the .+ round, .+; invoice INV-\\d+ raised; \\$1,035\\.00 cash taken`));
    assert.match(deliver.record ?? '', new RegExp(o.orderNumber));
    const settle = rows.find((r) => r.entity_type === 'DeliverySheet' && r.action === 'finalize')!;
    assert.match(settle.summary, /Settled the .+ round, .+: \d+ payments? posted .*cash expected \$1,035\.00, counted \$1,035\.00 \(balanced\)/);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(settle.record ?? ''), 'the round is named, not an id');
    const created = rows.find((r) => r.entity_type === 'CustomerOrder' && r.action === 'create')!;
    assert.match(created.summary, new RegExp(`Order ${o.orderNumber} taken for .+: \\$1,035\\.00, delivery`));
    // Times come back as ISO, with the zone.
    assert.match((log.rows[0] as { ts: string }).ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  test('settlement notes: on the round, in Rounds and cash, and in the log', async () => {
    const day = addDays(businessToday(), 2);
    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: day, lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }] });
    const st = await f.db.one<{ id: string; delivery_sheet_id: string }>(`SELECT id, delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [o.id]);
    await markStop(f.db, f.driver, { stopId: st.id, outcome: 'Delivered' } as never);
    await settleRoute(f.db, f.office, st.delivery_sheet_id, { actualCashCents: 0, settlementNotes: 'Gas - $12,000.00\nWalk-In - $2,500.00' } as never);
    const sheet = await getSheet(f.db, st.delivery_sheet_id) as unknown as { settlement_notes: string; reconciled_by_name: string };
    assert.match(sheet.settlement_notes, /Gas/);
    assert.equal(sheet.reconciled_by_name, 'Office');
    const rr = await roundsReport(f.db, day, day);
    assert.match(rr.rounds[0].notes ?? '', /Gas - \$12,000\.00\nWalk-In/);
    const log = await listAuditLog(f.db, f.admin, { types: ['DeliverySheet'], actions: ['finalize'], limit: 5 });
    const row = (log.rows as Array<{ entity_id: string; summary: string }>).find((r) => r.entity_id === st.delivery_sheet_id)!;
    assert.match(row.summary, /Notes: "Gas - \$12,000\.00; Walk-In - \$2,500\.00"/);
  });
});
