/**
 * The send screen (Everton, 28 Oct 2026): "Email..." opens a screen in a new
 * tab with the email written, the document attached, To / Cc / Bcc, "Send
 * me a copy" and other files; several ticked on a list go one at a time.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { buildServer } from '../src/server.ts';
import { counterSale } from '../src/services/counter.ts';
import { receivePayment } from '../src/services/payments.ts';
import { createOrder } from '../src/services/orders.ts';
import { createQuotation } from '../src/services/quotations.ts';
import { updateCustomer } from '../src/services/customers.ts';
import { emailInvoice, emailStatement, setMailSinkForTests, type MailMessage } from '../src/services/documents.ts';
import { draftEmail, sendEmail, planBatch, cleanRef } from '../src/services/sendscreen.ts';
import { setWording, listWording, fillBlanks } from '../src/services/emailwording.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
let app: Awaited<ReturnType<typeof buildServer>>;
let tok = '';
const sent: MailMessage[] = [];

before(async () => {
  f = await setupFixture();
  setMailSinkForTests((m) => { sent.push(m); });
  app = await buildServer(f.db);
  const { signToken } = await import('../src/lib/auth.ts');
  tok = signToken({ id: f.office.id, name: f.office.name, role: 'user', customerId: null });
  await f.db.query(`UPDATE customers SET email = 'accounts@corp.jm', contact_person = 'Marcia' WHERE id = $1`, [f.customerId]);
  await f.db.query(`UPDATE customers SET email = '' WHERE id = $1`, [f.otherCustomerId]);
});
after(async () => { setMailSinkForTests(null); await app.close(); await f.close(); });

const sale = (customerId: string) => counterSale(f.db, f.office, {
  customerId, lines: [{ productId: f.casedProductId, cases: 1 }], amountPaidCents: 0, method: 'Cash',
});
const asList = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

describe('Copy addresses saved on the customer', () => {
  test('saved, tidied and checked', async () => {
    await updateCustomer(f.db, f.office, f.customerId, { ccEmails: 'manager@corp.jm;  clerk@corp.jm, manager@corp.jm' });
    const c = await f.db.one<{ cc_emails: string }>(`SELECT cc_emails FROM customers WHERE id = $1`, [f.customerId]);
    assert.equal(c.cc_emails, 'manager@corp.jm, clerk@corp.jm');
    await assert.rejects(updateCustomer(f.db, f.office, f.customerId, { ccEmails: 'manager@corp' }), /not an email address/);
  });
});

describe('The draft', () => {
  test('an invoice: To from the account, Cc from the saved copies, wording filled in, the PDF ready', async () => {
    const s = await sale(f.customerId);
    const d = await draftEmail(f.db, f.office, cleanRef({ kind: 'invoice', ids: [s.invoiceId] }));
    assert.deepEqual(d.to, ['accounts@corp.jm']);
    assert.deepEqual(d.cc, ['manager@corp.jm', 'clerk@corp.jm']);
    assert.equal(d.ccSaved, true);
    assert.match(d.subject, /^Alka Vida invoice INV-/);
    assert.match(d.message, /Please find attached invoice INV-/);
    assert.equal(d.attachments.length, 1);
    assert.match(d.attachments[0].filename, /^INV-.*\.pdf$/);
    assert.ok(d.attachments[0].bytes > 1000);
    assert.equal(d.me, 'office@alkavida.jm');
    assert.equal(d.maxBytes, 10 * 1024 * 1024);
  });

  test('a customer with no address on file starts with an empty To', async () => {
    const s = await sale(f.otherCustomerId);
    const d = await draftEmail(f.db, f.office, cleanRef({ kind: 'invoice', ids: [s.invoiceId] }));
    assert.deepEqual(d.to, []);
    assert.equal(d.emailOnFile, null);
  });

  test('a bad link is refused in words', () => {
    assert.throws(() => cleanRef({ kind: 'invoice', ids: 'nonsense' } as never), /not complete/);
    assert.throws(() => cleanRef({ kind: 'payroll', ids: [] } as never), /not something that can be emailed/);
  });
});

describe('Sending from the screen', () => {
  test('exactly what was typed: several To, Cc, Bcc, a copy to me, another file; marked Sent; on the record', async () => {
    const s = await sale(f.customerId);
    const n = sent.length;
    const r = await sendEmail(f.db, f.office, cleanRef({ kind: 'invoice', ids: [s.invoiceId] }), {
      to: 'accounts@corp.jm, owner@corp.jm', cc: ['manager@corp.jm'], bcc: 'auditor@firm.jm', sendMeCopy: true,
      subject: 'Your invoice, as promised', message: 'Hi Marcia,\n\nHere it is.\n\nAlka Vida',
      extra: [{ filename: 'Price list.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.4 price list').toString('base64') }],
    });
    assert.equal(sent.length, n + 1);
    const m = sent.at(-1)!;
    assert.deepEqual(asList(m.to), ['accounts@corp.jm', 'owner@corp.jm']);
    assert.deepEqual(m.cc, ['manager@corp.jm']);
    assert.deepEqual(m.bcc, ['auditor@firm.jm', 'office@alkavida.jm']);
    assert.equal(m.subject, 'Your invoice, as promised');
    assert.match(m.text, /Hi Marcia,/);
    assert.doesNotMatch(m.text, /Please find attached/, 'the typed message replaces the standard one');
    assert.deepEqual(m.attachments!.map((a) => a.filename), [`${r.label}.pdf`, 'Price list.pdf']);
    assert.equal(r.sentTo, 'accounts@corp.jm, owner@corp.jm');

    const inv = await f.db.one<{ lifecycle: string }>(`SELECT lifecycle FROM invoices WHERE id = $1`, [s.invoiceId]);
    assert.equal(inv.lifecycle, 'Sent');
    const a = await f.db.one<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE entity_id = $1 ORDER BY ts DESC LIMIT 1`, [s.invoiceId]);
    assert.equal(a.details.cc, 'manager@corp.jm');
    assert.deepEqual(a.details.otherFiles, ['Price list.pdf']);
  });

  test('refused in words: no To, a bad address, a program, over 10 MB', async () => {
    const s = await sale(f.customerId);
    const ref = cleanRef({ kind: 'invoice', ids: [s.invoiceId] });
    const base = { to: 'a@b.jm', subject: 'S', message: 'M' };
    await assert.rejects(sendEmail(f.db, f.office, ref, { ...base, to: '' }), /at least one address/);
    await assert.rejects(sendEmail(f.db, f.office, ref, { ...base, cc: 'clerk@corp' }), /in Cc is not an email address/);
    await assert.rejects(sendEmail(f.db, f.office, ref, { ...base, extra: [{ filename: 'run.exe', data: 'AAAA' }] }), /does not allow/);
    const big = Buffer.alloc(10 * 1024 * 1024, 1).toString('base64');
    await assert.rejects(sendEmail(f.db, f.office, ref, { ...base, extra: [{ filename: 'big.pdf', data: big }] }), /limit is 10 MB/);
    await assert.rejects(sendEmail(f.db, f.driver, ref, base), /requires role/);
  });

  test('a statement for the chosen dates, a receipt, a quote with its accept link, an order confirmation', async () => {
    const s = await sale(f.customerId);
    const st = await sendEmail(f.db, f.office, cleanRef({ kind: 'statement', ids: [f.customerId], from: '2026-01-01' }),
      { to: 'accounts@corp.jm', subject: 'Statement', message: 'Your statement.' });
    assert.match(st.label, /Statement for/);
    assert.match(sent.at(-1)!.attachments![0].filename, /^Statement-/);

    const p = await receivePayment(f.db, f.office, { customerId: f.customerId, amountCents: 50000, method: 'Cash',
      allocations: [{ invoiceId: s.invoiceId, amountCents: 50000 }] });
    const pid = p.paymentIds[0];
    const rc = await sendEmail(f.db, f.office, cleanRef({ kind: 'receipt', ids: [pid] }),
      { to: 'accounts@corp.jm', subject: 'Receipt', message: 'Thanks.' });
    assert.match(rc.label, /^Receipt RCT-/);

    const qt = await createQuotation(f.db, f.office, { customerId: f.customerId,
      lines: [{ productId: f.casedProductId, cases: 2, pricePerCaseCents: 120_000 }] });
    const qd = await draftEmail(f.db, f.office, cleanRef({ kind: 'quote', ids: [qt.id] }));
    assert.match(qd.subject, /quotation/);
    const qs = await sendEmail(f.db, f.office, cleanRef({ kind: 'quote', ids: [qt.id] }),
      { to: 'accounts@corp.jm', subject: qd.subject, message: 'Our prices.' });
    assert.match(qs.link ?? '', /quote/);
    assert.match(sent.at(-1)!.html ?? '', /Accept this quotation/);

    const o = await createOrder(f.db, f.office, { customerId: f.customerId, deliveryMode: 'Delivery',
      requestedDeliveryDate: addDays(businessToday(), 3), lines: [{ productId: f.fiveGalProductId, looseBottles: 2 }] });
    const d = await draftEmail(f.db, f.office, cleanRef({ kind: 'order', ids: [o.id] }));
    assert.equal(d.attachments.length, 0, 'an order confirmation has no PDF');
    assert.match(d.subject, /received/);
    const oc = await sendEmail(f.db, f.office, cleanRef({ kind: 'order', ids: [o.id] }),
      { to: 'accounts@corp.jm', cc: 'clerk@corp.jm', subject: d.subject, message: 'We have it.' });
    assert.match(oc.label, /Confirmation of/);
    assert.deepEqual(sent.at(-1)!.cc, ['clerk@corp.jm']);
    assert.match(sent.at(-1)!.text, /We have it\./);
  });
});

describe('Wording in Settings', () => {
  test('an administrator changes it; drafts and automatic emails follow; the standard comes back', async () => {
    await assert.rejects(setWording(f.db, f.office, 'invoice', { subject: 'x', message: 'y' }), /requires role/);
    await setWording(f.db, f.admin, 'invoice', {
      subject: 'Invoice {number} for {customer}', message: 'Dear {contact},\n\n{number} for {amount} is due {due date}.',
    });
    const s = await sale(f.customerId);
    const d = await draftEmail(f.db, f.office, cleanRef({ kind: 'invoice', ids: [s.invoiceId] }));
    assert.match(d.subject, /^Invoice INV-\S+ for /);
    assert.match(d.message, /^Dear Marcia,/);
    assert.match(d.message, /is due /);

    // The old path (no screen) uses the same wording and the saved copies.
    await emailInvoice(f.db, f.office, s.invoiceId);
    const m = sent.at(-1)!;
    assert.match(m.subject, /^Invoice INV-/);
    assert.deepEqual(m.cc, ['manager@corp.jm', 'clerk@corp.jm']);

    const row = (await listWording(f.db)).find((w) => w.kind === 'invoice')!;
    assert.equal(row.changed, true);
    await setWording(f.db, f.admin, 'invoice', null);
    const back = (await listWording(f.db)).find((w) => w.kind === 'invoice')!;
    assert.equal(back.changed, false);
    assert.equal(back.subject, 'Alka Vida invoice {number}');
  });

  test('automatic statements carry the saved copies; reminders keep their own words', async () => {
    await emailStatement(f.db, f.admin, f.customerId, { category: 'statements' });
    assert.deepEqual(sent.at(-1)!.cc, ['manager@corp.jm', 'clerk@corp.jm']);
    assert.match(sent.at(-1)!.text, /Please find attached your statement/);
    await emailStatement(f.db, f.admin, f.customerId, { category: 'reminders', note: 'Kindly settle.', subject: 'Reminder' });
    assert.equal(sent.at(-1)!.subject, 'Reminder');
    assert.match(sent.at(-1)!.text, /Kindly settle\./);
  });

  test('a blank nobody filled stays as typed', () => {
    assert.equal(fillBlanks('{customer} owes {amount} {nonsense}', { '{customer}': 'Ann', '{amount}': '$5.00' }), 'Ann owes $5.00 {nonsense}');
  });
});

describe('Several ticked: one at a time', () => {
  test('invoices grouped one email per customer; no address listed first, not in the run', async () => {
    const a = await sale(f.customerId);
    const b = await sale(f.customerId);
    const c = await sale(f.otherCustomerId);
    const p = await planBatch(f.db, f.office, 'invoices', [a.invoiceId, b.invoiceId, c.invoiceId]);
    assert.equal(p.steps.length, 1);
    assert.equal(p.steps[0].ref.kind, 'invoices');
    assert.deepEqual(new Set(p.steps[0].ref.ids), new Set([a.invoiceId, b.invoiceId]));
    assert.equal(p.cannot.length, 1);
    assert.match(p.cannot[0].why, /no email address/);

    const one = await planBatch(f.db, f.office, 'invoices', [a.invoiceId]);
    assert.equal(one.steps[0].ref.kind, 'invoice', 'one invoice goes as itself');
  });
});

describe('Over HTTP', () => {
  const headers = () => ({ authorization: `Bearer ${tok}` });
  test('draft, view the very PDF, send with a 2 MB file, plan', async () => {
    const s = await sale(f.customerId);
    const q = `kind=invoice&ids=${s.invoiceId}`;
    const d = await app.inject({ method: 'GET', url: `/api/send/draft?${q}`, headers: headers() });
    assert.equal(d.statusCode, 200);
    assert.deepEqual(d.json().to, ['accounts@corp.jm']);

    const v = await app.inject({ method: 'GET', url: `/api/send/preview.pdf?${q}`, headers: headers() });
    assert.equal(v.statusCode, 200);
    assert.equal(v.headers['content-type'], 'application/pdf');
    assert.match(String(v.headers['content-disposition']), /^inline/);

    const file = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
    const r = await app.inject({ method: 'POST', url: '/api/send', headers: headers(), payload: {
      ref: { kind: 'invoice', ids: [s.invoiceId] },
      compose: { to: ['accounts@corp.jm'], subject: 'S', message: 'M', extra: [{ filename: 'photo.jpg', data: file }] },
    } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(sent.at(-1)!.attachments!.length, 2);

    const pl = await app.inject({ method: 'POST', url: '/api/send/plan', headers: headers(),
      payload: { kind: 'invoices', ids: [s.invoiceId] } });
    assert.equal(pl.statusCode, 200);
    assert.equal(pl.json().steps.length, 1);

    const w = await app.inject({ method: 'GET', url: '/api/email-wording', headers: headers() });
    assert.equal(w.statusCode, 200);
    assert.ok(w.json().some((x: { kind: string }) => x.kind === 'statement'));
    const put = await app.inject({ method: 'PUT', url: '/api/email-wording/invoice', headers: headers(), payload: { subject: 'a', message: 'b' } });
    assert.equal(put.statusCode, 403, 'office staff read the wording; an administrator changes it');
  });
});
