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
import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, num } from './core.ts';
import { RuleViolation } from '@alka/shared';
import { getInvoiceDetail } from './invoices.ts';

const BRAND = {
  name: 'Alka Vida',
  company: '1506 Investments Limited',
  line1: 'Kingston, Jamaica',
};

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

  /* letterhead */
  doc.fontSize(20).text(BRAND.name, { continued: false });
  doc.fontSize(9).fillColor('#555')
    .text(BRAND.company)
    .text(BRAND.line1)
    .moveDown(1.2);

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
