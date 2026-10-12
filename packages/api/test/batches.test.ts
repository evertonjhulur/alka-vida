/**
 * Batch actions on the lists (Everton, 11 Oct 2026): print and send several
 * at once, any customers, and the list of payments received.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { buildServer } from '../src/server.ts';
import { counterSale } from '../src/services/counter.ts';
import { receivePayment } from '../src/services/payments.ts';

let f: Fixture;
let app: Awaited<ReturnType<typeof buildServer>>;
let tok = '';

before(async () => {
  f = await setupFixture();
  app = await buildServer(f.db);
  const { signToken } = await import('../src/lib/auth.ts');
  tok = signToken({ id: f.office.id, name: f.office.name, role: 'user', customerId: null });
});
after(async () => { await app.close(); await f.close(); });

const post = (url: string, payload: unknown) => app.inject({
  method: 'POST', url, payload: payload as never, headers: { authorization: `Bearer ${tok}` },
});
const sale = (customerId: string, paid = 0) => counterSale(f.db, f.office, {
  customerId, lines: [{ productId: f.casedProductId, cases: 1 }], amountPaidCents: paid, method: 'Cash',
});

describe('Invoices, any customers', () => {
  test('print: one PDF with each invoice', async () => {
    const a = await sale(f.customerId);
    const b = await sale(f.otherCustomerId);
    const r = await post('/api/batch/invoices/print.pdf', { ids: [a.invoiceId, b.invoiceId] });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.ok(r.rawPayload.length > 2000);
    assert.equal(r.rawPayload.subarray(0, 4).toString(), '%PDF');
  });

  test('send: one result per customer, and one that cannot go does not stop the rest', async () => {
    const a = await sale(f.customerId);
    const b = await sale(f.otherCustomerId);
    const c = await sale(f.customerId);
    const r = await post('/api/batch/invoices/send', { ids: [a.invoiceId, b.invoiceId, c.invoiceId] });
    assert.equal(r.statusCode, 200);
    const out = r.json() as Array<{ label: string; error?: string }>;
    assert.equal(out.length, 2, 'grouped by customer');
    assert.ok(out.every((o) => o.error && /not set up/.test(o.error)), 'mail is not set up in tests');
  });

  test('nothing chosen is refused in words', async () => {
    const r = await post('/api/batch/invoices/print.pdf', { ids: [] });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /choose at least one/);
  });
});

describe('Payments', () => {
  test('the list of payments received, with what each went against', async () => {
    const s = await sale(f.customerId, 50_000);
    await receivePayment(f.db, f.office, { customerId: f.otherCustomerId, amountCents: 12_345, method: 'Cheque', reference: 'Chq 9' });
    const r = await app.inject({ method: 'GET', url: '/api/payments', headers: { authorization: `Bearer ${tok}` } });
    assert.equal(r.statusCode, 200);
    const rows = r.json() as Array<{ invoice_number: string | null; reference: string | null; amount_cents: string }>;
    assert.ok(rows.some((p) => p.invoice_number === s.invoiceNumber));
    assert.ok(rows.some((p) => p.reference === 'Chq 9' && p.invoice_number === null));
  });

  test('receipts: one PDF for payments of different customers', async () => {
    const all = (await app.inject({ method: 'GET', url: '/api/payments', headers: { authorization: `Bearer ${tok}` } }))
      .json() as Array<{ id: string; customer_id: string }>;
    const one = all.find((p) => p.customer_id === f.customerId)!;
    const two = all.find((p) => p.customer_id === f.otherCustomerId)!;
    const r = await post('/api/batch/receipts/print.pdf', { ids: [one.id, two.id] });
    assert.equal(r.statusCode, 200);
    assert.equal(r.rawPayload.subarray(0, 4).toString(), '%PDF');
  });
});
