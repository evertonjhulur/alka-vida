import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, stopsOf, type Fixture } from './helpers.ts';
import {
  createQuotation, convertQuotation, setQuotationStatus, getQuotation,
} from '../src/services/quotations.ts';
import { markStop } from '../src/services/delivery.ts';
import { getInvoiceLedger } from '../src/services/invoices.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

describe('Quotations', () => {
  test('show the GCT the order will attract, but book nothing (changed 30 Sep 2026)', async () => {
    const q = await createQuotation(f.db, f.office, {
      customerId: f.customerId,
      discountPercent: 10,
      lines: [{ productId: f.casedProductId, cases: 10, pricePerCaseCents: 120_000 }],
    });
    assert.equal(q.subtotalCents, 1_200_000);
    // 10% off 12,000.00 = 10,800.00, plus 15% GCT = 12,420.00: the price the
    // customer will actually pay, which is what a quote is for.
    assert.equal(q.gctCents, 162_000);
    assert.equal(q.grandTotalCents, 1_242_000);

    // A quote is still not a sale: nothing reaches any balance.
    const bal = await f.db.one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM invoices WHERE customer_id = $1`, [f.customerId],
    );
    assert.equal(Number(bal.n), 0);
  });

  test('a GCT-exempt customer is quoted without GCT', async () => {
    await f.db.query(`UPDATE customers SET gct_exempt = true WHERE id = $1`, [f.otherCustomerId]);
    const q = await createQuotation(f.db, f.office, {
      customerId: f.otherCustomerId,
      lines: [{ productId: f.casedProductId, cases: 1, pricePerCaseCents: 100_000 }],
    });
    assert.equal(q.gctCents, 0);
    assert.equal(q.grandTotalCents, 100_000);
    await f.db.query(`UPDATE customers SET gct_exempt = false WHERE id = $1`, [f.otherCustomerId]);
  });

  test('accept estimate prices that differ from the customer tier', async () => {
    const q = await createQuotation(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.casedProductId, cases: 5, pricePerCaseCents: 99_000 }],
    });
    assert.equal(q.subtotalCents, 495_000, 'freely editable estimate price is used');
  });

  test('honour the case-vs-bottle rule like every other document', async () => {
    await assert.rejects(
      createQuotation(f.db, f.office, {
        customerId: f.customerId,
        lines: [{ productId: f.casedProductId, cases: 0, looseBottles: 5 }],
      }),
      /loose bottles cannot be sold/,
    );
  });

  test('convert into a real order that DOES calculate GCT', async () => {
    const q = await createQuotation(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.casedProductId, cases: 10, pricePerCaseCents: 120_000 }],
    });
    await setQuotationStatus(f.db, f.office, q.id, 'Accepted');

    const converted = await convertQuotation(f.db, f.office, q.id, {
      deliveryMode: 'Delivery',
      requestedDeliveryDate: '2026-12-07',
    });

    // Quoted 12,000.00 + GCT = 13,800.00, and the order comes to the same.
    assert.equal(q.grandTotalCents, 1_380_000);
    assert.equal(converted.grandTotalCents, 1_380_000);

    const after = await getQuotation(f.db, q.id) as { status: string; converted_order_id: string };
    assert.equal(after.status, 'Converted');
    assert.equal(after.converted_order_id, converted.orderId);
  });

  test('carry quoted prices through to the invoice raised at delivery', async () => {
    const q = await createQuotation(f.db, f.office, {
      customerId: f.customerId,
      // Quoted well below the customer's usual Corporate rate.
      lines: [{ productId: f.casedProductId, cases: 4, pricePerCaseCents: 100_000 }],
    });
    const converted = await convertQuotation(f.db, f.office, q.id, {
      deliveryMode: 'Delivery', requestedDeliveryDate: '2026-12-14',
    });

    const sheet = await f.db.one<{ delivery_sheet_id: string }>(
      `SELECT delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [converted.orderId],
    );
    const [stop] = await stopsOf(f.db, sheet.delivery_sheet_id);
    const delivered = await markStop(f.db, f.driver, {
      stopId: stop.id, outcome: 'Delivered',
    });

    // 4 x 1,000.00 = 4,000.00 + 15% = 4,600.00, at the QUOTED price
    const inv = await getInvoiceLedger(f.db, delivered.invoiceId!);
    assert.equal(inv!.grandTotalCents, 460_000,
      'the customer is charged what they were quoted, not their standing tier rate');
  });

  test('cannot be converted twice', async () => {
    const q = await createQuotation(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 5 }],
    });
    await convertQuotation(f.db, f.office, q.id, { deliveryMode: 'Pickup' });
    await assert.rejects(
      convertQuotation(f.db, f.office, q.id, { deliveryMode: 'Pickup' }),
      /already been converted/,
    );
  });

  test('a declined quotation cannot be converted', async () => {
    const q = await createQuotation(f.db, f.office, {
      customerId: f.customerId,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }],
    });
    await setQuotationStatus(f.db, f.office, q.id, 'Declined');
    await assert.rejects(
      convertQuotation(f.db, f.office, q.id, { deliveryMode: 'Pickup' }), /declined/,
    );
  });
});
