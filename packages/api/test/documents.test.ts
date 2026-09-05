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
