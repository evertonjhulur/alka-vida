/**
 * The payment ⋯ menu (Everton, 4 Nov 2026), the same on the Payments screen
 * and the customer's Transactions tab: View receipt, Edit payment, Move to
 * another customer, Reverse, Delete (red, last).
 *
 * Each acts on the WHOLE payment (its RCT number), even when it was spread
 * over several invoices. An administrator's action applies at once; office
 * staff send it to Needs a decision. Edit, Move and Delete leave no note on
 * the account: the audit log is the record. API: /api/payments/:id/fix.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, getSession, openPdfPost } from '../lib/api';
import { money, toCents, todayInJamaica, when } from '../lib/format';
import { payMethods, useTakeCard } from '../lib/payments';
import CustomerPicker, { type PickerCustomer } from './CustomerPicker';

export type PaymentAction = 'edit' | 'move' | 'reverse' | 'delete';

const METHODS = ['Cash', 'Cheque', 'Bank Transfer', 'Card'] as const;

/** The ⋯ button and its menu, for one payment row. */
export function PaymentMenu({
  paymentId, receipt, open, onToggle, onPick, onReceipt,
}: {
  paymentId: string;
  receipt: string | null;
  open: boolean;
  onToggle: () => void;
  onPick: (action: PaymentAction) => void;
  onReceipt: () => void;
}) {
  const item = (label: string, run: () => void, danger = false) => (
    <button role="menuitem" type="button" className={`pop-item pop-button${danger ? ' pop-danger' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggle(); run(); }}>{label}</button>
  );
  return (
    <span className="deskbar-menu" data-payment={paymentId}>
      <button type="button" className="secondary more-button" aria-label={`More for ${receipt ?? 'this payment'}`}
              aria-haspopup="true" aria-expanded={open}
              onClick={(e) => { e.stopPropagation(); onToggle(); }}>⋯</button>
      {open && (
        <div className="deskbar-pop deskbar-pop-right row-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {item('View receipt', onReceipt)}
          {item('Edit payment…', () => onPick('edit'))}
          {item('Move to another customer…', () => onPick('move'))}
          {item('Reverse…', () => onPick('reverse'))}
          {item('Delete…', () => onPick('delete'), true)}
        </div>
      )}
    </span>
  );
}

/** Close an open ⋯ menu on any click elsewhere. */
export function useCloseOnClick(open: string | null, close: () => void) {
  useEffect(() => {
    if (!open) return;
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Open the whole payment's receipt in a new tab. */
export function viewPaymentReceipt(paymentId: string, receipt: string | null) {
  return openPdfPost('/api/receipts.pdf', { paymentIds: [paymentId] }, `Receipt-${receipt ?? 'payment'}.pdf`);
}

interface Info {
  paymentId: string; receiptNumber: string | null; customerId: string; customerName: string;
  paymentDate: string; method: string; reference: string | null; totalCents: number;
  lines: Array<{ id: string; invoiceId: string | null; invoiceNumber: string | null; amountCents: number }>;
  settledRound: string | null; receiptEmailedTo: string | null; waiting: boolean;
}
interface OpenInvoice {
  invoice_id: string; invoice_number: string; invoice_date: string; balance_cents: number | string;
  is_credit_note: boolean; status: string;
}

const TITLE: Record<PaymentAction, string> = {
  edit: 'Edit payment', move: 'Move to another customer', reverse: 'Reverse payment', delete: 'Delete payment',
};

/**
 * The panel for one action. Shown above the list; `onDone` gets the message
 * to show and should reload the list.
 */
export function PaymentFixPanel({
  paymentId, action, onDone, onClose, onSwitch,
}: {
  paymentId: string;
  action: PaymentAction;
  onDone: (message: string) => void;
  onClose: () => void;
  onSwitch: (action: PaymentAction) => void;
}) {
  const isAdmin = getSession()?.role === 'admin';
  const takeCard = useTakeCard();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  // Edit
  const [amount, setAmount] = useState('');
  const [payDate, setPayDate] = useState('');
  const [method, setMethod] = useState('Cash');
  const [reference, setReference] = useState('');
  // Edit and Move: the invoices it pays (invoiceId -> amount text) and whether they were touched.
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [allocTouched, setAllocTouched] = useState(false);
  // Move
  const [customers, setCustomers] = useState<PickerCustomer[]>([]);
  const [target, setTarget] = useState('');
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);

  useEffect(() => {
    setInfo(null); setError(null); setReason(''); setTarget(''); setAllocTouched(false);
    api.get<Info>(`/api/payments/${paymentId}/fix`).then((i) => {
      setInfo(i);
      setAmount((i.totalCents / 100).toFixed(2));
      setPayDate(i.paymentDate);
      setMethod(i.method);
      setReference(i.reference ?? '');
      const a: Record<string, string> = {};
      for (const l of i.lines) if (l.invoiceId) a[l.invoiceId] = ((Number(a[l.invoiceId] ?? 0) * 100 + l.amountCents) / 100).toFixed(2);
      setAlloc(action === 'edit' ? a : {});
    }).catch((e) => setError(e instanceof Error ? e.message : 'Could not open the payment'));
    if (action === 'move') api.get<PickerCustomer[]>('/api/customers').then(setCustomers).catch(() => {});
  }, [paymentId, action]);

  // The open invoices of the customer the money will sit on.
  const invoiceCustomer = action === 'move' ? target : info?.customerId ?? '';
  useEffect(() => {
    if (!invoiceCustomer || (action !== 'edit' && action !== 'move')) { setInvoices([]); return; }
    api.get<OpenInvoice[]>(`/api/invoices?customerId=${invoiceCustomer}`)
      .then((rows) => setInvoices(rows.filter((i) => !i.is_credit_note && i.status !== 'Cancelled')
        .sort((x, y) => (x.invoice_date + x.invoice_number).localeCompare(y.invoice_date + y.invoice_number))))
      .catch(() => setInvoices([]));
    if (action === 'move') { setAlloc({}); setAllocTouched(false); }
  }, [invoiceCustomer, action]);

  /** What an invoice owes, as if this payment were not on it. */
  const owes = (i: OpenInvoice) => Number(i.balance_cents)
    + (action === 'edit' ? (info?.lines ?? []).filter((l) => l.invoiceId === i.invoice_id).reduce((n, l) => n + l.amountCents, 0) : 0);
  const shown = invoices.filter((i) => owes(i) > 0 || alloc[i.invoice_id] !== undefined);

  const totalCents = action === 'edit' ? toCents(amount || '0') : info?.totalCents ?? 0;
  const pickedCents = Object.values(alloc).reduce((n, v) => n + toCents(v || '0'), 0);
  const leftCents = totalCents - pickedCents;

  // Edit: a new amount refills the invoices: the ones it pays now first, then
  // the other open invoices, oldest first. Each can still be changed.
  function changeAmount(v: string) {
    setAmount(v);
    if (!info) return;
    let left = toCents(v || '0');
    const now = new Set(info.lines.map((l) => l.invoiceId).filter(Boolean));
    const order = [...invoices.filter((i) => now.has(i.invoice_id)), ...invoices.filter((i) => !now.has(i.invoice_id))];
    const next: Record<string, string> = {};
    for (const i of order) {
      if (left <= 0) break;
      const take = Math.min(owes(i), left);
      if (take > 0) { next[i.invoice_id] = (take / 100).toFixed(2); left -= take; }
    }
    setAlloc(next);
    setAllocTouched(true);
  }

  function tick(i: OpenInvoice, on: boolean) {
    setAllocTouched(true);
    setAlloc((prev) => {
      const next = { ...prev };
      if (!on) { delete next[i.invoice_id]; return next; }
      const others = Object.entries(next).reduce((n, [, v]) => n + toCents(v || '0'), 0);
      const room = Math.max(totalCents - others, 0);
      next[i.invoice_id] = (Math.min(owes(i), room) / 100).toFixed(2);
      return next;
    });
  }

  const allocations = () => Object.entries(alloc)
    .filter(([, v]) => toCents(v || '0') > 0)
    .map(([invoiceId, v]) => ({ invoiceId, amountCents: toCents(v) }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!info) return;
    let fix: Record<string, unknown>;
    if (action === 'edit') {
      fix = { action: 'edit' };
      if (toCents(amount) !== info.totalCents) fix.amountCents = toCents(amount);
      if (payDate && payDate !== info.paymentDate) fix.paymentDate = payDate;
      if (method !== info.method) fix.method = method;
      if (reference !== (info.reference ?? '')) fix.reference = reference;
      if (allocTouched || fix.amountCents !== undefined) fix.allocations = allocations();
      if (Object.keys(fix).length === 1) { setError('Nothing was changed.'); return; }
    } else if (action === 'move') {
      if (!target) { setError('Choose the customer to move it to.'); return; }
      fix = { action: 'move', customerId: target, allocations: allocations() };
    } else {
      fix = { action };
    }
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ applied: boolean }>(`/api/payments/${paymentId}/fix`, { fix, reason: reason || null });
      const name = info.receiptNumber ?? 'The payment';
      const did = { edit: 'changed', move: 'moved', reverse: 'reversed', delete: 'deleted' }[action];
      onDone(r.applied ? `${name} ${did}.`
        : `Sent to an administrator under Needs a decision. Nothing changes until it is approved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  const needsReason = action === 'reverse' || action === 'delete';
  const go = isAdmin
    ? { edit: 'Save changes', move: 'Move it', reverse: 'Reverse it', delete: 'Delete it' }[action]
    : 'Send for approval';

  return (
    <div className="panel" id="payment-fix">
      <form onSubmit={submit}>
        <h2 style={{ marginTop: 0 }}>
          {TITLE[action]}{info ? ` ${info.receiptNumber ?? ''}` : ''}
        </h2>
        {error && <div className="notice error">{error}</div>}
        {!info && !error && <p className="muted">Opening the payment…</p>}
        {info && (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {money(info.totalCents)} {info.method === 'Bank Transfer' ? 'bank transfer' : info.method.toLowerCase()} from{' '}
              <strong>{info.customerName}</strong> on {when(info.paymentDate)}
              {info.reference ? ` · ${info.reference}` : ''} ·{' '}
              {info.lines.map((l) => `${money(l.amountCents)} ${l.invoiceNumber ? `on ${l.invoiceNumber}` : 'as credit'}`).join(', ')}
            </p>
            {info.waiting && (
              <div className="notice warn">A change to this payment is already waiting for an administrator.</div>
            )}

            {action === 'edit' && (
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <div className="field">
                  <label htmlFor="pf-amt">Amount</label>
                  <input id="pf-amt" type="number" step="0.01" min="0.01" style={{ width: 140 }} value={amount}
                         onChange={(e) => changeAmount(e.target.value)} required />
                </div>
                <div className="field">
                  <label htmlFor="pf-date">Date paid</label>
                  <input id="pf-date" type="date" max={todayInJamaica()} value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="pf-m">How</label>
                  <select id="pf-m" value={method} onChange={(e) => setMethod(e.target.value)}>
                    {payMethods(METHODS, takeCard, method).map((m) => <option key={m} value={m}>{m === 'Bank Transfer' ? 'Bank transfer' : m}</option>)}
                  </select>
                </div>
                <div className="field" style={{ flex: '1 1 160px' }}>
                  <label htmlFor="pf-ref">Reference</label>
                  <input id="pf-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
              </div>
            )}

            {action === 'move' && (
              <div className="field">
                <label htmlFor="pf-cust">Move it to</label>
                <CustomerPicker id="pf-cust" customers={customers.filter((c) => c.id !== info.customerId && !(c as { is_walk_in?: boolean }).is_walk_in)}
                                value={target} onChange={setTarget} placeholder="Type the customer's name or phone" />
              </div>
            )}

            {(action === 'edit' || (action === 'move' && target)) && (
              <div className="field">
                <label>What it pays</label>
                {shown.length === 0 ? (
                  <p className="muted small" style={{ margin: 0 }}>No open invoices. It stays as credit on the account.</p>
                ) : (
                  <table className="orders-table compact">
                    <tbody>
                      {shown.map((i) => {
                        const on = alloc[i.invoice_id] !== undefined;
                        return (
                          <tr key={i.invoice_id}>
                            <td className="tick-col">
                              <input type="checkbox" checked={on} aria-label={`Pay ${i.invoice_number}`}
                                     onChange={(e) => tick(i, e.target.checked)} />
                            </td>
                            <td>{i.invoice_number} <span className="muted small">· {when(i.invoice_date)} · owes {money(owes(i))}</span></td>
                            <td className="num">
                              {on && (
                                <input type="number" step="0.01" min="0" style={{ width: 120 }} value={alloc[i.invoice_id]}
                                       aria-label={`Amount on ${i.invoice_number}`}
                                       onChange={(e) => { setAllocTouched(true); setAlloc({ ...alloc, [i.invoice_id]: e.target.value }); }} />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {shown.length > 0 && <p className={`small ${leftCents < 0 ? 'bad-text' : 'muted'}`} style={{ margin: '6px 0 0' }}>
                  {action === 'move' && pickedCents === 0
                    ? 'None picked: it goes on their oldest open invoices first; anything left stays as credit.'
                    : leftCents < 0
                      ? `The invoices add up to ${money(-leftCents)} more than the payment.`
                      : leftCents > 0 ? `${money(leftCents)} stays as credit on the account.` : 'All of it goes on the invoices ticked.'}
                </p>}
              </div>
            )}

            {action === 'reverse' && (
              <p className="small">
                The payment and its reversal both stay on {info.customerName}'s account. The invoices it paid owe again.
              </p>
            )}

            {action === 'delete' && (
              <>
                <p className="small">
                  The payment disappears from the account, the Payments list and the reports.
                  {info.lines.some((l) => l.invoiceId) ? ' The invoices it paid owe again.' : ''} Only the audit log
                  keeps a record, and {info.receiptNumber ?? 'its number'} is not used again.
                </p>
                {(info.receiptEmailedTo || info.settledRound) && (
                  <div className="notice warn">
                    {info.receiptEmailedTo && <div>The receipt was emailed to {info.receiptEmailedTo}, so the customer knows of it.</div>}
                    {info.settledRound && <div>It is part of the cash of the settled {info.settledRound}; deleting it makes the round look short.</div>}
                    <div style={{ marginTop: 6 }}>
                      Reversing keeps both on record.{' '}
                      <button type="button" className="as-link" onClick={() => onSwitch('reverse')}>Reverse it instead</button>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="field">
              <label htmlFor="pf-why">{needsReason ? 'Why?' : 'Why? (optional, kept in the audit log)'}</label>
              <input id="pf-why" style={{ width: '100%' }} value={reason} required={needsReason}
                     onChange={(e) => setReason(e.target.value)} />
            </div>
            {!isAdmin && (
              <p className="muted small">An administrator approves this under Needs a decision before anything changes.</p>
            )}
          </>
        )}
        <div className="row" style={{ gap: 8 }}>
          {info && (
            <button className={action === 'delete' || action === 'reverse' ? 'danger-soft' : undefined}
                    disabled={busy || info.waiting || (needsReason && !reason.trim()) || (action === 'move' && !target) || leftCents < 0}>
              {go}
            </button>
          )}
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

/** For lists: which payment's menu is open and which panel is showing. */
export function usePaymentFix() {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ id: string; action: PaymentAction } | null>(null);
  useCloseOnClick(menuFor, () => setMenuFor(null));
  return useMemo(() => ({
    menuFor, panel,
    toggle: (id: string) => setMenuFor((m) => (m === id ? null : id)),
    pick: (id: string, action: PaymentAction) => {
      setPanel({ id, action });
      setTimeout(() => document.getElementById('payment-fix')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    },
    close: () => setPanel(null),
  }), [menuFor, panel]);
}
