import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date, todayInJamaica, BUSINESS_TIMEZONE, when } from '../lib/format';
import { NotifyPrompt } from '../components/NotificationsCard';

interface Aging {
  currentCents: number; d30Cents: number; d60Cents: number;
  d90Cents: number; totalCents: number;
}
interface Debtor {
  customer_id: string; name: string; balance_cents: string; days_overdue: number | null;
}
interface Round {
  id: string; zone: string; delivery_date: string; driver_name: string | null;
  stops: number; done: number; collected_cents: string; worth_cents: string;
}
interface Approval {
  id: string; request_type: string; entity_label: string | null; reason: string | null;
  amount_cents: string; discount_percent: string | null;
  customer_name: string | null; raised_by: string | null;
}
interface Application {
  id: string; account_type: string; business_name: string | null;
  first_name: string | null; last_name: string | null;
  parish: string | null; asked_on: string;
}
interface LowStock {
  id: string; name: string; category: string;
  quantity_on_hand: string; reorder_point: string; unit_of_measure: string;
}
interface DashboardData {
  aging: Aging;
  debtors: Debtor[];
  rounds: Round[];
  waiting: {
    applications: number; approvals: number;
    approvalDetail: Approval[]; applicationDetail: Application[];
  };
  lowStock: LowStock[];
}

const greeting = () => {
  // The hour in Jamaica, so "good morning" is not the browser's opinion.
  const h = Number(new Date().toLocaleString('en-GB', {
    timeZone: BUSINESS_TIMEZONE, hour: '2-digit', hour12: false,
  }));
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const today = () => new Date().toLocaleDateString('en-JM', {
  timeZone: BUSINESS_TIMEZONE,
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});

const applicantName = (a: Application) => (a.account_type === 'Corporate'
  ? a.business_name ?? 'A business'
  : [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Someone');

/**
 * The opening screen, built to answer one question: what needs me today?
 *
 * It used to list open delivery sheets and outstanding balances. Both were
 * records rather than prompts - true, and no help at all in deciding what to
 * do first. Everything here is chosen for whether it leads somewhere: money
 * that is LATE rather than merely large, rounds still running rather than
 * rounds that exist, and the things genuinely blocked on a decision.
 */
/** Each kind of request, in words (15 Oct 2026: delivery-day requests showed as "Credit note"). */
const DECISION_WORDS: Record<string, string> = {
  StopCorrection: 'Stop correction', SameDayOrder: 'Same-day order', PaymentChange: 'Payment change',
  SpecialDayOrder: 'Delivery day request',
};

export default function Dashboard({ session }: { session: Session }) {
  const [d, setD] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<DashboardData>('/api/dashboard').then(setD).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="notice error">{error}</div>;
  if (!d) return <p className="muted">Loading…</p>;

  const waiting = d.waiting.applications + d.waiting.approvals;
  /*
   * Every open round comes back, whatever its date. Shown under one
   * "Today's rounds" heading, a round finished yesterday but not yet settled
   * and a round booked for Thursday both read as out on the road today. Three
   * groups instead, each with the action it needs.
   */
  const todayIso = todayInJamaica();
  const day = (r: Round) => String(r.delivery_date).slice(0, 10);
  const finished = (r: Round) => r.stops > 0 && r.done === r.stops;
  const toSettle = d.rounds.filter((r) => finished(r) || day(r) < todayIso);
  const onRoad = d.rounds.filter((r) => day(r) === todayIso && !finished(r));
  const comingUp = d.rounds.filter((r) => day(r) > todayIso && !finished(r));
  const stopsLeft = onRoad.reduce((s, r) => s + (r.stops - r.done), 0);
  const overdue = d.aging.d30Cents + d.aging.d60Cents + d.aging.d90Cents;
  const firstName = session.name.split(' ')[0];

  /** A plain function returning JSX, not a nested component. */
  const figure = (
    to: string, label: string, value: string, sub: string,
    tone: 'plain' | 'bad' | 'attention' = 'plain',
  ) => (
    <Link className={`fig${tone === 'attention' ? ' attention' : ''}`} to={to}>
      <div className="fig-label">{label}</div>
      <div className="fig-value">{value}</div>
      <div className={`fig-sub${tone === 'plain' ? '' : ' bad'}`}>{sub}</div>
    </Link>
  );

  /** A plain function returning JSX, not a nested component. */
  const roundsTable = (list: Round[], settle = false) => (
    <table>
      <thead>
        <tr>
          <th>Round</th><th>Driver</th><th>Progress</th>
          <th className="num">Worth</th><th className="num">Collected</th><th />
        </tr>
      </thead>
      <tbody>
        {list.map((r) => {
          const pct = r.stops === 0 ? 0 : Math.round((r.done / r.stops) * 100);
          return (
            <tr key={r.id}>
              <td className="lead">
                <span>
                  {r.zone}
                  <div className="muted small">{when(r.delivery_date)}</div>
                </span>
                <span className="chip neutral phone-only">
                  {r.done} of {r.stops}
                </span>
              </td>
              <td data-label="Driver">
                {r.driver_name ?? <span className="muted">Not assigned</span>}
              </td>
              <td data-label="Progress" style={{ minWidth: 150 }}>
                <div className="small">{r.done} of {r.stops} done</div>
                <div className="bar"><span style={{ width: `${pct}%` }} /></div>
              </td>
              {/* What is ON the truck, not what the driver owes back: most
                  customers are on terms and pay nothing at the door. */}
              <td data-label="Worth" className="num">{money(Number(r.worth_cents))}</td>
              <td data-label="Collected" className="num money">
                {money(Number(r.collected_cents))}
              </td>
              <td className="num actions">
                {settle
                  ? <Link to={`/delivery/${r.id}/settlement`}>Settle</Link>
                  : <Link to={`/delivery/${r.id}`}>Open</Link>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="dash">
      <h1>{greeting()}, {firstName}</h1>
      <NotifyPrompt session={session} />
      <p className="subtitle">{today()} — Alka Vida operations</p>

      <div className="figures">
        {figure('/invoices', 'Owed to you', money(d.aging.totalCents),
          overdue > 0 ? `${money(overdue)} past due` : 'all within terms',
          overdue > 0 ? 'bad' : 'plain')}

        {figure('/delivery', 'Out today',
          onRoad.length === 1 ? '1 round' : `${onRoad.length} rounds`,
          [
            onRoad.length === 0 ? 'nothing on the road'
              : `${stopsLeft} stop${stopsLeft === 1 ? '' : 's'} still to do`,
            toSettle.length > 0 ? `${toSettle.length} to settle` : null,
          ].filter(Boolean).join(' · '))}

        {figure('/applications', 'Waiting on you', String(waiting),
          waiting === 0 ? 'nothing needs you' : [
            d.waiting.applications
              ? `${d.waiting.applications} account request${d.waiting.applications === 1 ? '' : 's'}`
              : null,
            d.waiting.approvals
              ? `${d.waiting.approvals} approval${d.waiting.approvals === 1 ? '' : 's'}`
              : null,
          ].filter(Boolean).join(', '),
          waiting > 0 ? 'attention' : 'plain')}

        {figure('/materials', 'Running low',
          d.lowStock.length === 0
            ? 'None'
            : `${d.lowStock.length} material${d.lowStock.length === 1 ? '' : 's'}`,
          d.lowStock.length === 0 ? 'nothing below its reorder point'
            : `${d.lowStock[0].name} is lowest`,
          d.lowStock.length > 0 ? 'bad' : 'plain')}
      </div>

      <div className="panel phone-cards">
        <div className="panel-head">
          <h2>On the road today</h2>
          <Link className="small" to="/delivery">All delivery rounds</Link>
        </div>
        {onRoad.length === 0 ? (
          <p className="muted">
            Nothing on the road today. Orders are routed onto a sheet as they come in.
          </p>
        ) : roundsTable(onRoad)}
      </div>

      {toSettle.length > 0 && (
        <div className="panel phone-cards">
          <div className="panel-head">
            <h2>Back and waiting to settle</h2>
          </div>
          <p className="muted small" style={{ marginTop: 0 }}>
            Every stop has an outcome, or the round&rsquo;s day has passed. Settling
            turns the driver&rsquo;s collections into payments on the customers&rsquo; accounts.
          </p>
          {roundsTable(toSettle, true)}
        </div>
      )}

      {comingUp.length > 0 && (
        <div className="panel phone-cards">
          <div className="panel-head">
            <h2>Coming up</h2>
          </div>
          {roundsTable(comingUp)}
        </div>
      )}

      {/* Side by side on a wide screen, stacked below it. */}
      <div className="split">
      <div className="panel phone-cards">
        <div className="panel-head">
          <h2>Money owed</h2>
          <Link className="small" to="/invoices">All invoices</Link>
        </div>

        {d.aging.totalCents === 0 ? (
          <p className="muted">Nothing outstanding. Every invoice is settled.</p>
        ) : (
          <>
            {/* Each figure opens its schedule (27 Oct 2026). */}
            <div className="aging">
              <Link className="age" to="/reports?tab=owed&age=current" title="See the invoices not yet due">
                <b>Not yet due</b><span>{money(d.aging.currentCents)}</span>
              </Link>
              <Link className="age" to="/reports?tab=owed&age=d30" title="See the invoices 1–30 days late">
                <b>1–30 days</b><span>{money(d.aging.d30Cents)}</span>
              </Link>
              <Link className="age" to="/reports?tab=owed&age=d60" title="See the invoices 31–60 days late">
                <b>31–60 days</b><span>{money(d.aging.d60Cents)}</span>
              </Link>
              <Link className={`age${d.aging.d90Cents > 0 ? ' over' : ''}`} to="/reports?tab=owed&age=d90" title="See the invoices over 60 days late">
                <b>Over 60 days</b><span>{money(d.aging.d90Cents)}</span>
              </Link>
            </div>

            <table style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th>Customer</th><th className="num">Owed</th>
                  <th className="num">Oldest unpaid</th><th />
                </tr>
              </thead>
              <tbody>
                {d.debtors.map((c) => {
                  const days = c.days_overdue == null ? null : Number(c.days_overdue);
                  const tone = days == null || days <= 0 ? 'ok'
                    : days > 60 ? 'bad' : days > 30 ? 'warn' : 'neutral';
                  return (
                    <tr key={c.customer_id}>
                      <td className="lead">
                        <span>{c.name}</span>
                        <span className={`chip ${tone} phone-only`}>
                          {days == null || days <= 0 ? 'not due' : `${days} days`}
                        </span>
                      </td>
                      <td data-label="Owed" className="num money">
                        {money(Number(c.balance_cents))}
                      </td>
                      <td className="num on-desktop">
                        <span className={`chip ${tone}`}>
                          {days == null || days <= 0 ? 'not due' : `${days} days`}
                        </span>
                      </td>
                      <td className="num actions"><Link to={`/customers/${c.customer_id}?tab=transactions`}>Statement</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted small" style={{ margin: '10px 0 0' }}>
              Sorted by how late, not how large — a big balance inside terms is business,
              a small one at ninety days is a problem.
            </p>
          </>
        )}
      </div>

      {/* Only the things the top bar's "Needs a decision" counts, so the two
          never disagree (UX review, 11 Oct 2026). Low stock is its own panel. */}
      {waiting > 0 && (
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Needs a decision</h2>
          <ul className="todo">
            {d.waiting.applicationDetail.map((a) => (
              <li key={a.id}>
                <span>
                  <strong>{applicantName(a)}</strong> asked to open an account
                  <div className="muted small">
                    {a.account_type === 'Corporate' ? 'Business' : 'Individual'}
                    {a.parish ? ` · ${a.parish}` : ''} · asked {when(a.asked_on)}
                  </div>
                </span>
                <Link to="/applications">Review</Link>
              </li>
            ))}

            {d.waiting.approvalDetail.map((a) => (
              <li key={a.id}>
                <span>
                  <strong>
                    {a.request_type === 'Discount'
                      ? `${a.discount_percent ?? ''}% discount`
                      : a.request_type === 'CreditNote' ? `Credit note ${money(Number(a.amount_cents))}`
                        : `${DECISION_WORDS[a.request_type] ?? a.request_type}${Number(a.amount_cents) ? ` ${money(Number(a.amount_cents))}` : ''}`}
                  </strong>
                  {a.customer_name ? ` — ${a.customer_name}` : ''}
                  <div className="muted small">
                    {a.entity_label ?? ''}{a.raised_by ? ` · raised by ${a.raised_by}` : ''}
                  </div>
                </span>
                <Link to="/decisions">Decide</Link>
              </li>
            ))}

          </ul>
      </div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Running low</h2>
        {d.lowStock.length === 0 ? (
          <p className="muted">Nothing is below its reorder point.</p>
        ) : (
          <ul className="todo">
            {d.lowStock.slice(0, 4).map((m) => (
              <li key={m.id}>
                <span>
                  <strong>{m.name}</strong> is below its reorder point
                  <div className="muted small">
                    {Number(m.quantity_on_hand).toLocaleString()} {m.unit_of_measure} on hand,
                    reorder at {Number(m.reorder_point).toLocaleString()}
                  </div>
                </span>
                <Link to="/purchase-orders">Raise a PO</Link>
              </li>
            ))}
            {d.lowStock.length > 4 && (
              <li><Link to="/materials">and {d.lowStock.length - 4} more on Raw materials</Link></li>
            )}
          </ul>
        )}
      </div>
      </div>
    </div>
  );
}
