import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { money, todayInJamaica, when } from '../lib/format';
import { ask } from '../components/Dialog';

/**
 * The portal's Order History (Everton, 15 Oct 2026), laid out like a shop's
 * order history: a filter across the top (All, Pending, Completed, Standing
 * orders) and a period on the right; one quiet row per order with the date,
 * number, what is on it, the total and where it stands in bold, and an arrow
 * to its own page. Nothing is done on the list any more: Cancel and "Make it
 * a standing order" moved to the order's page, and a standing order's page
 * is where it is changed, paused or stopped.
 *
 * Plain functions returning JSX, never components declared inside another
 * (see HANDOFF, "Never declare a React component inside another component").
 */

interface MyOrder {
  id: string; order_number: string; order_date: string;
  requested_delivery_date: string | null; status: string;
  delivery_mode: string; grand_total_cents: number; source: string;
  sheet_started?: boolean | null; sheet_status?: string | null; needs_review?: boolean;
  customer_po?: string | null; lines_summary?: string | null;
  is_recurring?: boolean; parent_recurring_id?: string | null;
  remaining_summary?: string | null;
  ready_at?: string | null; load_logged_at?: string | null; review_reason?: string | null;
}

interface Schedule {
  id: string; orderNumber: string; pattern: string;
  nextDeliveryDate: string | null; paused: boolean;
  occurrencesRaised: number; lineSummary: string;
}

interface Line {
  product_name: string; bottles_per_case: number; is_bottle_charge: boolean;
  cases: number; loose_bottles: number; price_per_case_cents: number; price_per_bottle_cents: number;
  delivered_cases: number; delivered_loose: number; line_total_cents: number;
}

interface OrderDetail {
  id: string; order_number: string; order_date: string; requested_delivery_date: string | null;
  status: string; delivery_mode: string; notes: string | null; customer_po: string | null;
  needs_review: boolean; subtotal_cents: number; discount_amount_cents: number; gct_cents: number;
  grand_total_cents: number; gct_exempt: boolean; is_recurring: boolean; parent_recurring_id: string | null;
  recurrence_pattern: string | null; empties_expected: number | null; fulfilled_on: string | null;
  sheet_started: boolean;
  ready_at?: string | null; load_logged_at?: string | null; review_reason?: string | null;
  lines: Line[];
  invoices: Array<{ invoice_id: string; invoice_number: string; invoice_date: string;
    grand_total_cents: number; balance_cents: number; status: string }>;
  address: { label: string | null; line: string | null };
  events?: Array<{ kind: string; from: string; to: string; reason: string | null }>;
}

interface ScheduleDetail {
  id: string; order_number: string; pattern: string; next_delivery_date: string | null;
  paused: boolean; ends_on: string | null; delivery_mode: string; notes: string | null;
  subtotal_cents: number; gct_cents: number; grand_total_cents: number;
  lines: Line[];
  raised: Array<{ id: string; order_number: string; requested_delivery_date: string | null; status: string; grand_total_cents: number }>;
  address: { label: string | null; line: string | null };
}

type Show = 'all' | 'pending' | 'completed' | 'standing';
type Period = 'all' | '30' | '180' | 'year';

const SHOWS: ReadonlyArray<readonly [Show, string]> = [
  ['all', 'All'], ['pending', 'Pending'], ['completed', 'Completed'], ['standing', 'Standing orders'],
];
const PERIODS: ReadonlyArray<readonly [Period, string]> = [
  ['all', 'All time'], ['30', 'Last 30 days'], ['180', 'Last 6 months'], ['year', 'This year'],
];
export const PATTERNS = [['Weekly', 'Every week'], ['Biweekly', 'Every two weeks'], ['Monthly', 'Every month']] as const;
export const patternWords = (p: string | null | undefined) => PATTERNS.find(([k]) => k === p)?.[1] ?? (p ?? '');

const short = (s: string | null | undefined) => (s ?? '').replace(/Alka Vida\s+/gi, '');

/** Long date, as the order page heads it: "Saturday 10 October 2026". */
function longDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Where an order stands, in the customer's words. */
export function customerStatus(o: { status: string; delivery_mode: string; needs_review?: boolean | null;
  sheet_started?: boolean | null; sheet_status?: string | null; requested_delivery_date?: string | null;
  ready_at?: string | null; load_logged_at?: string | null; review_reason?: string | null }): string {
  if (o.status === 'Cancelled') return 'Cancelled';
  if (o.status === 'Delivered') return o.delivery_mode === 'Pickup' ? 'Collected' : 'Delivered';
  if (o.status === 'Partially Delivered') return 'Partially delivered';
  if (o.needs_review) return o.review_reason === 'SpecialDay' ? 'Waiting for us to confirm the day' : 'Being confirmed';
  if (o.sheet_started && (o.sheet_status == null || o.sheet_status === 'Open')) return 'Out for delivery';
  const ready = !!o.ready_at || (!!o.load_logged_at && (o.sheet_status == null || o.sheet_status === 'Open'));
  const d = o.requested_delivery_date ? ` ${when(o.requested_delivery_date)}` : '';
  if (o.delivery_mode === 'Pickup') return ready ? 'Ready to collect' : `Order received · to collect${d}`;
  return ready ? `Ready · for delivery${d}` : `Order received · for${d || ' your next delivery day'}`;
}
const isPending = (o: { status: string }) => o.status === 'Pending' || o.status === 'Partially Delivered';
const canChange = (o: { status: string; sheet_started?: boolean | null; sheet_status?: string | null }) =>
  o.status === 'Pending' && !(o.sheet_started && (o.sheet_status == null || o.sheet_status === 'Open'));

/** A water bottle drawn in line, for the tile beside each order. */
function bottleTile(big: boolean, label: string) {
  return (
    <div className="oh-tile" aria-hidden="true">
      {big ? (
        <svg viewBox="0 0 48 64" width="40" height="54">
          <rect x="18" y="2" width="12" height="7" rx="2" fill="#0e76bc" />
          <path d="M14 12h20l6 8v34a8 8 0 0 1-8 8H16a8 8 0 0 1-8-8V20z" fill="#cfe6f7" stroke="#0e76bc" strokeWidth="2" />
          <path d="M9 30h30M9 44h30" stroke="#0e76bc" strokeWidth="1.5" opacity=".5" />
        </svg>
      ) : (
        <svg viewBox="0 0 48 64" width="40" height="54">
          <rect x="20" y="2" width="8" height="6" rx="1.5" fill="#0e76bc" />
          <path d="M19 9h10v6l5 7v34a6 6 0 0 1-6 6h-8a6 6 0 0 1-6-6V22l5-7z" fill="#cfe6f7" stroke="#0e76bc" strokeWidth="2" />
          <rect x="14" y="32" width="20" height="12" fill="#2d3590" opacity=".8" />
        </svg>
      )}
      <span>{label}</span>
    </div>
  );
}

function tileFor(summary: string | null | undefined) {
  const s = short(summary);
  const first = s.split(',')[0]?.trim() ?? '';
  const big = /5\s*gal/i.test(first);
  // "5 cs 5L" → "5L", "5 x 5 Gallon" → "5 Gallon"
  const name = first.replace(/^\d+\s*(cs\s*(\+\s*\d+\s*)?|x\s*)/i, '').trim();
  return bottleTile(big, name || 'Water');
}

/** How many items: "5 cases", "3 bottles", "2 products". */
function itemCount(summary: string | null | undefined): string {
  const parts = short(summary).split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length > 1) return `${parts.length} products`;
  const m = /^(\d+)\s*(cs)?/i.exec(parts[0]);
  if (!m) return parts[0];
  const n = Number(m[1]);
  return m[2] ? `${n} case${n === 1 ? '' : 's'}` : `${n} bottle${n === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

export function OrderHistory({ start = 'all' }: { start?: Show }) {
  const navigate = useNavigate();
  const [show, setShow] = useState<Show>(start);
  const [period, setPeriod] = useState<Period>('all');
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setShow(start); }, [start]);
  useEffect(() => {
    Promise.all([
      api.get<MyOrder[]>('/api/orders?limit=500'),
      api.get<Schedule[]>('/api/portal/recurring'),
    ]).then(([o, s]) => { setOrders(o); setSchedules(s); }).catch((e) => setError(e.message));
  }, []);

  const today = todayInJamaica();
  const since = period === 'all' ? null
    : period === 'year' ? `${today.slice(0, 4)}-01-01`
      : (() => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - Number(period)); return d.toISOString().slice(0, 10); })();
  const inPeriod = (d: string | null | undefined) => !since || (!!d && String(d).slice(0, 10) >= since);

  const list = (orders ?? []).filter((o) => inPeriod(o.order_date)
    && (show === 'all' ? true : show === 'pending' ? isPending(o) : show === 'completed' ? o.status === 'Delivered' : false));
  const standing = schedules.filter((s) => show === 'standing' || show === 'all' ? true : false);

  const orderRow = (o: MyOrder) => (
    <Link key={o.id} to={`/portal/orders/${o.id}`} className="oh-row">
      <div className="oh-text">
        <strong>{longDate(o.order_date).replace(/^\w+ /, '')}</strong>
        <span>Order {o.order_number}{o.parent_recurring_id ? ' · from a standing order' : ''}</span>
        <span>{itemCount(o.lines_summary)}{o.lines_summary ? ` · ${short(o.lines_summary)}` : ''}</span>
        <span>{money(Number(o.grand_total_cents))}</span>
        <strong className={`oh-status ${o.status === 'Cancelled' ? 'muted' : ''}`}>{customerStatus(o)}</strong>
      </div>
      {tileFor(o.lines_summary)}
      <span className="oh-arrow" aria-hidden="true">›</span>
    </Link>
  );

  const scheduleRow = (s: Schedule) => (
    <Link key={s.id} to={`/portal/standing/${s.id}`} className="oh-row">
      <div className="oh-text">
        <strong>{patternWords(s.pattern)}</strong>
        <span>Standing order · from {s.orderNumber}</span>
        <span>{short(s.lineSummary) || '—'}</span>
        <span>{s.nextDeliveryDate && !s.paused ? `Next: ${when(s.nextDeliveryDate)}` : s.paused ? 'Nothing coming while paused' : '—'}</span>
        <strong className={`oh-status ${s.paused ? 'warn' : ''}`}>{s.paused ? 'Paused' : 'Active'}</strong>
      </div>
      {tileFor(s.lineSummary)}
      <span className="oh-arrow" aria-hidden="true">›</span>
    </Link>
  );

  return (
    <div className="oh">
      <h2 className="oh-title">Order History</h2>
      <div className="oh-filters">
        <div className="oh-radios" role="radiogroup" aria-label="Which orders">
          {SHOWS.map(([k, w]) => (
            <label key={k} className={`oh-radio${show === k ? ' on' : ''}`}>
              <input type="radio" name="oh-show" checked={show === k}
                     onChange={() => { setShow(k); navigate(k === 'standing' ? '/portal/orders?show=standing' : '/portal/orders', { replace: true }); }} />
              <span>{w}</span>
            </label>
          ))}
        </div>
        {show !== 'standing' && (
          <select aria-label="Period" className="oh-period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map(([k, w]) => <option key={k} value={k}>{w}</option>)}
          </select>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}
      {orders === null && !error && <p className="muted">Loading…</p>}

      {orders !== null && (
        <div className="oh-list">
          {show === 'all' && standing.length > 0 && (
            <>
              <div className="oh-group">Standing orders</div>
              {standing.map(scheduleRow)}
              <div className="oh-group">Orders</div>
            </>
          )}
          {show === 'standing' ? standing.map(scheduleRow) : list.map(orderRow)}
          {show === 'standing' && standing.length === 0 && (
            <p className="muted oh-empty">
              No standing orders. When you place an order, switch on <strong>Make this a standing order</strong> to
              have it sent regularly.
            </p>
          )}
          {show !== 'standing' && list.length === 0 && (
            <p className="muted oh-empty">
              {(orders ?? []).length === 0
                ? <>No orders yet. Use <Link to="/portal/order">Place an order</Link> to make your first one.</>
                : 'No orders match. Try another choice above.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared pieces of the two detail pages                               */
/* ------------------------------------------------------------------ */

function linesTable(lines: Line[], showDelivered: boolean) {
  return (
    <div className="oh-items">
      {lines.map((l, i) => {
        const cased = Number(l.bottles_per_case) > 0;
        const qty = cased ? Number(l.cases) : Number(l.loose_bottles);
        const got = cased ? Number(l.delivered_cases) : Number(l.delivered_loose);
        const unit = cased ? Number(l.price_per_case_cents) : Number(l.price_per_bottle_cents);
        return (
          <div className="oh-item" key={i}>
            {bottleTile(/5\s*gal/i.test(l.product_name) || l.is_bottle_charge, '')}
            <div className="oh-item-what">
              <strong>{short(l.product_name)}</strong>
              <span>{qty} {cased ? `case${qty === 1 ? '' : 's'} of ${l.bottles_per_case}` : `bottle${qty === 1 ? '' : 's'}`}</span>
              <span className="muted">{money(unit)} {cased ? 'a case' : 'each'}</span>
            </div>
            <div className="oh-item-money">{money(Number(l.line_total_cents))}</div>
            {showDelivered && (
              <div className="oh-item-state">
                {got >= qty ? <strong>Delivered</strong>
                  : got > 0 ? <><strong>Part delivered</strong><span className="muted">{qty - got} still to come</span></>
                    : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function summaryBox(rows: Array<[string, number]>, total: [string, number]) {
  return (
    <div className="oh-summary">
      <h3>Order summary</h3>
      {rows.map(([k, v]) => (
        <div className="total-line" key={k}><span>{k}</span><span>{v < 0 ? `−${money(-v)}` : money(v)}</span></div>
      ))}
      <div className="total-line grand"><span>{total[0]}</span><span>{money(total[1])}</span></div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One order                                                           */
/* ------------------------------------------------------------------ */

export function PortalOrderDetail() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [o, setO] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);

  const load = () => api.get<OrderDetail>(`/api/portal/orders/${orderId}`).then(setO).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { await what(); await load(); } catch (e) { setError(e instanceof Error ? e.message : fallback); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!o) return;
    if (!await ask(`Cancel order ${o.order_number}?\n\nIt will not be delivered.`,
      { confirmLabel: 'Cancel the order', cancelLabel: 'Keep it', danger: true })) return;
    await act(async () => {
      await api.post(`/api/portal/orders/${o.id}/cancel`, {});
      setMsg(`Order ${o.order_number} has been cancelled.`);
    }, 'Could not cancel the order');
  }
  async function makeStanding(pattern: string) {
    if (!o) return;
    await act(async () => {
      const r = await api.post<{ nextDeliveryDate: string }>(`/api/portal/orders/${o.id}/repeat`, { pattern });
      setRepeatOpen(false);
      setMsg(`${o.order_number} is now a standing order: ${patternWords(pattern).toLowerCase()}, the next on ${when(r.nextDeliveryDate)}.`);
    }, 'Could not set up the standing order');
  }

  const back = <p className="oh-back"><Link to="/portal/orders">‹ Order History</Link></p>;
  if (error && !o) return <>{back}<div className="notice error">{error}</div></>;
  if (!o) return <>{back}<p className="muted">Loading…</p></>;

  const status = customerStatus({ ...o, sheet_status: null });
  const changeable = canChange({ ...o, sheet_status: null });
  const canRepeat = changeable && !o.is_recurring && !o.parent_recurring_id;
  const discount = Number(o.discount_amount_cents);

  return (
    <div className="oh-detail">
      {back}
      <div className="oh-head">
        <div className="oh-head-line">
          <strong>{longDate(o.order_date)}</strong>
          <span className="oh-sep">|</span>
          <strong>Order {o.order_number}</strong>
          <span className="oh-sep">|</span>
          <strong className={o.status === 'Cancelled' ? 'muted' : ''}>{status}</strong>
        </div>
        <div className="oh-actions">
          {canRepeat && (
            <button type="button" className="secondary" disabled={busy} onClick={() => setRepeatOpen(!repeatOpen)}>
              {repeatOpen ? 'Not now' : 'Make it a standing order'}
            </button>
          )}
          {changeable && (
            <button type="button" className="danger-soft" disabled={busy} onClick={cancel}>Cancel order</button>
          )}
          {o.status === 'Pending' && !changeable && <span className="muted small">On its way. Call us to change it.</span>}
        </div>
      </div>
      {o.is_recurring && (
        <div className="notice info">This order is a standing order ({patternWords(o.recurrence_pattern).toLowerCase()}).{' '}
          <Link to={`/portal/standing/${o.id}`}>Change or stop it</Link></div>
      )}
      {o.parent_recurring_id && (
        <div className="notice info">Raised for you by a standing order. <Link to={`/portal/standing/${o.parent_recurring_id}`}>See the standing order</Link></div>
      )}
      {msg && <div className="notice ok">{msg}</div>}
      {error && <div className="notice error">{error}</div>}

      {repeatOpen && (
        <div className="panel oh-repeat">
          <strong>Get this order again, regularly</strong>
          <p className="muted small" style={{ margin: '4px 0 10px' }}>
            We raise the same order for you each time, about a week before it is due, at your prices on the day.
            You can change, pause or stop it from Order History.
          </p>
          <div className="row" style={{ gap: 8 }}>
            {PATTERNS.map(([k, w]) => (
              <button key={k} type="button" disabled={busy} onClick={() => makeStanding(k)}>{w}</button>
            ))}
          </div>
        </div>
      )}

      {(o.events?.length ?? 0) > 0 && (
        <ul className="order-events">
          {o.events!.map((ev, i) => (
            <li key={i} className={ev.kind === 'Part delivered' ? 'part' : undefined}>
              {ev.kind === 'Rescheduled'
                ? `Rescheduled from ${when(ev.from)} to ${when(ev.to)}${ev.reason ? ` (${ev.reason})` : ''}`
                : `Part delivered ${when(ev.from)}; the rest on ${when(ev.to)}`}
            </li>
          ))}
        </ul>
      )}

      <h3 className="oh-section">Items ({o.lines.length})</h3>
      {linesTable(o.lines, o.status === 'Partially Delivered' || o.status === 'Delivered')}

      <div className="panel oh-box">
        <div className="oh-details">
          <h3>Order details</h3>
          <div className="oh-details-grid">
            <div>
              <div className="oh-label">{o.delivery_mode === 'Pickup' ? 'Collection' : 'Delivery address'}</div>
              {o.delivery_mode === 'Pickup' ? <div>You collect from our plant</div>
                : <div>{o.address.label && <strong>{o.address.label}<br /></strong>}{o.address.line ?? 'Your main address'}</div>}
            </div>
            <div>
              <div className="oh-label">{o.delivery_mode === 'Pickup' ? 'Collection day' : 'Delivery date'}</div>
              <div>{o.fulfilled_on ? `${o.delivery_mode === 'Pickup' ? 'Collected' : 'Delivered'} ${when(o.fulfilled_on)}`
                : o.needs_review ? 'Being confirmed with you'
                  : o.requested_delivery_date ? when(o.requested_delivery_date) : 'Your next delivery day'}</div>
            </div>
            {o.customer_po && <div><div className="oh-label">Your PO</div><div>{o.customer_po}</div></div>}
            {o.empties_expected != null && <div><div className="oh-label">Empty bottles to hand over</div><div>{o.empties_expected}</div></div>}
            {o.notes && <div><div className="oh-label">Your note</div><div>{o.notes}</div></div>}
            <div>
              <div className="oh-label">Invoice</div>
              {o.invoices.length === 0
                ? <div className="muted">Raised when it is {o.delivery_mode === 'Pickup' ? 'collected' : 'delivered'}</div>
                : o.invoices.map((i) => (
                    <div key={i.invoice_id}>
                      <Link to={`/portal/invoices/${i.invoice_id}`}>{i.invoice_number}</Link>
                      {' '}<span className="muted small">{Number(i.balance_cents) > 0 ? `${money(Number(i.balance_cents))} to pay` : 'paid'}</span>
                    </div>
                  ))}
            </div>
          </div>
        </div>
        {summaryBox([
          ['Subtotal', Number(o.subtotal_cents)],
          ...(discount > 0 ? [['Discount', -discount] as [string, number]] : []),
          [o.gct_exempt ? 'GCT (exempt)' : 'GCT 15%', Number(o.gct_cents)],
        ], ['Order total', Number(o.grand_total_cents)])}
      </div>
      <p className="muted small">
        The total is what we expect. The invoice is made from what is actually delivered on the day.
      </p>
      <p><button type="button" className="as-link" onClick={() => navigate('/portal/order')}>Place another order</button></p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One standing order                                                  */
/* ------------------------------------------------------------------ */

export function PortalStandingDetail() {
  const { scheduleId } = useParams();
  const [s, setS] = useState<ScheduleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ pattern: string; next: string } | null>(null);

  const load = () => api.get<ScheduleDetail>(`/api/portal/recurring/${scheduleId}`).then(setS).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, [scheduleId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { await what(); await load(); } catch (e) { setError(e instanceof Error ? e.message : fallback); } finally { setBusy(false); }
  }
  const ended = !!s && !s.next_delivery_date && !s.paused;

  const back = <p className="oh-back"><Link to="/portal/orders?show=standing">‹ Order History</Link></p>;
  if (error && !s) return <>{back}<div className="notice error">{error}</div></>;
  if (!s) return <>{back}<p className="muted">Loading…</p></>;

  return (
    <div className="oh-detail">
      {back}
      <div className="oh-head">
        <div className="oh-head-line">
          <strong>{patternWords(s.pattern)}</strong>
          <span className="oh-sep">|</span>
          <strong>Standing order {s.order_number}</strong>
          <span className="oh-sep">|</span>
          <strong>{ended ? 'Stopped' : s.paused ? 'Paused' : 'Active'}</strong>
        </div>
        {!ended && (
          <div className="oh-actions">
            <button type="button" className="secondary" disabled={busy}
                    onClick={() => setEdit(edit ? null : { pattern: s.pattern, next: s.next_delivery_date ?? '' })}>
              {edit ? 'Close' : 'Edit'}
            </button>
            <button type="button" className="secondary" disabled={busy}
                    onClick={() => act(async () => {
                      await api.post(`/api/portal/recurring/${s.id}/pause`, { paused: !s.paused });
                      setMsg(s.paused ? 'Your standing order has started again.' : 'Paused. Nothing is sent until you start it again.');
                    }, 'Could not change it')}>
              {s.paused ? 'Start again' : 'Pause'}
            </button>
            <button type="button" className="danger-soft" disabled={busy}
                    onClick={async () => {
                      if (!await ask('Cancel this standing order for good?\n\nAnything already delivered is unaffected. To stop it for a while, use Pause.',
                        { confirmLabel: 'Cancel it', cancelLabel: 'Keep it', danger: true })) return;
                      await act(async () => {
                        await api.post(`/api/portal/recurring/${s.id}/cancel`, {});
                        setMsg('Your standing order is cancelled.');
                      }, 'Could not cancel it');
                    }}>
              Cancel standing order
            </button>
          </div>
        )}
      </div>
      {msg && <div className="notice ok">{msg}</div>}
      {error && <div className="notice error">{error}</div>}

      {edit && (
        <form className="panel oh-repeat" onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api.post(`/api/portal/recurring/${s.id}/update`, {
              pattern: edit.pattern, nextDeliveryDate: edit.next && edit.next !== s.next_delivery_date ? edit.next : null,
            });
            setEdit(null);
            setMsg('Your standing order is updated.');
          }, 'Could not save the change');
        }}>
          <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="so-often">How often</label>
              <select id="so-often" value={edit.pattern} onChange={(e) => setEdit({ ...edit, pattern: e.target.value })}>
                {PATTERNS.map(([k, w]) => <option key={k} value={k}>{w}</option>)}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="so-next">Next delivery</label>
              <input id="so-next" type="date" min={todayInJamaica()} value={edit.next}
                     onChange={(e) => setEdit({ ...edit, next: e.target.value })} />
            </div>
            <button disabled={busy}>Save</button>
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>
            To change what comes each time, call or WhatsApp us, or cancel this one and place a new order as a standing order.
          </p>
        </form>
      )}

      <h3 className="oh-section">Each time ({s.lines.length})</h3>
      {linesTable(s.lines, false)}

      <div className="panel oh-box">
        <div className="oh-details">
          <h3>Details</h3>
          <div className="oh-details-grid">
            <div>
              <div className="oh-label">{s.delivery_mode === 'Pickup' ? 'Collection' : 'Delivery address'}</div>
              {s.delivery_mode === 'Pickup' ? <div>You collect from our plant</div>
                : <div>{s.address.label && <strong>{s.address.label}<br /></strong>}{s.address.line ?? 'Your main address'}</div>}
            </div>
            <div>
              <div className="oh-label">Next one</div>
              <div>{ended ? 'None: this standing order has stopped' : s.paused ? 'None while paused' : when(s.next_delivery_date)}</div>
            </div>
            <div>
              <div className="oh-label">How often</div>
              <div>{patternWords(s.pattern)}</div>
            </div>
          </div>
        </div>
        {summaryBox([['Subtotal', Number(s.subtotal_cents)], ['GCT', Number(s.gct_cents)]],
          ['Each time, about', Number(s.grand_total_cents)])}
      </div>

      {s.raised.length > 0 && (
        <>
          <h3 className="oh-section">Orders from it</h3>
          <div className="oh-list">
            {s.raised.map((r) => (
              <Fragment key={r.id}>
                <Link to={`/portal/orders/${r.id}`} className="oh-row compact">
                  <div className="oh-text">
                    <strong>{r.requested_delivery_date ? when(r.requested_delivery_date) : '—'}</strong>
                    <span>Order {r.order_number} · {money(Number(r.grand_total_cents))}</span>
                  </div>
                  <strong className="oh-status">{r.status === 'Pending' ? 'Pending' : r.status}</strong>
                  <span className="oh-arrow" aria-hidden="true">›</span>
                </Link>
              </Fragment>
            ))}
          </div>
        </>
      )}
      <p className="muted small">Prices are your prices on the day each order is raised. Missed weeks while paused are not made up.</p>
    </div>
  );
}
