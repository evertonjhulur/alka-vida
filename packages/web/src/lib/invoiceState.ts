import { date, todayInJamaica } from './format';

/**
 * Where an invoice stands, in the same words as a customer's statement
 * (Open, Paid, Partially paid, Overdue), plus Sent, Cancelled and Credit
 * note. One place, so the Invoices screen and the customer's Invoices tab
 * filter and label alike (Everton, 11 Oct 2026).
 *
 * Overdue wins over Partially paid: part paid and past due is still late.
 */
export interface InvoiceLike {
  status: string;
  lifecycle?: string | null;
  is_credit_note?: boolean | null;
  due_date?: string | null;
  balance_cents: number | string;
  amount_paid_cents?: number | string | null;
}

export type InvoiceState = 'Open' | 'Sent' | 'Overdue' | 'Partially paid' | 'Paid' | 'Cancelled' | 'Credit note';

export function invoiceState(r: InvoiceLike, today = todayInJamaica()): InvoiceState {
  if (r.status === 'Cancelled' || r.lifecycle === 'Cancelled') return 'Cancelled';
  if (r.is_credit_note || r.status === 'Credit Note') return 'Credit note';
  const bal = Number(r.balance_cents);
  if (bal <= 0) return 'Paid';
  if (r.due_date && date(r.due_date) < today) return 'Overdue';
  if (Number(r.amount_paid_cents ?? 0) > 0 || r.status === 'Partial') return 'Partially paid';
  if (r.lifecycle === 'Sent' || r.status === 'Sent') return 'Sent';
  return 'Open';
}

export const STATE_TONE: Record<InvoiceState, string> = {
  Open: 'info', Sent: 'info', Overdue: 'bad', 'Partially paid': 'warn', Paid: 'ok', Cancelled: 'muted', 'Credit note': 'neutral',
};

/** The Status drop-down: the statement's choices first. */
export const INVOICE_FILTERS = [
  ['', 'Any status'],
  ['open', 'Open (still owed)'],
  ['overdue', 'Overdue'],
  ['partial', 'Partially paid'],
  ['paid', 'Paid'],
  ['sent', 'Sent, not yet paid'],
  ['credit', 'Credit notes'],
  ['cancelled', 'Cancelled'],
] as const;

export function invoiceMatches(r: InvoiceLike, filter: string, today = todayInJamaica()): boolean {
  if (!filter) return true;
  const s = invoiceState(r, today);
  const owed = s === 'Open' || s === 'Sent' || s === 'Overdue' || s === 'Partially paid';
  switch (filter) {
    case 'open': return owed;
    case 'overdue': return s === 'Overdue';
    case 'partial': return owed && Number(r.amount_paid_cents ?? 0) > 0;
    case 'paid': return s === 'Paid';
    case 'sent': return owed && (r.lifecycle === 'Sent' || r.status === 'Sent');
    case 'credit': return s === 'Credit note';
    case 'cancelled': return s === 'Cancelled';
    default: return true;
  }
}
