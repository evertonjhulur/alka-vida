/**
 * One list of a customer's money: invoices, payments and credit notes, with
 * the running balance (Everton, 12 Oct 2026: the customer page shows "just
 * the transaction history showing invoices and monies received", QuickBooks
 * style, in place of the separate invoices list and statement).
 *
 * Pure: no imports, so the test runner can load it as it is.
 *
 * What counts towards the balance is what the statement counts: every
 * invoice that is not cancelled, credit notes once approved, every confirmed
 * payment (a reversal is stored negated, so it adds back what was taken
 * off). A payment spread over several invoices is several rows sharing one
 * number; here it is one line.
 */

export interface TxInvoice {
  invoice_id: string; invoice_number: string; invoice_date: string; due_date: string | null;
  status: string; lifecycle?: string | null; grand_total_cents: number | string;
  amount_paid_cents?: number | string | null; balance_cents: number | string;
  is_credit_note: boolean; credit_status?: string | null; notes?: string | null;
  order_numbers?: string | null;
}

export interface TxPayment {
  id: string; payment_date: string; amount_cents: number | string; method: string | null;
  reference: string | null; receipt_number: string | null; invoice_id: string | null;
  invoice_number: string | null; is_credit_note?: boolean | null; is_reversal: boolean;
  reversed: boolean; order_number?: string | null;
}

export type TxKind = 'invoice' | 'credit' | 'payment' | 'reversal';

export interface Tx {
  key: string;
  kind: TxKind;
  /** YYYY-MM-DD */
  date: string;
  number: string;
  /** What it does to what they owe: + an invoice or a reversal, - a payment or credit note. */
  effectCents: number;
  /** The figure shown as the amount: always positive. */
  amountCents: number;
  /** An invoice: still owed on it. A payment: the part not against any invoice. */
  openCents: number;
  /** In the balance (a cancelled invoice and a credit note waiting for approval are not). */
  counts: boolean;
  /** The balance after this line, oldest first; null when it does not count. */
  balanceCents: number | null;
  invoice?: TxInvoice;
  /** Every row of the payment (or reversal). */
  rows?: TxPayment[];
  /** Payments: the invoices it went against. */
  invoiceNumbers?: string[];
  /** Payments: none, some or all of it reversed. */
  reversed?: 'none' | 'part' | 'all';
  method?: string | null;
  reference?: string | null;
  orderNumbers?: string[];
}

const cents = (v: number | string | null | undefined) => Number(v ?? 0) || 0;
const ORDER: Record<TxKind, number> = { invoice: 0, credit: 1, payment: 2, reversal: 3 };

/**
 * `day` turns a date or timestamp from the server into YYYY-MM-DD in
 * Jamaica (the page passes its `date` helper); the default takes the first
 * ten characters.
 */
export function buildTransactions(
  invoices: readonly TxInvoice[],
  payments: readonly TxPayment[],
  day: (v: string) => string = (v) => String(v).slice(0, 10),
): Tx[] {
  const out: Tx[] = [];

  for (const i of invoices) {
    const total = cents(i.grand_total_cents);
    const cancelled = i.status === 'Cancelled' || i.lifecycle === 'Cancelled';
    if (i.is_credit_note) {
      const approved = !i.credit_status || i.credit_status === 'Approved';
      out.push({
        key: `i:${i.invoice_id}`, kind: 'credit', date: day(i.invoice_date), number: i.invoice_number,
        effectCents: total, amountCents: Math.abs(total), openCents: 0,
        counts: !cancelled && approved, balanceCents: null, invoice: i,
      });
    } else {
      out.push({
        key: `i:${i.invoice_id}`, kind: 'invoice', date: day(i.invoice_date), number: i.invoice_number,
        effectCents: total, amountCents: total, openCents: cancelled ? 0 : Math.max(cents(i.balance_cents), 0),
        counts: !cancelled, balanceCents: null, invoice: i,
        orderNumbers: i.order_numbers ? i.order_numbers.split(', ') : [],
      });
    }
  }

  // Payments: one line per number; reversals on their own line.
  const groups = new Map<string, TxPayment[]>();
  for (const p of payments) {
    const k = `${p.is_reversal ? 'r' : 'p'}:${p.receipt_number ?? p.id}`;
    const g = groups.get(k);
    if (g) g.push(p); else groups.set(k, [p]);
  }
  for (const [k, rows] of groups) {
    const reversal = rows[0].is_reversal;
    const sum = rows.reduce((a, p) => a + cents(p.amount_cents), 0);
    const date = rows.map((p) => day(p.payment_date)).sort()[0];
    const invoiceNumbers = [...new Set(rows.filter((p) => p.invoice_number).map((p) => p.invoice_number!))].sort();
    const orders = [...new Set(rows.filter((p) => p.order_number).map((p) => p.order_number!))];
    const nReversed = rows.filter((p) => p.reversed).length;
    out.push({
      key: k, kind: reversal ? 'reversal' : 'payment', date,
      number: rows[0].receipt_number ?? '',
      effectCents: -sum, amountCents: Math.abs(sum),
      openCents: reversal ? 0 : rows.filter((p) => !p.invoice_id && !p.reversed)
        .reduce((a, p) => a + Math.max(cents(p.amount_cents), 0), 0),
      counts: true, balanceCents: null, rows, invoiceNumbers,
      reversed: reversal ? 'none' : nReversed === 0 ? 'none' : nReversed === rows.length ? 'all' : 'part',
      method: rows[0].method, reference: rows.find((p) => p.reference)?.reference ?? null,
      orderNumbers: orders,
    });
  }

  // Oldest first: the date, then invoices before credit notes before
  // payments before reversals, then the number.
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : ORDER[a.kind] - ORDER[b.kind] || a.number.localeCompare(b.number)));
  let bal = 0;
  for (const t of out) {
    if (!t.counts) continue;
    bal += t.effectCents;
    t.balanceCents = bal;
  }
  return out;
}

/** The balance after everything: what they owe (negative: in credit). */
export function closingBalance(txs: readonly Tx[]): number {
  return txs.reduce((a, t) => a + (t.counts ? t.effectCents : 0), 0);
}
