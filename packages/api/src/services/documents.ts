/**
 * Invoice documents: the PDF a customer receives, and sending it.
 *
 * The PDF is generated from the same ledger figures the screen shows, so a
 * printed invoice and an on-screen one can never disagree.
 *
 * Sending is deliberately inert until configured. There is no fallback SMTP
 * host, no default account: with nothing set up, a send is refused with an
 * explanation rather than silently going nowhere. Nothing here ever stores a
 * password - the credentials are read from the environment, which the person
 * running Alka Vida sets up themselves.
 */

import PDFDocument from 'pdfkit';
import { createTransport } from 'nodemailer';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num } from './core.ts';
import { RuleViolation } from '@alka/shared';
import { getInvoiceDetail } from './invoices.ts';
import { getStatement, type StatementFilter } from './ledger.ts';
import { bottleAccount } from './bottles.ts';

const BRAND = {
  name: 'Alka Vida',
  company: '1506 Investments Limited',
  line1: 'Kingston, Jamaica',
};

/** Repository root: src/services -> src -> api -> packages -> root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The company logo, if the owner has supplied one.
 *
 * A file beside the launcher, exactly where the settings file lives, because
 * that is the one folder a non-technical owner already knows to open. It is
 * deliberately NOT in the repository: a logo is the business's property, it
 * changes without the software changing, and a placeholder shipped in git
 * would eventually go out on a real customer's statement.
 *
 * With no logo present every document falls back to the wordmark set in type.
 * Nothing fails and nothing is blank - the letterhead is simply plainer.
 */
const LOGO_CANDIDATES = ['Alka Vida logo.png', 'Alka Vida logo.jpg', 'logo.png'];

export function logoPath(): string | null {
  for (const name of LOGO_CANDIDATES) {
    const p = join(REPO_ROOT, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * The letterhead every document shares, so an invoice and a statement are
 * recognisably from the same company.
 */
const LOGO_TOP = 45;
/** Generous enough for a tall logo, narrow enough to leave the page room. */
const LOGO_BOX: [number, number] = [150, 86];

function letterhead(doc: PDFKit.PDFDocument, left: number): void {
  const logo = logoPath();
  if (logo) {
    try {
      /*
       * Fitted, never stretched - a logo squashed to fill a box looks worse
       * than no logo at all.
       *
       * The company line is placed under where the logo ACTUALLY ends, not at
       * a fixed offset. A box sized for a wide wordmark renders a squarish
       * logo under an inch across, and a fixed offset then either overlaps it
       * or leaves a hole. `openImage` gives the real dimensions, so the same
       * code suits whatever shape of logo the business happens to own.
       */
      const img = doc.openImage(logo);
      const scale = Math.min(LOGO_BOX[0] / img.width, LOGO_BOX[1] / img.height);
      const height = img.height * scale;
      doc.image(logo, left, LOGO_TOP, { fit: LOGO_BOX });
      doc.fontSize(9).fillColor('#555')
        .text(BRAND.company, left, LOGO_TOP + height + 8)
        .text(BRAND.line1);
      return;
    } catch {
      // A corrupt or unreadable image must never stop a document going out.
    }
  }
  doc.fontSize(20).fillColor('#000').text(BRAND.name, left, 50);
  doc.fontSize(9).fillColor('#555')
    .text(BRAND.company)
    .text(BRAND.line1);
}

const cash = (cents: number) => {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toLocaleString('en-JM');
  return `${neg ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
};

export interface InvoiceDocument {
  filename: string;
  pdf: Buffer;
  invoiceNumber: string;
  customerName: string;
  customerEmail: string | null;
}

/** Build the invoice PDF. Pure rendering - it changes nothing. */
export async function renderInvoicePdf(db: Db, invoiceId: string): Promise<InvoiceDocument> {
  const detail = await getInvoiceDetail(db, invoiceId);
  if (!detail) throw new RuleViolation('that invoice no longer exists');
  const ledger = detail as unknown as {
    customerId: string; invoiceNumber: string; invoiceDate: string;
    dueDate: string | null; isCreditNote: boolean; grandTotalCents: number;
    amountPaidCents: number; balanceCents: number;
    subtotal_cents: number; discount_amount_cents: number; gct_cents: number;
  };

  const customer = await db.one<{
    name: string; email: string | null; phone: string | null;
    delivery_address: string | null; payment_terms: string | null;
  }>(
    `SELECT name, email, phone, delivery_address, payment_terms
     FROM customers WHERE id = $1`,
    [ledger.customerId],
  );

  const orders = await db.query<{ order_number: string; delivery_mode: string }>(
    `SELECT o.order_number, o.delivery_mode
     FROM invoice_orders io JOIN customer_orders o ON o.id = io.order_id
     WHERE io.invoice_id = $1 ORDER BY o.order_number`,
    [invoiceId],
  );

  const lines = (detail as unknown as { lines?: Array<Record<string, unknown>> }).lines ?? [];

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  /* letterhead — shared with the statement, so the two match */
  letterhead(doc, 50);
  doc.moveDown(1.2);

  doc.fillColor('#000').fontSize(16)
    .text(ledger.isCreditNote ? 'CREDIT NOTE' : 'INVOICE', { align: 'right' });
  doc.fontSize(10)
    .text(ledger.invoiceNumber, { align: 'right' })
    .text(`Date: ${String(ledger.invoiceDate).slice(0, 10)}`, { align: 'right' });
  if (ledger.dueDate) {
    doc.text(`Due: ${String(ledger.dueDate).slice(0, 10)}`, { align: 'right' });
  }
  doc.moveDown(1);

  /* who it is for */
  doc.fontSize(9).fillColor('#555').text('BILL TO');
  doc.fontSize(11).fillColor('#000').text(customer.name);
  doc.fontSize(9).fillColor('#333');
  if (customer.delivery_address) doc.text(customer.delivery_address);
  if (customer.phone) doc.text(customer.phone);
  if (customer.email) doc.text(customer.email);
  if (customer.payment_terms) doc.text(`Terms: ${customer.payment_terms}`);
  if (orders.length > 0) {
    doc.text(`Order${orders.length > 1 ? 's' : ''}: ${orders.map((o) => o.order_number).join(', ')}`);
  }
  doc.moveDown(1.2);

  /* the goods */
  const left = 50;
  const cols = { desc: left, qty: 330, unit: 400, total: 480 };
  doc.fillColor('#000').fontSize(9);
  doc.text('DESCRIPTION', cols.desc, doc.y, { continued: true });
  doc.text('QTY', cols.qty, doc.y, { continued: true });
  doc.text('UNIT', cols.unit, doc.y, { continued: true });
  doc.text('AMOUNT', cols.total, doc.y);
  doc.moveTo(left, doc.y + 2).lineTo(560, doc.y + 2).strokeColor('#ccc').stroke();
  doc.moveDown(0.6);

  for (const l of lines) {
    const cases = num(l.cases as number);
    const loose = num(l.loose_bottles as number);
    const qty = cases > 0 ? `${cases} cs` : `${loose}`;
    const unit = cases > 0
      ? num(l.price_per_case_cents as number)
      : num(l.price_per_bottle_cents as number);
    const y = doc.y;
    doc.fontSize(9)
      .text(String(l.product_name ?? ''), cols.desc, y, { width: 270 })
      .text(qty, cols.qty, y)
      .text(cash(unit), cols.unit, y)
      .text(cash(num(l.line_total_cents as number)), cols.total, y);
    doc.moveDown(0.4);
  }

  doc.moveDown(0.8);
  const money = (label: string, value: number, bold = false) => {
    const y = doc.y;
    doc.fontSize(bold ? 11 : 9)
      .text(label, cols.unit - 80, y, { width: 150, align: 'right' })
      .text(cash(value), cols.total, y, { width: 80, align: 'right' });
    doc.moveDown(0.35);
  };
  money('Subtotal', num(ledger.subtotal_cents));
  if (num(ledger.discount_amount_cents) > 0) {
    money('Discount', -num(ledger.discount_amount_cents));
  }
  money('GCT 15%', num(ledger.gct_cents));
  money('Total', ledger.grandTotalCents, true);
  money('Paid', ledger.amountPaidCents);
  money('Balance due', ledger.balanceCents, true);

  doc.moveDown(2).fontSize(8).fillColor('#777')
    .text(`${BRAND.company}  ·  All amounts in Jamaican dollars, GCT inclusive.`,
      left, doc.y, { align: 'center', width: 510 });

  doc.end();
  const pdf = await finished;

  return {
    filename: `${ledger.invoiceNumber}.pdf`,
    pdf,
    invoiceNumber: ledger.invoiceNumber,
    customerName: customer.name,
    customerEmail: customer.email,
  };
}

export interface StatementDocument {
  filename: string;
  pdf: Buffer;
  customerName: string;
  customerEmail: string | null;
}

/**
 * The statement of account a customer receives.
 *
 * Built from `getStatement` - the same figures the screen shows - so a printed
 * statement and the one on screen cannot disagree, the same rule the invoice
 * follows.
 *
 * It carries an AGE ANALYSIS, which the screen does not. A statement exists to
 * be acted on: "you owe $40,000" invites a shrug, while "$12,000 of it is over
 * 60 days" is a conversation. The buckets are worked out from each open
 * invoice's own due date, so terms agreed per customer are respected rather
 * than a flat 30 days being assumed for everybody.
 */
export async function renderStatementPdf(
  db: Db,
  customerId: string,
  opts: { from?: string | null; to?: string | null; filter?: StatementFilter } = {},
): Promise<StatementDocument> {
  const statement = await getStatement(db, customerId, opts);

  const customer = await db.one<{
    name: string; email: string | null; phone: string | null;
    delivery_address: string | null; payment_terms: string | null;
  }>(
    `SELECT name, email, phone, delivery_address, payment_terms
     FROM customers WHERE id = $1`,
    [customerId],
  );

  /*
   * Age analysis, from the invoice ledger rather than the statement stream:
   * what is still OPEN today, bucketed by how long it has been due. An
   * invoice with no due date counts as current - it is not overdue until a
   * date says it is.
   */
  const aging = await db.one<{
    current: string; d30: string; d60: string; d90: string; total: string;
  }>(
    `SELECT
       COALESCE(SUM(balance_cents) FILTER (
         WHERE due_date IS NULL OR business_today() - due_date <= 0), 0)::text AS current,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date BETWEEN 1 AND 30), 0)::text AS d30,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date BETWEEN 31 AND 60), 0)::text AS d60,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date > 60), 0)::text AS d90,
       COALESCE(SUM(balance_cents), 0)::text AS total
     FROM invoice_ledger
     WHERE customer_id = $1 AND balance_cents > 0`,
    [customerId],
  );

  // Bottles they are holding, over the same window as the ledger.
  const bottles = await bottleAccount(db, customerId, { from: opts.from, to: opts.to });

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const left = 50;
  const right = 560;

  letterhead(doc, left);
  doc.moveDown(1.2);

  doc.fillColor('#000').fontSize(16).text('STATEMENT OF ACCOUNT', { align: 'right' });
  doc.fontSize(10).fillColor('#333')
    .text(
      statement.from || statement.to
        ? `${statement.from ?? 'the beginning'} to ${statement.to ?? 'today'}`
        : 'All activity to date',
      { align: 'right' },
    );
  doc.moveDown(1);

  /* who it is for */
  doc.fontSize(9).fillColor('#555').text('ACCOUNT', left, doc.y);
  doc.fontSize(11).fillColor('#000').text(customer.name);
  doc.fontSize(9).fillColor('#333');
  if (customer.delivery_address) doc.text(customer.delivery_address);
  if (customer.phone) doc.text(customer.phone);
  if (customer.email) doc.text(customer.email);
  if (customer.payment_terms) doc.text(`Terms: ${customer.payment_terms}`);
  doc.moveDown(1.2);

  /* the ledger */
  const cols = { date: left, type: 118, desc: 196, ref: 350, amount: 420, balance: 490 };
  const headerRow = () => {
    const y = doc.y;
    doc.fontSize(8).fillColor('#555')
      .text('DATE', cols.date, y)
      .text('TYPE', cols.type, y)
      .text('DESCRIPTION', cols.desc, y)
      .text('REFERENCE', cols.ref, y)
      .text('AMOUNT', cols.amount, y, { width: 62, align: 'right' })
      .text('BALANCE', cols.balance, y, { width: 70, align: 'right' });
    doc.moveTo(left, doc.y + 3).lineTo(right, doc.y + 3).strokeColor('#ccc').stroke();
    doc.moveDown(0.7);
  };
  headerRow();

  /**
   * One line of the ledger.
   *
   * The row advances by its TALLEST cell, not by whatever the last one
   * happened to be. Six cells are drawn at the same y; pdfkit leaves the
   * cursor wherever the final call finished, so a description that wrapped to
   * two lines was written over by the row beneath it - which put figures
   * against the wrong line and made an invoice number look like it did not
   * match its payment.
   */
  const row = (
    date: string, type: string, desc: string, ref: string,
    amount: string, balance: string, muted = false,
  ) => {
    const cells: Array<{ text: string; x: number; w: number; right?: boolean }> = [
      { text: date, x: cols.date, w: 64 },
      { text: type, x: cols.type, w: 74 },
      { text: desc, x: cols.desc, w: 150 },
      { text: ref, x: cols.ref, w: 66 },
      { text: amount, x: cols.amount, w: 62, right: true },
      { text: balance, x: cols.balance, w: 70, right: true },
    ];

    doc.fontSize(8.5).fillColor(muted ? '#666' : '#000');
    const height = Math.max(
      ...cells.map((c) => doc.heightOfString(c.text || ' ', { width: c.w })),
    );

    // Break before drawing, not after, so a row is never split across pages.
    if (doc.y + height > 690) {
      doc.addPage();
      doc.y = 50;
      headerRow();
      doc.fontSize(8.5).fillColor(muted ? '#666' : '#000');
    }

    const y = doc.y;
    for (const c of cells) {
      doc.text(c.text, c.x, y, { width: c.w, align: c.right ? 'right' : 'left' });
    }
    doc.y = y + height + 3;
  };

  row('', '', 'Opening balance', '', '', cash(statement.openingBalanceCents), true);
  for (const e of statement.entries) {
    row(
      String(e.date).slice(0, 10), e.type, e.description, e.reference,
      cash(e.amountCents), cash(e.runningBalanceCents),
    );
  }
  if (statement.entries.length === 0) {
    doc.fontSize(9).fillColor('#666')
      .text('No activity in this period.', left, doc.y).moveDown(0.5);
  }

  doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor('#ccc').stroke();
  doc.moveDown(0.8);

  /*
   * What they owe - or what they are up.
   *
   * A customer who paid more than the invoice is IN CREDIT, and "Balance due
   * -$275.00" is a sentence nobody should have to decode. The figure is shown
   * unsigned under the label that describes it.
   */
  const closing = statement.closingBalanceCents;
  const inCredit = closing < 0;

  /*
   * The figure sits in the SAME column as the running balance above it, and
   * the label is right-aligned into the space to its left. Two separate
   * placements, not one `continued` run: a continued string inherits the
   * right-alignment of the piece before it, so the amount was laid out
   * against the wrong box and pushed past the right margin.
   */
  const totalY = doc.y;
  doc.fontSize(12).fillColor('#000')
    .text(inCredit ? 'In credit' : 'Balance due',
      cols.desc, totalY, { width: cols.balance - cols.desc - 10, align: 'right' })
    .text(cash(Math.abs(closing)),
      cols.balance, totalY, { width: 70, align: 'right' });
  doc.y = totalY + 18;

  if (inCredit) {
    doc.fontSize(8.5).fillColor('#555')
      .text('Paid ahead. This comes off the next invoice.',
        cols.desc, doc.y, { width: right - cols.desc, align: 'right' });
  }
  doc.moveDown(1.2);

  /*
   * The bottle account.
   *
   * A returnable 5-gallon bottle is a real asset out on loan. The ledger above
   * says what the customer owes; this says how many bottles of yours they are
   * holding. They belong on one piece of paper because the conversation about
   * one is usually the conversation about the other.
   *
   * Printed only when this customer has ever had a returnable - a 500ml case
   * buyer should not read a row of zeroes and wonder what it means.
   */
  const everHadBottles = bottles.delivered > 0 || bottles.openingHolding !== 0
    || bottles.closingHolding !== 0;
  if (everHadBottles) {
    doc.fontSize(9).fillColor('#555').text('5-GALLON BOTTLES', left, doc.y);
    doc.moveDown(0.4);
    const top = doc.y;
    const cell = (label: string, value: string, i: number, strong = false) => {
      const x = left + i * 128;
      doc.y = top;
      doc.fontSize(8).fillColor('#555').text(label, x, doc.y, { width: 120 });
      doc.fontSize(11).fillColor(strong ? '#000' : '#333')
        .text(value, x, doc.y, { width: 120 });
    };
    cell('Held at start', String(bottles.openingHolding), 0);
    cell('Delivered', `+${bottles.delivered}`, 1);
    cell('Collected', `-${bottles.returned}`, 2);
    cell('Held now', String(bottles.closingHolding), 3, true);
    doc.y = top + 34;

    if (bottles.lost > 0) {
      doc.fontSize(8).fillColor('#777')
        .text(`${bottles.lost} recorded lost or damaged and written off.`, left, doc.y);
      doc.moveDown(0.8);
    }
    doc.moveDown(0.6);
  }

  const owed = Number(aging.total);
  if (owed > 0) {
    doc.fontSize(9).fillColor('#555').text('AGE OF WHAT IS OWED', left, doc.y);
    doc.moveDown(0.5);
    const bucket = (label: string, value: number, x: number) => {
      doc.fontSize(8).fillColor('#555').text(label, x, doc.y, { width: 118 });
      doc.fontSize(11).fillColor(label === 'Over 60 days' && value > 0 ? '#b42318' : '#000')
        .text(cash(value), x, doc.y, { width: 118 });
    };
    const top = doc.y;
    [
      ['Not yet due', Number(aging.current)],
      ['1–30 days', Number(aging.d30)],
      ['31–60 days', Number(aging.d60)],
      ['Over 60 days', Number(aging.d90)],
    ].forEach(([label, value], i) => {
      doc.y = top;
      bucket(label as string, value as number, left + i * 128);
    });
    doc.y = top + 34;
  }

  doc.moveDown(1.5).fontSize(8).fillColor('#777')
    .text(
      `${BRAND.company}  ·  All amounts in Jamaican dollars, GCT inclusive.  ·  `
      + 'Please quote the invoice number with any payment.',
      left, doc.y, { align: 'center', width: right - left },
    );

  doc.end();
  const pdf = await finished;

  const period = statement.to ? `-${String(statement.to).slice(0, 10)}` : '';
  return {
    filename: `Statement-${customer.name.replace(/[^A-Za-z0-9]+/g, '-')}${period}.pdf`,
    pdf,
    customerName: customer.name,
    customerEmail: customer.email,
  };
}

/**
 * Is sending set up on this machine?
 *
 * Kept separate so a screen can hide or explain the Send button rather than
 * offering something that will fail.
 */
export function mailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * Email an invoice to the customer on file.
 *
 * Marks the invoice Sent only once the mail server has accepted it, so an
 * invoice is never recorded as sent when it was not.
 */
/**
 * Send a customer their statement.
 *
 * Mirrors emailInvoice deliberately, including refusing plainly when no mail
 * account is set up rather than failing somewhere in the middle. Unlike an
 * invoice, sending a statement changes nothing about the records - it is a
 * copy of what is already true - so there is no lifecycle to update, only an
 * audit line saying it went.
 */
export async function emailStatement(
  db: Db,
  actor: Actor,
  customerId: string,
  opts: { from?: string | null; to?: string | null;
          filter?: StatementFilter; sendTo?: string | null } = {},
): Promise<{ sentTo: string; customerName: string }> {
  requireRole(actor, 'admin', 'user');

  if (!mailConfigured()) {
    throw new RuleViolation(
      'email is not set up on this machine yet. Add the Alka Vida mail account '
      + 'details to the settings file, restart, and the Send button will work. '
      + 'Until then, download the PDF and attach it yourself.',
    );
  }

  const doc = await renderStatementPdf(db, customerId,
    { from: opts.from, to: opts.to, filter: opts.filter });
  const to = (opts.sendTo ?? doc.customerEmail ?? '').trim();
  if (!to) {
    throw new RuleViolation(
      `${doc.customerName} has no email address on file. Add one to the customer `
      + 'record, or type an address to send this to.',
    );
  }

  const transport = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
  });

  await transport.sendMail({
    from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
    to,
    subject: `${BRAND.name} statement of account`,
    text:
      `Good day,\n\nPlease find attached your statement of account from `
      + `${BRAND.name}.\n\nThank you for your business.\n\n${BRAND.company}\n`,
    attachments: [{ filename: doc.filename, content: doc.pdf }],
  });

  await db.tx(async (t) => {
    await audit(t, actor, 'update', 'Customer', customerId, doc.customerName, {
      statementEmailedTo: to,
    });
  });

  return { sentTo: to, customerName: doc.customerName };
}

export async function emailInvoice(
  db: Db,
  actor: Actor,
  invoiceId: string,
  overrideTo?: string | null,
): Promise<{ sentTo: string; invoiceNumber: string }> {
  requireRole(actor, 'admin', 'user');

  if (!mailConfigured()) {
    throw new RuleViolation(
      'email is not set up on this machine yet. Add the Alka Vida mail account ' +
      'details to the settings file, restart, and the Send button will work. ' +
      'Until then, download the PDF and attach it yourself.',
    );
  }

  const doc = await renderInvoicePdf(db, invoiceId);
  const to = (overrideTo ?? doc.customerEmail ?? '').trim();
  if (!to) {
    throw new RuleViolation(
      `${doc.customerName} has no email address on file. Add one to the customer ` +
      `record, or type an address to send this to.`,
    );
  }

  const transport = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    // 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
  });

  await transport.sendMail({
    from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
    to,
    subject: `${BRAND.name} invoice ${doc.invoiceNumber}`,
    text:
      `Good day,\n\nPlease find attached invoice ${doc.invoiceNumber} from ` +
      `${BRAND.name}.\n\nThank you for your business.\n\n${BRAND.company}\n`,
    attachments: [{ filename: doc.filename, content: doc.pdf }],
  });

  // Only now is it true to say it was sent.
  await db.tx(async (t) => {
    await t.query(
      `UPDATE invoices SET lifecycle = 'Sent', sent_date = business_today()
       WHERE id = $1 AND lifecycle <> 'Cancelled'`,
      [invoiceId],
    );
    await audit(t, actor, 'update', 'Invoice', invoiceId, doc.invoiceNumber, {
      emailedTo: to,
    });
  });

  return { sentTo: to, invoiceNumber: doc.invoiceNumber };
}
