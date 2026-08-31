/**
 * Coverage for the rules outside the Section 12 list: the statement, the
 * approval queue, customer merge, FIFO costing, duplicate-submission guards,
 * counter sales, routing and the bottle pool.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop, addOrderToSheet } from '../src/services/delivery.ts';
import { settleRoute } from '../src/services/settlement.ts';
import { getInvoiceLedger } from '../src/services/invoices.ts';
import { recordPayment, getCustomerBalance, reversePayment } from '../src/services/payments.ts';
import { getStatement } from '../src/services/ledger.ts';
import { mergeCustomers } from '../src/services/customers.ts';
import { counterSale } from '../src/services/counter.ts';
import {
  createPurchaseOrder, receivePurchaseOrder, completeProduction,
  materialCostReport, lookupSupplierPrice,
} from '../src/services/inventory.ts';
import { requestInvoiceDiscount, reviewApproval, listPendingApprovals } from '../src/services/approvals.ts';
import { totalDiscounts, discountsByClient } from '../src/services/reports.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

describe('Counter / pickup sales', () => {
  test('never touch a delivery sheet, and the payment is Confirmed at once', async () => {
    const sheetsBefore = await f.db.query(`SELECT id FROM delivery_sheets`);

    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 4 }],
      amountPaidCents: 207_000, // 4 x 450.00 = 1800.00 + 15% = 2070.00
    });

    assert.equal(sale.grandTotalCents, 207_000);
    assert.equal(sale.amountPaidCents, 207_000, 'no Provisional step for a counter sale');
    assert.equal(sale.status, 'Paid');

    const sheetsAfter = await f.db.query(`SELECT id FROM delivery_sheets`);
    assert.equal(sheetsAfter.length, sheetsBefore.length, 'no delivery sheet was created');

    const stops = await f.db.query(
      `SELECT id FROM delivery_stops WHERE order_id = $1`, [sale.orderId],
    );
    assert.equal(stops.length, 0);
  });

  test('a repeated click does not create a second invoice', async () => {
    const key = 'counter-sale-double-click-1';
    const first = await counterSale(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
      amountPaidCents: 103_500,
      idempotencyKey: key,
    });
    const second = await counterSale(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
      amountPaidCents: 103_500,
      idempotencyKey: key,
    });
    assert.equal(second.replayed, true);
    assert.equal(second.invoiceId, first.invoiceId, 'the same invoice comes back');
  });

  test('an overpaid counter sale produces one unattached payment, same as a route', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.otherCustomerId,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
      amountPaidCents: 150_000, // invoice is 1,035.00; pays 1,500.00
    });
    assert.equal(sale.amountPaidCents, 103_500, 'invoice shows only what it was worth');
    const unattached = await f.db.query<{ amount_cents: number }>(
      `SELECT amount_cents FROM payments
       WHERE customer_id = $1 AND invoice_id IS NULL`, [f.otherCustomerId],
    );
    assert.equal(unattached.length, 1);
    assert.equal(Number(unattached[0].amount_cents), 46_500);
  });
});

describe('Duplicate submission guard on Record Payment', () => {
  test('two clicks with one key create exactly one payment', async () => {
    const key = 'record-payment-double-click-1';
    const before = await f.db.query(
      `SELECT id FROM payments WHERE customer_id = $1`, [f.customerId],
    );
    const a = await recordPayment(f.db, f.office, {
      customerId: f.customerId, amountCents: 50_000, method: 'Cash', idempotencyKey: key,
    });
    const b = await recordPayment(f.db, f.office, {
      customerId: f.customerId, amountCents: 50_000, method: 'Cash', idempotencyKey: key,
    });
    const after = await f.db.query(
      `SELECT id FROM payments WHERE customer_id = $1`, [f.customerId],
    );
    assert.equal(after.length, before.length + 1, 'only one real payment');
    assert.equal(b.replayed, true);
    assert.equal(b.id, a.id);
  });
});

describe('Order routing (Step 1)', () => {
  test('a customer with no delivery zone warns instead of silently proceeding', async () => {
    const zoneless = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email) VALUES ('No Zone Ltd','876','a@b.com')
       RETURNING id`,
    );
    const order = await createOrder(f.db, f.office, {
      customerId: zoneless.id, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-09-01',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }],
    });
    assert.equal(order.deliverySheetId, null);
    assert.match(order.warnings.join(' '), /no delivery zone/i);
  });

  test('orders for the same zone and date share one sheet', async () => {
    const a = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-09-08',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }],
    });
    const b = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-09-08',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 5 }],
    });
    assert.equal(a.deliverySheetId, b.deliverySheetId);
  });

  test('a completed sheet is never reused; a new Open sheet is created', async () => {
    const first = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-09-15',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    });
    await settleRoute(f.db, f.admin, first.deliverySheetId!, { actualCashCents: 0 });

    const second = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-09-15',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    });
    assert.notEqual(second.deliverySheetId, first.deliverySheetId,
      'a late order must not attach to a settled route');

    const status = await f.db.one<{ status: string }>(
      `SELECT status FROM delivery_sheets WHERE id = $1`, [second.deliverySheetId],
    );
    assert.equal(status.status, 'Open');
  });

  test('an order cannot be manually added to a Completed sheet', async () => {
    const done = await f.db.one<{ id: string }>(
      `INSERT INTO delivery_sheets (delivery_date, zone, status)
       VALUES ('2026-09-20','Kingston','Completed') RETURNING id`,
    );
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Pickup',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }],
    });
    await assert.rejects(
      addOrderToSheet(f.db, f.admin, done.id, order.id), /only be added to an Open/,
    );
  });

  test('stops seed their sequence from the customer route template', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-09-22',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }],
    });
    const stop = await f.db.one<{ sequence_no: number }>(
      `SELECT sequence_no FROM delivery_stops WHERE order_id = $1`, [order.id],
    );
    assert.equal(Number(stop.sequence_no), 10, 'seeded from customers.route_sequence');
  });
});

describe('Customer statement (Section 4)', () => {
  test('interleaves invoices and payments with a running balance', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email, price_tier_id, delivery_zone)
       VALUES ('Statement Test Ltd','876','st@x.com',$1,'Kingston') RETURNING id`,
      [f.tierId],
    );
    const sale = await counterSale(f.db, f.office, {
      customerId: c.id,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 10 }],
      amountPaidCents: 200_000,
    });

    const st = await getStatement(f.db, c.id);
    assert.equal(st.entries.length, 2);
    assert.equal(st.entries[0].type, 'Invoice');
    assert.equal(st.entries[0].amountCents, sale.grandTotalCents);
    assert.equal(st.entries[1].type, 'Payment');
    assert.equal(st.entries[1].amountCents, -200_000, 'a payment reduces the balance');
    assert.equal(st.closingBalanceCents, sale.grandTotalCents - 200_000);
  });

  test('an unattached payment appears in the SAME Payments category', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email) VALUES ('Unattached Ltd','8','u@x.com')
       RETURNING id`,
    );
    await recordPayment(f.db, f.office, {
      customerId: c.id, amountCents: 75_000, method: 'Cash',
    });
    const st = await getStatement(f.db, c.id, { filter: 'Payments' });
    assert.equal(st.entries.length, 1);
    assert.equal(st.entries[0].type, 'Payment',
      'not a separate credit category - just a payment');
    assert.equal(st.closingBalanceCents, -75_000);
  });

  test('a reversal shows as its own entry beside the original', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email) VALUES ('Reversal Ltd','8','r@x.com')
       RETURNING id`,
    );
    const p = await recordPayment(f.db, f.office, {
      customerId: c.id, amountCents: 30_000, method: 'Cash',
    });
    await reversePayment(f.db, f.admin, p.id!, 'bounced');

    const st = await getStatement(f.db, c.id);
    assert.deepEqual(st.entries.map((e) => e.type), ['Payment', 'Reversal']);
    assert.equal(st.closingBalanceCents, 0, 'the pair nets to zero');
  });

  test('filters restrict the rows but the running balance stays true', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email, price_tier_id)
       VALUES ('Filter Ltd','8','f@x.com',$1) RETURNING id`, [f.tierId],
    );
    const sale = await counterSale(f.db, f.office, {
      customerId: c.id,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 4 }],
      amountPaidCents: 100_000,
    });
    const invoicesOnly = await getStatement(f.db, c.id, { filter: 'Invoices' });
    assert.equal(invoicesOnly.entries.length, 1);
    assert.equal(invoicesOnly.entries[0].type, 'Invoice');
    // The closing balance still accounts for the payment that was filtered out.
    assert.equal(invoicesOnly.closingBalanceCents, sale.grandTotalCents - 100_000);
  });

  test('a date range acts as the customer periodic bill, with an opening balance', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email) VALUES ('Range Ltd','8','rg@x.com')
       RETURNING id`,
    );
    await f.db.query(
      `INSERT INTO invoices (invoice_number, customer_id, invoice_date, grand_total_cents)
       VALUES ('INV-OLD',$1,'2026-01-10',100000), ('INV-NEW',$1,'2026-02-10',50000)`,
      [c.id],
    );
    const feb = await getStatement(f.db, c.id, { from: '2026-02-01', to: '2026-02-28' });
    assert.equal(feb.entries.length, 1);
    assert.equal(feb.openingBalanceCents, 100_000, 'January carried forward');
    assert.equal(feb.closingBalanceCents, 150_000);
  });
});

describe('Customer merge (Section 6)', () => {
  test('history moves to the survivor and the loser is deactivated, not deleted', async () => {
    const dupe = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email, price_tier_id, delivery_zone)
       VALUES ('Blue Mountain Offices (dup)','876','dup@bm.jm',$1,'Kingston') RETURNING id`,
      [f.tierId],
    );
    const sale = await counterSale(f.db, f.office, {
      customerId: dupe.id,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 5 }],
      amountPaidCents: 50_000,
    });

    const survivorBefore = await getCustomerBalance(f.db, f.customerId);
    const result = await mergeCustomers(f.db, f.admin, {
      survivorId: f.customerId, mergedId: dupe.id, reason: 'duplicate record',
    });
    assert.ok(result.moved.invoices >= 1);
    assert.ok(result.moved.payments >= 1);

    const merged = await f.db.one<{ active: boolean; merged_into_id: string }>(
      `SELECT active, merged_into_id FROM customers WHERE id = $1`, [dupe.id],
    );
    assert.equal(merged.active, false, 'deactivated');
    assert.equal(merged.merged_into_id, f.customerId);

    // The record still exists - history is intact.
    const stillThere = await f.db.query(`SELECT id FROM customers WHERE id = $1`, [dupe.id]);
    assert.equal(stillThere.length, 1);

    const survivorAfter = await getCustomerBalance(f.db, f.customerId);
    const net = sale.grandTotalCents - 50_000;
    assert.equal(survivorAfter.balanceCents, survivorBefore.balanceCents + net);

    // And an inactive customer can no longer be ordered for.
    await assert.rejects(
      createOrder(f.db, f.office, {
        customerId: dupe.id, deliveryMode: 'Pickup',
        lines: [{ productId: f.fiveGalProductId, looseBottles: 1 }],
      }),
      /inactive/,
    );
  });
});

describe('FIFO material costing', () => {
  test('production spanning two batches is charged both real costs', async () => {
    const supplier = await f.db.one<{ id: string }>(
      `INSERT INTO suppliers (name) VALUES ('Caribbean Preforms') RETURNING id`,
    );
    const material = await f.db.one<{ id: string }>(
      `INSERT INTO raw_materials (name, category, unit_cost_cents)
       VALUES ('500ml preform','Bottle',900) RETURNING id`,
    );
    const product = await f.db.one<{ id: string }>(
      `INSERT INTO products (name, bottles_per_case, price_per_case_cents)
       VALUES ('Test Water 500ml', 24, 100000) RETURNING id`,
    );
    await f.db.query(
      `INSERT INTO bom_line_items (product_id, raw_material_id, component_type, quantity)
       VALUES ($1,$2,'Bottle',1)`, [product.id, material.id],
    );

    // Two receipts at different costs: 100 @ 9.00 then 100 @ 12.00.
    const po1 = await createPurchaseOrder(f.db, f.office, {
      supplierId: supplier.id,
      lines: [{ rawMaterialId: material.id, quantityOrdered: 100, unitCostCents: 900 }],
    });
    const l1 = await f.db.one<{ id: string }>(
      `SELECT id FROM po_line_items WHERE po_id = $1`, [po1.id],
    );
    await receivePurchaseOrder(f.db, f.office, po1.id, [
      { poLineItemId: l1.id, quantityReceived: 100 },
    ]);

    const po2 = await createPurchaseOrder(f.db, f.office, {
      supplierId: supplier.id,
      lines: [{ rawMaterialId: material.id, quantityOrdered: 100, unitCostCents: 1200 }],
    });
    const l2 = await f.db.one<{ id: string }>(
      `SELECT id FROM po_line_items WHERE po_id = $1`, [po2.id],
    );
    await receivePurchaseOrder(f.db, f.office, po2.id, [
      { poLineItemId: l2.id, quantityReceived: 100 },
    ]);

    // Produce 150 bottles: 100 from the 9.00 batch, 50 from the 12.00 batch.
    const run = await completeProduction(f.db, f.office, {
      productId: product.id, cases: 0, looseBottles: 150,
    });
    assert.equal(run.bottlesProduced, 150);
    assert.equal(run.materialCostCents, 100 * 900 + 50 * 1200,
      'charged the true FIFO cost across both batches, not a blended rate');

    // The transaction records both contributing batches.
    const txn = await f.db.one<{ batch_ids: string[]; total_cost_cents: number }>(
      `SELECT batch_ids, total_cost_cents FROM inventory_transactions
       WHERE item_id = $1 AND direction = 'out' ORDER BY txn_date DESC LIMIT 1`,
      [material.id],
    );
    assert.equal(txn.batch_ids.length, 2);

    // Oldest batch is exhausted and closed; the newer one has 50 left.
    const batches = await f.db.query<{ quantity_remaining: number; status: string }>(
      `SELECT quantity_remaining, status FROM material_batches
       WHERE raw_material_id = $1 ORDER BY received_date`, [material.id],
    );
    assert.equal(batches[0].status, 'Consumed');
    assert.equal(Number(batches[1].quantity_remaining), 50);

    // The blended average is a REPORTING figure and differs from what was charged.
    const report = await materialCostReport(f.db, material.id);
    assert.equal(report[0].blendedAverageUnitCostCents, 1200, 'only the 12.00 batch remains');
    assert.equal(report[0].quantityOnHand, 50);
  });

  test('supplier price breaks pick the best tier and then freeze on the PO', async () => {
    const supplier = await f.db.one<{ id: string }>(
      `INSERT INTO suppliers (name) VALUES ('Bulk Caps Ltd') RETURNING id`,
    );
    const material = await f.db.one<{ id: string }>(
      `INSERT INTO raw_materials (name, category) VALUES ('28mm cap','Cap') RETURNING id`,
    );
    await f.db.query(
      `INSERT INTO supplier_materials (supplier_id, raw_material_id, unit_cost_cents)
       VALUES ($1,$2,500)`, [supplier.id, material.id],
    );
    await f.db.query(
      `INSERT INTO supplier_price_breaks (supplier_id, raw_material_id, min_qty, unit_cost_cents)
       VALUES ($1,$2,1000,400), ($1,$2,5000,300)`, [supplier.id, material.id],
    );

    assert.equal(await lookupSupplierPrice(f.db, supplier.id, material.id, 10), 500);
    assert.equal(await lookupSupplierPrice(f.db, supplier.id, material.id, 1000), 400);
    assert.equal(await lookupSupplierPrice(f.db, supplier.id, material.id, 9999), 300);

    const po = await createPurchaseOrder(f.db, f.office, {
      supplierId: supplier.id,
      lines: [{ rawMaterialId: material.id, quantityOrdered: 5000 }],
    });
    const line = await f.db.one<{ unit_cost_cents: number }>(
      `SELECT unit_cost_cents FROM po_line_items WHERE po_id = $1`, [po.id],
    );
    assert.equal(Number(line.unit_cost_cents), 300);

    // The supplier raises prices afterwards; the issued PO must not change.
    await f.db.query(
      `UPDATE supplier_price_breaks SET unit_cost_cents = 999
       WHERE supplier_id = $1 AND raw_material_id = $2`, [supplier.id, material.id],
    );
    const after = await f.db.one<{ unit_cost_cents: number }>(
      `SELECT unit_cost_cents FROM po_line_items WHERE po_id = $1`, [po.id],
    );
    assert.equal(Number(after.unit_cost_cents), 300, 'frozen at the price when issued');
  });
});

describe('Discount approval queue (Section 5)', () => {
  test('a User discount is saved but does NOT reduce the amount owed until approved', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.casedProductId, cases: 5 }],
    });
    const originalTotal = sale.grandTotalCents;

    const req = await requestInvoiceDiscount(
      f.db, f.office, sale.invoiceId, 10, 'loyal customer',
    );
    assert.equal(req.appliedImmediately, false);

    const stillOwed = await getInvoiceLedger(f.db, sale.invoiceId);
    assert.equal(stillOwed!.grandTotalCents, originalTotal,
      'the money does not move while the request is pending');

    const pending = await listPendingApprovals(f.db);
    assert.ok(pending.some((p) => p.id === req.approvalRequestId));

    // A pending discount is excluded from reporting.
    const beforeApproval = await totalDiscounts(f.db);
    const pendingCounted = beforeApproval.totalDiscountCents;

    await reviewApproval(f.db, f.admin, req.approvalRequestId, 'Approved', 'ok');

    const after = await getInvoiceLedger(f.db, sale.invoiceId);
    assert.ok(after!.grandTotalCents < originalTotal, 'now the discount is live');
    // 5 x 1200.00 = 6000.00, less 10% = 5400.00, +15% = 6210.00
    assert.equal(after!.grandTotalCents, 621_000);

    const afterApproval = await totalDiscounts(f.db);
    assert.ok(afterApproval.totalDiscountCents > pendingCounted,
      'only approved discounts are reported');
  });

  test('a rejected discount leaves the invoice unchanged', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.casedProductId, cases: 2 }],
    });
    const before = (await getInvoiceLedger(f.db, sale.invoiceId))!.grandTotalCents;
    const req = await requestInvoiceDiscount(f.db, f.office, sale.invoiceId, 25, 'ad hoc');
    await reviewApproval(f.db, f.admin, req.approvalRequestId, 'Rejected', 'not authorised');

    const after = await getInvoiceLedger(f.db, sale.invoiceId);
    assert.equal(after!.grandTotalCents, before, 'unchanged');
    const status = await f.db.one<{ discount_status: string }>(
      `SELECT discount_status FROM invoices WHERE id = $1`, [sale.invoiceId],
    );
    assert.equal(status.discount_status, 'Rejected', 'still visible for reference');
  });

  test('an office User cannot approve a request', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const req = await requestInvoiceDiscount(f.db, f.office, sale.invoiceId, 5, 'x');
    await assert.rejects(
      reviewApproval(f.db, f.office, req.approvalRequestId, 'Approved'),
      /requires role admin/,
    );
  });

  test('the same request cannot be reviewed twice', async () => {
    const sale = await counterSale(f.db, f.office, {
      customerId: f.customerId, lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const req = await requestInvoiceDiscount(f.db, f.office, sale.invoiceId, 5, 'x');
    await reviewApproval(f.db, f.admin, req.approvalRequestId, 'Approved');
    await assert.rejects(
      reviewApproval(f.db, f.admin, req.approvalRequestId, 'Rejected'), /already approved/,
    );
  });

  test('per-client discount detail reports only approved discounts', async () => {
    const rows = await discountsByClient(f.db);
    const mine = rows.find((r) => r.customerId === f.customerId);
    assert.ok(mine, 'the discounted customer appears');
    assert.ok(mine!.totalDiscountCents > 0);
    assert.ok(mine!.averageDiscountPercent > 0);
  });
});

describe('5-gallon bottle pool', () => {
  test('a delivery, a pickup of empties and a loss move the right counters', async () => {
    const before = await f.db.one<{
      clean_ready: number; filled_with_customer: number;
      returned_dirty: number; lost_damaged: number;
    }>(`SELECT * FROM five_gal_bottle_pool LIMIT 1`);

    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-10-05',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 10 }],
    });
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      bottlesDeliveredFull: 10, bottlesEmptiesPickedUp: 6, bottlesLostDamaged: 2,
    });

    const after = await f.db.one<{
      clean_ready: number; filled_with_customer: number;
      returned_dirty: number; lost_damaged: number;
    }>(`SELECT * FROM five_gal_bottle_pool LIMIT 1`);

    assert.equal(Number(after.clean_ready), Number(before.clean_ready) - 10);
    assert.equal(Number(after.returned_dirty), Number(before.returned_dirty) + 6);
    assert.equal(Number(after.lost_damaged), Number(before.lost_damaged) + 2);
  });

  test('a lost bottle is a business loss and is never charged to the customer', async () => {
    const order = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-10-12',
      lines: [{ productId: f.fiveGalProductId, looseBottles: 4 }],
    });
    const [stop] = await stopsOf(f.db, order.deliverySheetId!);
    const r = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
      bottlesDeliveredFull: 4, bottlesLostDamaged: 3,
    });
    // 4 x 450.00 = 1800.00 + 15% = 2070.00. The 3 lost bottles add nothing.
    const inv = await getInvoiceLedger(f.db, r.invoiceId!);
    assert.equal(inv!.grandTotalCents, 207_000);

    const lines = await f.db.query(
      `SELECT id FROM invoice_line_items WHERE invoice_id = $1`, [r.invoiceId],
    );
    assert.equal(lines.length, 1, 'no extra line for the lost bottles');
  });
});
