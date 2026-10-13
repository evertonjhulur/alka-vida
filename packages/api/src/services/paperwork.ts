/**
 * The rest of the paperwork (Everton's revisions, 30 Sep 2026):
 *
 *   - a quotation as a PDF, and emailed with its accept link   (point 1)
 *   - a purchase order as a PDF, and emailed to the supplier    (point 14)
 *   - a payment receipt, emailed when the office ticks the box  (point 18)
 *   - automatic statements and payment reminders                (point 17)
 *
 * Everything is drawn with the same letterhead as the invoice and statement,
 * and sent through the one sendMail in documents.ts.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessToday, contactEmail, nextNumber, num, requireRole, siteUrl } from './core.ts';
import { RuleViolation, addDays } from '@alka/shared';
import {
  BRAND, COLOR_BLUE, COLOR_INDIGO, billTo, emailInvoice, emailStatement, fmtDate, formatCash as cash, letterhead,
  mailConfigured, newDoc, recipient, sendMail, signOff,
} from './documents.ts';
import { customerEmail, renderEmail } from './emailkit.ts';
import { getQuotation, issueAcceptToken, quoteAcceptLink } from './quotations.ts';
import { getPurchaseOrder } from './inventory.ts';
import { raiseCycleInvoices } from './cycles.ts';

/* ------------------------------------------------------------------ */
/* Quotation                                                           */
/* ------------------------------------------------------------------ */

export async function renderQuotePdf(db: Db, quoteId: string) {
  const { doc, finished } = newDoc();
  const meta = await drawQuote(doc, db, quoteId);
  doc.end();
  return { ...meta, pdf: await finished };
}

async function drawQuote(doc: PDFKit.PDFDocument, db: Db, quoteId: string) {
  const q = await getQuotation(db, quoteId) as unknown as Record<string, unknown> & {
    lines: Array<Record<string, unknown>>;
  } | null;
  if (!q) throw new RuleViolation('that quotation no longer exists');
  const customer = await billTo(db, q.customer_id as string);

  letterhead(doc, 50);
  doc.moveDown(1.2);
  doc.fillColor(COLOR_INDIGO).fontSize(16).text('QUOTATION', 50, doc.y, { align: 'right', width: 510 });
  doc.fontSize(10)
    .text(String(q.quote_number), { align: 'right', width: 510 })
    .text(`Date: ${fmtDate(q.quote_date)}`, { align: 'right', width: 510 });
  if (q.valid_until) doc.text(`Valid until: ${fmtDate(q.valid_until)}`, { align: 'right', width: 510 });
  doc.moveDown(1);

  doc.fontSize(9).fillColor('#555').text('PREPARED FOR', 50);
  doc.fontSize(11).fillColor('#000').text(customer.name);
  doc.fontSize(9).fillColor('#333');
  if (customer.attention) doc.text(`Attn: ${customer.attention}`);
  if (customer.address) doc.text(customer.address);
  if (customer.phone) doc.text(customer.phone);
  if (customer.email) doc.text(customer.email);
  doc.text(q.delivery_mode === 'Pickup' ? 'Collected from our plant' : 'Delivered to you');
  doc.moveDown(1.2);

  const cols = { desc: 50, qty: 330, unit: 400, total: 480 };
  const y0 = doc.y;
  doc.fillColor('#555').fontSize(8)
    .text('DESCRIPTION', cols.desc, y0).text('QTY', cols.qty, y0)
    .text('UNIT PRICE', cols.unit, y0, { width: 70, align: 'right' })
    .text('AMOUNT', cols.total, y0, { width: 80, align: 'right' });
  doc.moveTo(50, doc.y + 2).lineTo(560, doc.y + 2).strokeColor(COLOR_BLUE).stroke();
  doc.moveDown(0.6);
  for (const l of q.lines) {
    const cases = num(l.cases);
    const unit = cases > 0 ? num(l.price_per_case_cents) : num(l.price_per_bottle_cents);
    const bpc = num(l.bottles_per_case);
    const y = doc.y;
    doc.fontSize(9).fillColor('#000')
      .text(`${l.product_name}${bpc > 0 ? ` (case of ${bpc})` : ''}`, cols.desc, y, { width: 270 })
      .text(cases > 0 ? `${cases} cs` : String(num(l.loose_bottles)), cols.qty, y)
      .text(cash(unit), cols.unit, y, { width: 70, align: 'right' })
      .text(cash(num(l.line_total_cents)), cols.total, y, { width: 80, align: 'right' });
    doc.moveDown(0.4);
  }
  doc.moveDown(0.8);
  const row = (label: string, v: number, bold = false) => {
    const y = doc.y;
    doc.fillColor('#000').fontSize(bold ? 11 : 9)
      .text(label, cols.unit - 150, y, { width: 220, align: 'right' })
      .text(cash(v), cols.total, y, { width: 80, align: 'right' });
    doc.moveDown(0.35);
  };
  row('Subtotal', num(q.subtotal_cents));
  if (num(q.discount_amount_cents) > 0) row('Discount', -num(q.discount_amount_cents));
  row(q.gct_exempt ? 'GCT (exempt)' : 'GCT 15%', num(q.gct_cents));
  row('Total', num(q.grand_total_cents), true);

  if (q.notes) {
    doc.moveDown(1).fontSize(9).fillColor('#333').text(String(q.notes), 50, doc.y, { width: 510 });
  }
  doc.moveDown(2).fontSize(8).fillColor('#777')
    .text(`${BRAND.company}  ·  All amounts in Jamaican dollars. This is a quotation, not an invoice.`
      + `\nContact ${await contactEmail(db)} for any orders or queries.`,
      50, doc.y, { align: 'center', width: 510 });
  return {
    filename: `${q.quote_number}.pdf`, quoteNumber: String(q.quote_number), customerName: customer.name, customerEmail: customer.email,
  };
}

/**
 * Email a quote with its PDF and a link the customer can accept it from.
 * Sending marks it Sent. The link is always returned so it can also be
 * copied into WhatsApp or read over the phone.
 */
export async function emailQuote(
  db: Db, actor: Actor, quoteId: string, opts: { to?: string | null; note?: string | null } = {},
): Promise<{ sentTo: string | null; link: string; quoteNumber: string }> {
  requireRole(actor, 'admin', 'user');
  const q = await db.one<{ status: string; quote_number: string }>(
    `SELECT status, quote_number FROM quotations WHERE id = $1`, [quoteId],
  );
  if (['Converted', 'Declined'].includes(q.status)) {
    throw new RuleViolation(`${q.quote_number} is ${q.status.toLowerCase()}; it cannot be sent again`);
  }
  if (!mailConfigured()) {
    throw new RuleViolation('email is not set up on this machine yet. Download the PDF and send it '
      + 'yourself, then press "Mark as sent".');
  }
  const doc = await renderQuotePdf(db, quoteId);
  const to = recipient(opts.to, doc.customerEmail, doc.customerName);
  const token = await db.tx((t) => issueAcceptToken(t, quoteId));
  const link = quoteAcceptLink(token);

  const qrow = await db.one<{ customer_id: string; valid_until: string | null; grand_total_cents: number }>(
    `SELECT customer_id, valid_until::text AS valid_until, grand_total_cents FROM quotations WHERE id = $1`, [quoteId],
  );
  const mail = await customerEmail(db, qrow.customer_id, null, {
    preheader: `Quotation ${doc.quoteNumber} from ${BRAND.name}`,
    heading: `Quotation ${doc.quoteNumber}`,
    subheading: doc.customerName,
    greeting: 'Good day,',
    intro: `Please find attached quotation ${doc.quoteNumber} from ${BRAND.name}.`
      + (opts.note ? `\n\n${opts.note}` : ''),
    facts: [
      ['Total', cash(num(qrow.grand_total_cents))],
      ['Valid until', qrow.valid_until ? fmtDate(qrow.valid_until) : 'Ask us'],
    ],
    button: { label: 'Accept this quotation', url: link },
    outro: 'Or simply reply to this email and we will take it from there.',
  });
  await sendMail({
    to,
    subject: `${BRAND.name} quotation ${doc.quoteNumber}`,
    text: mail.text, html: mail.html,
    attachments: [{ filename: doc.filename, content: doc.pdf }],
  });
  await db.tx((t) => audit(t, actor, 'update', 'Quotation', quoteId, doc.quoteNumber, { emailedTo: to }));
  return { sentTo: to, link, quoteNumber: doc.quoteNumber };
}

/** Sent some other way (printed, WhatsApp): mark it Sent and get a link. */
export async function markQuoteSent(db: Db, actor: Actor, quoteId: string) {
  requireRole(actor, 'admin', 'user');
  const q = await db.one<{ status: string; quote_number: string }>(
    `SELECT status, quote_number FROM quotations WHERE id = $1`, [quoteId],
  );
  if (!['Draft', 'Sent'].includes(q.status)) {
    throw new RuleViolation(`${q.quote_number} is ${q.status.toLowerCase()}`);
  }
  const token = await db.tx(async (t) => {
    const tok = await issueAcceptToken(t, quoteId);
    await audit(t, actor, 'update', 'Quotation', quoteId, q.quote_number, { markedSent: true });
    return tok;
  });
  return { link: quoteAcceptLink(token) };
}

/* ------------------------------------------------------------------ */
/* Purchase order                                                      */
/* ------------------------------------------------------------------ */

export async function renderPoPdf(db: Db, poId: string) {
  const { doc, finished } = newDoc();
  const meta = await drawPo(doc, db, poId);
  doc.end();
  return { ...meta, pdf: await finished };
}

async function drawPo(doc: PDFKit.PDFDocument, db: Db, poId: string) {
  const po = await getPurchaseOrder(db, poId) as unknown as Record<string, unknown> & {
    lines: Array<Record<string, unknown>>;
  } | null;
  if (!po) throw new RuleViolation('that purchase order no longer exists');
  const envRate = await db.maybeOne<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = 'env_tax_rate_percent'`,
  );

  letterhead(doc, 50);
  doc.moveDown(1.2);
  doc.fillColor(COLOR_INDIGO).fontSize(16).text('PURCHASE ORDER', 50, doc.y, { align: 'right', width: 510 });
  doc.fontSize(10)
    .text(String(po.po_number), { align: 'right', width: 510 })
    .text(`Date: ${fmtDate(po.order_date)}`, { align: 'right', width: 510 });
  if (po.expected_delivery_date) {
    doc.text(`Required by: ${fmtDate(po.expected_delivery_date)}`, { align: 'right', width: 510 });
  }
  doc.moveDown(1);
  doc.fontSize(9).fillColor('#555').text('SUPPLIER', 50);
  doc.fontSize(11).fillColor('#000').text(String(po.supplier_name));
  doc.fontSize(9).fillColor('#333');
  if (po.supplier_contact) doc.text(`Attn: ${po.supplier_contact}`);
  if (po.supplier_address) doc.text(String(po.supplier_address));
  if (po.supplier_phone) doc.text(String(po.supplier_phone));
  if (po.supplier_email) doc.text(String(po.supplier_email));
  doc.moveDown(1.2);

  const cols = { desc: 50, qty: 300, unit: 370, tax: 440, total: 480 };
  const y0 = doc.y;
  doc.fillColor('#555').fontSize(8)
    .text('ITEM', cols.desc, y0).text('QTY', cols.qty, y0)
    .text('UNIT COST', cols.unit, y0, { width: 60, align: 'right' })
    .text('TAX', cols.tax, y0, { width: 36 })
    .text('AMOUNT', cols.total, y0, { width: 80, align: 'right' });
  doc.moveTo(50, doc.y + 2).lineTo(560, doc.y + 2).strokeColor(COLOR_BLUE).stroke();
  doc.moveDown(0.6);
  for (const l of po.lines) {
    const y = doc.y;
    const tax = [l.gct_exempt ? null : 'G', l.env_exempt ? null : 'E'].filter(Boolean).join('');
    doc.fontSize(9).fillColor('#000')
      .text(String(l.raw_material_name), cols.desc, y, { width: 240 })
      .text(`${Number(l.quantity_ordered)} ${l.unit_of_measure ?? ''}`, cols.qty, y, { width: 66 })
      .text(cash(num(l.unit_cost_cents)), cols.unit, y, { width: 60, align: 'right' })
      .text(tax || '-', cols.tax, y, { width: 36 })
      .text(cash(num(l.line_total_cents) || Math.round(num(l.unit_cost_cents) * Number(l.quantity_ordered))),
        cols.total, y, { width: 80, align: 'right' });
    doc.moveDown(0.4);
  }
  doc.moveDown(0.8);
  const row = (label: string, v: number, bold = false) => {
    const y = doc.y;
    doc.fillColor('#000').fontSize(bold ? 11 : 9)
      .text(label, cols.unit - 170, y, { width: 240, align: 'right' })
      .text(cash(v), cols.total, y, { width: 80, align: 'right' });
    doc.moveDown(0.35);
  };
  row('Subtotal', num(po.subtotal_cents));
  row('GCT 15% (items marked G)', num(po.gct_cents));
  row(`Environmental Levy ${envRate?.value ?? '0.375'}% (items marked E)`, num(po.env_tax_cents));
  row('Total', num(po.grand_total_cents), true);
  if (po.notes) doc.moveDown(1).fontSize(9).fillColor('#333').text(String(po.notes), 50, doc.y, { width: 510 });
  doc.moveDown(2).fontSize(8).fillColor('#777')
    .text(`${BRAND.company}  ·  Please quote ${po.po_number} on your invoice and delivery note.`,
      50, doc.y, { align: 'center', width: 510 });
  return {
    filename: `${po.po_number}.pdf`, poNumber: String(po.po_number), supplierName: String(po.supplier_name),
    supplierEmail: (po.supplier_email as string) ?? null,
  };
}

export async function emailPurchaseOrder(
  db: Db, actor: Actor, poId: string, opts: { to?: string | null; note?: string | null } = {},
): Promise<{ sentTo: string; poNumber: string }> {
  requireRole(actor, 'admin', 'user');
  const doc = await renderPoPdf(db, poId);
  const to = recipient(opts.to, doc.supplierEmail, doc.supplierName);
  // To a supplier: the same look, no offer band, no unsubscribe.
  const mail = renderEmail({
    preheader: `Purchase order ${doc.poNumber} from ${BRAND.company}`,
    heading: `Purchase order ${doc.poNumber}`,
    subheading: BRAND.company,
    greeting: 'Good day,',
    intro: `Please find attached purchase order ${doc.poNumber} from ${BRAND.company}.`
      + (opts.note ? `\n\n${opts.note}` : ''),
    outro: 'Kindly confirm receipt and the delivery date.',
    offer: null, contact: await contactEmail(db),
  });
  await sendMail({
    to,
    subject: `${BRAND.name} purchase order ${doc.poNumber}`,
    text: mail.text, html: mail.html,
    attachments: [{ filename: doc.filename, content: doc.pdf }],
  });
  await db.tx(async (t) => {
    await t.query(
      `UPDATE purchase_orders SET status = CASE WHEN status = 'Draft' THEN 'Sent' ELSE status END,
         sent_to = $2, updated_at = now()
       WHERE id = $1`, [poId, to],
    );
    await audit(t, actor, 'update', 'PurchaseOrder', poId, doc.poNumber, { emailedTo: to });
  });
  return { sentTo: to, poNumber: doc.poNumber };
}

/* ------------------------------------------------------------------ */
/* Payment receipt                                                     */
/* ------------------------------------------------------------------ */

/**
 * A receipt for money received. Covers every piece of one receipt - a
 * payment spread over three invoices is three payment rows but one receipt -
 * so it takes a list of payment ids. They share one receipt number, given
 * the first time a receipt is issued.
 */
export async function renderReceiptPdf(db: Db, paymentIds: readonly string[]) {
  const { doc, finished } = newDoc();
  const meta = await drawReceipt(doc, db, paymentIds);
  doc.end();
  return { ...meta, pdf: await finished };
}

async function drawReceipt(doc: PDFKit.PDFDocument, db: Db, chosenIds: readonly string[]) {
  if (chosenIds.length === 0) throw new RuleViolation('no payment to give a receipt for');
  // A receipt is for whole payments (12 Oct 2026): a payment spread over
  // several invoices is several rows sharing one number, and its receipt
  // shows them all, whichever row was picked.
  const paymentIds = (await db.query<{ id: string }>(
    `SELECT id FROM payments
     WHERE id = ANY($1::uuid[])
        OR (NOT is_reversal AND amount_cents > 0 AND receipt_number IN (
              SELECT receipt_number FROM payments WHERE id = ANY($1::uuid[]) AND receipt_number IS NOT NULL))`,
    [[...chosenIds]],
  )).map((r) => r.id);
  const rows = await db.query<{
    id: string; customer_id: string; amount_cents: number; payment_date: string; method: string;
    reference: string | null; receipt_number: string | null; invoice_number: string | null;
    is_reversal: boolean;
  }>(
    `SELECT p.id, p.customer_id, p.amount_cents, business_date(p.payment_date)::text AS payment_date,
            p.method, p.reference, p.receipt_number, i.invoice_number, p.is_reversal
     FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
     WHERE p.id = ANY($1::uuid[]) ORDER BY i.invoice_number NULLS LAST`, [paymentIds],
  );
  if (rows.length === 0) throw new RuleViolation('that payment no longer exists');
  if (new Set(rows.map((r) => r.customer_id)).size > 1) {
    throw new RuleViolation('a receipt is for one customer');
  }
  if (rows.some((r) => r.is_reversal)) throw new RuleViolation('a reversal does not get a receipt');

  // Every payment is numbered when it is recorded (migration 024); one
  // recorded before that and somehow missed gets its number now.
  const missing = rows.filter((r) => !r.receipt_number);
  if (missing.length) {
    const n = await db.tx((t) => nextNumber(t, 'receipt_number_seq', 'RCT'));
    await db.query(`UPDATE payments SET receipt_number = $2 WHERE id = ANY($1::uuid[])`, [missing.map((r) => r.id), n]);
    for (const r of missing) r.receipt_number = n;
  }
  const number = [...new Set(rows.map((r) => r.receipt_number!))].join(', ');
  const customer = await billTo(db, rows[0].customer_id);
  const balance = await db.one<{ b: string }>(
    `SELECT COALESCE(balance_cents,0)::text AS b FROM customer_balances WHERE customer_id = $1`,
    [rows[0].customer_id],
  );
  const total = rows.reduce((s, r) => s + num(r.amount_cents), 0);

  letterhead(doc, 50);
  doc.moveDown(1.2);
  doc.fillColor(COLOR_INDIGO).fontSize(16).text('RECEIPT', 50, doc.y, { align: 'right', width: 510 });
  doc.fontSize(10).text(number, { align: 'right', width: 510 })
    .text(`Date: ${fmtDate(rows[0].payment_date)}`, { align: 'right', width: 510 });
  doc.moveDown(1);
  doc.fontSize(9).fillColor('#555').text('RECEIVED FROM', 50);
  doc.fontSize(11).fillColor('#000').text(customer.name);
  doc.fontSize(9).fillColor('#333');
  if (customer.address) doc.text(customer.address);
  doc.moveDown(1.2);

  doc.fontSize(12).fillColor('#000').text(`Amount received: ${cash(total)}`, 50);
  doc.fontSize(9).fillColor('#333')
    .text(`Paid by ${rows[0].method}${rows[0].reference ? `, reference ${rows[0].reference}` : ''}`);
  doc.moveDown(1);
  doc.fontSize(8).fillColor('#555').text('APPLIED TO', 50);
  doc.moveDown(0.3);
  for (const r of rows) {
    const y = doc.y;
    doc.fontSize(9).fillColor('#000')
      .text(r.invoice_number ? `Invoice ${r.invoice_number}` : 'On account (not yet against an invoice)', 50, y)
      .text(cash(num(r.amount_cents)), 430, y, { width: 130, align: 'right' });
    doc.moveDown(0.4);
  }
  doc.moveDown(0.8);
  const b = Number(balance.b);
  doc.fontSize(10).fillColor('#000')
    .text(b > 0 ? `Balance still owed on the account: ${cash(b)}`
      : b < 0 ? `Account in credit: ${cash(-b)}` : 'The account is fully paid. Thank you.', 50);
  doc.moveDown(2).fontSize(8).fillColor('#777')
    .text(`${BRAND.company}  ·  All amounts in Jamaican dollars.`
      + `\nContact ${await contactEmail(db)} for any orders or queries.`, 50, doc.y, { align: 'center', width: 510 });
  return {
    filename: `Receipt-${number.split(", ")[0]}.pdf`, receiptNumber: number,
    customerName: customer.name, customerEmail: customer.email, totalCents: total,
  };
}

/** Email a receipt (the "send a receipt" tick box, Zoho-style). */
export async function emailReceipt(
  db: Db, actor: Actor, paymentIds: readonly string[], opts: { to?: string | null } = {},
): Promise<{ sentTo: string; receiptNumber: string }> {
  requireRole(actor, 'admin', 'user');
  if (!mailConfigured()) {
    throw new RuleViolation('email is not set up on this computer. The receipt can be downloaded '
      + 'from their Transactions tab and sent by hand.');
  }
  const doc = await renderReceiptPdf(db, paymentIds);
  const to = recipient(opts.to, doc.customerEmail, doc.customerName);
  const rcpt = await db.one<{ customer_id: string; method: string; day: string }>(
    `SELECT customer_id, method, business_date(payment_date)::text AS day FROM payments WHERE id = $1`, [paymentIds[0]],
  );
  const bal = await db.one<{ b: number }>(
    `SELECT COALESCE((SELECT balance_cents FROM customer_balances WHERE customer_id = $1), 0)::bigint AS b`,
    [rcpt.customer_id],
  );
  const mail = await customerEmail(db, rcpt.customer_id, null, {
    preheader: `Receipt ${doc.receiptNumber}: thank you for your payment`,
    tick: true,
    heading: 'Thank you for your payment',
    subheading: `Receipt ${doc.receiptNumber}`,
    greeting: 'Good day,',
    intro: `We have received your payment of ${cash(doc.totalCents)}. Your receipt is attached.`,
    facts: [
      ['Paid', `${cash(doc.totalCents)}${rcpt.method ? ` by ${rcpt.method.toLowerCase()}` : ''}`],
      ['Date', fmtDate(rcpt.day)],
      [num(bal.b) < 0 ? 'In credit' : 'Balance on account', cash(Math.abs(num(bal.b)))],
    ],
    button: { label: 'See my account', url: `${siteUrl()}/#/portal/account` },
  });
  await sendMail({
    to,
    subject: `${BRAND.name} receipt ${doc.receiptNumber}`,
    text: mail.text, html: mail.html,
    attachments: [{ filename: doc.filename, content: doc.pdf }],
  });
  await db.tx((t) => audit(t, actor, 'update', 'Payment', paymentIds[0], doc.receiptNumber,
    { receiptEmailedTo: to, paymentIds }));
  return { sentTo: to, receiptNumber: doc.receiptNumber };
}

/* ------------------------------------------------------------------ */
/* Automatic emails (point 17) and cycle invoices (point 15)           */
/* ------------------------------------------------------------------ */

export interface AutomationSettings {
  statementsEnabled: boolean;
  statementsDay: number;
  remindersEnabled: boolean;
  remindersAfterDays: number;
  remindersEveryDays: number;
  cycleInvoicesAutoSend: boolean;
}

const KEYS: Record<keyof AutomationSettings, string> = {
  statementsEnabled: 'auto_statements_enabled',
  statementsDay: 'auto_statements_day',
  remindersEnabled: 'auto_reminders_enabled',
  remindersAfterDays: 'auto_reminders_after_days',
  remindersEveryDays: 'auto_reminders_every_days',
  cycleInvoicesAutoSend: 'cycle_invoices_auto_send',
};

export async function getAutomation(db: Db): Promise<AutomationSettings & { mailConfigured: boolean }> {
  const rows = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM system_settings WHERE key = ANY($1::text[])`, [Object.values(KEYS)],
  );
  const v = (k: keyof AutomationSettings) => rows.find((r) => r.key === KEYS[k])?.value;
  return {
    statementsEnabled: v('statementsEnabled') === 'true',
    statementsDay: Math.min(Math.max(Number(v('statementsDay')) || 1, 1), 28),
    remindersEnabled: v('remindersEnabled') === 'true',
    remindersAfterDays: Math.max(Number(v('remindersAfterDays')) || 7, 0),
    remindersEveryDays: Math.max(Number(v('remindersEveryDays')) || 14, 1),
    cycleInvoicesAutoSend: v('cycleInvoicesAutoSend') === 'true',
    mailConfigured: mailConfigured(),
  };
}

export async function setAutomation(db: Db, actor: Actor, input: Partial<AutomationSettings>) {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    for (const [k, key] of Object.entries(KEYS) as Array<[keyof AutomationSettings, string]>) {
      if (!(k in input)) continue;
      let value = String(input[k]);
      if (k === 'statementsDay') value = String(Math.min(Math.max(Number(input[k]) || 1, 1), 28));
      await t.query(
        `INSERT INTO system_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value],
      );
    }
    await audit(t, actor, 'update', 'Settings', null, 'Automatic emails', input as Record<string, unknown>);
  });
  return getAutomation(db);
}

async function logAuto(db: Db, kind: string, customerId: string, sentTo: string | null,
  periodKey: string | null, detail: string, ok: boolean) {
  await db.query(
    `INSERT INTO auto_emails (kind, customer_id, sent_to, period_key, detail, ok)
     VALUES ($1,$2,$3,$4,$5,$6)`, [kind, customerId, sentTo, periodKey, detail, ok],
  );
}

export interface AutomationRun {
  cycleInvoices: number;
  cycleInvoicesSent: number;
  statements: number;
  reminders: number;
  problems: string[];
}

/**
 * The hourly job. Safe to run as often as you like:
 *   - cycle invoices are raised only for closed weeks/months not yet invoiced;
 *   - a monthly statement goes once per customer per month, on or after the
 *     chosen day, to customers who owe something and have not opted out;
 *   - a reminder goes when an invoice is overdue by the chosen number of
 *     days, then again every N days while it stays unpaid.
 * Nothing is sent when email is not set up; that is reported, not an error.
 */
export async function runAutomation(db: Db, actor: Actor, opts: { today?: string } = {}): Promise<AutomationRun> {
  const today = opts.today ?? businessToday();
  const out: AutomationRun = { cycleInvoices: 0, cycleInvoicesSent: 0, statements: 0, reminders: 0, problems: [] };
  const s = await getAutomation(db);

  // 1. Weekly and monthly invoices for periods that have closed.
  try {
    const raised = await raiseCycleInvoices(db, actor, { today, mode: 'closed' });
    out.cycleInvoices = raised.length;
    if (s.cycleInvoicesAutoSend && mailConfigured()) {
      for (const r of raised) {
        try {
          const sent = await emailInvoice(db, actor, r.invoiceId);
          await logAuto(db, 'CycleInvoice', r.customerId, sent.sentTo, r.invoiceNumber, 'sent', true);
          out.cycleInvoicesSent += 1;
        } catch (err) {
          await logAuto(db, 'CycleInvoice', r.customerId, null, r.invoiceNumber, (err as Error).message, false);
          out.problems.push(`${r.customerName}: ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    out.problems.push(`weekly/monthly invoices: ${(err as Error).message}`);
  }

  if (!mailConfigured()) return out;

  // 2. Monthly statements.
  const dayOfMonth = Number(today.slice(8, 10));
  if (s.statementsEnabled && dayOfMonth >= s.statementsDay) {
    const month = today.slice(0, 7);
    const due = await db.query<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM customers c
       JOIN customer_balances b ON b.customer_id = c.id
       WHERE c.active AND c.auto_statements AND b.balance_cents > 0
         AND c.email IS NOT NULL AND btrim(c.email) <> ''
         AND NOT EXISTS (SELECT 1 FROM auto_emails a WHERE a.customer_id = c.id
                          AND a.kind = 'Statement' AND a.period_key = $1 AND a.ok)`,
      [month],
    );
    for (const c of due) {
      try {
        const r = await emailStatement(db, actor, c.id, { category: 'statements' });
        await logAuto(db, 'Statement', c.id, r.sentTo, month, 'monthly statement', true);
        out.statements += 1;
      } catch (err) {
        await logAuto(db, 'Statement', c.id, null, month, (err as Error).message, false);
        out.problems.push(`${c.name}: ${(err as Error).message}`);
      }
    }
  }

  // 3. Payment reminders for overdue invoices.
  if (s.remindersEnabled) {
    const cutoff = addDays(today, -s.remindersAfterDays);
    const again = addDays(today, -s.remindersEveryDays);
    const overdue = await db.query<{
      invoice_id: string; invoice_number: string; customer_id: string; customer_name: string;
      due_date: string; balance_cents: number;
    }>(
      `SELECT l.invoice_id, l.invoice_number, l.customer_id, l.customer_name,
              l.due_date::text AS due_date, l.balance_cents
       FROM invoice_ledger l
       JOIN invoices i ON i.id = l.invoice_id
       JOIN customers c ON c.id = l.customer_id
       WHERE NOT l.is_credit_note AND l.balance_cents > 0 AND l.status <> 'Cancelled'
         AND l.due_date IS NOT NULL AND l.due_date <= $1::date
         AND c.active AND c.auto_reminders AND c.email IS NOT NULL AND btrim(c.email) <> ''
         AND (i.last_reminder_on IS NULL OR i.last_reminder_on <= $2::date)
       ORDER BY l.customer_name, l.due_date`,
      [cutoff, again],
    );
    const byCustomer = new Map<string, typeof overdue>();
    for (const o of overdue) {
      byCustomer.set(o.customer_id, [...(byCustomer.get(o.customer_id) ?? []), o]);
    }
    for (const [customerId, list] of byCustomer) {
      const total = list.reduce((a, o) => a + num(o.balance_cents), 0);
      const lines = list.map((o) => `  ${o.invoice_number}, due ${fmtDate(o.due_date)}: ${cash(num(o.balance_cents))}`).join('\n');
      try {
        const r = await emailStatement(db, actor, customerId, {
          subject: `${BRAND.name} payment reminder`,
          category: 'reminders',
          note: `A friendly reminder that the following ${list.length === 1 ? 'invoice is' : 'invoices are'} `
            + `past due:\n\n${lines}\n\nTotal overdue: ${cash(total)}.\n\nIf you have already paid, thank you, `
            + 'and please disregard this note.',
        });
        await db.query(`UPDATE invoices SET last_reminder_on = $2::date WHERE id = ANY($1::uuid[])`,
          [list.map((o) => o.invoice_id), today]);
        await logAuto(db, 'Reminder', customerId, r.sentTo, list.map((o) => o.invoice_number).join(','),
          `${list.length} overdue, ${cash(total)}`, true);
        out.reminders += 1;
      } catch (err) {
        await logAuto(db, 'Reminder', customerId, null, null, (err as Error).message, false);
        out.problems.push(`${list[0].customer_name}: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

export async function automationLog(db: Db, limit = 100) {
  return db.query(
    `SELECT a.*, a.sent_on::text AS sent_on, c.name AS customer_name
     FROM auto_emails a JOIN customers c ON c.id = a.customer_id
     ORDER BY a.created_at DESC LIMIT $1`, [limit],
  );
}

/* ------------------------------------------------------------------ */
/* Several at once: batch actions on the lists (11 Oct 2026)           */
/* ------------------------------------------------------------------ */

/** What happened to each thing a batch action was asked to send. */
export interface BatchResult { label: string; sentTo?: string; error?: string }

/** Several documents in one PDF, each starting on its own page. */
async function printEach(
  ids: readonly string[], noun: string, filename: string,
  draw: (doc: PDFKit.PDFDocument, id: string) => Promise<unknown>,
): Promise<{ filename: string; pdf: Buffer }> {
  const list = [...new Set(ids)];
  if (list.length === 0) throw new RuleViolation(`choose at least one ${noun}`);
  const { doc, finished } = newDoc();
  for (let i = 0; i < list.length; i++) {
    if (i > 0) doc.addPage();
    await draw(doc, list[i]);
  }
  doc.end();
  return { filename, pdf: await finished };
}

export async function printQuotes(db: Db, ids: readonly string[]) {
  return printEach(ids, 'quote', `Quotes-${ids.length}.pdf`, (doc, id) => drawQuote(doc, db, id));
}

export async function printPurchaseOrders(db: Db, ids: readonly string[]) {
  return printEach(ids, 'purchase order', `Purchase-orders-${ids.length}.pdf`, (doc, id) => drawPo(doc, db, id));
}

/** One receipt per payment, any customers, in one PDF. Reversals have none. */
export async function printReceipts(db: Db, paymentIds: readonly string[]) {
  const ok = await db.query<{ id: string; receipt_number: string | null }>(
    `SELECT id, receipt_number FROM payments WHERE id = ANY($1::uuid[]) AND NOT is_reversal AND amount_cents > 0
     ORDER BY payment_date, created_at`, [[...new Set(paymentIds)]],
  );
  if (ok.length === 0) throw new RuleViolation('none of those payments gets a receipt (reversals do not)');
  // One receipt per payment number: the rows of one payment print together.
  const seen = new Set<string>();
  const firsts = ok.filter((r) => {
    const k = r.receipt_number ?? r.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((r) => r.id);
  return printEach(firsts, 'payment', `Receipts-${firsts.length}.pdf`, (doc, id) => drawReceipt(doc, db, [id]));
}

/** Each customer gets one receipt email covering their payments in the batch. */
export async function emailReceiptsByCustomer(
  db: Db, actor: Actor, paymentIds: readonly string[],
): Promise<BatchResult[]> {
  requireRole(actor, 'admin', 'user');
  const rows = await db.query<{ id: string; customer_id: string; name: string }>(
    `SELECT p.id, p.customer_id, c.name FROM payments p JOIN customers c ON c.id = p.customer_id
     WHERE p.id = ANY($1::uuid[]) AND NOT p.is_reversal AND p.amount_cents > 0
     ORDER BY c.name, p.payment_date`, [[...new Set(paymentIds)]],
  );
  const groups = new Map<string, { name: string; ids: string[] }>();
  for (const r of rows) {
    if (!groups.has(r.customer_id)) groups.set(r.customer_id, { name: r.name, ids: [] });
    groups.get(r.customer_id)!.ids.push(r.id);
  }
  const out: BatchResult[] = [];
  for (const g of groups.values()) {
    try {
      const r = await emailReceipt(db, actor, g.ids, {});
      out.push({ label: g.name, sentTo: r.sentTo });
    } catch (e) { out.push({ label: g.name, error: (e as Error).message }); }
  }
  return out;
}

export async function emailPurchaseOrders(db: Db, actor: Actor, ids: readonly string[]): Promise<BatchResult[]> {
  const out: BatchResult[] = [];
  for (const id of new Set(ids)) {
    try {
      const r = await emailPurchaseOrder(db, actor, id);
      out.push({ label: r.poNumber, sentTo: r.sentTo });
    } catch (e) {
      const po = await db.maybeOne<{ po_number: string }>(`SELECT po_number FROM purchase_orders WHERE id = $1`, [id]);
      out.push({ label: po?.po_number ?? 'A purchase order', error: (e as Error).message });
    }
  }
  return out;
}

export async function emailQuotes(db: Db, actor: Actor, ids: readonly string[]): Promise<BatchResult[]> {
  const out: BatchResult[] = [];
  for (const id of new Set(ids)) {
    try {
      const r = await emailQuote(db, actor, id);
      out.push({ label: r.quoteNumber, sentTo: r.sentTo ?? undefined });
    } catch (e) {
      const q = await db.maybeOne<{ quote_number: string }>(`SELECT quote_number FROM quotations WHERE id = $1`, [id]);
      out.push({ label: q?.quote_number ?? 'A quote', error: (e as Error).message });
    }
  }
  return out;
}
