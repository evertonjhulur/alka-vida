/**
 * The words of the emails the office sends (Everton, 28 Oct 2026).
 *
 * Each kind of document has a subject and a message, set once in Settings >
 * Emails & ordering. Words in {braces} are blanks the app fills in for each
 * customer: {customer}, {number}, {amount}... The send screen starts from
 * this wording and anyone sending can change it for that one email. The
 * automatic emails (monthly statements, invoices raised at the end of a
 * week or month, the "email a receipt" tick) use it as it stands.
 *
 * Nothing here imports the senders: they import it.
 */

import { RuleViolation } from '@alka/shared';
import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, num, requireRole } from './core.ts';

export type WordingKind =
  | 'invoice' | 'invoices' | 'credit-note' | 'statement' | 'quote' | 'receipt' | 'purchase-order' | 'order';

export interface Wording { subject: string; message: string }

interface KindInfo extends Wording { label: string; blanks: string[]; }

/**
 * The standard wording. It says what the emails said before the send
 * screen, so nothing changes for a customer until someone changes it.
 */
export const WORDING: Record<WordingKind, KindInfo> = {
  invoice: {
    label: 'Invoice',
    blanks: ['{customer}', '{contact}', '{number}', '{amount}', '{to pay}', '{due date}', '{invoice date}'],
    subject: 'Alka Vida invoice {number}',
    message: 'Good day,\n\nPlease find attached invoice {number} from Alka Vida.\n\nThank you for your business.',
  },
  invoices: {
    label: 'Several invoices for one customer',
    blanks: ['{customer}', '{contact}', '{numbers}', '{count}', '{to pay}'],
    subject: 'Alka Vida invoices {numbers}',
    message: 'Good day,\n\nPlease find attached invoices {numbers} from Alka Vida, in one PDF.\n\nThank you for your business.',
  },
  'credit-note': {
    label: 'Credit note',
    blanks: ['{customer}', '{contact}', '{number}', '{amount}', '{date}'],
    subject: 'Alka Vida credit note {number}',
    message: 'Good day,\n\nPlease find attached credit note {number} from Alka Vida.\n\nThank you for your business.',
  },
  statement: {
    label: 'Statement',
    blanks: ['{customer}', '{contact}', '{balance}', '{past due}', '{period}'],
    subject: 'Alka Vida statement of account',
    message: 'Good day,\n\nPlease find attached your statement of account from Alka Vida.\n\nThank you for your business.',
  },
  quote: {
    label: 'Quotation',
    blanks: ['{customer}', '{contact}', '{number}', '{amount}', '{valid until}'],
    subject: 'Alka Vida quotation {number}',
    message: 'Good day,\n\nPlease find attached quotation {number} from Alka Vida.\n\nTo go ahead, press "Accept this quotation" below, or simply reply to this email and we will take it from there.',
  },
  receipt: {
    label: 'Receipt',
    blanks: ['{customer}', '{contact}', '{number}', '{amount}', '{date}'],
    subject: 'Alka Vida receipt {number}',
    message: 'Good day,\n\nWe have received your payment of {amount}. Your receipt is attached.\n\nThank you.',
  },
  'purchase-order': {
    label: 'Purchase order (to a supplier)',
    blanks: ['{supplier}', '{contact}', '{number}', '{amount}', '{required by}'],
    subject: 'Alka Vida purchase order {number}',
    message: 'Good day,\n\nPlease find attached purchase order {number} from 1506 Investments Limited.\n\nKindly confirm receipt and the delivery date.',
  },
  order: {
    label: 'Order confirmation',
    blanks: ['{customer}', '{contact}', '{number}', '{delivery date}'],
    subject: 'Alka Vida order {number} received',
    message: 'Good day {customer},\n\nWe have your order and will have it with you as below.\n\nThe invoice is made out from what is actually delivered.',
  },
};

export const WORDING_KINDS = Object.keys(WORDING) as WordingKind[];
const KEY = 'email_wording';

async function saved(db: Queryable): Promise<Partial<Record<WordingKind, Wording>>> {
  const r = await db.maybeOne<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [KEY]);
  if (!r?.value) return {};
  try { return JSON.parse(r.value) as Partial<Record<WordingKind, Wording>>; } catch { return {}; }
}

/** The wording in use for one kind: what was saved, else the standard. */
export async function wordingFor(db: Queryable, kind: WordingKind): Promise<Wording> {
  const s = (await saved(db))[kind];
  const d = WORDING[kind];
  return { subject: s?.subject?.trim() || d.subject, message: s?.message?.trim() || d.message };
}

/** Every kind, for Settings. */
export async function listWording(db: Queryable) {
  const s = await saved(db);
  return WORDING_KINDS.map((k) => {
    const d = WORDING[k];
    const mine = s[k];
    return {
      kind: k, label: d.label, blanks: d.blanks,
      subject: mine?.subject?.trim() || d.subject,
      message: mine?.message?.trim() || d.message,
      standardSubject: d.subject, standardMessage: d.message,
      changed: !!(mine && ((mine.subject?.trim() && mine.subject.trim() !== d.subject)
        || (mine.message?.trim() && mine.message.trim() !== d.message))),
    };
  });
}

/** Save one kind's wording; null puts the standard wording back. */
export async function setWording(db: Db, actor: Actor, kind: WordingKind, w: Wording | null): Promise<void> {
  requireRole(actor, 'admin');
  if (!WORDING[kind]) throw new RuleViolation('there is no such kind of email');
  const all = await saved(db);
  if (w) {
    const subject = String(w.subject ?? '').replace(/[\r\n]+/g, ' ').trim();
    const message = String(w.message ?? '').replace(/\r\n/g, '\n').trim();
    if (!subject) throw new RuleViolation('the email needs a subject');
    if (!message) throw new RuleViolation('the email needs a message');
    if (subject.length > 250 || message.length > 10000) throw new RuleViolation('that wording is too long');
    all[kind] = { subject, message };
  } else {
    delete all[kind];
  }
  await db.tx(async (t) => {
    await t.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [KEY, JSON.stringify(all)],
    );
    await audit(t, actor, 'update', 'Settings', null, 'Email wording', {
      emailWording: WORDING[kind].label, reset: !w,
    });
  });
}

/** Puts each blank's value in. A blank with no value is left as it was typed. */
export function fillBlanks(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-z ]+)\}/gi, (whole, name: string) => {
    const v = values[`{${name.toLowerCase()}}`];
    return v === undefined ? whole : v;
  });
}

/* ------------------------------------------------------------------ */
/* The figures each blank stands for                                   */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayWords(d: unknown): string {
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}
export function money(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${neg ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-JM')}.${String(abs % 100).padStart(2, '0')}`;
}
function andList(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export interface StatementWindow { from?: string | null; to?: string | null }

/**
 * The values of the blanks for one email. Reads the records directly, so the
 * wording and the senders never depend on each other.
 */
export async function blankValues(
  db: Queryable, kind: WordingKind, ids: readonly string[], win: StatementWindow = {},
): Promise<Record<string, string>> {
  const who = async (customerId: string) => {
    const c = await db.maybeOne<{ name: string; contact_person: string | null }>(
      `SELECT name, contact_person FROM customers WHERE id = $1`, [customerId],
    );
    return { '{customer}': c?.name ?? '', '{contact}': c?.contact_person?.trim() || c?.name || '' };
  };
  switch (kind) {
    case 'invoice':
    case 'credit-note': {
      const r = await db.one<{
        customer_id: string; invoice_number: string; invoice_date: string; due_date: string | null;
        grand_total_cents: number; balance_cents: number;
      }>(
        `SELECT customer_id, invoice_number, invoice_date::text AS invoice_date, due_date::text AS due_date,
                grand_total_cents, balance_cents
         FROM invoice_ledger WHERE invoice_id = $1`, [ids[0]],
      );
      return {
        ...(await who(r.customer_id)),
        '{number}': r.invoice_number,
        '{amount}': money(Math.abs(num(r.grand_total_cents))),
        '{to pay}': num(r.balance_cents) > 0 ? money(num(r.balance_cents)) : money(0),
        '{due date}': r.due_date ? dayWords(r.due_date) : 'on receipt',
        '{invoice date}': dayWords(r.invoice_date),
        '{date}': dayWords(r.invoice_date),
      };
    }
    case 'invoices': {
      const rows = await db.query<{ customer_id: string; invoice_number: string; balance_cents: number }>(
        `SELECT customer_id, invoice_number, balance_cents FROM invoice_ledger
         WHERE invoice_id = ANY($1::uuid[]) ORDER BY invoice_date, invoice_number`, [[...ids]],
      );
      if (rows.length === 0) throw new RuleViolation('those invoices no longer exist');
      return {
        ...(await who(rows[0].customer_id)),
        '{numbers}': andList(rows.map((r) => r.invoice_number)),
        '{count}': String(rows.length),
        '{to pay}': money(rows.reduce((a, r) => a + Math.max(num(r.balance_cents), 0), 0)),
      };
    }
    case 'statement': {
      const customerId = ids[0];
      const owed = await db.one<{ balance_cents: number; overdue_cents: number }>(
        `SELECT COALESCE((SELECT balance_cents FROM customer_balances WHERE customer_id = $1), 0)::bigint AS balance_cents,
                COALESCE((SELECT SUM(balance_cents) FROM invoice_ledger
                          WHERE customer_id = $1 AND NOT is_credit_note AND status <> 'Cancelled'
                            AND balance_cents > 0 AND due_date < business_today()), 0)::bigint AS overdue_cents`,
        [customerId],
      );
      const period = win.from && win.to ? `${dayWords(win.from)} to ${dayWords(win.to)}`
        : win.to ? `up to ${dayWords(win.to)}` : win.from ? `from ${dayWords(win.from)}` : 'to date';
      return {
        ...(await who(customerId)),
        '{balance}': money(num(owed.balance_cents)),
        '{past due}': money(num(owed.overdue_cents)),
        '{period}': period,
      };
    }
    case 'quote': {
      const q = await db.one<{ customer_id: string; quote_number: string; grand_total_cents: number; valid_until: string | null }>(
        `SELECT customer_id, quote_number, grand_total_cents, valid_until::text AS valid_until FROM quotations WHERE id = $1`, [ids[0]],
      );
      return {
        ...(await who(q.customer_id)),
        '{number}': q.quote_number, '{amount}': money(num(q.grand_total_cents)),
        '{valid until}': q.valid_until ? dayWords(q.valid_until) : 'ask us',
      };
    }
    case 'receipt': {
      const rows = await db.query<{ customer_id: string; receipt_number: string | null; amount_cents: number; day: string }>(
        `SELECT customer_id, receipt_number, amount_cents, business_date(payment_date)::text AS day
         FROM payments WHERE id = ANY($1::uuid[]) ORDER BY payment_date`, [[...ids]],
      );
      if (rows.length === 0) throw new RuleViolation('those payments no longer exist');
      const numbers = [...new Set(rows.map((r) => r.receipt_number).filter(Boolean) as string[])];
      return {
        ...(await who(rows[0].customer_id)),
        '{number}': andList(numbers),
        '{amount}': money(rows.reduce((a, r) => a + num(r.amount_cents), 0)),
        '{date}': dayWords(rows[0].day),
      };
    }
    case 'purchase-order': {
      const p = await db.one<{ po_number: string; grand_total_cents: number; expected_delivery_date: string | null;
                               name: string; contact_person: string | null }>(
        `SELECT po.po_number, po.grand_total_cents, po.expected_delivery_date::text AS expected_delivery_date,
                s.name, s.contact_person
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [ids[0]],
      );
      return {
        '{supplier}': p.name, '{contact}': p.contact_person?.trim() || p.name,
        '{number}': p.po_number, '{amount}': money(num(p.grand_total_cents)),
        '{required by}': p.expected_delivery_date ? dayWords(p.expected_delivery_date) : 'as soon as possible',
      };
    }
    case 'order': {
      const o = await db.one<{ customer_id: string; order_number: string; requested_delivery_date: string | null }>(
        `SELECT customer_id, order_number, requested_delivery_date::text AS requested_delivery_date
         FROM customer_orders WHERE id = $1`, [ids[0]],
      );
      return {
        ...(await who(o.customer_id)),
        '{number}': o.order_number,
        '{delivery date}': o.requested_delivery_date ? dayWords(o.requested_delivery_date) : 'your next delivery day',
      };
    }
  }
}

/** The subject and message for one email, blanks filled in. */
export async function filledWording(
  db: Queryable, kind: WordingKind, ids: readonly string[], win: StatementWindow = {},
): Promise<Wording> {
  const w = await wordingFor(db, kind);
  const v = await blankValues(db, kind, ids, win);
  return { subject: fillBlanks(w.subject, v), message: fillBlanks(w.message, v) };
}
