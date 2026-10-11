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
import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessToday, contactEmail, documentFooter, requireRole, num, siteUrl } from './core.ts';
import { RuleViolation, GCT_RATE } from '@alka/shared';
import { resolveLines } from './orders.ts';
import { getInvoiceDetail } from './invoices.ts';
import { getStatement, invoicesInStatus, type StatementFilter, type StatementStatus } from './ledger.ts';
import { customerEmail } from './emailkit.ts';
import { bottleAccount } from './bottles.ts';

/** The logo's colours (Everton chose them over the old teal, 28 Sep 2026). */
const COLOR_BLUE = '#0E76BC';
const COLOR_INDIGO = '#2D3590';

const BRAND = {
  name: 'Alka Vida',
  company: '1506 Investments Limited',
  line1: 'Kingston, Jamaica',
};

/** Repository root: src/services -> src -> api -> packages -> root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The company logo (tester's findings, 10 Oct 2026, point 16: into the app
 * itself, so the hosted site, emails and PDFs all show it).
 *
 * The owner's own file beside the launcher wins, so a new logo can still be
 * dropped in without changing the software; otherwise the copy built into the
 * app (packages/api/assets/alka-vida-logo.png). Should both be missing,
 * documents fall back to the wordmark set in type.
 */
const LOGO_CANDIDATES = ['Alka Vida logo.png', 'Alka Vida logo.jpg', 'logo.png'];
const BUILT_IN_LOGO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'alka-vida-logo.png');

export function logoPath(): string | null {
  for (const name of LOGO_CANDIDATES) {
    const p = join(REPO_ROOT, name);
    if (existsSync(p)) return p;
  }
  return existsSync(BUILT_IN_LOGO) ? BUILT_IN_LOGO : null;
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
  doc.fontSize(20).fillColor(COLOR_INDIGO).text(BRAND.name, left, 50);
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

/* ------------------------------------------------------------------ */
/* Invoice and statement layout (Everton, 11 Oct 2026, after the        */
/* QuickBooks invoice and statement he sent): title and company block   */
/* top left, logo top right, a light blue band for who it is for, then  */
/* the lines, then totals beside the bank details.                       */
/* ------------------------------------------------------------------ */

/** The business as QuickBooks prints it. */
const COMPANY = {
  name: 'Alka Vida',
  address: ['White Marl', 'Unit 7, St Catherine, Jamaica'],
  gctReg: 'GCT Registration No. 003-948-412',
  phone: '+1 876 528 6112',
  web: 'www.alkavidaja.com',
};
const PAGE_L = 40;
const PAGE_R = 572;
const INK = '#1F2937';
const SOFT = '#4B5563';
const MUTED = '#6B7280';
const RULE = '#DCE3EA';
const BAND = '#EAF3FB';
const GREEN = '#15803D';
const R = 'Helvetica';
const B = 'Helvetica-Bold';

/** 21/09/2026, the way QuickBooks and the customers' own books write it. */
const dmy = (d: unknown) => {
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, day] = iso.split('-');
  return `${day}/${m}/${y}`;
};

/**
 * Title, company and contact details top left, the logo top right. Returns
 * where the page carries on below it.
 */
async function docHeader(doc: PDFKit.PDFDocument, db: Queryable, title: string): Promise<number> {
  const top = 38;
  doc.font(B).fontSize(17).fillColor(COLOR_BLUE).text(title, PAGE_L, top, { characterSpacing: 0.6 });
  const y = doc.y + 5;
  doc.font(B).fontSize(9).fillColor(INK).text(COMPANY.name, PAGE_L, y);
  doc.font(R).fontSize(8.5).fillColor(SOFT);
  for (const line of COMPANY.address) doc.text(line, PAGE_L, doc.y + 1.5);
  doc.text(COMPANY.gctReg, PAGE_L, doc.y + 1.5);
  const leftBottom = doc.y;

  doc.font(R).fontSize(8.5).fillColor(SOFT);
  doc.text(await contactEmail(db), 215, y);
  doc.text(COMPANY.phone, 215, doc.y + 1.5);
  doc.text(COMPANY.web, 215, doc.y + 1.5);

  let logoBottom = top;
  const logo = logoPath();
  if (logo) {
    try {
      const img = doc.openImage(logo);
      const box: [number, number] = [150, 80];
      const scale = Math.min(box[0] / img.width, box[1] / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      doc.image(logo, PAGE_R - w, top - 4, { width: w, height: h });
      logoBottom = top - 4 + h;
    } catch { /* a bad image never stops a document going out */ }
  }
  return Math.max(leftBottom, logoBottom) + 22;
}

/** Light blue band across the page, behind the who-it-is-for block. */
function band(doc: PDFKit.PDFDocument, y: number, h: number): void {
  doc.save().rect(0, y, 612, h).fill(BAND).restore();
}

/** A small bold label over a block of lines. Returns the y below it. */
function labelled(doc: PDFKit.PDFDocument, label: string, lines: string[], x: number, y: number, width: number): number {
  doc.font(B).fontSize(8).fillColor(INK).text(label, x, y, { width });
  let at = doc.y + 3;
  lines.filter(Boolean).forEach((line, i) => {
    doc.font(R).fontSize(i === 0 ? 10 : 9).fillColor(i === 0 ? INK : SOFT).text(line, x, at, { width });
    at = doc.y + 1.5;
  });
  return at;
}

/**
 * The bank details and note to the customer (the setting under Settings ›
 * Invoices & payments), set in a column: "Electronic Transfers:" bold, "Note
 * to customer" a little larger with space above, the rest as typed.
 */
async function paymentColumn(doc: PDFKit.PDFDocument, db: Queryable, x: number, y: number, width: number): Promise<number> {
  const text = await documentFooter(db);
  if (!text) return y;
  doc.y = y;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^note to customer:?$/i.test(line)) {
      doc.font(R).fontSize(10.5).fillColor(INK).text('Note to customer', x, doc.y + 10, { width });
      doc.y += 2;
    } else if (/^electronic transfers:?$/i.test(line)) {
      doc.font(B).fontSize(8.5).fillColor(INK).text('Electronic Transfers', x, doc.y + 7, { width });
      doc.y += 1.5;
    } else if (line === '') {
      doc.y += 6;
    } else {
      doc.font(R).fontSize(8.5).fillColor(SOFT).text(line, x, doc.y + 1.5, { width });
    }
  }
  return doc.y;
}

/** The small line at the very bottom of every invoice and statement. */
async function smallPrint(doc: PDFKit.PDFDocument, db: Queryable, text: string): Promise<void> {
  // Pinned near the foot of the page; onto a new page only if the content
  // already reaches there.
  let y = Math.max(doc.y + 18, 748);
  if (y > 770) { doc.addPage(); y = 748; }
  // Written inside the page's bottom margin, so pdfkit must not treat it as
  // overflowing and start a blank page.
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font(R).fontSize(7.5).fillColor(MUTED)
    .text(`${text}  Questions: ${await contactEmail(db)} or ${COMPANY.phone}.`,
      PAGE_L, y, { width: PAGE_R - PAGE_L, align: 'center', lineBreak: false });
  doc.page.margins.bottom = bottom;
}

export interface InvoiceDocument {
  filename: string;
  pdf: Buffer;
  invoiceNumber: string;
  customerName: string;
  customerEmail: string | null;
}

/** A new letter-size document collecting into a Buffer. */
/**
 * The bank details and note to the customer (Everton, 10 Oct 2026, point 5),
 * printed on every invoice and statement - never on a quote or a credit
 * note. The text is a setting (Settings › Invoices & payments) and is printed
 * line for line as typed; "Electronic Transfers:" and "Note to customer" are
 * set in bold as headings.
 */
async function drawPaymentFooter(doc: PDFKit.PDFDocument, db: Queryable, left: number, width: number): Promise<void> {
  const text = await documentFooter(db);
  if (!text) return;
  const lines = text.split('\n');
  const height = lines.length * 11 + 16;
  if (doc.y + height > 760) { doc.addPage(); doc.y = 50; }
  doc.moveDown(1.2);
  const top = doc.y;
  doc.moveTo(left, top).lineTo(left + width, top).strokeColor(COLOR_BLUE).lineWidth(0.5).stroke();
  doc.y = top + 6;
  for (const line of lines) {
    const heading = /^(electronic transfers:?|note to customer:?)$/i.test(line.trim());
    doc.font(heading ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor('#222')
      .text(line, left, doc.y, { width });
  }
  doc.font('Helvetica');
}

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
  const orders = await db.query<{ order_number: string; customer_po: string | null }>(
    `SELECT o.order_number, o.customer_po FROM invoice_orders io JOIN customer_orders o ON o.id = io.order_id
     WHERE io.invoice_id = $1 ORDER BY o.order_number`, [invoiceId],
  );
  const pos = [...new Set(orders.map((o) => o.customer_po).filter(Boolean))] as string[];
  const linked = await db.maybeOne<{ invoice_number: string }>(
    `SELECT li.invoice_number FROM invoices i JOIN invoices li ON li.id = i.linked_invoice_id
     WHERE i.id = $1`, [invoiceId],
  );
  const lines = (detail as unknown as { lines?: Array<Record<string, unknown>> }).lines ?? [];
  const isCN = ledger.isCreditNote;

  const shipTo = await db.maybeOne<{ delivery_address: string | null }>(
    `SELECT delivery_address FROM customers WHERE id = $1`, [ledger.customerId]);

  /* 1. Title, company, logo */
  let y = await docHeader(doc, db, isCN ? 'CREDIT NOTE' : 'INVOICE');

  /* 2. The band: who it is for, then the invoice's own details */
  const billLines = [customer.name, customer.attention ? `Attn: ${customer.attention}` : '',
    customer.address ?? '', customer.phone ?? '', customer.email ?? ''].filter(Boolean);
  const shipLines = [customer.name, shipTo?.delivery_address ?? customer.address ?? ''].filter(Boolean);
  const details: Array<[string, string]> = [
    [isCN ? 'Credit note no.' : 'Invoice no.', ledger.invoiceNumber],
    [isCN ? 'Date' : 'Invoice date', dmy(ledger.invoiceDate)],
  ];
  if (!isCN) {
    const onReceipt = !!ledger.cycle || (!!ledger.dueDate && dmy(ledger.dueDate) === dmy(ledger.invoiceDate));
    details.push(['Due date', onReceipt ? 'On receipt' : ledger.dueDate ? dmy(ledger.dueDate) : '-']);
  }
  const details2: Array<[string, string]> = [];
  if (!isCN && customer.payment_terms && !ledger.cycle) details2.push(['Terms', customer.payment_terms]);
  if (!isCN && ledger.cycle) details2.push(['Terms', 'Due on receipt']);
  if (!ledger.cycle && orders.length > 0) details2.push(['Order no.', orders.map((o) => o.order_number).join(', ')]);
  if (pos.length > 0) details2.push(['Your PO', pos.join(', ')]);
  if (ledger.period_from && ledger.period_to) details2.push(['Deliveries', `${dmy(ledger.period_from)} to ${dmy(ledger.period_to)}`]);
  if (isCN && linked) details2.push(['Against invoice', linked.invoice_number]);
  if (ledger.gct_exempt && customer.gct_exempt_ref) details2.push(['GCT exemption', customer.gct_exempt_ref]);

  const topH = 22 + 14 + Math.max(billLines.length, shipLines.length) * 12.5;
  const detH = 22 + 14 + Math.max(details.length, details2.length) * 13.5;
  band(doc, y, topH + detH + 8);
  labelled(doc, isCN ? 'Credit to' : 'Bill to', billLines, PAGE_L, y + 18, 280);
  labelled(doc, 'Ship to', shipLines, 360, y + 18, 212);
  const dash = y + topH;
  doc.save().moveTo(PAGE_L, dash).lineTo(PAGE_R, dash).dash(2, { space: 2 }).strokeColor('#B9CCE0').lineWidth(0.6).stroke().undash().restore();
  doc.font(B).fontSize(9.5).fillColor(INK).text(isCN ? 'Credit note details' : 'Invoice details', PAGE_L, dash + 16);
  const detTop = doc.y + 4;
  const pairCol = (rows: Array<[string, string]>, x: number) => {
    let at = detTop;
    for (const [k, v] of rows) {
      doc.font(R).fontSize(9).fillColor(SOFT).text(`${k}: `, x, at, { continued: true }).fillColor(INK).text(v);
      at = doc.y + 2.5;
    }
  };
  pairCol(details, PAGE_L);
  pairCol(details2, 360);
  y += topH + detH + 8 + 22;

  /* 3. The lines */
  const col = {
    n: { x: PAGE_L, w: 16 }, date: { x: 58, w: 60 }, prod: { x: 122, w: 132 },
    desc: { x: 260, w: 112 }, qty: { x: 372, w: 34 }, rate: { x: 410, w: 58 },
    amt: { x: 470, w: 62 }, tax: { x: 536, w: 36 },
  };
  const head = () => {
    doc.font(R).fontSize(8.5).fillColor(INK);
    doc.text('#', col.n.x, y, { width: col.n.w });
    doc.text('Date', col.date.x, y, { width: col.date.w });
    doc.text('Product or service', col.prod.x, y, { width: col.prod.w });
    doc.text('Description', col.desc.x, y, { width: col.desc.w });
    doc.text('Qty', col.qty.x, y, { width: col.qty.w, align: 'right' });
    doc.text('Rate', col.rate.x, y, { width: col.rate.w, align: 'right' });
    doc.text('Amount', col.amt.x, y, { width: col.amt.w, align: 'right' });
    doc.text('Tax', col.tax.x, y, { width: col.tax.w, align: 'right' });
    y += 16;
    doc.moveTo(col.date.x, y).lineTo(PAGE_R, y).strokeColor(RULE).lineWidth(0.7).stroke();
    y += 9;
  };
  head();

  const describe = (l: Record<string, unknown>) => {
    const size = String(l.product_size ?? '').trim();
    const bpc = num(l.bottles_per_case as number);
    if (l.is_bottle_charge) return 'Bottle not returned (yours to keep)';
    if (/^5\s*gal/i.test(size)) return '19 litres (5 Gallon)';
    return [size, bpc > 0 ? `case of ${bpc}` : ''].filter(Boolean).join(', ');
  };
  const rows: Array<{ date: string; prod: string; desc: string; qty: string; rate: string; amt: string }> =
    lines.map((l) => {
      const cases = num(l.cases as number);
      const loose = num(l.loose_bottles as number);
      const unit = cases > 0 ? num(l.price_per_case_cents as number) : num(l.price_per_bottle_cents as number);
      return {
        date: dmy(l.delivered_on ?? ledger.invoiceDate),
        prod: String(l.product_name ?? ''),
        desc: describe(l) + (l.reference ? `\n${String(l.reference)}` : ''),
        qty: cases > 0 ? `${cases} cs` : String(loose),
        rate: cash(Math.abs(unit)), amt: cash(isCN ? Math.abs(num(l.line_total_cents as number)) : num(l.line_total_cents as number)),
      };
    });
  if (rows.length === 0 && isCN) {
    rows.push({ date: dmy(ledger.invoiceDate), prod: 'Credit', desc: ledger.notes ?? '', qty: '', rate: '', amt: cash(Math.abs(num(ledger.subtotal_cents))) });
  }
  rows.forEach((r, i) => {
    doc.font(B).fontSize(9);
    const h = Math.max(
      doc.heightOfString(r.prod || ' ', { width: col.prod.w }),
      doc.font(R).heightOfString(r.desc || ' ', { width: col.desc.w }),
    );
    if (y + h > 690) { doc.addPage(); y = 50; head(); }
    doc.font(R).fontSize(9).fillColor(INK);
    doc.text(`${i + 1}.`, col.n.x, y, { width: col.n.w });
    doc.text(r.date, col.date.x, y, { width: col.date.w });
    doc.font(B).text(r.prod, col.prod.x, y, { width: col.prod.w });
    doc.font(R).fillColor(SOFT).text(r.desc, col.desc.x, y, { width: col.desc.w });
    doc.fillColor(INK);
    doc.text(r.qty, col.qty.x, y, { width: col.qty.w, align: 'right' });
    doc.text(r.rate, col.rate.x, y, { width: col.rate.w, align: 'right' });
    doc.text(r.amt, col.amt.x, y, { width: col.amt.w, align: 'right' });
    doc.text(ledger.gct_exempt ? 'Exempt' : 'GCT', col.tax.x, y, { width: col.tax.w, align: 'right' });
    y += h + 10;
    doc.moveTo(PAGE_L, y - 4).lineTo(PAGE_R, y - 4).strokeColor(RULE).lineWidth(0.5).stroke();
  });

  /* 4. Totals on the right; bank details and the note on the left */
  y += 8;
  if (y > 560) { doc.addPage(); y = 50; }
  // A credit note shows its figures as plain amounts under its own title.
  const sign = 1;
  const abs = (n: number) => (isCN ? Math.abs(n) : n);
  const TX = 330;
  const TW = PAGE_R - TX;
  let ty = y;
  const trow = (label: string, value: string, big = false) => {
    if (big) {
      doc.font(B).fontSize(9).fillColor(INK).text(label, TX, ty + 3, { width: 140 });
      doc.font(B).fontSize(13).text(value, TX, ty, { width: TW, align: 'right' });
      ty += 24;
    } else {
      doc.font(R).fontSize(9).fillColor(SOFT).text(label, TX + 14, ty, { width: 170 });
      doc.fillColor(INK).text(value, TX, ty, { width: TW, align: 'right' });
      ty += 20;
    }
  };
  const rule = () => {
    doc.moveTo(TX, ty - 6).lineTo(PAGE_R, ty - 6).strokeColor(RULE).lineWidth(0.7).stroke();
    ty += 6;
  };
  const sub = num(ledger.subtotal_cents);
  trow('Subtotal', cash(abs(sign * sub)));
  if (num(ledger.discount_amount_cents) > 0) {
    const how = num(ledger.discount_fixed_cents) > 0 ? 'Discount' : `Discount ${num(ledger.discount_percent)}%`;
    trow(how, cash(-num(ledger.discount_amount_cents)));
  }
  const taxable = sub - num(ledger.discount_amount_cents);
  trow(ledger.gct_exempt ? 'GCT (exempt)' : `GCT @ 15% on ${cash(abs(taxable))}`, cash(abs(sign * num(ledger.gct_cents))));
  rule();
  if (isCN) {
    trow('Credit total', cash(Math.abs(ledger.grandTotalCents)), true);
    if (ledger.credit_status === 'Pending') {
      doc.font(R).fontSize(8).fillColor('#8A5C00').text('Awaiting approval: not yet applied to the account.', TX, ty, { width: TW, align: 'right' });
      ty = doc.y + 6;
    }
  } else {
    trow('Total', cash(ledger.grandTotalCents), true);
    rule();
    if (ledger.amountPaidCents > 0) { trow('Payment', cash(-ledger.amountPaidCents)); rule(); }
    trow('Balance due', cash(ledger.balanceCents), true);
    rule();
    if (ledger.balanceCents <= 0 && ledger.grandTotalCents > 0) {
      doc.font(B).fontSize(12).fillColor(GREEN).text('Paid in Full', TX, ty + 2, { width: TW, align: 'right' });
      ty = doc.y + 4;
    }
  }

  let ly = y + 12;
  if (!isCN) ly = await paymentColumn(doc, db, 58, ly, 250);
  doc.y = Math.max(ly, ty);

  await smallPrint(doc, db, `All amounts in Jamaican dollars${ledger.gct_exempt ? '' : ', GCT shown separately'}.`);

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
  let due = 0;
  for (const r of rows) due += num(r.balance_cents);
  let y = await docHeader(doc, db, 'INVOICES ENCLOSED');
  const toLines = [customer.name, customer.attention ? `Attn: ${customer.attention}` : '', customer.address ?? '', customer.email ?? ''].filter(Boolean);
  const bandH = 30 + Math.max(toLines.length * 12.5 + 12, 64);
  band(doc, y, bandH);
  labelled(doc, 'To', toLines, PAGE_L, y + 18, 280);
  doc.font(R).fontSize(9).fillColor(SOFT).text('Date', 360, y + 18, { width: 90 });
  doc.fillColor(INK).text(dmy(businessToday()), 450, y + 18, { width: PAGE_R - 450, align: 'right' });
  doc.moveTo(360, y + 40).lineTo(PAGE_R, y + 40).strokeColor('#B9CCE0').lineWidth(0.6).stroke();
  doc.font(B).fontSize(9.5).fillColor(INK).text('Total still owed', 360, y + 50, { width: 100 });
  doc.font(B).fontSize(13).text(`JMD ${cash(due).replace('$', '')}`, 430, y + 48, { width: PAGE_R - 430, align: 'right' });
  y += bandH + 22;
  const cc = { inv: PAGE_L + 10, date: 160, due: 260, total: 370, owed: 470 };
  doc.save().rect(PAGE_L, y, PAGE_R - PAGE_L, 20).fill(BAND).restore();
  doc.font(R).fontSize(8).fillColor(COLOR_BLUE)
    .text('INVOICE', cc.inv, y + 6.5).text('DATE', cc.date, y + 6.5).text('DUE', cc.due, y + 6.5)
    .text('TOTAL', cc.total, y + 6.5, { width: 90, align: 'right' })
    .text('STILL OWED', cc.owed, y + 6.5, { width: 92, align: 'right' });
  y += 30;
  for (const r of rows) {
    doc.font(R).fontSize(9).fillColor(INK)
      .text(r.invoice_number, cc.inv, y).text(dmy(r.invoice_date), cc.date, y)
      .text(r.due_date ? dmy(r.due_date) : '-', cc.due, y)
      .text(cash(num(r.grand_total_cents)), cc.total, y, { width: 90, align: 'right' })
      .text(cash(num(r.balance_cents)), cc.owed, y, { width: 92, align: 'right' });
    y += 19;
  }
  doc.moveTo(PAGE_L, y).lineTo(PAGE_R, y).strokeColor(RULE).lineWidth(0.7).stroke();
  doc.font(R).fontSize(9).fillColor(SOFT).text('Each invoice follows on its own page.', PAGE_L, y + 12);

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
  opts: { from?: string | null; to?: string | null; filter?: StatementFilter;
          status?: StatementStatus | string | null } = {},
): Promise<StatementDocument> {
  const statement = await getStatement(db, customerId, opts);
  // Narrowed to invoices in one state: the age analysis follows it.
  const onlyIds = statement.status ? await invoicesInStatus(db, customerId, statement.status) : null;

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
    current: string; d30: string; d60: string; d90: string; d91: string; total: string;
  }>(
    `SELECT
       COALESCE(SUM(balance_cents) FILTER (
         WHERE due_date IS NULL OR business_today() - due_date <= 0), 0)::text AS current,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date BETWEEN 1 AND 30), 0)::text AS d30,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date BETWEEN 31 AND 60), 0)::text AS d60,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date BETWEEN 61 AND 90), 0)::text AS d90,
       COALESCE(SUM(balance_cents) FILTER (
         WHERE business_today() - due_date > 90), 0)::text AS d91,
       COALESCE(SUM(balance_cents), 0)::text AS total
     FROM invoice_ledger
     WHERE customer_id = $1 AND balance_cents > 0
       AND ($2::uuid[] IS NULL OR invoice_id = ANY($2::uuid[]))`,
    [customerId, onlyIds],
  );

  // Bottles they are holding, over the same window as the ledger.
  const bottles = await bottleAccount(db, customerId, { from: opts.from, to: opts.to });
  // What one of our bottles costs THIS customer to buy, GCT included the way
  // every amount on the statement is (the footer says so): their price list
  // or special price for the bottle charge, else the standard price.
  let bottlePriceCents: number | null = null;
  if (bottles.closingHolding > 0) {
    const charge = await db.maybeOne<{ id: string }>(
      `SELECT id FROM products WHERE is_bottle_charge AND active ORDER BY created_at LIMIT 1`,
    );
    if (charge) {
      const [line] = await resolveLines(db, customerId, [{ productId: charge.id, looseBottles: 1 }]);
      const exempt = (await db.one<{ gct_exempt: boolean }>(
        `SELECT gct_exempt FROM customers WHERE id = $1`, [customerId])).gct_exempt;
      const net = num(line.pricePerBottleCents);
      bottlePriceCents = exempt ? net : Math.round(net * (1 + GCT_RATE));
    }
  }

  const { doc, finished } = newDoc();
  const closing = statement.closingBalanceCents;
  const inCredit = closing < 0;

  /* 1. Title, company, logo */
  let y = await docHeader(doc, db, 'STATEMENT');

  /* 2. The band: who it is for on the left, the statement's figures on the right */
  const toLines = [customer.name, customer.attention ? `Attn: ${customer.attention}` : '',
    customer.delivery_address ?? '', customer.phone ?? '', customer.email ?? ''].filter(Boolean);
  const facts: Array<[string, string]> = [
    ['Statement date', dmy(businessToday())],
    ['Period', statement.from || statement.to
      ? `${statement.from ? dmy(statement.from) : 'Start'} to ${statement.to ? dmy(statement.to) : dmy(businessToday())}`
      : 'All activity to date'],
  ];
  if (customer.payment_terms) facts.push(['Terms', customer.payment_terms]);
  if (statement.status) facts.push(['Showing', `${statement.status} invoices only`]);
  const bandH = 30 + Math.max(toLines.length * 12.5 + 12, facts.length * 15 + 34);
  band(doc, y, bandH);
  labelled(doc, 'To', toLines, PAGE_L, y + 18, 280);
  let fy = y + 18;
  for (const [k, v] of facts) {
    doc.font(R).fontSize(9).fillColor(SOFT).text(k, 360, fy, { width: 90 });
    doc.fillColor(INK).text(v, 450, fy, { width: PAGE_R - 450, align: 'right' });
    fy += 15;
  }
  fy += 4;
  doc.moveTo(360, fy).lineTo(PAGE_R, fy).strokeColor('#B9CCE0').lineWidth(0.6).stroke();
  fy += 8;
  doc.font(B).fontSize(9.5).fillColor(INK).text(inCredit ? 'In credit' : 'Total due', 360, fy + 2, { width: 90 });
  doc.font(B).fontSize(13).text(`JMD ${cash(Math.abs(closing)).replace('$', '')}`, 430, fy, { width: PAGE_R - 430, align: 'right' });
  y += bandH + 22;

  /* 3. The ledger: date, description, amount, running balance */
  const c = { date: { x: PAGE_L + 10, w: 70 }, desc: { x: 128, w: 250 }, amt: { x: 388, w: 84 }, bal: { x: 478, w: 84 } };
  const head = () => {
    doc.save().rect(PAGE_L, y, PAGE_R - PAGE_L, 20).fill(BAND).restore();
    doc.font(R).fontSize(8).fillColor(COLOR_BLUE);
    doc.text('DATE', c.date.x, y + 6.5, { width: c.date.w, characterSpacing: 0.4 });
    doc.text('DESCRIPTION', c.desc.x, y + 6.5, { width: c.desc.w, characterSpacing: 0.4 });
    doc.text('AMOUNT', c.amt.x, y + 6.5, { width: c.amt.w, align: 'right', characterSpacing: 0.4 });
    doc.text('BALANCE', c.bal.x, y + 6.5, { width: c.bal.w, align: 'right', characterSpacing: 0.4 });
    y += 30;
  };
  head();
  const line = (date: string, desc: string, amount: string, balance: string, muted = false) => {
    doc.font(R).fontSize(9);
    const h = doc.heightOfString(desc || ' ', { width: c.desc.w });
    if (y + h > 680) { doc.addPage(); y = 50; head(); }
    doc.font(R).fontSize(9).fillColor(muted ? SOFT : INK);
    doc.text(date, c.date.x, y, { width: c.date.w });
    doc.text(desc, c.desc.x, y, { width: c.desc.w });
    doc.text(amount, c.amt.x, y, { width: c.amt.w, align: 'right' });
    doc.text(balance, c.bal.x, y, { width: c.bal.w, align: 'right' });
    y += h + 7;
  };
  const dayBefore = (iso: string) => {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const plain = (cents: number) => cash(cents).replace('$', '');
  line(statement.from ? dmy(dayBefore(String(statement.from))) : '', 'Balance forward', '', plain(statement.openingBalanceCents), true);
  y += 6;
  const words = (e: (typeof statement.entries)[number]) => {
    if (e.type === 'Invoice') return `Invoice ${e.reference}`;
    if (e.type === 'Credit Note') return `Credit note ${e.reference}`;
    if (e.type === 'Reversal') return `Payment reversed${e.reference ? `, ${e.reference}` : ''}`;
    if (e.type === 'Reassignment') return 'Payment moved to another account';
    return e.description.startsWith('Payment received, applied to ')
      ? `Payment, ${e.reference}` : 'Payment, on account';
  };
  for (const e of statement.entries) {
    line(dmy(e.date), words(e), plain(e.amountCents), plain(e.runningBalanceCents));
  }
  if (statement.entries.length === 0) line('', 'No activity in this period.', '', '', true);
  doc.moveTo(PAGE_L, y + 2).lineTo(PAGE_R, y + 2).strokeColor(RULE).lineWidth(0.7).stroke();
  y += 14;

  /* 4. Our bottles with them (left) and what is due (right) */
  if (y > 600) { doc.addPage(); y = 50; }
  doc.font(B).fontSize(9.5).fillColor(INK).text(inCredit ? 'In credit' : 'Balance due', 330, y + 2, { width: 120 });
  doc.font(B).fontSize(13).text(`JMD ${plain(Math.abs(closing))}`, 430, y, { width: PAGE_R - 430, align: 'right' });
  if (inCredit) {
    doc.font(R).fontSize(8).fillColor(SOFT).text('Paid ahead. This comes off the next invoice.', 330, y + 20, { width: PAGE_R - 330, align: 'right' });
  }
  if (bottles.closingHolding > 0) {
    doc.font(R).fontSize(8).fillColor(SOFT).text('OUR 5-GALLON BOTTLES WITH YOU', PAGE_L, y, { characterSpacing: 0.3 });
    doc.font(B).fontSize(12).fillColor(INK).text(String(bottles.closingHolding), PAGE_L, doc.y + 2);
    if (bottlePriceCents !== null) {
      doc.font(R).fontSize(6.5).fillColor(MUTED)
        .text(`These are to be returned or purchased at ${cash(bottlePriceCents)} each.`, PAGE_L, doc.y + 2);
    }
  }
  y = Math.max(doc.y, y + 22) + 16;

  /* 5. Age of what is owed, across the page */
  const owed = Number(aging.total);
  if (owed > 0) {
    if (y > 640) { doc.addPage(); y = 50; }
    const cells: Array<[string, number]> = [
      ['Current\ndue', Number(aging.current)], ['1-30 days\npast due', Number(aging.d30)],
      ['31-60 days\npast due', Number(aging.d60)], ['61-90 days\npast due', Number(aging.d90)],
      ['90+ days\npast due', Number(aging.d91)],
    ];
    const w = (PAGE_R - PAGE_L) / 6;
    doc.save().rect(PAGE_L, y, PAGE_R - PAGE_L, 30).fill(BAND).restore();
    cells.forEach(([label], i) => {
      doc.font(R).fontSize(7.5).fillColor(COLOR_BLUE).text(label, PAGE_L + 10 + i * w, y + 5, { width: w - 12, lineGap: 1 });
    });
    doc.font(R).fontSize(7.5).fillColor(COLOR_BLUE).text('Amount\ndue', PAGE_L + 5 * w, y + 5, { width: w - 10, align: 'right', lineGap: 1 });
    const vy = y + 40;
    cells.forEach(([, v], i) => {
      doc.font(R).fontSize(9).fillColor(i >= 3 && v > 0 ? '#B42318' : INK).text(plain(v), PAGE_L + 10 + i * w, vy, { width: w - 12 });
    });
    doc.font(B).fontSize(9.5).fillColor(INK).text(`JMD ${plain(owed)}`, PAGE_L + 5 * w - 10, vy, { width: w, align: 'right' });
    y = vy + 30;
  }

  /* 6. How to pay: only when something is owed */
  if (closing > 0) {
    if (y > 600) { doc.addPage(); y = 50; }
    doc.y = await paymentColumn(doc, db, 58, y, 300);
  } else {
    doc.y = y;
  }

  await smallPrint(doc, db, 'All amounts in Jamaican dollars, GCT inclusive. Please quote the invoice number with any payment.');

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
  /** Always present: the plain-text twin, for mail programs that show only text. */
  text: string;
  /** The branded version (emailkit.ts). */
  html?: string;
  /** e.g. List-Unsubscribe on non-essential email. */
  headers?: Record<string, string>;
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
  if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) return true;
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

  /*
   * On a web host, send through Resend's web API rather than SMTP. Railway
   * (like many hosts) blocks outgoing SMTP on its smaller plans, so the
   * office PC keeps using the mail account in the settings file while the
   * hosted copy uses RESEND_API_KEY. Replies go to MAIL_REPLY_TO when set.
   */
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        ...(m.headers ? { headers: m.headers } : {}),
        ...(process.env.MAIL_REPLY_TO ? { reply_to: process.env.MAIL_REPLY_TO } : {}),
        attachments: (m.attachments ?? []).map((a) => ({
          filename: a.filename, content: a.content.toString('base64'),
        })),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new RuleViolation(`the email could not be sent (${res.status}): ${detail.slice(0, 200)}`);
    }
    return;
  }

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
    to: m.to, subject: m.subject, text: m.text, html: m.html, headers: m.headers,
    attachments: m.attachments,
    ...(process.env.MAIL_REPLY_TO ? { replyTo: process.env.MAIL_REPLY_TO } : {}),
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

/** "3 cases" / "4 bottles", the way every email counts a line. */
export function qtyWords(bpc: number, cases: number, loose: number): string {
  const c = Math.abs(cases); const l = Math.abs(loose);
  if (bpc > 0 && c > 0 && l > 0) return `${c} cs + ${l}`;
  if (bpc > 0 && c > 0) return `${c} case${c === 1 ? '' : 's'}`;
  return `${l} bottle${l === 1 ? '' : 's'}`;
}

/** An invoice's lines and totals, as an email lays them out. */
export async function invoiceEmailFigures(db: Queryable, invoiceId: string): Promise<{
  items: Array<{ name: string; qty: string; amount: string }>;
  totals: Array<[string, string, boolean?]>;
  customerId: string; invoiceNumber: string; invoiceDate: string; dueDate: string | null;
  balanceCents: number; isCreditNote: boolean;
}> {
  const h = await db.one<{
    customer_id: string; invoice_number: string; invoice_date: string; due_date: string | null;
    subtotal_cents: number; discount_amount_cents: number; gct_cents: number; grand_total_cents: number;
    is_credit_note: boolean; gct_exempt: boolean;
  }>(
    `SELECT customer_id, invoice_number, invoice_date::text AS invoice_date, due_date::text AS due_date,
            subtotal_cents, discount_amount_cents, gct_cents, grand_total_cents, is_credit_note, gct_exempt
     FROM invoices WHERE id = $1`, [invoiceId],
  );
  const bal = await db.one<{ balance_cents: number; amount_paid_cents: number }>(
    `SELECT balance_cents, amount_paid_cents FROM invoice_ledger WHERE invoice_id = $1`, [invoiceId],
  );
  const lines = await db.query<{ name: string; bpc: number; cases: number; loose: number; total: number }>(
    `SELECT p.name, p.bottles_per_case AS bpc, l.cases, l.loose_bottles AS loose, l.line_total_cents AS total
     FROM invoice_line_items l JOIN products p ON p.id = l.product_id
     WHERE l.invoice_id = $1 ORDER BY p.name`, [invoiceId],
  );
  const totals: Array<[string, string, boolean?]> = [['Subtotal', cash(Math.abs(num(h.subtotal_cents)))]];
  if (num(h.discount_amount_cents) > 0) totals.push(['Discount', `-${cash(num(h.discount_amount_cents))}`]);
  totals.push([h.gct_exempt ? 'GCT (exempt)' : 'GCT 15%', cash(Math.abs(num(h.gct_cents)))]);
  totals.push([h.is_credit_note ? 'Credit' : 'Total', cash(Math.abs(num(h.grand_total_cents))), true]);
  if (!h.is_credit_note && num(bal.amount_paid_cents) > 0) {
    totals.push(['Paid', cash(num(bal.amount_paid_cents))]);
    totals.push(['Balance due', cash(num(bal.balance_cents)), true]);
  }
  return {
    items: lines.map((l) => ({ name: l.name, qty: qtyWords(num(l.bpc), num(l.cases), num(l.loose)), amount: cash(Math.abs(num(l.total))) })),
    totals, customerId: h.customer_id, invoiceNumber: h.invoice_number,
    invoiceDate: h.invoice_date, dueDate: h.due_date, balanceCents: num(bal.balance_cents),
    isCreditNote: h.is_credit_note,
  };
}

/**
 * Send a customer their statement.
 *
 * Unlike an invoice, sending a statement changes nothing about the records -
 * it is a copy of what is already true - so there is no lifecycle to update,
 * only an audit line saying it went.
 *
 * `category` is set by the automatic sends (monthly statement, reminders):
 * those carry an unsubscribe link. One the office sends by hand does not.
 */
export async function emailStatement(
  db: Db,
  actor: Actor,
  customerId: string,
  opts: { from?: string | null; to?: string | null;
          filter?: StatementFilter; status?: StatementStatus | null;
          sendTo?: string | null; note?: string | null;
          subject?: string | null; heading?: string | null;
          category?: 'statements' | 'reminders' | null } = {},
): Promise<{ sentTo: string; customerName: string }> {
  requireRole(actor, 'admin', 'user');
  if (!mailConfigured()) throw new RuleViolation(NOT_SET_UP);

  const doc = await renderStatementPdf(db, customerId,
    { from: opts.from, to: opts.to, filter: opts.filter, status: opts.status ?? null });
  const to = recipient(opts.sendTo, doc.customerEmail, doc.customerName);
  const owed = await db.one<{ balance_cents: number; overdue_cents: number }>(
    `SELECT COALESCE((SELECT balance_cents FROM customer_balances WHERE customer_id = $1), 0)::bigint AS balance_cents,
            COALESCE((SELECT SUM(balance_cents) FROM invoice_ledger
                      WHERE customer_id = $1 AND NOT is_credit_note AND status <> 'Cancelled'
                        AND balance_cents > 0 AND due_date < business_today()), 0)::bigint AS overdue_cents`,
    [customerId],
  );
  const reminder = opts.category === 'reminders';
  const mail = await customerEmail(db, customerId, opts.category ?? null, {
    preheader: reminder ? 'A friendly reminder about your account' : `Your statement from ${BRAND.name}`,
    heading: opts.heading ?? (reminder ? 'A friendly payment reminder' : 'Your statement of account'),
    subheading: doc.customerName,
    greeting: 'Good day,',
    intro: (reminder ? '' : `Please find attached your statement of account from ${BRAND.name}.`)
      + (opts.note ? `${reminder ? '' : '\n\n'}${opts.note}` : ''),
    facts: [
      [num(owed.balance_cents) < 0 ? 'In credit' : 'Balance on account', cash(Math.abs(num(owed.balance_cents)))],
      ['Past due', cash(num(owed.overdue_cents))],
    ],
    button: { label: 'See my account', url: `${siteUrl()}/#/portal/account` },
    outro: 'Thank you for your business.',
  });

  await sendMail({
    to,
    subject: opts.subject ?? `${BRAND.name} statement of account`,
    text: mail.text, html: mail.html, headers: mail.headers,
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
  const f = await invoiceEmailFigures(db, invoiceId);
  const mail = await customerEmail(db, f.customerId, null, {
    preheader: `${isCN ? 'Credit note' : 'Invoice'} ${doc.invoiceNumber} from ${BRAND.name}`,
    heading: `${isCN ? 'Credit note' : 'Invoice'} ${doc.invoiceNumber}`,
    subheading: doc.customerName,
    greeting: 'Good day,',
    intro: `Please find attached ${isCN ? 'credit note' : 'invoice'} ${doc.invoiceNumber} from ${BRAND.name}.`,
    items: f.items,
    totals: f.totals,
    facts: isCN ? [['Dated', fmtDate(f.invoiceDate)]] : [
      ['Dated', fmtDate(f.invoiceDate)],
      ['Due', f.dueDate ? fmtDate(f.dueDate) : 'On receipt'],
      ['To pay', f.balanceCents > 0 ? cash(f.balanceCents) : 'Paid, thank you'],
    ],
    button: { label: 'See it online', url: `${siteUrl()}/#/portal/invoices/${invoiceId}` },
    outro: 'Thank you for your business.',
  });

  await sendMail({
    to,
    subject: `${BRAND.name} ${isCN ? 'credit note' : 'invoice'} ${doc.invoiceNumber}`,
    text: mail.text, html: mail.html,
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
  const each = await db.query<{ invoice_number: string; invoice_date: string; balance_cents: number }>(
    `SELECT invoice_number, invoice_date::text AS invoice_date, balance_cents FROM invoice_ledger
     WHERE invoice_id = ANY($1::uuid[]) ORDER BY invoice_date, invoice_number`, [invoiceIds],
  );
  const mail = await customerEmail(db, doc.customerId, null, {
    preheader: `${doc.numbers.length} invoices from ${BRAND.name}`,
    heading: doc.numbers.length === 1 ? `Invoice ${list}` : `Your invoices (${doc.numbers.length})`,
    subheading: doc.customerName,
    greeting: 'Good day,',
    intro: `Please find attached ${doc.numbers.length === 1 ? 'invoice' : 'invoices'} ${list} from ${BRAND.name}, in one PDF.`
      + (opts.note ? `\n\n${opts.note}` : ''),
    items: each.map((i) => ({ name: i.invoice_number, qty: fmtDate(i.invoice_date), amount: cash(num(i.balance_cents)) })),
    totals: [['Total still owed on these', cash(doc.totalDueCents), true]],
    button: { label: 'See my account', url: `${siteUrl()}/#/portal/account` },
    outro: 'Thank you for your business.',
  });

  await sendMail({
    to,
    subject: `${BRAND.name} invoices ${doc.numbers.length > 3
      ? `(${doc.numbers.length})` : list}`,
    text: mail.text, html: mail.html,
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

export { cash as formatCash, newDoc, fmtDate, billTo, letterhead, BRAND, recipient, signOff, COLOR_BLUE, COLOR_INDIGO };
