/**
 * The send screen (Everton, 28 Oct 2026).
 *
 * "Email..." on any document opens a screen in a new tab, the way QuickBooks
 * and Zoho work: the email already written, the document attached, To / Cc /
 * Bcc, "Send me a copy", and room for other files. The browser cannot attach
 * a file to Outlook or Gmail, so the app sends it, from the Alka Vida
 * address, and replies come back to the office as before.
 *
 * - draft: what the screen starts with. The document is built here exactly
 *   as it will be attached, so "View" shows the very PDF that goes.
 * - send: what the screen sends back, through the same sender each document
 *   always used (so an invoice is still marked Sent, a quote still gets its
 *   accept link, a PO is still marked Sent to the supplier).
 * - plan: several ticked on a list. Everton chose to go one at a time
 *   ("Option B"): the screen shows each email in turn, Send and go to the
 *   next, Skip, or Stop. Invoices and receipts are grouped one email per
 *   customer, as before; quotes and purchase orders go one each. Anything
 *   that cannot be emailed (no address on file) is listed before the first.
 */

import { RuleViolation } from '@alka/shared';
import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { requireRole } from './core.ts';
import {
  emailInvoice, emailInvoices, emailStatement, mailConfigured,
  renderInvoicePdf, renderInvoicesPdf, renderStatementPdf,
} from './documents.ts';
import {
  emailPurchaseOrder, emailQuote, emailReceipt, renderPoPdf, renderQuotePdf, renderReceiptPdf,
} from './paperwork.ts';
import { emailOrderConfirmation } from './messaging.ts';
import { type Compose, MAX_ATTACH_BYTES, savedCopies, senderAddress, splitAddresses, looksLikeEmail } from './compose.ts';
import { type WordingKind, WORDING, filledWording } from './emailwording.ts';
import { asStatementStatuses, type StatementFilter } from './ledger.ts';

export type SendKind = 'invoice' | 'invoices' | 'statement' | 'quote' | 'receipt' | 'purchase-order' | 'order';
export const SEND_KINDS: SendKind[] = ['invoice', 'invoices', 'statement', 'quote', 'receipt', 'purchase-order', 'order'];

/** Which document: a kind, its ids, and for a statement its window. */
export interface SendRef {
  kind: SendKind;
  ids: string[];
  from?: string | null;
  to?: string | null;
  filter?: string | null;
  status?: string | null;
}

export interface Draft {
  kind: SendKind;
  /** "Invoice INV-016401", "Statement", "Purchase order PO-001002"... */
  docLabel: string;
  recipientName: string;
  /** customer or supplier */
  recipientType: 'customer' | 'supplier';
  recipientId: string | null;
  emailOnFile: string | null;
  to: string[];
  cc: string[];
  /** Where the Cc came from, said on the screen. */
  ccSaved: boolean;
  subject: string;
  message: string;
  attachments: Array<{ filename: string; bytes: number }>;
  /** The wording used, so the screen can say "set in Settings". */
  wordingKind: WordingKind;
  wordingLabel: string;
  mailConfigured: boolean;
  me: string | null;
  maxBytes: number;
  /** Shown above the form: why this one cannot go, or something to know first. */
  blocked?: string | null;
  note?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Checks a reference from the screen (it arrives in the address bar). */
export function cleanRef(raw: Partial<SendRef> & { ids?: unknown }): SendRef {
  const kind = String(raw.kind ?? '') as SendKind;
  if (!SEND_KINDS.includes(kind)) throw new RuleViolation('that is not something that can be emailed');
  const list = Array.isArray(raw.ids) ? raw.ids.map(String) : String(raw.ids ?? '').split(',');
  const ids = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new RuleViolation('nothing was chosen to email');
  if (ids.some((i) => !UUID.test(i))) throw new RuleViolation('that link is not complete; go back and choose Email again');
  if (ids.length > 200) throw new RuleViolation('choose fewer at a time (200 at most)');
  if (['invoice', 'statement', 'quote', 'purchase-order', 'order'].includes(kind) && ids.length > 1) {
    throw new RuleViolation('one at a time for this kind of document');
  }
  const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : null);
  const filter = ['All', 'Invoices', 'Payments'].includes(String(raw.filter)) ? String(raw.filter) : null;
  return {
    kind, ids, from: day(raw.from), to: day(raw.to), filter,
    status: typeof raw.status === 'string' && raw.status ? raw.status : null,
  };
}

async function customerOf(db: Db, sql: string, id: string): Promise<{ id: string; name: string; email: string | null }> {
  const r = await db.maybeOne<{ id: string; name: string; email: string | null }>(sql, [id]);
  if (!r) throw new RuleViolation('that document no longer exists');
  return r;
}

/** What the send screen starts with. */
export async function draftEmail(db: Db, actor: Actor, ref: SendRef): Promise<Draft> {
  requireRole(actor, 'admin', 'user');
  let docLabel = '';
  let wordingKind: WordingKind = ref.kind === 'invoice' ? 'invoice' : ref.kind;
  let recipient: { id: string | null; name: string; email: string | null; type: 'customer' | 'supplier' };
  let attachments: Array<{ filename: string; bytes: number }> = [];
  let blocked: string | null = null;
  let note: string | null = null;
  const win = { from: ref.from, to: ref.to };

  switch (ref.kind) {
    case 'invoice': {
      const c = await customerOf(db,
        `SELECT c.id, c.name, c.email FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`, ref.ids[0]);
      const inv = await db.one<{ is_credit_note: boolean; invoice_number: string; lifecycle: string }>(
        `SELECT is_credit_note, invoice_number, lifecycle FROM invoices WHERE id = $1`, [ref.ids[0]]);
      wordingKind = inv.is_credit_note ? 'credit-note' : 'invoice';
      docLabel = `${inv.is_credit_note ? 'Credit note' : 'Invoice'} ${inv.invoice_number}`;
      if (inv.lifecycle === 'Cancelled') note = `${inv.invoice_number} is void. The PDF says so.`;
      const doc = await renderInvoicePdf(db, ref.ids[0]);
      attachments = [{ filename: doc.filename, bytes: doc.pdf.length }];
      recipient = { ...c, type: 'customer' };
      break;
    }
    case 'invoices': {
      const doc = await renderInvoicesPdf(db, ref.ids);
      const c = await customerOf(db, `SELECT id, name, email FROM customers WHERE id = $1`, doc.customerId);
      docLabel = `${doc.numbers.length} invoices in one PDF (${doc.numbers.join(', ')})`;
      attachments = [{ filename: doc.filename, bytes: doc.pdf.length }];
      recipient = { ...c, type: 'customer' };
      break;
    }
    case 'statement': {
      const c = await customerOf(db, `SELECT id, name, email FROM customers WHERE id = $1`, ref.ids[0]);
      const doc = await renderStatementPdf(db, ref.ids[0], {
        from: ref.from, to: ref.to, filter: (ref.filter ?? undefined) as StatementFilter | undefined,
        status: ref.status ? asStatementStatuses(ref.status) : null,
      });
      docLabel = 'Statement of account';
      attachments = [{ filename: doc.filename, bytes: doc.pdf.length }];
      recipient = { ...c, type: 'customer' };
      break;
    }
    case 'quote': {
      const c = await customerOf(db,
        `SELECT c.id, c.name, c.email FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE q.id = $1`, ref.ids[0]);
      const q = await db.one<{ quote_number: string; status: string }>(
        `SELECT quote_number, status FROM quotations WHERE id = $1`, [ref.ids[0]]);
      docLabel = `Quotation ${q.quote_number}`;
      if (['Converted', 'Declined'].includes(q.status)) blocked = `${q.quote_number} is ${q.status.toLowerCase()}; it cannot be sent again.`;
      const doc = await renderQuotePdf(db, ref.ids[0]);
      attachments = [{ filename: doc.filename, bytes: doc.pdf.length }];
      note = 'The email carries an "Accept this quotation" button for the customer.';
      recipient = { ...c, type: 'customer' };
      break;
    }
    case 'receipt': {
      const c = await customerOf(db,
        `SELECT c.id, c.name, c.email FROM payments p JOIN customers c ON c.id = p.customer_id WHERE p.id = $1`, ref.ids[0]);
      const doc = await renderReceiptPdf(db, ref.ids);
      docLabel = `Receipt ${doc.receiptNumber}`;
      attachments = [{ filename: doc.filename, bytes: doc.pdf.length }];
      recipient = { ...c, type: 'customer' };
      break;
    }
    case 'purchase-order': {
      const s = await db.maybeOne<{ id: string; name: string; email: string | null; po_number: string }>(
        `SELECT s.id, s.name, s.email, po.po_number FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`,
        [ref.ids[0]]);
      if (!s) throw new RuleViolation('that purchase order no longer exists');
      docLabel = `Purchase order ${s.po_number}`;
      const doc = await renderPoPdf(db, ref.ids[0]);
      attachments = [{ filename: doc.filename, bytes: doc.pdf.length }];
      recipient = { id: s.id, name: s.name, email: s.email, type: 'supplier' };
      break;
    }
    case 'order': {
      const o = await db.maybeOne<{ id: string; name: string; email: string | null; order_number: string; status: string; delivery_mode: string }>(
        `SELECT c.id, c.name, c.email, o.order_number, o.status, o.delivery_mode
         FROM customer_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`, [ref.ids[0]]);
      if (!o) throw new RuleViolation('that order no longer exists');
      docLabel = `Order confirmation ${o.order_number}`;
      if (o.delivery_mode === 'Counter') blocked = 'A counter sale has its receipt and invoice instead.';
      else if (o.status === 'Cancelled') blocked = `${o.order_number} is cancelled.`;
      else if (o.status === 'Delivered') blocked = `${o.order_number} is already delivered; email the invoice instead.`;
      note = 'The email lists the order, its total and the delivery details. It has no PDF; attach a file if you need to.';
      recipient = { id: o.id, name: o.name, email: o.email, type: 'customer' };
      break;
    }
  }

  const w = await filledWording(db, wordingKind,
    ref.kind === 'statement' ? [ref.ids[0]] : ref.ids, win);
  const onFile = recipient!.email?.trim() || null;
  const cc = recipient!.type === 'customer' ? await savedCopies(db, recipient!.id) : [];
  return {
    kind: ref.kind, docLabel,
    recipientName: recipient!.name, recipientType: recipient!.type, recipientId: recipient!.id,
    emailOnFile: onFile,
    to: splitAddresses(onFile).filter(looksLikeEmail),
    cc, ccSaved: cc.length > 0,
    subject: w.subject, message: w.message,
    attachments,
    wordingKind, wordingLabel: WORDING[wordingKind].label,
    mailConfigured: mailConfigured(),
    me: await senderAddress(db, actor.id),
    maxBytes: MAX_ATTACH_BYTES,
    blocked, note,
  };
}

/** Sends what the screen sent back, through the document's own sender. */
export async function sendEmail(
  db: Db, actor: Actor, ref: SendRef, compose: Compose,
): Promise<{ sentTo: string; label: string; link?: string }> {
  requireRole(actor, 'admin', 'user');
  if (!compose || typeof compose !== 'object') throw new RuleViolation('nothing to send');
  switch (ref.kind) {
    case 'invoice': {
      const r = await emailInvoice(db, actor, ref.ids[0], null, compose);
      return { sentTo: r.sentTo, label: r.invoiceNumber };
    }
    case 'invoices': {
      const r = await emailInvoices(db, actor, ref.ids, { compose });
      return { sentTo: r.sentTo, label: r.invoiceNumbers.join(', ') };
    }
    case 'statement': {
      const r = await emailStatement(db, actor, ref.ids[0], {
        from: ref.from, to: ref.to, filter: (ref.filter ?? undefined) as StatementFilter | undefined,
        status: ref.status ? asStatementStatuses(ref.status) : null, compose,
      });
      return { sentTo: r.sentTo, label: `Statement for ${r.customerName}` };
    }
    case 'quote': {
      const r = await emailQuote(db, actor, ref.ids[0], { compose });
      return { sentTo: r.sentTo ?? '', label: r.quoteNumber, link: r.link };
    }
    case 'receipt': {
      const r = await emailReceipt(db, actor, ref.ids, { compose });
      return { sentTo: r.sentTo, label: `Receipt ${r.receiptNumber}` };
    }
    case 'purchase-order': {
      const r = await emailPurchaseOrder(db, actor, ref.ids[0], { compose });
      return { sentTo: r.sentTo, label: r.poNumber };
    }
    case 'order': {
      const r = await emailOrderConfirmation(db, actor, ref.ids[0], { compose });
      return { sentTo: r.sentTo, label: `Confirmation of ${r.orderNumber}` };
    }
  }
}

/** The PDF exactly as it will be attached, for "View". */
export async function previewPdf(db: Db, actor: Actor, ref: SendRef): Promise<{ filename: string; pdf: Buffer }> {
  requireRole(actor, 'admin', 'user');
  switch (ref.kind) {
    case 'invoice': return renderInvoicePdf(db, ref.ids[0]);
    case 'invoices': return renderInvoicesPdf(db, ref.ids);
    case 'statement': return renderStatementPdf(db, ref.ids[0], {
      from: ref.from, to: ref.to, filter: (ref.filter ?? undefined) as StatementFilter | undefined,
      status: ref.status ? asStatementStatuses(ref.status) : null,
    });
    case 'quote': return renderQuotePdf(db, ref.ids[0]);
    case 'receipt': return renderReceiptPdf(db, ref.ids);
    case 'purchase-order': return renderPoPdf(db, ref.ids[0]);
    case 'order': throw new RuleViolation('an order confirmation has no PDF');
  }
}

/* ------------------------------------------------------------------ */
/* Several ticked on a list: one email at a time                       */
/* ------------------------------------------------------------------ */

export type BatchKind = 'invoices' | 'receipts' | 'quotes' | 'purchase-orders';

export interface PlanStep {
  /** Who it goes to. */
  name: string;
  /** What goes: "INV-016401, INV-016412". */
  what: string;
  email: string | null;
  ref: SendRef;
}

export async function planBatch(
  db: Db, actor: Actor, kind: BatchKind, rawIds: readonly string[],
): Promise<{ steps: PlanStep[]; cannot: Array<{ name: string; what: string; why: string }> }> {
  requireRole(actor, 'admin', 'user');
  const ids = [...new Set(rawIds.map(String))].filter((i) => UUID.test(i));
  if (ids.length === 0) throw new RuleViolation('nothing was chosen to email');
  const steps: PlanStep[] = [];
  const cannot: Array<{ name: string; what: string; why: string }> = [];
  const noEmail = 'no email address on file';

  if (kind === 'invoices' || kind === 'receipts') {
    const rows = kind === 'invoices'
      ? await db.query<{ id: string; customer_id: string; name: string; email: string | null; label: string }>(
        `SELECT l.invoice_id AS id, l.customer_id, c.name, c.email, l.invoice_number AS label
         FROM invoice_ledger l JOIN customers c ON c.id = l.customer_id
         WHERE l.invoice_id = ANY($1::uuid[]) AND l.status <> 'Cancelled'
         ORDER BY c.name, l.invoice_date, l.invoice_number`, [ids])
      : await db.query<{ id: string; customer_id: string; name: string; email: string | null; label: string }>(
        `SELECT p.id, p.customer_id, c.name, c.email, COALESCE(p.receipt_number, 'payment') AS label
         FROM payments p JOIN customers c ON c.id = p.customer_id
         WHERE p.id = ANY($1::uuid[]) AND NOT p.is_reversal AND p.amount_cents > 0
         ORDER BY c.name, p.payment_date`, [ids]);
    const groups = new Map<string, { name: string; email: string | null; ids: string[]; labels: string[] }>();
    for (const r of rows) {
      if (!groups.has(r.customer_id)) groups.set(r.customer_id, { name: r.name, email: r.email, ids: [], labels: [] });
      const g = groups.get(r.customer_id)!;
      g.ids.push(r.id);
      if (!g.labels.includes(r.label)) g.labels.push(r.label);
    }
    for (const g of groups.values()) {
      const what = g.labels.join(', ');
      const email = g.email?.trim() || null;
      if (!email) { cannot.push({ name: g.name, what, why: noEmail }); continue; }
      const ref: SendRef = kind === 'receipts'
        ? { kind: 'receipt', ids: g.ids }
        : { kind: g.ids.length === 1 ? 'invoice' : 'invoices', ids: g.ids };
      steps.push({ name: g.name, what, email, ref });
    }
    const skipped = ids.length - rows.length;
    if (skipped > 0) {
      cannot.push({ name: `${skipped} more`, what: kind === 'invoices' ? 'void or cancelled' : 'reversals',
        why: kind === 'invoices' ? 'void and cancelled ones are not emailed' : 'a reversal has no receipt' });
    }
  } else if (kind === 'quotes') {
    const rows = await db.query<{ id: string; quote_number: string; status: string; name: string; email: string | null }>(
      `SELECT q.id, q.quote_number, q.status, c.name, c.email FROM quotations q JOIN customers c ON c.id = q.customer_id
       WHERE q.id = ANY($1::uuid[]) ORDER BY c.name, q.quote_number`, [ids]);
    for (const r of rows) {
      const email = r.email?.trim() || null;
      if (['Converted', 'Declined'].includes(r.status)) cannot.push({ name: r.name, what: r.quote_number, why: `${r.status.toLowerCase()}, so it cannot be sent again` });
      else if (!email) cannot.push({ name: r.name, what: r.quote_number, why: noEmail });
      else steps.push({ name: r.name, what: r.quote_number, email, ref: { kind: 'quote', ids: [r.id] } });
    }
  } else if (kind === 'purchase-orders') {
    const rows = await db.query<{ id: string; po_number: string; name: string; email: string | null }>(
      `SELECT po.id, po.po_number, s.name, s.email FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.id = ANY($1::uuid[]) ORDER BY s.name, po.po_number`, [ids]);
    for (const r of rows) {
      const email = r.email?.trim() || null;
      if (!email) cannot.push({ name: r.name, what: r.po_number, why: noEmail });
      else steps.push({ name: r.name, what: r.po_number, email, ref: { kind: 'purchase-order', ids: [r.id] } });
    }
  } else {
    throw new RuleViolation('that list cannot be emailed from here');
  }
  return { steps, cannot };
}
