import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date } from '../lib/format';

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
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const today = () => new Date().toLocaleDateString('en-JM', {
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
export default function Dashboard({ session }: { session: Session }) {
  const [d, setD] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<DashboardData>('/api/dashboard').then(setD).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="notice error">{error}</div>;
  if (!d) return <p className="muted">Loading…</p>;

  const waiting = d.waiting.applications + d.waiting.approvals;
  const stopsLeft = d.rounds.reduce((s, r) => s + (r.stops - r.done), 0);
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

  return (
    <div className="dash">
      <h1>{greeting()}, {firstName}</h1>
      <p className="subtitle">{today()} — Alka Vida operations</p>

      <div className="figures">
        {figure('/statement', 'Owed to you', money(d.aging.totalCents),
          overdue > 0 ? `${money(overdue)} past due` : 'all within terms',
          overdue > 0 ? 'bad' : 'plain')}

        {figure('/delivery', 'Out today',
          d.rounds.length === 1 ? '1 round' : `${d.rounds.length} rounds`,
          d.rounds.length === 0 ? 'nothing on the road'
            : `${stopsLeft} stop${stopsLeft === 1 ? '' : 's'} still to do`)}

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
          <h2>Today&rsquo;s rounds</h2>
          <Link className="small" to="/delivery">All delivery sheets</Link>
        </div>
        {d.rounds.length === 0 ? (
          <p className="muted">
            No rounds open. Orders are routed onto a sheet as they come in.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Round</th><th>Driver</th><th>Progress</th>
                <th className="num">Worth</th><th className="num">Collected</th><th />
              </tr>
            </thead>
            <tbody>
              {d.rounds.map((r) => {
                const pct = r.stops === 0 ? 0 : Math.round((r.done / r.stops) * 100);
                return (
                  <tr key={r.id}>
                    <td className="lead">
                      <span>
                        {r.zone}
                        <div className="muted small">{date(r.delivery_date)}</div>
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
                      <Link to={`/delivery/${r.id}`}>Open</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Side by side on a wide screen, stacked below it. */}
      <div className="split">
      <div className="panel phone-cards">
        <div className="panel-head">
          <h2>Money owed</h2>
          <Link className="small" to="/statement">Statements</Link>
        </div>

        {d.aging.totalCents === 0 ? (
          <p className="muted">Nothing outstanding. Every invoice is settled.</p>
        ) : (
          <>
            <div className="aging">
              <div className="age">
                <b>Not yet due</b><span>{money(d.aging.currentCents)}</span>
              </div>
              <div className="age">
                <b>1–30 days</b><span>{money(d.aging.d30Cents)}</span>
              </div>
              <div className="age">
                <b>31–60 days</b><span>{money(d.aging.d60Cents)}</span>
              </div>
              <div className={`age${d.aging.d90Cents > 0 ? ' over' : ''}`}>
                <b>Over 60 days</b><span>{money(d.aging.d90Cents)}</span>
              </div>
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
                      <td className="num actions"><Link to="/statement">Statement</Link></td>
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

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Needs a decision</h2>
        {waiting === 0 && d.lowStock.length === 0 ? (
          <p className="muted">Nothing is waiting on you.</p>
        ) : (
          <ul className="todo">
            {d.waiting.applicationDetail.map((a) => (
              <li key={a.id}>
                <span>
                  <strong>{applicantName(a)}</strong> asked to open an account
                  <div className="muted small">
                    {a.account_type === 'Corporate' ? 'Business' : 'Individual'}
                    {a.parish ? ` · ${a.parish}` : ''} · asked {date(a.asked_on)}
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
                      : `Credit note ${money(Number(a.amount_cents))}`}
                  </strong>
                  {a.customer_name ? ` — ${a.customer_name}` : ''}
                  <div className="muted small">
                    {a.entity_label ?? ''}{a.raised_by ? ` · raised by ${a.raised_by}` : ''}
                  </div>
                </span>
                <Link to="/approvals">Approve</Link>
              </li>
            ))}

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
          </ul>
        )}
      </div>
      </div>
    </div>
  );
}
