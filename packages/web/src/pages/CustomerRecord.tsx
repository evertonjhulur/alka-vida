import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date, statusTone, toCents } from '../lib/format';

interface Customer {
  id: string; name: string; phone: string; email: string;
  contact_person: string | null; delivery_address: string | null;
  delivery_zone: string | null; payment_terms: string | null;
  account_type: string | null; price_tier_name: string | null;
  portal_email: string | null; notes: string | null; active: boolean;
}
interface Order {
  id: string; order_number: string; order_date: string; status: string;
  delivery_mode: string; source: string; grand_total_cents: string;
}
interface Invoice {
  invoice_id: string; invoice_number: string; invoice_date: string;
  due_date: string | null; status: string; grand_total_cents: string;
  balance_cents: string; is_credit_note: boolean;
}
interface Payment {
  id: string; payment_date: string; amount_cents: string; method: string | null;
  reference: string | null; is_reversal: boolean; invoice_number: string | null;
}
interface History {
  customer: Customer; orders: Order[]; invoices: Invoice[];
  payments: Payment[]; balanceCents: number;
}
interface Bottles {
  openingHolding: number; delivered: number; returned: number;
  lost: number; closingHolding: number;
}

const METHODS = ['Cash', 'Cheque', 'Bank Transfer', 'Card'] as const;

/**
 * One customer, everything about them.
 *
 * The list screen answers "which customer?"; this answers "what has been going
 * on with them?" - which is the question actually being asked when somebody
 * rings up. Taking a payment and sending a statement live here too, because
 * that is the moment you want to do both.
 */
export default function CustomerRecord({ session }: { session: Session }) {
  const { customerId } = useParams();
  const navigate = useNavigate();

  const [h, setH] = useState<History | null>(null);
  const [bottles, setBottles] = useState<Bottles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [payOpen, setPayOpen] = useState(false);
  const [pay, setPay] = useState({ amount: '', method: 'Cash', invoiceId: '', reference: '' });
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState('');

  const load = useCallback(async () => {
    const data = await api.get<History>(`/api/customers/${customerId}/history`);
    setH(data);
    try {
      setBottles(await api.get<Bottles>(`/api/customers/${customerId}/bottles`));
    } catch { setBottles(null); }
  }, [customerId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function run(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { await what(); await load(); } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  async function takePayment(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      await api.post('/api/payments', {
        customerId,
        // Blank means it is not against any one invoice - which is a real
        // thing here, not a fallback. It simply sits on the account.
        invoiceId: pay.invoiceId || null,
        amountCents: toCents(pay.amount),
        method: pay.method,
        reference: pay.reference || null,
      });
      setMsg(`Payment of ${money(toCents(pay.amount))} recorded.`);
      setPay({ amount: '', method: 'Cash', invoiceId: '', reference: '' });
      setPayOpen(false);
    }, 'Could not record the payment');
  }

  async function downloadStatement() {
    if (!h) return;
    setBusy(true); setError(null);
    try {
      const blob = await api.getBlob(`/api/customers/${customerId}/statement.pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${h.customer.name.replace(/\W+/g, '-')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the statement');
    } finally { setBusy(false); }
  }

  async function emailStatement(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await api.post<{ sentTo: string }>(
        `/api/customers/${customerId}/statement/email`,
        { sendTo: sendTo || undefined },
      );
      setMsg(`Statement emailed to ${r.sentTo}.`);
      setSendOpen(false); setSendTo('');
    }, 'Could not send the statement');
  }

  if (error && !h) return <div className="notice error">{error}</div>;
  if (!h) return <p className="muted">Loading…</p>;

  const c = h.customer;
  const open = h.invoices.filter((i) => Number(i.balance_cents) > 0);

  return (
    <>
      <p><Link to="/customers">← All customers</Link></p>

      <div className="panel-head">
        <div>
          <h1 style={{ marginBottom: 2 }}>{c.name}</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {[c.account_type, c.contact_person, c.delivery_zone,
              c.price_tier_name ?? 'list price', c.payment_terms]
              .filter(Boolean).join(' · ')}
          </p>
        </div>
        <div>
          <button className="secondary" disabled={busy} onClick={downloadStatement}>
            Statement PDF
          </button>{' '}
          <button className="secondary" disabled={busy}
                  onClick={() => { setSendOpen(!sendOpen); setPayOpen(false); }}>
            {sendOpen ? 'Cancel' : 'Send statement'}
          </button>{' '}
          <button disabled={busy}
                  onClick={() => { setPayOpen(!payOpen); setSendOpen(false); }}>
            {payOpen ? 'Cancel' : 'Take a payment'}
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {sendOpen && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Send this statement</h2>
          <p className="muted small">
            Emails the same PDF the button beside it downloads. Leave the address
            blank to use the one on the customer record.
          </p>
          <form onSubmit={emailStatement}>
            <div className="row">
              <div className="field" style={{ flex: '1 1 300px' }}>
                <label htmlFor="sendto">Send to</label>
                <input id="sendto" type="email" style={{ width: '100%' }} value={sendTo}
                       placeholder={c.email || 'no address on file'}
                       onChange={(e) => setSendTo(e.target.value)} />
              </div>
              <div className="field">
                <button disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
              </div>
            </div>
          </form>
        </div>
      )}

      {payOpen && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Take a payment from {c.name}</h2>
          <form onSubmit={takePayment}>
            <div className="row">
              <div className="field">
                <label htmlFor="amt">Amount</label>
                <input id="amt" type="number" step="0.01" min="0" required
                       style={{ width: 140 }} value={pay.amount}
                       onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pm">How</label>
                <select id="pm" value={pay.method}
                        onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                  {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 260px' }}>
                <label htmlFor="inv">Against which invoice?</label>
                <select id="inv" style={{ width: '100%' }} value={pay.invoiceId}
                        onChange={(e) => setPay({ ...pay, invoiceId: e.target.value })}>
                  <option value="">Leave it on the account</option>
                  {open.map((i) => (
                    <option key={i.invoice_id} value={i.invoice_id}>
                      {i.invoice_number} — {money(Number(i.balance_cents))} outstanding
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ref">Reference</label>
                <input id="ref" style={{ width: 160 }} value={pay.reference}
                       placeholder="cheque no., slip"
                       onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
              </div>
              <div className="field">
                <button disabled={busy || !(Number(pay.amount) > 0)}>
                  {busy ? 'Recording…' : 'Record payment'}
                </button>
              </div>
            </div>
            {!pay.invoiceId && (
              <p className="muted small" style={{ margin: 0 }}>
                Money left on the account is not applied to anything until somebody
                puts it against an invoice. It still counts towards what they owe.
              </p>
            )}
          </form>
        </div>
      )}

      <div className="figures">
        <div className="fig">
          <div className="fig-label">{h.balanceCents < 0 ? 'In credit' : 'Owes'}</div>
          <div className="fig-value">{money(Math.abs(h.balanceCents))}</div>
          <div className="fig-sub">
            {open.length} open invoice{open.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="fig">
          <div className="fig-label">Orders</div>
          <div className="fig-value">{h.orders.length}</div>
          <div className="fig-sub">most recent 25</div>
        </div>
        <div className="fig">
          <div className="fig-label">Bottles held</div>
          <div className="fig-value">{bottles ? bottles.closingHolding : '—'}</div>
          <div className="fig-sub">
            {bottles ? `${bottles.delivered} out, ${bottles.returned} back` : 'no returnables'}
          </div>
        </div>
        <div className="fig">
          <div className="fig-label">Portal login</div>
          <div className="fig-value" style={{ fontSize: 17 }}>
            {c.portal_email ? 'Yes' : 'No'}
          </div>
          <div className="fig-sub">{c.portal_email ?? 'cannot order online'}</div>
        </div>
      </div>

      <div className="panel phone-cards">
        <div className="panel-head">
          <h2>Invoices</h2>
          <Link className="small" to="/statement">Full statement</Link>
        </div>
        <table>
          <thead>
            <tr>
              <th>Invoice</th><th>Date</th><th>Due</th>
              <th className="num">Total</th><th className="num">Outstanding</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {h.invoices.map((i) => (
              <tr key={i.invoice_id}>
                <td className="lead">
                  <Link to={`/invoices/${i.invoice_id}`}>{i.invoice_number}</Link>
                  <span className={`chip ${statusTone(i.status)} phone-only`}>{i.status}</span>
                </td>
                <td data-label="Date">{date(i.invoice_date)}</td>
                <td data-label="Due">{i.due_date ? date(i.due_date) : '—'}</td>
                <td data-label="Total" className="num">
                  {money(Number(i.grand_total_cents))}
                </td>
                <td data-label="Outstanding" className="num money">
                  {money(Number(i.balance_cents))}
                </td>
                <td className="on-desktop">
                  <span className={`chip ${statusTone(i.status)}`}>{i.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {h.invoices.length === 0 && <p className="muted">No invoices yet.</p>}
      </div>

      <div className="panel phone-cards">
        <h2 style={{ marginTop: 0 }}>Payments</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Against</th><th>How</th>
              <th>Reference</th><th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {h.payments.map((p) => (
              <tr key={p.id}>
                <td className="lead">
                  <span>{date(p.payment_date)}</span>
                  {p.is_reversal && <span className="chip bad phone-only">reversed</span>}
                </td>
                <td data-label="Against">
                  {p.invoice_number ?? <span className="muted">left on account</span>}
                </td>
                <td data-label="How">{p.method ?? '—'}</td>
                <td data-label="Reference" className="small muted">{p.reference ?? '—'}</td>
                <td data-label="Amount" className="num money">
                  {money(Number(p.amount_cents))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {h.payments.length === 0 && <p className="muted">Nothing paid yet.</p>}
      </div>

      <div className="panel phone-cards">
        <h2 style={{ marginTop: 0 }}>Orders</h2>
        <table>
          <thead>
            <tr>
              <th>Order</th><th>Date</th><th>How</th>
              <th className="num">Total</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {h.orders.map((o) => (
              <tr key={o.id}>
                <td className="lead">
                  <span>
                    {o.order_number}
                    {o.source === 'Portal' && (
                      <div className="muted small">placed by the customer</div>
                    )}
                  </span>
                  <span className={`chip ${statusTone(o.status)} phone-only`}>{o.status}</span>
                </td>
                <td data-label="Date">{date(o.order_date)}</td>
                <td data-label="How" className="small">
                  {o.delivery_mode === 'Pickup' ? 'Collection' : o.delivery_mode}
                </td>
                <td data-label="Total" className="num money">
                  {money(Number(o.grand_total_cents))}
                </td>
                <td className="on-desktop">
                  <span className={`chip ${statusTone(o.status)}`}>{o.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {h.orders.length === 0 && <p className="muted">No orders yet.</p>}
      </div>

      {session.role === 'admin' && (
        <p className="muted small">
          To change this customer&rsquo;s details, use Edit on the{' '}
          <a href="#/customers" onClick={() => navigate('/customers')}>customers list</a>.
        </p>
      )}
    </>
  );
}
