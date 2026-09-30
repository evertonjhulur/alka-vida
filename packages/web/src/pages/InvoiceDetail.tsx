import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download, type Session } from '../lib/api';
import { money, toCents, date, day, time, statusTone } from '../lib/format';
import Logo from '../components/Logo';

/**
 * One invoice, laid out the way the customer receives it, with what can be
 * done about it beside (approved mockup, 29 Sep 2026): money already on
 * their account and a one-click "Apply here", what has happened to it so
 * far, and the three ways to put something right. Nothing uses browser
 * pop-ups; each action opens a panel under the header.
 */

interface Line {
  id: string; product_id: string; product_name: string; cases: number;
  loose_bottles: number; bottles_per_case: number; line_total_cents: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
}
interface Payment {
  id: string; amount_cents: number; payment_date: string; method: string;
  status: string; is_reversal: boolean; reference: string | null;
  reverses_payment_id?: string | null;
}
interface CustomerRef {
  id: string; name: string; email: string | null; phone: string | null;
  delivery_address: string | null; payment_terms: string | null;
  delivery_zone: string | null; address_line1?: string | null; address_line2?: string | null;
  city?: string | null; parish?: string | null; contact_person?: string | null;
}
interface OrderRef {
  id: string; order_number: string; delivery_mode: string;
  order_date: string; requested_delivery_date: string | null; status: string;
}
interface Delivery {
  zone: string; delivery_date: string; driver_name: string | null; driver_user_name: string | null;
  bottles_delivered_full: number; bottles_empties_picked_up: number; bottles_lost_damaged: number;
}
interface CreditNote {
  id: string; invoice_number: string; grand_total_cents: number; credit_status: string; created_at: string;
}
interface HistoryRow {
  ts: string; user_name: string | null; action: string; details: Record<string, unknown>;
}
interface Invoice {
  invoiceId: string; invoiceNumber: string; customerId: string;
  invoice_date: string; due_date: string | null; sent_date: string | null; lifecycle: string;
  created_at: string;
  subtotal_cents: number; discount_amount_cents: number; discount_status: string;
  discount_percent: number; is_credit_note: boolean;
  gct_cents: number; grandTotalCents: number; amountPaidCents: number;
  balanceCents: number; status: string; lines: Line[]; payments: Payment[];
  // Optional on purpose: an older server does not send these, and a screen
  // that assumes them turns a version mismatch into a blank page.
  customer?: CustomerRef; orders?: OrderRef[];
  delivery?: Delivery | null; creditNotes?: CreditNote[]; history?: HistoryRow[];
  onAccountCents?: number;
}

type Panel = 'pay' | 'email' | 'edit' | 'discount' | 'credit' | null;

const METHODS = ['Cash', 'Card', 'Bank Transfer', 'Cheque', 'Other'] as const;

const qtyText = (l: Line) => (Number(l.bottles_per_case) > 0
  ? `${l.cases} ${Number(l.cases) === 1 ? 'case' : 'cases'} of ${l.bottles_per_case}`
  : `${l.loose_bottles} ${Number(l.loose_bottles) === 1 ? 'bottle' : 'bottles'}`);
const unitPrice = (l: Line) => (Number(l.bottles_per_case) > 0
  ? Number(l.price_per_case_cents) : Number(l.price_per_bottle_cents));

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Jamaica' });
  return Math.round((Date.parse(`${date(iso)}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
}

export default function InvoiceDetail({ session }: { session: Session }) {
  const { invoiceId } = useParams();
  const isAdmin = session.role === 'admin';
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mailReady, setMailReady] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pay, setPay] = useState({ amount: '', method: 'Cash', reference: '' });
  const [mailTo, setMailTo] = useState('');
  const [disc, setDisc] = useState({ percent: '', reason: '' });
  const [credit, setCredit] = useState({ amount: '', reason: '' });
  const [edit, setEdit] = useState<{ discount: string; reason: string; qty: Record<string, string> }>(
    { discount: '', reason: '', qty: {} });
  const [reversing, setReversing] = useState<{ id: string; reason: string } | null>(null);

  async function load() { setInv(await api.get<Invoice>(`/api/invoices/${invoiceId}`)); }
  useEffect(() => { load().catch((e) => setError(e.message)); }, [invoiceId]);
  useEffect(() => {
    api.get<{ configured: boolean }>('/api/settings/mail')
      .then((r) => setMailReady(r.configured)).catch(() => setMailReady(false));
  }, []);
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [moreOpen]);

  if (error && !inv) return <div className="notice error">{error}</div>;
  if (!inv) return <p className="muted">Loading…</p>;
  const i = inv;

  async function act(what: () => Promise<string>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try {
      setMsg(await what());
      setPanel(null);
      setReversing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally { setBusy(false); }
  }

  const open = (p: Panel) => {
    setMoreOpen(false); setError(null);
    if (p === panel) { setPanel(null); return; }
    if (p === 'pay') setPay({ amount: (i.balanceCents / 100).toFixed(2), method: 'Cash', reference: '' });
    if (p === 'email') setMailTo(i.customer?.email ?? '');
    if (p === 'discount') setDisc({ percent: '', reason: '' });
    if (p === 'credit') setCredit({ amount: '', reason: '' });
    if (p === 'edit') {
      setEdit({
        discount: String(Number(i.discount_percent) || 0), reason: '',
        qty: Object.fromEntries(i.lines.map((l) => [
          l.id, String(Number(l.bottles_per_case) > 0 ? l.cases : l.loose_bottles)])),
      });
    }
    setPanel(p);
  };

  /** The document, as the customer would receive it. */
  async function downloadPdf() {
    setBusy(true); setError(null);
    try {
      await download(`/api/invoices/${i.invoiceId}/pdf`, `${i.invoiceNumber}.pdf`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download the invoice');
    } finally { setBusy(false); }
  }

  const sendEmail = () => act(async () => {
    const out = await api.post<{ sentTo: string }>(`/api/invoices/${i.invoiceId}/email`, { to: mailTo.trim() });
    return `${i.invoiceNumber} sent to ${out.sentTo}.`;
  }, 'Could not send the invoice');

  const recordPayment = () => act(async () => {
    const cents = toCents(pay.amount);
    const toThis = Math.min(cents, Math.max(i.balanceCents, 0));
    await api.post('/api/payments/receive', {
      customerId: i.customerId, amountCents: cents, method: pay.method,
      reference: pay.reference || null,
      allocations: toThis > 0 ? [{ invoiceId: i.invoiceId, amountCents: toThis }] : [],
    });
    return cents > toThis
      ? `${money(cents)} received: ${money(toThis)} against ${i.invoiceNumber}, ${money(cents - toThis)} left on their account.`
      : `${money(cents)} received against ${i.invoiceNumber}.`;
  }, 'Could not record the payment');

  const applyHere = (cents: number) => act(async () => {
    const r = await api.post<{ appliedCents: number }>(
      `/api/invoices/${i.invoiceId}/apply-on-account`, { amountCents: cents });
    return `${money(r.appliedCents)} from their account put against ${i.invoiceNumber}.`;
  }, 'Could not apply the money');

  const requestDiscount = () => act(async () => {
    const r = await api.post<{ appliedImmediately?: boolean }>(`/api/invoices/${i.invoiceId}/discount`, {
      discountPercent: Number(disc.percent), reason: disc.reason.trim(),
    });
    return r.appliedImmediately
      ? `${disc.percent}% discount given on ${i.invoiceNumber}.`
      : `${disc.percent}% discount asked for. It is in Needs a decision; the balance stays as it is until approved.`;
  }, 'Could not record the discount');

  const raiseCredit = () => act(async () => {
    const r = await api.post<{ invoiceNumber?: string; approvalRequestId?: string | null }>(
      `/api/invoices/${i.invoiceId}/credit-note`,
      { amountCents: toCents(credit.amount), reason: credit.reason.trim() });
    return r.approvalRequestId
      ? `Credit note for ${money(toCents(credit.amount))} raised and waiting in Needs a decision.`
      : `Credit note ${r.invoiceNumber ?? ''} for ${money(toCents(credit.amount))} raised.`;
  }, 'Could not raise the credit note');

  /** Admin only. Editing an issued invoice always demands a reason. */
  const saveEdit = () => act(async () => {
    await api.patch(`/api/invoices/${i.invoiceId}`, {
      discountPercent: Number(edit.discount) || 0,
      reason: edit.reason,
      lines: i.lines.map((l) => {
        const typed = Number(edit.qty[l.id]);
        const qty = Number.isFinite(typed) ? typed
          : Number(l.bottles_per_case) > 0 ? Number(l.cases) : Number(l.loose_bottles);
        return {
          productId: l.product_id,
          cases: Number(l.bottles_per_case) > 0 ? qty : 0,
          looseBottles: Number(l.bottles_per_case) > 0 ? 0 : qty,
          pricePerCaseCents: Number(l.price_per_case_cents),
          pricePerBottleCents: Number(l.price_per_bottle_cents),
        };
      }),
    });
    return 'Invoice changed. The change is recorded against your name.';
  }, 'Could not change the invoice');

  const reverse = () => act(async () => {
    await api.post(`/api/payments/${reversing!.id}/reverse`, { reason: reversing!.reason || undefined });
    return 'Payment reversed. The original stays visible beside its reversal.';
  }, 'Could not reverse');

  // ---- words for the header and the timeline ----
  const order = i.orders?.[0];
  const mode = order?.delivery_mode;
  const dueIn = daysUntil(i.due_date);
  const statusWords = i.is_credit_note ? 'Credit note'
    : i.status === 'Paid' ? 'Paid'
      : i.status === 'Cancelled' ? 'Cancelled'
        : `${i.status === 'Overdue' ? 'Overdue' : i.status === 'Partial' ? 'Part paid' : 'Open'}${i.due_date ? ` · due ${day(i.due_date)}` : ''}`;
  const origin = i.delivery
    ? <>delivered {day(i.delivery.delivery_date)} on the {i.delivery.zone} round</>
    : mode === 'Pickup' ? <>collected {day(i.invoice_date)}</>
      : mode === 'Counter' ? <>counter sale {day(i.invoice_date)}</>
        : <>raised {day(i.invoice_date)}</>;
  const addr = [
    i.customer?.address_line1 ?? i.customer?.delivery_address, i.customer?.address_line2,
    [i.customer?.city, i.customer?.parish].filter(Boolean).join(', ') || null,
  ].filter(Boolean) as string[];

  const onAccount = Number(i.onAccountCents ?? 0);
  const canApply = !i.is_credit_note && i.balanceCents > 0 && onAccount > 0 && i.status !== 'Cancelled';
  const applyCents = Math.min(onAccount, i.balanceCents);

  type Step = { tone: 'done' | 'todo' | 'warn' | 'bad'; title: ReactNode; meta?: ReactNode; extra?: ReactNode };
  const steps: Step[] = [];
  steps.push({
    tone: 'done',
    title: i.delivery ? 'Raised when delivered' : mode === 'Pickup' ? 'Raised when collected'
      : mode === 'Counter' ? 'Raised at the counter' : 'Raised',
    meta: <>{day(i.created_at)}, {time(i.created_at)}
      {i.delivery && <> · {i.delivery.driver_user_name ?? i.delivery.driver_name ?? 'driver'}, {i.delivery.zone} round</>}</>,
  });
  for (const h of i.history ?? []) {
    if (h.action === 'create') continue;
    const d = h.details ?? {};
    let title = '';
    if (d.emailedTo) title = `Emailed to ${String(d.emailedTo)}`;
    else if (d.lifecycle === 'Sent') title = 'Marked as sent';
    else if (d.approvedInline) title = `${String(d.discountPercent)}% discount given`;
    else if ('before' in d) title = 'Changed';
    else title = 'Updated';
    steps.push({
      tone: 'done', title,
      meta: <>{day(h.ts)}, {time(h.ts)}{h.user_name ? ` · ${h.user_name}` : ''}{d.reason ? ` · “${String(d.reason)}”` : ''}</>,
    });
  }
  if (!i.sent_date && !(i.history ?? []).some((h) => h.details?.emailedTo)) {
    steps.push({ tone: 'todo', title: 'Not emailed yet', meta: 'Use Email to customer, or it goes with their next statement' });
  }
  if (i.discount_status === 'Pending') {
    steps.push({ tone: 'warn', title: `${Number(i.discount_percent)}% discount waiting for a decision`, meta: 'The full amount is owed until it is approved' });
  }
  for (const c of i.creditNotes ?? []) {
    steps.push({
      tone: c.credit_status === 'Pending' ? 'warn' : c.credit_status === 'Rejected' ? 'bad' : 'done',
      title: <>Credit note {c.invoice_number} for {money(Math.abs(Number(c.grand_total_cents)))}</>,
      meta: <>{day(c.created_at)} · {c.credit_status === 'Pending' ? 'waiting for a decision' : c.credit_status.toLowerCase()}</>,
    });
  }
  for (const p of i.payments ?? []) {
    steps.push({
      tone: p.is_reversal ? 'bad' : 'done',
      title: p.is_reversal ? <>Payment of {money(Math.abs(Number(p.amount_cents)))} reversed</>
        : <>Paid {money(Number(p.amount_cents))} by {p.method.toLowerCase()}</>,
      meta: <>{day(p.payment_date)}{p.reference ? ` · ${p.reference}` : ''}{p.status !== 'Confirmed' ? ` · ${p.status}` : ''}</>,
      extra: isAdmin && !p.is_reversal && p.status === 'Confirmed' && !(i.payments ?? []).some((x) => x.reverses_payment_id === p.id) ? (
        reversing?.id === p.id ? (
          <div className="row" style={{ marginTop: 6 }}>
            <input placeholder="Why? (optional)" value={reversing.reason} style={{ flex: '1 1 140px' }}
                   onChange={(e) => setReversing({ id: p.id, reason: e.target.value })} />
            <button className="danger-soft" disabled={busy} onClick={reverse}>Reverse it</button>
            <button className="secondary" onClick={() => setReversing(null)}>Keep</button>
          </div>
        ) : (
          <button type="button" className="link-button bad-text" onClick={() => setReversing({ id: p.id, reason: '' })}>
            Reverse…
          </button>
        )
      ) : null,
    });
  }
  if (!i.is_credit_note && i.status !== 'Cancelled') {
    if (i.balanceCents <= 0) {
      steps.push({ tone: 'done', title: 'Paid in full' });
    } else {
      steps.push({
        tone: i.status === 'Overdue' ? 'bad' : 'todo',
        title: (i.payments ?? []).length ? `${money(i.balanceCents)} still owed` : 'No payments against it',
        meta: dueIn === null ? undefined : dueIn > 1 ? `Due in ${dueIn} days` : dueIn === 1 ? 'Due tomorrow'
          : dueIn === 0 ? 'Due today' : `${-dueIn} ${dueIn === -1 ? 'day' : 'days'} late`,
      });
    }
  }

  // ---- the panels ----
  const panelBody = (() => {
    if (panel === 'pay') {
      return (
        <>
          <h2>Record a payment</h2>
          <div className="row">
            <div className="field"><label htmlFor="p-amt">Amount</label>
              <input id="p-amt" inputMode="decimal" style={{ width: 150 }} value={pay.amount}
                     onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></div>
            <div className="field"><label htmlFor="p-how">Method</label>
              <select id="p-how" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                {METHODS.map((m) => <option key={m}>{m}</option>)}
              </select></div>
            <div className="field"><label htmlFor="p-ref">Reference</label>
              <input id="p-ref" value={pay.reference} placeholder="bank ref, cheque no."
                     onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></div>
            <div className="field"><button disabled={busy || toCents(pay.amount) <= 0} onClick={recordPayment}>Record payment</button></div>
          </div>
          <p className="muted small">Anything above the {money(i.balanceCents)} owed stays on their account for the next invoice.</p>
        </>
      );
    }
    if (panel === 'email') {
      return (
        <>
          <h2>Email {i.invoiceNumber}</h2>
          {!mailReady && (
            <p className="notice warn small" style={{ margin: '0 0 10px' }}>
              Sending is not set up on this computer yet; trying will say what is needed. Download PDF always works.
            </p>
          )}
          <div className="row">
            <div className="field" style={{ flex: '1 1 280px' }}><label htmlFor="m-to">Send to</label>
              <input id="m-to" type="email" style={{ width: '100%' }} value={mailTo}
                     onChange={(e) => setMailTo(e.target.value)} /></div>
            <div className="field"><button disabled={busy || !mailTo.trim()} onClick={sendEmail}>Send it</button></div>
          </div>
        </>
      );
    }
    if (panel === 'discount') {
      return (
        <>
          <h2>Give a discount</h2>
          <div className="row">
            <div className="field"><label htmlFor="d-pct">Discount %</label>
              <input id="d-pct" type="number" min="0" max="100" step="0.01" style={{ width: 100 }}
                     value={disc.percent} onChange={(e) => setDisc({ ...disc, percent: e.target.value })} /></div>
            <div className="field" style={{ flex: '1 1 280px' }}><label htmlFor="d-why">Why (required)</label>
              <input id="d-why" style={{ width: '100%' }} value={disc.reason}
                     onChange={(e) => setDisc({ ...disc, reason: e.target.value })} /></div>
            <div className="field"><button className="approve-soft"
                    disabled={busy || !(Number(disc.percent) > 0) || !disc.reason.trim()} onClick={requestDiscount}>
              {isAdmin ? 'Give discount' : 'Ask for it'}</button></div>
          </div>
          {!isAdmin && <p className="muted small">It goes to Needs a decision; the balance stays as it is until approved.</p>}
        </>
      );
    }
    if (panel === 'credit') {
      return (
        <>
          <h2>Credit note</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Takes money off what they owe, as its own document against {i.invoiceNumber}.
          </p>
          <div className="row">
            <div className="field"><label htmlFor="c-amt">Amount</label>
              <input id="c-amt" inputMode="decimal" style={{ width: 140 }} value={credit.amount}
                     onChange={(e) => setCredit({ ...credit, amount: e.target.value })} /></div>
            <div className="field" style={{ flex: '1 1 280px' }}><label htmlFor="c-why">Why (required)</label>
              <input id="c-why" style={{ width: '100%' }} value={credit.reason}
                     onChange={(e) => setCredit({ ...credit, reason: e.target.value })} /></div>
            <div className="field"><button className="danger-soft"
                    disabled={busy || toCents(credit.amount) <= 0 || !credit.reason.trim()} onClick={raiseCredit}>
              Raise credit note</button></div>
          </div>
        </>
      );
    }
    if (panel === 'edit') {
      return (
        <>
          <h2>Change quantities</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Recorded against your name. If the total drops below what is already paid, a credit note is raised for the difference.
          </p>
          <table>
            <thead><tr><th>Product</th><th>Quantity</th></tr></thead>
            <tbody>
              {i.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.product_name}</td>
                  <td>
                    <input type="number" min="0" style={{ width: 100 }} aria-label={`Quantity of ${l.product_name}`}
                           value={edit.qty[l.id] ?? ''}
                           onChange={(e) => setEdit({ ...edit, qty: { ...edit.qty, [l.id]: e.target.value } })} />
                    <span className="muted small"> {Number(l.bottles_per_case) > 0 ? 'cases' : 'bottles'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}>
            <div className="field"><label htmlFor="e-pct">Discount %</label>
              <input id="e-pct" type="number" min="0" max="100" step="0.01" style={{ width: 100 }}
                     value={edit.discount} onChange={(e) => setEdit({ ...edit, discount: e.target.value })} /></div>
            <div className="field" style={{ flex: '1 1 280px' }}><label htmlFor="e-why">Why (required)</label>
              <input id="e-why" style={{ width: '100%' }} value={edit.reason}
                     onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></div>
            <div className="field"><button disabled={busy || !edit.reason.trim()} onClick={saveEdit}>Save changes</button></div>
          </div>
        </>
      );
    }
    return null;
  })();

  const closed = i.is_credit_note || i.status === 'Cancelled';

  return (
    <>
      <Link to="/invoices" className="back-link">← Invoices</Link>
      <div className="panel-head record-head">
        <div>
          <div className="inv-title">
            <h1>{i.invoiceNumber}</h1>
            <span className={`chip ${statusTone(i.status)}`}>{statusWords}</span>
          </div>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {i.customer ? <Link to={`/customers/${i.customer.id}?tab=invoices`}>{i.customer.name}</Link> : 'Customer'}
            {' · '}{origin}
            {(i.orders ?? []).length > 0 && <> · from {(i.orders ?? []).map((o) => o.order_number).join(', ')}</>}
          </p>
        </div>
        <div className="record-actions">
          <button className="secondary" disabled={busy} onClick={downloadPdf}>Download PDF</button>
          <button className="secondary" disabled={busy} onClick={() => open('email')}>Email to customer</button>
          {!closed && i.balanceCents > 0 && (
            <button disabled={busy} onClick={() => open('pay')}>Record a payment</button>
          )}
          {!closed && (
            <span className="deskbar-menu">
              <button type="button" className="secondary" aria-haspopup="true" aria-expanded={moreOpen}
                      aria-label="More: change quantities, discount, credit note"
                      onClick={(e) => { e.stopPropagation(); setMoreOpen(!moreOpen); }}>More ▾</button>
              {moreOpen && (
                <div className="deskbar-pop deskbar-pop-right" role="menu">
                  {isAdmin && <button role="menuitem" className="pop-item pop-button" onClick={() => open('edit')}>Change quantities</button>}
                  <button role="menuitem" className="pop-item pop-button" onClick={() => open('discount')}>Give a discount</button>
                  <div className="pop-rule" />
                  <button role="menuitem" className="pop-item pop-button pop-danger" onClick={() => open('credit')}>Credit note</button>
                </div>
              )}
            </span>
          )}
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {i.discount_status === 'Pending' && (
        <div className="notice warn">
          A {Number(i.discount_percent)}% discount on this invoice is waiting in Needs a decision.
          Until it is approved the full amount is owed.
        </div>
      )}

      {panel && (
        <div className="panel action-panel">
          {panelBody}
          <button type="button" className="secondary panel-close" onClick={() => setPanel(null)}>Close</button>
        </div>
      )}

      <div className="inv-grid">
        <section className="panel paper" aria-label="The invoice as the customer sees it">
          <div className="paper-head">
            <Logo height={84} />
            <div className="paper-id">
              <div className="paper-kind">{i.is_credit_note ? 'Credit note' : 'Invoice'} {i.invoiceNumber}</div>
              1506 Investments Limited<br />{day(i.invoice_date)} {date(i.invoice_date).slice(0, 4)}
            </div>
          </div>
          <div className="paper-parties">
            <div>
              <div className="paper-label">Billed to</div>
              <strong>{i.customer?.name ?? '—'}</strong>
              {addr.map((a) => <div key={a}>{a}</div>)}
              {i.customer?.email && <div>{i.customer.email}</div>}
            </div>
            <div>
              <div className="paper-label">Terms</div>
              {i.customer?.payment_terms ?? 'Not set'}
              {i.due_date && <div>Due {day(i.due_date)} {date(i.due_date).slice(0, 4)}</div>}
            </div>
          </div>
          <div className="table-scroll">
            <table className="paper-lines">
              <thead>
                <tr><th>{i.delivery ? 'Delivered' : 'Item'}</th><th>Quantity</th><th className="num">Price</th><th className="num">Amount</th></tr>
              </thead>
              <tbody>
                {(i.lines ?? []).map((l) => (
                  <tr key={l.id}>
                    <td>{l.product_name}</td>
                    <td>{qtyText(l)}</td>
                    <td className="num">{money(unitPrice(l))}</td>
                    <td className="num">{money(Number(l.line_total_cents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="paper-totals">
            <div className="total-line"><span>Subtotal</span><span>{money(Number(i.subtotal_cents))}</span></div>
            {Number(i.discount_amount_cents) > 0 && (
              <div className="total-line"><span>Discount {Number(i.discount_percent)}%</span><span>−{money(Number(i.discount_amount_cents))}</span></div>
            )}
            <div className="total-line"><span>GCT 15%</span><span>{money(Number(i.gct_cents))}</span></div>
            <div className="total-line grand"><span>Total</span><span>{money(i.grandTotalCents)}</span></div>
            {!i.is_credit_note && (
              <>
                <div className="total-line"><span>Paid</span><span>{money(i.amountPaidCents)}</span></div>
                <div className={`total-line grand${i.balanceCents > 0 ? ' due' : ''}`}>
                  <span>Balance due</span><span>{money(i.balanceCents)}</span>
                </div>
              </>
            )}
          </div>
          <div className="paper-foot">
            {i.delivery && (
              <>Bottles on this delivery: {i.delivery.bottles_delivered_full} full out,{' '}
                {i.delivery.bottles_empties_picked_up} empties back
                {i.delivery.bottles_lost_damaged ? `, ${i.delivery.bottles_lost_damaged} lost or damaged` : ''}.{' '}</>
            )}
            Thank you for choosing Alka Vida.
          </div>
        </section>

        <aside className="inv-side">
          {canApply && (
            <section className="panel on-account">
              <strong>{money(onAccount)} is on their account, not yet against an invoice.</strong>
              <div className="small" style={{ margin: '4px 0 10px' }}>
                Put {money(applyCents)} of it against this invoice
                {applyCents >= i.balanceCents ? ' to clear it' : ''}.
              </div>
              <button disabled={busy} onClick={() => applyHere(applyCents)}>Apply {money(applyCents)} here</button>
            </section>
          )}

          <section className="panel">
            <h2 className="side-h">What has happened</h2>
            <ol className="timeline">
              {steps.map((s, n) => (
                <li key={n} className={`tl-${s.tone}`}>
                  <span className="tl-dot" aria-hidden="true" />
                  <div>
                    <div className="tl-title">{s.title}</div>
                    {s.meta && <div className="muted small">{s.meta}</div>}
                    {s.extra}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {!closed && (
            <section className="panel">
              <h2 className="side-h">Something wrong with it?</h2>
              <p className="muted small" style={{ marginTop: 0 }}>
                {isAdmin
                  ? 'Changes are recorded against your name, with the reason.'
                  : 'Changes by office staff go to Needs a decision; the balance stays as it is until they are approved.'}
              </p>
              <div className="row" style={{ gap: 6 }}>
                {isAdmin && <button className="secondary" onClick={() => open('edit')}>Change quantities</button>}
                <button className="secondary" onClick={() => open('discount')}>Give a discount</button>
                <button className="danger-soft" onClick={() => open('credit')}>Credit note</button>
              </div>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
