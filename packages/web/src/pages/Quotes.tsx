import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, download } from '../lib/api';
import { money, statusTone, todayInJamaica, when } from '../lib/format';
import CustomerPicker, { type PickerCustomer } from '../components/CustomerPicker';
import { ask, askText } from '../components/Dialog';

/**
 * Quotations (Everton's revisions, 30 Sep 2026, point 1).
 *
 * Prepare a quote, send it to the customer for acceptance, and turn an
 * accepted one into an order that then goes through delivery and invoicing.
 * The customer can accept from the link in the email, from their portal, or
 * by telling the office - in which case the office marks it accepted here.
 *
 *   /quotes            the list
 *   /quotes/new        a new quote (?customer= to start with one)
 *   /quotes/:id        one quote: send, accept, convert
 *   /quotes/:id/edit   change it while it is still a draft or waiting
 */

interface QuoteRow {
  id: string; quote_number: string; quote_date: string; valid_until: string | null;
  status: string; grand_total_cents: number; customer_id: string; customer_name: string;
  sent_date: string | null; accepted_via: string | null; converted_order_id: string | null;
  converted_order_number: string | null; lines_summary: string | null; expired: boolean;
}
interface QuoteLine {
  id: string; product_id: string; product_name: string; bottles_per_case: number;
  cases: number; loose_bottles: number; price_per_case_cents: number; price_per_bottle_cents: number;
  line_total_cents: number;
}
interface Quote extends QuoteRow {
  subtotal_cents: number; discount_percent: number; discount_fixed_cents: number;
  discount_amount_cents: number; gct_cents: number; gct_exempt: boolean; notes: string | null;
  delivery_mode: 'Delivery' | 'Pickup'; customer_email: string | null; decline_reason: string | null;
  accepted_at: string | null; lines: QuoteLine[];
}
interface Priced {
  product_id: string; name: string; bottles_per_case: number;
  price_per_case_cents: number; price_per_bottle_cents: number;
}
interface Customer extends PickerCustomer { gct_exempt?: boolean }

const shortName = (n: string) => n.replace(/^Alka Vida\s+/i, '');
const STATUS_WORDS: Record<string, string> = {
  Draft: 'Draft, not sent', Sent: 'Waiting for their answer', Accepted: 'Accepted, make the order',
  Converted: 'Order made', Declined: 'Declined', Expired: 'Expired',
};
const statusOf = (q: QuoteRow) => (q.expired ? 'Expired' : q.status);

export default function Quotes() {
  const { quoteId, mode } = useParams();
  if (quoteId === 'new') return <QuoteEditor />;
  if (quoteId && mode === 'edit') return <QuoteEditor quoteId={quoteId} />;
  if (quoteId) return <QuoteView quoteId={quoteId} />;
  return <QuoteList />;
}

/* ------------------------------------------------------------------ */

function QuoteList() {
  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [show, setShow] = useState<'waiting' | 'accepted' | 'done' | 'all'>('waiting');
  const [find, setFind] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.get<QuoteRow[]>('/api/quotations').then(setRows).catch((e) => setError(e.message)); }, []);

  const needle = find.trim().toLowerCase();
  const shown = rows.filter((q) => {
    const st = statusOf(q);
    if (show === 'waiting' && !['Draft', 'Sent'].includes(st)) return false;
    if (show === 'accepted' && st !== 'Accepted') return false;
    if (show === 'done' && !['Converted', 'Declined', 'Expired'].includes(st)) return false;
    return !needle || q.quote_number.toLowerCase().includes(needle) || q.customer_name.toLowerCase().includes(needle);
  });
  const count = (f: (q: QuoteRow) => boolean) => rows.filter(f).length;

  return (
    <>
      <div className="panel-head record-head">
        <div>
          <h1>Quotes</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Prices offered to a customer. Once they accept, turn it into an order.
          </p>
        </div>
        <Link to="/quotes/new"><button type="button">New quote</button></Link>
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="panel phone-cards">
        <div className="pills">
          {([
            ['waiting', `Out with the customer (${count((q) => ['Draft', 'Sent'].includes(statusOf(q)))})`],
            ['accepted', `Accepted (${count((q) => statusOf(q) === 'Accepted')})`],
            ['done', 'Done'], ['all', 'All'],
          ] as const).map(([k, label]) => (
            <button key={k} type="button" className={`pill${show === k ? ' active' : ''}`} onClick={() => setShow(k)}>{label}</button>
          ))}
          <input aria-label="Find a quote" placeholder="Find: number or customer" value={find}
                 onChange={(e) => setFind(e.target.value)} style={{ marginLeft: 'auto', minWidth: 220 }} />
        </div>
        <table>
          <thead>
            <tr><th>Quote</th><th>Customer</th><th>What</th><th>Valid until</th><th className="num">Total</th><th>Where it stands</th></tr>
          </thead>
          <tbody>
            {shown.map((q) => (
              <tr key={q.id}>
                <td className="lead"><Link to={`/quotes/${q.id}`}><strong>{q.quote_number}</strong></Link>
                  <div className="muted small">{when(q.quote_date)}</div></td>
                <td data-label="Customer"><Link to={`/customers/${q.customer_id}`}>{q.customer_name}</Link></td>
                <td data-label="What" className="small">{q.lines_summary}</td>
                <td data-label="Valid until">{q.valid_until ? when(q.valid_until) : '—'}</td>
                <td data-label="Total" className="num money">{money(Number(q.grand_total_cents))}</td>
                <td data-label="Status">
                  <span className={`chip ${statusTone(statusOf(q) === 'Converted' ? 'Paid' : statusOf(q) === 'Accepted' ? 'Open' : statusOf(q) === 'Sent' ? 'Sent' : statusOf(q) === 'Declined' || statusOf(q) === 'Expired' ? 'Cancelled' : 'Draft')}`}>
                    {STATUS_WORDS[statusOf(q)] ?? statusOf(q)}
                  </span>
                  {q.converted_order_number && <div className="muted small">{q.converted_order_number}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="muted">Nothing here.</p>}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

interface EdLine { productId: string; qty: number; price: string }

function addDaysIso(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function QuoteEditor({ quoteId }: { quoteId?: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const [prices, setPrices] = useState<Priced[]>([]);
  const [lines, setLines] = useState<EdLine[]>([]);
  const [mode, setMode] = useState<'Delivery' | 'Pickup'>('Delivery');
  const [validUntil, setValidUntil] = useState(addDaysIso(todayInJamaica(), 30));
  const [discount, setDiscount] = useState('0');
  const [discountAs, setDiscountAs] = useState<'%' | '$'>('%');
  const [chargeGct, setChargeGct] = useState(true);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!quoteId);

  useEffect(() => { api.get<Customer[]>('/api/customers').then(setCustomers).catch(() => {}); }, []);
  useEffect(() => {
    if (!quoteId) return;
    api.get<Quote>(`/api/quotations/${quoteId}`).then((q) => {
      setCustomerId(q.customer_id);
      setMode(q.delivery_mode);
      setValidUntil(q.valid_until ?? '');
      const fixed = Number(q.discount_fixed_cents) || 0;
      setDiscountAs(fixed > 0 ? '$' : '%');
      setDiscount(fixed > 0 ? (fixed / 100).toFixed(2) : String(Number(q.discount_percent) || 0));
      setChargeGct(!q.gct_exempt);
      setNotes(q.notes ?? '');
      setLines(q.lines.map((l) => {
        const cased = Number(l.bottles_per_case) > 0;
        return {
          productId: l.product_id, qty: cased ? Number(l.cases) : Number(l.loose_bottles),
          price: (Number(cased ? l.price_per_case_cents : l.price_per_bottle_cents) / 100).toFixed(2),
        };
      }));
      setLoaded(true);
    }).catch((e) => setError(e.message));
  }, [quoteId]);

  useEffect(() => {
    if (!customerId) { setPrices([]); return; }
    api.get<Priced[]>(`/api/customers/${customerId}/prices`).then(setPrices).catch(() => {});
    if (!quoteId) {
      const c = customers.find((x) => x.id === customerId);
      if (c) setChargeGct(!c.gct_exempt);
    }
  }, [customerId, customers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const productOf = (id: string) => prices.find((p) => p.product_id === id);
  const usual = (p: Priced) => (Number(p.bottles_per_case) > 0 ? Number(p.price_per_case_cents) : Number(p.price_per_bottle_cents));
  const unitOf = (l: EdLine) => {
    const p = productOf(l.productId);
    if (l.price.trim() === '') return p ? usual(p) : 0;
    return Math.max(0, Math.round(Number(l.price) * 100) || 0);
  };
  const totals = useMemo(() => {
    const subtotal = lines.reduce((a, l) => a + l.qty * unitOf(l), 0);
    const fixed = discountAs === '$' ? Math.max(0, Math.round((Number(discount) || 0) * 100)) : 0;
    const pct = discountAs === '%' ? Math.min(Math.max(Number(discount) || 0, 0), 100) : 0;
    const discountAmount = fixed > 0 ? Math.min(fixed, subtotal) : Math.round(subtotal * pct / 100);
    const gct = chargeGct ? Math.round((subtotal - discountAmount) * 0.15) : 0;
    return { subtotal, discountAmount, gct, total: subtotal - discountAmount + gct, fixed, pct };
  }, [lines, discount, discountAs, chargeGct, prices]); // eslint-disable-line react-hooks/exhaustive-deps

  const notYet = prices.filter((p) => !lines.some((l) => l.productId === p.product_id));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = {
        customerId, deliveryMode: mode, validUntil: validUntil || null, notes: notes || null,
        discountPercent: totals.pct, discountFixedCents: totals.fixed, gctExempt: !chargeGct,
        lines: lines.filter((l) => l.qty > 0).map((l) => {
          const cased = Number(productOf(l.productId)?.bottles_per_case) > 0;
          const unit = unitOf(l);
          return cased
            ? { productId: l.productId, cases: l.qty, pricePerCaseCents: unit }
            : { productId: l.productId, looseBottles: l.qty, pricePerBottleCents: unit };
        }),
      };
      if (quoteId) {
        await api.patch(`/api/quotations/${quoteId}`, body);
        navigate(`/quotes/${quoteId}`);
      } else {
        const r = await api.post<{ id: string }>('/api/quotations', body);
        navigate(`/quotes/${r.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the quote');
    } finally { setBusy(false); }
  }

  if (!loaded) return <p className="muted">Loading…</p>;
  return (
    <>
      <Link to={quoteId ? `/quotes/${quoteId}` : '/quotes'} className="back-link">← {quoteId ? 'The quote' : 'Quotes'}</Link>
      <h1>{quoteId ? 'Change the quote' : 'New quote'}</h1>
      {error && <div className="notice error">{error}</div>}
      <form onSubmit={save} className="order-grid">
        <div className="order-main">
          <section className="panel">
            <div className="field" style={{ maxWidth: 520 }}>
              <label htmlFor="q-cust">For</label>
              <CustomerPicker id="q-cust" customers={customers} value={customerId} onChange={setCustomerId} />
              <div className="muted small" style={{ marginTop: 4 }}>
                Someone new? <Link to="/customers?new=1">Add them as a customer</Link> first, then come back.
              </div>
            </div>
            <div className="row">
              <div className="field">
                <span className="label">How it would go out</span>
                <div className="seg seg-small" role="group" aria-label="How it would go out">
                  {([['Delivery', 'We deliver'], ['Pickup', 'They collect']] as const).map(([k, label]) => (
                    <button key={k} type="button" className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="q-valid">Valid until</label>
                <input id="q-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </div>
            </div>
          </section>

          <section className="panel">
            <h2 style={{ marginTop: 0 }}>What is quoted</h2>
            {!customerId && <p className="muted">Choose the customer first; their own prices fill in.</p>}
            {lines.length > 0 && (
              <table className="lines-table">
                <thead><tr><th>Product</th><th className="num">Unit price</th><th>How many</th><th className="num">Line total</th><th /></tr></thead>
                <tbody>
                  {lines.map((l) => {
                    const p = productOf(l.productId);
                    if (!p) return null;
                    const cased = Number(p.bottles_per_case) > 0;
                    return (
                      <tr key={l.productId}>
                        <td data-label="Product"><strong>{shortName(p.name)}</strong>
                          <div className="muted small">{cased ? `case of ${p.bottles_per_case}` : 'by the bottle'}</div></td>
                        <td data-label="Unit price" className="num">
                          <input type="number" min="0" step="0.01" className="price-input"
                                 aria-label={`Price per ${cased ? 'case' : 'bottle'} of ${p.name}`}
                                 value={l.price === '' ? (usual(p) / 100).toFixed(2) : l.price}
                                 onChange={(e) => setLines(lines.map((x) => (x.productId === l.productId ? { ...x, price: e.target.value } : x)))} />
                          <div className="muted small">their usual {money(usual(p))}</div>
                        </td>
                        <td data-label="How many">
                          <span className="stepper">
                            <button type="button" className="secondary" disabled={l.qty <= 1}
                                    onClick={() => setLines(lines.map((x) => (x.productId === l.productId ? { ...x, qty: x.qty - 1 } : x)))}>−</button>
                            <input type="number" min="1" value={l.qty || ''} aria-label={`How many ${p.name}`}
                                   onChange={(e) => setLines(lines.map((x) => (x.productId === l.productId ? { ...x, qty: Math.max(0, Math.round(Number(e.target.value)) || 0) } : x)))} />
                            <button type="button" className="secondary"
                                    onClick={() => setLines(lines.map((x) => (x.productId === l.productId ? { ...x, qty: x.qty + 1 } : x)))}>+</button>
                          </span>
                          <span className="muted small unit">{cased ? 'cs' : 'btl'}</span>
                        </td>
                        <td data-label="Line total" className="num">{money(l.qty * unitOf(l))}</td>
                        <td className="num"><button type="button" className="danger-soft"
                                                    onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}>Remove</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {customerId && notYet.length > 0 && (
              <div className="add-row">
                <span className="muted small">Add:</span>
                {notYet.map((p) => (
                  <button key={p.product_id} type="button" className="secondary"
                          onClick={() => setLines([...lines, { productId: p.product_id, qty: 1, price: '' }])}>
                    + {shortName(p.name)}
                  </button>
                ))}
              </div>
            )}
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="q-notes">Note on the quote</label>
              <input id="q-notes" style={{ width: '100%' }} value={notes} placeholder="e.g. Prices held for 30 days; delivery every Tuesday"
                     onChange={(e) => setNotes(e.target.value)} />
            </div>
          </section>
        </div>

        <aside className="order-side">
          <section className="panel totals-card">
            <div className="total-line"><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
            <div className="total-line">
              <span>Discount</span>
              <span>
                <span className="money-toggle" role="group" aria-label="Discount as">
                  {(['%', '$'] as const).map((k) => (
                    <button key={k} type="button" className={discountAs === k ? 'on' : ''}
                            onClick={() => { setDiscountAs(k); setDiscount('0'); }}>{k === '%' ? '%' : '$ amount'}</button>
                  ))}
                </span>{' '}
                <input type="number" min="0" step="0.01" style={{ width: 84 }} value={discount} aria-label="Discount"
                       onChange={(e) => setDiscount(e.target.value)} />
              </span>
            </div>
            {totals.discountAmount > 0 && <div className="total-line muted"><span /><span>−{money(totals.discountAmount)}</span></div>}
            <div className="total-line">
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={chargeGct} onChange={(e) => setChargeGct(e.target.checked)} /> GCT 15%
              </label>
              <span>{chargeGct ? money(totals.gct) : 'none'}</span>
            </div>
            <div className="total-line grand"><span>Total</span><span>{money(totals.total)}</span></div>
            <p className="muted small" style={{ margin: '8px 0 0' }}>A quote books nothing. Nothing is owed until it becomes an order and goes out.</p>
            <button className="wide" style={{ marginTop: 12 }} disabled={busy || !customerId || !lines.some((l) => l.qty > 0)}>
              {busy ? 'Saving…' : quoteId ? 'Save changes' : 'Save the quote'}
            </button>
          </section>
        </aside>
      </form>
    </>
  );
}

/* ------------------------------------------------------------------ */

interface Address { id: string; label: string; is_delivery: boolean; delivery_zone: string | null }

function QuoteView({ quoteId }: { quoteId: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'email' | 'convert' | null>(null);
  const [mailTo, setMailTo] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [conv, setConv] = useState({ mode: 'Delivery', date: todayInJamaica(), addressId: '' });
  const [addresses, setAddresses] = useState<Address[]>([]);

  const load = () => api.get<Quote>(`/api/quotations/${quoteId}`).then((x) => {
    setQ(x);
    setMailTo(x.customer_email ?? '');
    setConv((c) => ({ ...c, mode: x.delivery_mode }));
    api.get<Address[]>(`/api/customers/${x.customer_id}/addresses`)
      .then((a) => setAddresses(a.filter((y) => y.is_delivery))).catch(() => {});
  });
  useEffect(() => { load().catch((e) => setError(e.message)); }, [quoteId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(what: () => Promise<string | void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { const m = await what(); if (m) setMsg(m); setPanel(null); await load(); } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  if (error && !q) return <div className="notice error">{error}</div>;
  if (!q) return <p className="muted">Loading…</p>;
  const st = statusOf(q);
  const open = ['Draft', 'Sent'].includes(q.status);

  const sendIt = () => act(async () => {
    const r = await api.post<{ sentTo: string; link: string }>(`/api/quotations/${q.id}/email`, { to: mailTo });
    setLink(r.link);
    return `${q.quote_number} emailed to ${r.sentTo}, with a link they can accept it from.`;
  }, 'Could not send the quote');
  const markSent = () => act(async () => {
    const r = await api.post<{ link: string }>(`/api/quotations/${q.id}/mark-sent`, {});
    setLink(r.link);
    return 'Marked as sent. The accept link is below if you want to pass it on.';
  }, 'Could not mark it sent');
  const accepted = () => act(async () => {
    await api.post(`/api/quotations/${q.id}/status`, { status: 'Accepted' });
    return `${q.quote_number} marked accepted. Make the order when you are ready.`;
  }, 'Could not mark it accepted');
  const declined = async () => {
    const why = await askText(`Why did ${q.customer_name} decline ${q.quote_number}?`, { label: 'Reason (optional)', confirmLabel: 'Mark declined' });
    if (why === null) return;
    await act(async () => {
      await api.post(`/api/quotations/${q.id}/status`, { status: 'Declined', reason: why || null });
      return `${q.quote_number} marked declined.`;
    }, 'Could not mark it declined');
  };
  const remove = async () => {
    if (!await ask(`Throw away ${q.quote_number}? It has not been sent.`, { confirmLabel: 'Delete it', cancelLabel: 'Keep it', danger: true })) return;
    setBusy(true);
    try { await api.del(`/api/quotations/${q.id}`); navigate('/quotes'); } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete it'); setBusy(false);
    }
  };
  const convert = () => act(async () => {
    const r = await api.post<{ orderNumber: string; warnings: string[] }>(`/api/quotations/${q.id}/convert`, {
      deliveryMode: conv.mode, requestedDeliveryDate: conv.date || null,
      addressId: conv.mode === 'Delivery' ? (conv.addressId || null) : null,
    });
    return `Order ${r.orderNumber} made from ${q.quote_number} at the quoted prices.` + (r.warnings?.length ? ` ${r.warnings.join(' ')}` : '');
  }, 'Could not make the order');

  return (
    <>
      <Link to="/quotes" className="back-link">← Quotes</Link>
      <div className="panel-head record-head">
        <div>
          <div className="inv-title"><h1>{q.quote_number}</h1><span className="chip info">{STATUS_WORDS[st] ?? st}</span></div>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            <Link to={`/customers/${q.customer_id}`}>{q.customer_name}</Link> · {when(q.quote_date)}
            {q.valid_until && <> · valid until {when(q.valid_until)}</>}
            {q.accepted_via && <> · accepted {q.accepted_via === 'Email link' ? 'from the email link' : q.accepted_via === 'Portal' ? 'in their portal' : 'by the office'}</>}
            {q.converted_order_number && <> · order {q.converted_order_number}</>}
          </p>
        </div>
        <div className="record-actions">
          <button className="secondary" disabled={busy}
                  onClick={() => act(async () => { await download(`/api/quotations/${q.id}/pdf`, `${q.quote_number}.pdf`); }, 'Could not build the PDF')}>
            Download PDF</button>
          {open && <Link to={`/quotes/${q.id}/edit`}><button type="button" className="secondary">Change it</button></Link>}
          {open && <button className="secondary" disabled={busy} onClick={() => setPanel(panel === 'email' ? null : 'email')}>Email to customer</button>}
          {(q.status === 'Accepted' || open) && (
            <button disabled={busy} onClick={() => setPanel(panel === 'convert' ? null : 'convert')}>Make it an order</button>
          )}
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {link && (
        <div className="notice info">
          Accept link: <code style={{ wordBreak: 'break-all' }}>{link}</code>{' '}
          <button type="button" className="as-link" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
          <div className="small">Until Alka Vida is on the web this link only opens on this computer.</div>
        </div>
      )}
      {q.status === 'Declined' && q.decline_reason && <div className="notice warn">Declined: {q.decline_reason}</div>}

      {panel === 'email' && (
        <div className="panel action-panel">
          <h2>Email {q.quote_number}</h2>
          <p className="muted small" style={{ marginTop: 0 }}>The PDF goes with a link they can press to accept. They can also just reply.</p>
          <div className="row">
            <div className="field grow"><label htmlFor="qm-to">Send to</label>
              <input id="qm-to" type="email" value={mailTo} onChange={(e) => setMailTo(e.target.value)} /></div>
            <div className="field"><button disabled={busy || !mailTo.trim()} onClick={sendIt}>Send it</button></div>
          </div>
          <p className="muted small">Sent it another way (printed, WhatsApp)?{' '}
            <button type="button" className="as-link small" onClick={markSent}>Mark it as sent</button></p>
          <button type="button" className="secondary panel-close" onClick={() => setPanel(null)}>Close</button>
        </div>
      )}
      {panel === 'convert' && (
        <div className="panel action-panel">
          <h2>Make {q.quote_number} an order</h2>
          <p className="muted small" style={{ marginTop: 0 }}>At the quoted prices, discount and GCT. It then goes out and is invoiced like any order.</p>
          <div className="row">
            <div className="field">
              <span className="label">How it goes out</span>
              <div className="seg seg-small">
                {([['Delivery', 'We deliver'], ['Pickup', 'They collect']] as const).map(([k, label]) => (
                  <button key={k} type="button" className={conv.mode === k ? 'active' : ''} onClick={() => setConv({ ...conv, mode: k })}>{label}</button>
                ))}
              </div>
            </div>
            <div className="field"><label htmlFor="qc-date">{conv.mode === 'Pickup' ? 'Collect on' : 'Deliver on'}</label>
              <input id="qc-date" type="date" value={conv.date} min={todayInJamaica()} onChange={(e) => setConv({ ...conv, date: e.target.value })} /></div>
            {conv.mode === 'Delivery' && addresses.length > 0 && (
              <div className="field"><label htmlFor="qc-addr">Deliver to</label>
                <select id="qc-addr" value={conv.addressId} onChange={(e) => setConv({ ...conv, addressId: e.target.value })}>
                  <option value="">Main address</option>
                  {addresses.map((a) => <option key={a.id} value={a.id}>{a.label}{a.delivery_zone ? ` (${a.delivery_zone})` : ''}</option>)}
                </select></div>
            )}
            <div className="field"><button className="approve-soft" disabled={busy} onClick={convert}>Make the order</button></div>
          </div>
          {q.status !== 'Accepted' && <p className="muted small">It will be marked accepted by the office.</p>}
          <button type="button" className="secondary panel-close" onClick={() => setPanel(null)}>Close</button>
        </div>
      )}

      <div className="inv-grid">
        <section className="panel paper">
          <div className="paper-parties">
            <div><div className="paper-label">Prepared for</div><strong>{q.customer_name}</strong></div>
            <div><div className="paper-label">Goes out</div>{q.delivery_mode === 'Pickup' ? 'They collect' : 'We deliver'}</div>
          </div>
          <div className="table-scroll">
            <table className="paper-lines">
              <thead><tr><th>Item</th><th>Quantity</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {q.lines.map((l) => {
                  const cased = Number(l.bottles_per_case) > 0;
                  return (
                    <tr key={l.id}>
                      <td>{l.product_name}</td>
                      <td>{cased ? `${l.cases} cs` : `${l.loose_bottles}`}</td>
                      <td className="num">{money(Number(cased ? l.price_per_case_cents : l.price_per_bottle_cents))}</td>
                      <td className="num">{money(Number(l.line_total_cents))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="paper-totals">
            <div className="total-line"><span>Subtotal</span><span>{money(Number(q.subtotal_cents))}</span></div>
            {Number(q.discount_amount_cents) > 0 && (
              <div className="total-line"><span>Discount{Number(q.discount_fixed_cents) > 0 ? '' : ` ${Number(q.discount_percent)}%`}</span><span>−{money(Number(q.discount_amount_cents))}</span></div>
            )}
            <div className="total-line"><span>{q.gct_exempt ? 'GCT (exempt)' : 'GCT 15%'}</span><span>{money(Number(q.gct_cents))}</span></div>
            <div className="total-line grand"><span>Total</span><span>{money(Number(q.grand_total_cents))}</span></div>
          </div>
          {q.notes && <div className="paper-foot">{q.notes}</div>}
        </section>
        <aside className="inv-side">
          <section className="panel">
            <h2 className="side-h">Their answer</h2>
            {open ? (
              <>
                <p className="muted small" style={{ marginTop: 0 }}>
                  {q.status === 'Draft' ? 'Not sent yet.' : `Sent ${q.sent_date ? when(q.sent_date) : ''}. `}
                  If they tell you rather than using the link:
                </p>
                <div className="row" style={{ gap: 6 }}>
                  <button className="approve-soft" disabled={busy} onClick={accepted}>They accepted</button>
                  <button className="danger-soft" disabled={busy} onClick={declined}>They declined</button>
                </div>
                {q.status === 'Draft' && (
                  <p style={{ marginBottom: 0 }}><button type="button" className="danger-soft" disabled={busy} onClick={remove}>Delete this draft</button></p>
                )}
              </>
            ) : <p className="muted small" style={{ margin: 0 }}>{STATUS_WORDS[st] ?? st}.</p>}
          </section>
        </aside>
      </div>
    </>
  );
}
