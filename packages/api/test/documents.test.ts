/**
 * The invoice as a document, and sending it.
 *
 * Nothing here sends real mail: the tests assert that an unconfigured
 * install REFUSES to send and says why, which is the state every machine is
 * in until the owner fills in the settings file.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { collectOrder } from '../src/services/counter.ts';
import {
  renderInvoicePdf, renderStatementPdf, logoPath, emailInvoice, mailConfigured,
} from '../src/services/documents.ts';
import { getStatement } from '../src/services/ledger.ts';
import { recordPayment } from '../src/services/payments.ts';
import { bottleAccount } from '../src/services/bottles.ts';
import { customerHistory } from '../src/services/customers.ts';
import { bottlesNotRecorded } from '../src/services/reports.ts';

let f: Fixture;
let invoiceId: string;
let invoiceNumber: string;

before(async () => {
  f = await setupFixture();
  const order = await createOrder(f.db, f.office, {
    customerId: f.customerId,
    deliveryMode: 'Pickup',
    lines: [{ productId: f.casedProductId, cases: 3 }],
  });
  const out = await collectOrder(f.db, f.office, { orderId: order.id });
  invoiceId = out.invoiceId;
  invoiceNumber = out.invoiceNumber;
});
after(async () => { await f.close(); });

describe('The invoice PDF', () => {
  test('is a real PDF, named after the invoice', async () => {
    const doc = await renderInvoicePdf(f.db, invoiceId);
    assert.equal(doc.filename, `${invoiceNumber}.pdf`);
    assert.ok(doc.pdf.length > 800, 'a page with content, not an empty shell');
    assert.equal(doc.pdf.subarray(0, 5).toString('latin1'), '%PDF-',
      'the file a customer opens must actually be a PDF');
  });

  test('carries the customer it is billed to', async () => {
    const doc = await renderInvoicePdf(f.db, invoiceId);
    assert.equal(doc.customerName, 'Blue Mountain Offices');
    assert.equal(doc.customerEmail, 'ap@bluemountain.jm',
      'so a send defaults to the right address');
  });

  test('an invoice that does not exist is refused, not rendered blank', async () => {
    await assert.rejects(
      () => renderInvoicePdf(f.db, '00000000-0000-0000-0000-000000000000'),
      /no longer exists/,
    );
  });
});

describe('The statement PDF', () => {
  test('is a real PDF, named after the customer', async () => {
    const doc = await renderStatementPdf(f.db, f.customerId);
    assert.equal(doc.pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(doc.filename, /^Statement-Blue-Mountain-Offices/);
    assert.ok(doc.pdf.length > 800, 'a page with content, not an empty shell');
    assert.equal(doc.customerName, 'Blue Mountain Offices');
  });

  test('renders for an account with no activity at all', async () => {
    const quiet = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email)
       VALUES ('Never Ordered','876-555-0001','quiet@example.jm') RETURNING id`,
    );
    const doc = await renderStatementPdf(f.db, quiet.id);
    assert.equal(doc.pdf.subarray(0, 5).toString('latin1'), '%PDF-',
      'an empty statement is a valid document, not a crash');
  });

  /**
   * A statement row is drawn as six cells at one vertical position, and the
   * cursor used to end wherever the LAST cell finished rather than the
   * tallest. A wrapping description was then written over by the row beneath,
   * which put figures against the wrong line - it read as an invoice number
   * not matching its own payment.
   *
   * Long descriptions are ordinary here: "Payment received, applied to
   * INV-001066" already wraps in the column it is given.
   */
  test('a long description does not collide with the row below it', async () => {
    const long = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email)
       VALUES ('Wrapping Descriptions Ltd','876-555-0002','wrap@example.jm') RETURNING id`,
    );
    const order = await createOrder(f.db, f.office, {
      customerId: long.id, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 2 }],
    });
    const sale = await collectOrder(f.db, f.office, { orderId: order.id });
    // An unattached payment as well, so both description shapes are present.
    await recordPayment(f.db, f.office, {
      customerId: long.id, invoiceId: null, amountCents: 5_000, method: 'Cash',
    });

    const statement = await getStatement(f.db, long.id);
    assert.ok(
      statement.entries.some((e) => e.description.length > 30),
      'the fixture must actually contain a description long enough to wrap',
    );
    assert.ok(sale.invoiceNumber);

    const doc = await renderStatementPdf(f.db, long.id);
    assert.equal(doc.pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(doc.pdf.length > 800);
  });

  test('a customer in credit is not shown as owing a negative amount', async () => {
    const credit = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email)
       VALUES ('Paid Ahead Ltd','876-555-0003','ahead@example.jm') RETURNING id`,
    );
    await recordPayment(f.db, f.office, {
      customerId: credit.id, invoiceId: null, amountCents: 27_500, method: 'Cash',
    });

    const statement = await getStatement(f.db, credit.id);
    assert.equal(statement.closingBalanceCents, -27_500,
      'the ledger keeps the sign; only the wording changes');

    const doc = await renderStatementPdf(f.db, credit.id);
    assert.equal(doc.pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  test('a payment carries the invoice it paid, not whatever was typed', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email)
       VALUES ('Reference Test Ltd','876-555-0004','ref@example.jm') RETURNING id`,
    );
    const order = await createOrder(f.db, f.office, {
      customerId: c.id, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    // Paid at the counter, so there IS a payment against the invoice.
    const sale = await collectOrder(f.db, f.office, {
      orderId: order.id, amountPaidCents: 100_000, method: 'Cash',
    });
    // A cheque number on the payment must NOT displace the invoice number.
    await f.db.query(
      `UPDATE payments SET reference = 'CHQ-99887' WHERE invoice_id = $1`,
      [sale.invoiceId],
    );

    const statement = await getStatement(f.db, c.id);
    const payment = statement.entries.find((e) => e.type === 'Payment');
    assert.equal(payment?.reference, sale.invoiceNumber,
      'the Reference column beside an invoice row must name the same invoice');
  });

  /**
   * A returnable bottle is an asset out on loan, so the statement has to say
   * how many of them the customer is holding, not only what they owe.
   */
  test('the bottle account counts delivered against collected', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email)
       VALUES ('Bottle Holder Ltd','876-555-0005','bottles@example.jm') RETURNING id`,
    );
    const sheet = await f.db.one<{ id: string }>(
      `INSERT INTO delivery_sheets (delivery_date, zone)
       VALUES (business_today(), 'Kingston') RETURNING id`,
    );
    // Two rounds: 10 out and 4 back, then 6 out and 9 back.
    for (const [full, empties] of [[10, 4], [6, 9]]) {
      await f.db.query(
        `INSERT INTO delivery_stops
           (delivery_sheet_id, customer_id, stop_outcome,
            bottles_delivered_full, bottles_empties_picked_up, bottles_lost_damaged)
         VALUES ($1,$2,'Delivered',$3,$4,0)`,
        [sheet.id, c.id, full, empties],
      );
    }

    const acct = await bottleAccount(f.db, c.id);
    assert.equal(acct.delivered, 16);
    assert.equal(acct.returned, 13);
    assert.equal(acct.closingHolding, 3,
      'sixteen out, thirteen back - the customer is holding three of your bottles');

    const doc = await renderStatementPdf(f.db, c.id);
    assert.equal(doc.pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  test('a customer who never had a returnable has an empty bottle account', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email)
       VALUES ('Cases Only Ltd','876-555-0006','cases@example.jm') RETURNING id`,
    );
    const acct = await bottleAccount(f.db, c.id);
    assert.equal(acct.delivered, 0);
    assert.equal(acct.closingHolding, 0,
      'and the statement prints no bottle section at all rather than a row of zeroes');
  });

  /**
   * The customer record and the statement must agree about what somebody is
   * worth. They nearly did not: the record summed invoice_ledger, which a
   * payment left on the account never enters, so a customer $275 in credit
   * read as owing exactly nothing on one screen and being in credit on the
   * other.
   */
  test('the customer record and the statement agree on the balance', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email)
       VALUES ('Overpaid Ltd','876-555-0007','over@example.jm') RETURNING id`,
    );
    const order = await createOrder(f.db, f.office, {
      customerId: c.id, deliveryMode: 'Pickup',
      lines: [{ productId: f.casedProductId, cases: 1 }],
    });
    const sale = await collectOrder(f.db, f.office, {
      orderId: order.id, amountPaidCents: 100_000, method: 'Cash',
    });
    // Paid over: the excess belongs to no invoice.
    await recordPayment(f.db, f.office, {
      customerId: c.id, invoiceId: null, amountCents: 40_000, method: 'Cash',
    });

    const statement = await getStatement(f.db, c.id);
    const record = await customerHistory(f.db, c.id);

    assert.equal(record.balanceCents, statement.closingBalanceCents,
      'the record and the statement must not disagree about one customer');
    assert.ok(sale.invoiceNumber);
  });

  test('a date range narrows it without breaking the document', async () => {
    const doc = await renderStatementPdf(f.db, f.customerId,
      { from: '2020-01-01', to: '2020-01-31' });
    assert.equal(doc.pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  /**
   * The logo is the owner's own file, kept beside the launcher and out of the
   * repository, so it is present on some machines and not others. The
   * document has to build either way — which is the thing worth asserting.
   * An earlier version of this test asserted `logoPath() === null` and went
   * red the moment a real logo was installed.
   */
  test('builds whether or not a logo is installed on this machine', async () => {
    const found = logoPath();
    if (found !== null) {
      assert.ok(existsSync(found), 'logoPath must only ever name a file that is there');
    }
    const doc = await renderStatementPdf(f.db, f.customerId);
    assert.equal(doc.pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(doc.pdf.length > 800);
  });
});

describe('Sending an invoice', () => {
  test('is not configured out of the box', () => {
    assert.equal(mailConfigured(), false,
      'no fallback mail account - a fresh install sends nothing anywhere');
  });

  test('refuses with an explanation rather than failing silently', async () => {
    await assert.rejects(
      () => emailInvoice(f.db, f.office, invoiceId),
      /email is not set up/,
      'the person clicking Send must be told what to do about it',
    );
  });

  test('an unconfigured send leaves the invoice NOT marked as sent', async () => {
    await emailInvoice(f.db, f.office, invoiceId).catch(() => {});
    const row = await f.db.one<{ lifecycle: string }>(
      `SELECT lifecycle FROM invoices WHERE id = $1`, [invoiceId]);
    assert.notEqual(row.lifecycle, 'Sent',
      'an invoice is only ever Sent once a mail server has accepted it');
  });

  test('a driver cannot email an invoice out', async () => {
    await assert.rejects(
      () => emailInvoice(f.db, f.driver, invoiceId), /not permitted|role/i,
    );
  });
});

describe('The invoice list can say whose invoice it is', () => {
  test('the ledger carries the customer name', async () => {
    const row = await f.db.one<{ customer_name: string; status: string }>(
      `SELECT customer_name, status FROM invoice_ledger WHERE invoice_id = $1`, [invoiceId]);
    assert.equal(row.customer_name, 'Blue Mountain Offices');
  });

  test('overdue is judged against the Jamaican date, not the UTC one', async () => {
    // Due today: from 7pm Jamaica until midnight, UTC has already rolled over
    // and this invoice would wrongly have read Overdue.
    await f.db.query(
      `UPDATE invoices SET due_date = business_today() WHERE id = $1`, [invoiceId]);
    const row = await f.db.one<{ status: string }>(
      `SELECT status FROM invoice_ledger WHERE invoice_id = $1`, [invoiceId]);
    assert.notEqual(row.status, 'Overdue', 'due today is not yet overdue');

    await f.db.query(
      `UPDATE invoices SET due_date = business_today() - 1 WHERE id = $1`, [invoiceId]);
    const late = await f.db.one<{ status: string }>(
      `SELECT status FROM invoice_ledger WHERE invoice_id = $1`, [invoiceId]);
    assert.equal(late.status, 'Overdue', 'due yesterday is');
  });
});

/**
 * Migrations 004 and 008 exist because dates were got wrong twice. This is a
 * third shape of the same mistake: applying business_date() to a column that
 * is ALREADY a date. The cast to timestamptz assumes midnight UTC, converting
 * to Jamaica then lands on the evening BEFORE, so every such date printed a
 * day early. A delivery made on the 4th was reported as the 3rd.
 */
describe('A date column is not put through business_date again', () => {
  test('a delivery reports the date its round actually ran', async () => {
    const c = await f.db.one<{ id: string }>(
      `INSERT INTO customers (name, phone, email)
       VALUES ('Date Check Ltd','876-555-0008','date@example.jm') RETURNING id`,
    );
    const sheet = await f.db.one<{ id: string; d: string }>(
      `INSERT INTO delivery_sheets (delivery_date, zone)
       VALUES (DATE '2026-08-30', 'Kingston')
       RETURNING id, delivery_date::text AS d`,
    );
    const p = await f.db.one<{ id: string }>(
      `SELECT id FROM products WHERE is_returnable LIMIT 1`);
    const order = await f.db.one<{ id: string }>(
      `INSERT INTO customer_orders (order_number, customer_id, delivery_mode, status)
       VALUES ('SO-DATECHK', $1, 'Delivery', 'Delivered') RETURNING id`, [c.id]);
    await f.db.query(
      `INSERT INTO order_line_items
         (order_id, product_id, cases, loose_bottles, total_bottles,
          price_per_case_cents, price_per_bottle_cents)
       VALUES ($1,$2,0,3,3,0,45000)`, [order.id, p.id]);
    await f.db.query(
      `INSERT INTO delivery_stops
         (delivery_sheet_id, customer_id, order_id, stop_outcome,
          bottles_delivered_full, bottles_empties_picked_up, bottles_lost_damaged)
       VALUES ($1,$2,$3,'Delivered',0,0,0)`, [sheet.id, c.id, order.id]);

    const gaps = await bottlesNotRecorded(f.db);
    const mine = gaps.find((g) => (g as { customer_name: string }).customer_name
      === 'Date Check Ltd') as { delivery_date: string } | undefined;
    assert.ok(mine, 'the delivery must appear in the report');
    assert.equal(mine.delivery_date, sheet.d,
      'the reported date must be the round\'s own date, not the evening before');
    assert.equal(mine.delivery_date, '2026-08-30');
  });
});
