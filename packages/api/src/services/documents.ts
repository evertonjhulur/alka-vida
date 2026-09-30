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
import { audit, businessToday, requireRole, num } from './core.ts';
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

/** A new letter-size document collecting into a Buffer. */
function newDoc(): { doc: PDFKit.PDFDocument; finished: Promise<Buffer> } {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  return { doc, finished };
}

const fmtDate = (d: unknown) => {
  // A DATE column arrives as a Date at UTC midnight; its ISO form is the day.
  // String(date) would print it in local time, a day early (see migration 004).
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, day] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[m - 1]} ${y}`;
};

/** Where to send paper for this customer: billing address if one is marked. */
async function billTo(db: Db, customerId: string) {
  const customer = await db.one<{
    name: string; email: string | null; phone: string | null; contact_person: string | null;
    delivery_address: string | null; payment_terms: string | null;
    gct_exempt: boolean; gct_exempt_ref: string | null; invoice_cycle: string;
  }>(
    `SELECT name, email, phone, contact_person, delivery_address, payment_terms,
            gct_exempt, gct_exempt_ref, invoice_cycle
     FROM customers WHERE id = $1`, [customerId],
  );
  const billing = await db.maybeOne<{
    label: string; address_line1: string | null; address_line2: string | null;
    city: string | null; parish: string | null; contact_person: string | null;
  }>(
    `SELECT label, address_line1, address_line2, city, parish, contact_person
     FROM customer_addresses WHERE customer_id = $1 AND active AND is_billing LIMIT 1`,
    [customerId],
  );
  const address = billing
    ? [billing.address_line1, billing.address_line2, billing.city, billing.parish]
      .map((x) => (x ?? '').trim()).filter(Boolean).join(', ')
    : customer.delivery_address;
  return { ...customer, address, attention: billing?.contact_person ?? customer.contact_person };
}

/**
 * Draw one invoice or credit note onto `doc`, starting on the current page.
 * Shared by the single PDF and by several invoices sent together in one
 * attachment, so they can never look different.
 */
async function drawInvoice(doc: PDFKit.PDFDocument, db: Db, invoiceId: string) {
  const detail = await getInvoiceDetail(db, invoiceId);
  if (!detail) throw new RuleViolation('that invoice no longer exists');
  const ledger = detail as unknown as {
    customerId: string; invoiceNumber: string; invoiceDate: string;
    dueDate: string | null; isCreditNote: boolean; grandTotalCents: number;
    amountPaidCents: number; balanceCents: number;
    subtotal_cents: number; discount_amount_cents: number; gct_cents: number;
    discount_percent: number; discount_fixed_cents: number; gct_exempt: boolean;
    cycle: string | null; period_from: string | null; period_to: string | null;
    notes: string | null; credit_status: string;
  };
  const customer = await billTo(db, ledger.customerId);
  const orders = await db.query<{ order_number: string }>(
    `SELECT o.order_number FROM invoice_orders io JOIN customer_orders o ON o.id = io.order_id
     WHERE io.invoice_id = $1 ORDER BY o.order_number`, [invoiceId],
  );
  const linked = await db.maybeOne<{ invoice_number: string }>(
    `SELECT li.invoice_number FROM invoices i JOIN invoices li ON li.id = i.linked_invoice_id
     WHERE i.id = $1`, [invoiceId],
  );
  const lines = (detail as unknown as { lines?: Array<Record<string, unknown>> }).lines ?? [];
  const isCN = ledger.isCreditNote;

  letterhead(doc, 50);
  doc.moveDown(1.2);

  doc.fillColor('#000').fontSize(16)
    .text(isCN ? 'CREDIT NOTE' : 'INVOICE', 50, doc.y, { align: 'right', width: 510 });
  doc.fontSize(10)
    .text(ledger.invoiceNumber, { align: 'right', width: 510 })
    .text(`Date: ${fmtDate(ledger.invoiceDate)}`, { align: 'right', width: 510 });
  if (!isCN) {
    // A weekly or monthly invoice is due on receipt (Everton, 30 Sep 2026).
    if (ledger.cycle || (ledger.dueDate && fmtDate(ledger.dueDate) === fmtDate(ledger.invoiceDate))) {
      doc.text('Due: on receipt', { align: 'right', width: 510 });
    } else if (ledger.dueDate) {
      doc.text(`Due: ${fmtDate(ledger.dueDate)}`, { align: 'right', width: 510 });
    }
  }
  if (ledger.period_from && ledger.period_to) {
    doc.text(`Deliveries ${fmtDate(ledger.period_from)} to ${fmtDate(ledger.period_to)}`,
      { align: 'right', width: 510 });
  }
  doc.moveDown(1);

  doc.fontSize(9).fillColor('#555').text(isCN ? 'CREDIT TO' : 'BILL TO', 50);
  doc.fontSize(11).fillColor('#000').text(customer.name);
  doc.fontSize(9).fillColor('#333');
  if (customer.attention) doc.text(`Attn: ${customer.attention}`);
  if (customer.address) doc.text(customer.address);
  if (customer.phone) doc.text(customer.phone);
  if (customer.email) doc.text(customer.email);
  if (!isCN && customer.payment_terms && !ledger.cycle) doc.text(`Terms: ${customer.payment_terms}`);
  if (ledger.gct_exempt && customer.gct_exempt_ref) doc.text(`GCT exemption: ${customer.gct_exempt_ref}`);
  if (isCN && linked) doc.text(`Against invoice ${linked.invoice_number}`);
  if (!ledger.cycle && orders.length > 0) {
    doc.text(`Order${orders.length > 1 ? 's' : ''}: ${orders.map((o) => o.order_number).join(', ')}`);
  }
  doc.moveDown(1.2);

  const left = 50;
  const cycleLayout = lines.some((l) => l.delivered_on);
  const cols = cycleLayout
    ? { date: left, ref: 118, desc: 180, qty: 340, unit: 400, total: 480 }
    : { date: 0, ref: 0, desc: left, qty: 330, unit: 400, total: 480 };
  const header = () => {
    const y = doc.y;
    doc.fillColor('#555').fontSize(8);
    if (cycleLayout) {
      doc.text('DELIVERED', cols.date, y).text('ORDER', cols.ref, y);
    }
    doc.text('DESCRIPTION', cols.desc, y)
      .text('QTY', cols.qty, y)
      .text('UNIT PRICE', cols.unit, y, { width: 70, align: 'right' })
      .text('AMOUNT', cols.total, y, { width: 80, align: 'right' });
    doc.moveTo(left, doc.y + 2).lineTo(560, doc.y + 2).strokeColor('#ccc').stroke();
    doc.moveDown(0.6);
  };
  header();

  if (lines.length === 0 && isCN) {
    const y = doc.y;
    doc.fontSize(9).fillColor('#000')
      .text(ledger.notes || 'Credit', cols.desc, y, { width: 270 });
    doc.moveDown(0.4);
  }
  for (const l of lines) {
    const cases = num(l.cases as number);
    const loose = num(l.loose_bottles as number);
    const qty = cases > 0 ? `${cases} cs` : `${loose}`;
    const unit = cases > 0
      ? num(l.price_per_case_cents as number)
      : num(l.price_per_bottle_cents as number);
    if (doc.y > 680) { doc.addPage(); doc.y = 50; header(); }
    const y = doc.y;
    doc.fontSize(9).fillColor('#000');
    if (cycleLayout) {
      doc.text(l.delivered_on ? fmtDate(l.delivered_on) : '', cols.date, y, { width: 64 })
        .text(String(l.reference ?? ''), cols.ref, y, { width: 60 });
    }
    doc.text(String(l.product_name ?? ''), cols.desc, y, { width: cols.qty - cols.desc - 8 })
      .text(qty, cols.qty, y)
      .text(cash(unit), cols.unit, y, { width: 70, align: 'right' })
      .text(cash(num(l.line_total_cents as number)), cols.total, y, { width: 80, align: 'right' });
    doc.y = Math.max(doc.y, y + 12);
    doc.moveDown(0.3);
  }

  doc.moveDown(0.8);
  const sign = isCN ? -1 : 1;
  const row = (label: string, value: number, bold = false) => {
    if (doc.y > 700) { doc.addPage(); doc.y = 50; }
    const y = doc.y;
    doc.fillColor('#000').fontSize(bold ? 11 : 9)
      .text(label, cols.unit - 150, y, { width: 220, align: 'right' })
      .text(cash(value), cols.total, y, { width: 80, align: 'right' });
    doc.moveDown(0.35);
  };
  row('Subtotal', sign * num(ledger.subtotal_cents));
  if (num(ledger.discount_amount_cents) > 0) {
    const how = num(ledger.discount_fixed_cents) > 0 ? 'Discount'
      : `Discount ${num(ledger.discount_percent)}%`;
    row(how, -num(ledger.discount_amount_cents));
  }
  row(ledger.gct_exempt ? 'GCT (exempt)' : 'GCT 15%', sign * num(ledger.gct_cents));
  if (isCN) {
    row('Credit total', -ledger.grandTotalCents, true);
    if (ledger.credit_status === 'Pending') {
      doc.fontSize(8).fillColor('#8a5c00').text('Awaiting approval - not yet applied to the account.',
        cols.desc, doc.y, { width: 510 - cols.desc + 50, align: 'right' });
    }
  } else {
    row('Total', ledger.grandTotalCents, true);
    row('Paid', ledger.amountPaidCents);
    row('Balance due', ledger.balanceCents, true);
  }

  doc.moveDown(2).fontSize(8).fillColor('#777')
    .text(`${BRAND.company}  ·  All amounts in Jamaican dollars${ledger.gct_exempt ? '' : ', GCT inclusive'}.`,
      left, doc.y, { align: 'center', width: 510 });

  return { invoiceNumber: ledger.invoiceNumber, customerName: customer.name, customerEmail: customer.email };
}

/** Build the invoice (or credit note) PDF. Pure rendering - it changes nothing. */
export async function renderInvoicePdf(db: Db, invoiceId: string): Promise<InvoiceDocument> {
  const { doc, finished } = newDoc();
  const info = await drawInvoice(doc, db, invoiceId);
  doc.end();
  return { filename: `${info.invoiceNumber}.pdf`, pdf: await finished, ...info };
}

/**
 * Several invoices in ONE PDF, one after another, each on its own page
 * (Everton, 30 Sep 2026, point 16: select open invoices, send one email with
 * one attachment). A short cover page lists them and the total.
 */
export async function renderInvoicesPdf(
  db: Db, invoiceIds: readonly string[],
): Promise<{ filename: string; pdf: Buffer; customerId: string; customerName: string;
             customerEmail: string | null; numbers: string[]; totalDueCents: number }> {
  const ids = [...new Set(invoiceIds)];
  if (ids.length === 0) throw new RuleViolation('choose at least one invoice');
  const rows = await db.query<{
    invoice_id: string; invoice_number: string; customer_id: string; invoice_date: string;
    due_date: string | null; grand_total_cents: number; balance_cents: number; is_credit_note: boolean;
  }>(
    `SELECT invoice_id, invoice_number, customer_id, invoice_date::text AS invoice_date,
            due_date::text AS due_date, grand_total_cents, balance_cents, is_credit_note
     FROM invoice_ledger WHERE invoice_id = ANY($1::uuid[])
     ORDER BY invoice_date, invoice_number`, [ids],
  );
  if (rows.length !== ids.length) throw new RuleViolation('one of those invoices no longer exists');
  const customerIds = new Set(rows.map((r) => r.customer_id));
  if (customerIds.size > 1) throw new RuleViolation('invoices sent together must all be for one customer');
  const customer = await billTo(db, rows[0].customer_id);

  const { doc, finished } = newDoc();
  letterhead(doc, 50);
  doc.moveDown(1.2);
  doc.fillColor('#000').fontSize(16).text('INVOICES ENCLOSED', 50, doc.y, { align: 'right', width: 510 });
  doc.fontSize(10).text(fmtDate(businessToday()), { align: 'right', width: 510 });
  doc.moveDown(1);
  doc.fontSize(11).text(customer.name, 50);
  doc.fontSize(9).fillColor('#333');
  if (customer.address) doc.text(customer.address);
  doc.moveDown(1.2);
  const y0 = doc.y;
  doc.fontSize(8).fillColor('#555')
    .text('INVOICE', 50, y0).text('DATE', 160, y0).text('DUE', 260, y0)
    .text('TOTAL', 360, y0, { width: 90, align: 'right' })
    .text('STILL OWED', 460, y0, { width: 100, align: 'right' });
  doc.moveTo(50, doc.y + 2).lineTo(560, doc.y + 2).strokeColor('#ccc').stroke();
  doc.moveDown(0.6);
  let due = 0;
  for (const r of rows) {
    const y = doc.y;
    doc.fontSize(9).fillColor('#000')
      .text(r.invoice_number, 50, y).text(fmtDate(r.invoice_date), 160, y)
      .text(r.due_date ? fmtDate(r.due_date) : '-', 260, y)
      .text(cash(num(r.grand_total_cents)), 360, y, { width: 90, align: 'right' })
      .text(cash(num(r.balance_cents)), 460, y, { width: 100, align: 'right' });
    doc.moveDown(0.4);
    due += num(r.balance_cents);
  }
  doc.moveDown(0.6);
  const yt = doc.y;
  doc.fontSize(11).text('Total still owed', 300, yt, { width: 150, align: 'right' })
    .text(cash(due), 460, yt, { width: 100, align: 'right' });

  for (const r of rows) {
    doc.addPage();
    await drawInvoice(doc, db, r.invoice_id);
  }
  doc.end();
  const numbers = rows.map((r) => r.invoice_number);
  return {
    filename: `Invoices-${customer.name.replace(/[^A-Za-z0-9]+/g, '-')}-${numbers.length}.pdf`,
    pdf: await finished,
    customerId: rows[0].customer_id,
    customerName: customer.name,
    customerEmail: customer.email,
    numbers,
    totalDueCents: due,
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

  // The billing address when one is marked, the main address otherwise.
  const bt = await billTo(db, customerId);
  const customer = { ...bt, delivery_address: bt.address };

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

/* ================================================================== */
/* Sending                                                             */
/* ================================================================== */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
}

/**
 * Tests (and only tests) can catch outgoing mail instead of needing a real
 * mail account. Never set by the app itself.
 */
let mailSink: ((m: MailMessage) => void | Promise<void>) | null = null;
export function setMailSinkForTests(fn: typeof mailSink): void { mailSink = fn; }

/**
 * Is sending set up on this machine?
 *
 * Kept separate so a screen can hide or explain the Send button rather than
 * offering something that will fail.
 */
export function mailConfigured(): boolean {
  if (mailSink) return true;
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

const NOT_SET_UP =
  'email is not set up on this machine yet. Add the Alka Vida mail account '
  + 'details to the settings file, restart, and the Send button will work. '
  + 'Until then, download the PDF and attach it yourself.';

/** The one place mail leaves the building. */
export async function sendMail(m: MailMessage): Promise<void> {
  if (!mailConfigured()) throw new RuleViolation(NOT_SET_UP);
  if (mailSink) { await mailSink(m); return; }
  const port = Number(process.env.SMTP_PORT ?? 587);
  const transport = createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: port === 465,
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
  });
  await transport.sendMail({
    from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
    to: m.to, subject: m.subject, text: m.text, attachments: m.attachments,
  });
}

/** The address to use, or a plain refusal naming who has none. */
function recipient(override: string | null | undefined, onFile: string | null, who: string): string {
  const to = (override ?? onFile ?? '').trim();
  if (!to) {
    throw new RuleViolation(
      `${who} has no email address on file. Add one to their record, or type an address to send this to.`,
    );
  }
  return to;
}

const signOff = `\n\nThank you for your business.\n\n${BRAND.company}\n`;

/**
 * Send a customer their statement.
 *
 * Unlike an invoice, sending a statement changes nothing about the records -
 * it is a copy of what is already true - so there is no lifecycle to update,
 * only an audit line saying it went.
 */
export async function emailStatement(
  db: Db,
  actor: Actor,
  customerId: string,
  opts: { from?: string | null; to?: string | null;
          filter?: StatementFilter; sendTo?: string | null; note?: string | null;
          subject?: string | null } = {},
): Promise<{ sentTo: string; customerName: string }> {
  requireRole(actor, 'admin', 'user');
  if (!mailConfigured()) throw new RuleViolation(NOT_SET_UP);

  const doc = await renderStatementPdf(db, customerId,
    { from: opts.from, to: opts.to, filter: opts.filter });
  const to = recipient(opts.sendTo, doc.customerEmail, doc.customerName);

  await sendMail({
    to,
    subject: opts.subject ?? `${BRAND.name} statement of account`,
    text: `Good day,\n\nPlease find attached your statement of account from ${BRAND.name}.`
      + (opts.note ? `\n\n${opts.note}` : '') + signOff,
    attachments: [{ filename: doc.filename, content: doc.pdf }],
  });

  await db.tx(async (t) => {
    await audit(t, actor, 'update', 'Customer', customerId, doc.customerName, {
      statementEmailedTo: to,
    });
  });
  return { sentTo: to, customerName: doc.customerName };
}

/**
 * Email one invoice or credit note to the customer on file.
 *
 * Marks it Sent only once the mail server has accepted it, so an invoice is
 * never recorded as sent when it was not.
 */
export async function emailInvoice(
  db: Db,
  actor: Actor,
  invoiceId: string,
  overrideTo?: string | null,
): Promise<{ sentTo: string; invoiceNumber: string }> {
  requireRole(actor, 'admin', 'user');
  if (!mailConfigured()) throw new RuleViolation(NOT_SET_UP);

  const doc = await renderInvoicePdf(db, invoiceId);
  const to = recipient(overrideTo, doc.customerEmail, doc.customerName);
  const isCN = doc.invoiceNumber.startsWith('CN');

  await sendMail({
    to,
    subject: `${BRAND.name} ${isCN ? 'credit note' : 'invoice'} ${doc.invoiceNumber}`,
    text: `Good day,\n\nPlease find attached ${isCN ? 'credit note' : 'invoice'} `
      + `${doc.invoiceNumber} from ${BRAND.name}.` + signOff,
    attachments: [{ filename: doc.filename, content: doc.pdf }],
  });

  await db.tx(async (t) => {
    await t.query(
      `UPDATE invoices SET lifecycle = CASE WHEN lifecycle = 'Open' THEN 'Sent' ELSE lifecycle END,
         sent_date = business_today()
       WHERE id = $1 AND lifecycle <> 'Cancelled'`,
      [invoiceId],
    );
    await audit(t, actor, 'update', 'Invoice', invoiceId, doc.invoiceNumber, { emailedTo: to });
  });
  return { sentTo: to, invoiceNumber: doc.invoiceNumber };
}

/**
 * Several of one customer's invoices in ONE email with ONE attachment
 * (Everton, 30 Sep 2026, point 16). Each is marked Sent.
 */
export async function emailInvoices(
  db: Db,
  actor: Actor,
  invoiceIds: readonly string[],
  opts: { to?: string | null; note?: string | null } = {},
): Promise<{ sentTo: string; invoiceNumbers: string[]; totalDueCents: number }> {
  requireRole(actor, 'admin', 'user');
  if (!mailConfigured()) throw new RuleViolation(NOT_SET_UP);
  const doc = await renderInvoicesPdf(db, invoiceIds);
  const to = recipient(opts.to, doc.customerEmail, doc.customerName);
  const list = doc.numbers.join(', ');

  await sendMail({
    to,
    subject: `${BRAND.name} invoices ${doc.numbers.length > 3
      ? `(${doc.numbers.length})` : list}`,
    text: `Good day,\n\nPlease find attached ${doc.numbers.length === 1 ? 'invoice' : 'invoices'} `
      + `${list} from ${BRAND.name}, in one PDF.\n\nTotal still owed on these: ${cash(doc.totalDueCents)}.`
      + (opts.note ? `\n\n${opts.note}` : '') + signOff,
    attachments: [{ filename: doc.filename, content: doc.pdf }],
  });

  await db.tx(async (t) => {
    for (const id of invoiceIds) {
      await t.query(
        `UPDATE invoices SET lifecycle = CASE WHEN lifecycle = 'Open' THEN 'Sent' ELSE lifecycle END,
           sent_date = business_today()
         WHERE id = $1 AND lifecycle <> 'Cancelled'`, [id],
      );
    }
    await audit(t, actor, 'update', 'Customer', doc.customerId, doc.customerName, {
      invoicesEmailedTogether: doc.numbers, emailedTo: to,
    });
  });
  return { sentTo: to, invoiceNumbers: doc.numbers, totalDueCents: doc.totalDueCents };
}

export { cash as formatCash, newDoc, fmtDate, billTo, letterhead, BRAND, recipient, signOff };
