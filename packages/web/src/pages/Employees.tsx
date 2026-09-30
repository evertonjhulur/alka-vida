import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, toCents, date, todayInJamaica, when } from '../lib/format';
import { ask, askText } from '../components/Dialog';

interface Employee {
  id: string; name: string; job_title: string | null;
  pay_basis: 'Hourly' | 'PerTrip'; rate_cents: string;
  phone: string | null; email: string | null;
  user_id: string | null; login_email: string | null;
  started_on: string | null; ended_on: string | null;
  active: boolean; notes: string | null;
  lifetime_cents: string;
}

interface Entry {
  id: string; work_date: string; basis: 'Hourly' | 'PerTrip';
  quantity: string; rate_cents: string; amount_cents: string;
  reference: string | null; notes: string | null;
  employee_name: string; recorded_by_name: string | null;
}

interface PeriodRow {
  employee_id: string; name: string; job_title: string | null;
  pay_basis: 'Hourly' | 'PerTrip'; rate_cents: string;
  quantity: string; amount_cents: string; entries: number;
}

interface Period {
  from: string | null; to: string | null;
  byEmployee: PeriodRow[]; totalCents: number;
}

interface Login { id: string; name: string; email: string; role: string; active: boolean }

const BLANK = {
  name: '', jobTitle: '', payBasis: 'Hourly' as 'Hourly' | 'PerTrip',
  rate: '', phone: '', email: '', userId: '', startedOn: '', notes: '',
};

/** "per hour" or "per trip", said the way the business says it. */
const per = (basis: string) => (basis === 'Hourly' ? 'per hour' : 'per trip');
const unit = (basis: string, n: number) => (basis === 'Hourly'
  ? `${n} hour${n === 1 ? '' : 's'}`
  : `${n} trip${n === 1 ? '' : 's'}`);

/** The first of the current month, for the payroll period default. */
const monthStart = () => `${todayInJamaica().slice(0, 7)}-01`;

/**
 * Employees, what they are paid, and the work they have done.
 *
 * Two things this eventually feeds, neither of them wired up yet:
 *
 *   * PAYROLL — what is owed to each person for a period.
 *   * TRUE PRODUCTION COST — today a case of water costs what its materials
 *     cost. The people who made it are not in that figure, so every margin
 *     in the system currently reads better than it is.
 *
 * Nothing here touches costing or any figure the business relies on today.
 * The rate is copied onto each entry when the work is recorded, so a rise
 * next year never rewrites what last year cost.
 */
export default function Employees({ session }: { session: Session }) {
  const [staff, setStaff] = useState<Employee[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [period, setPeriod] = useState<Period | null>(null);
  const [logins, setLogins] = useState<Login[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLeavers, setShowLeavers] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [nw, setNw] = useState({ ...BLANK });

  const [work, setWork] = useState({
    employeeId: '', workDate: todayInJamaica(), quantity: '',
    rate: '', reference: '', notes: '',
  });

  const [range, setRange] = useState({ from: monthStart(), to: todayInJamaica() });

  const isAdmin = session.role === 'admin';

  async function load() {
    const [s, e, p] = await Promise.all([
      api.get<Employee[]>('/api/employees'),
      api.get<Entry[]>('/api/labour'),
      api.get<Period>(`/api/labour/period?from=${range.from}&to=${range.to}`),
    ]);
    setStaff(s); setEntries(e); setPeriod(p);
  }

  useEffect(() => { load().catch((err) => setError(err.message)); }, []);

  // The logins an employee can be tied to. Admin-only on the server, so a
  // clerk simply does not get the picker rather than seeing an error.
  useEffect(() => {
    if (!isAdmin) return;
    api.get<Login[]>('/api/users').then(setLogins).catch(() => setLogins([]));
  }, [isAdmin]);

  async function run(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { await what(); await load(); } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  const body = (f: typeof BLANK) => ({
    name: f.name.trim(),
    jobTitle: f.jobTitle.trim() || null,
    payBasis: f.payBasis,
    rateCents: toCents(f.rate || '0'),
    phone: f.phone.trim() || null,
    email: f.email.trim() || null,
    userId: f.userId || null,
    startedOn: f.startedOn || null,
    notes: f.notes.trim() || null,
  });

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api.post('/api/employees', body(nw));
      setMsg(`${nw.name.trim()} added at ${money(toCents(nw.rate || '0'))} ${per(nw.payBasis)}.`);
      setNw({ ...BLANK });
      setShowNew(false);
    }, 'Could not add the employee');
  };

  const record = (e: React.FormEvent) => {
    e.preventDefault();
    const who = staff.find((p) => p.id === work.employeeId);
    return run(async () => {
      const r = await api.post<{ amountCents: number }>('/api/labour', {
        employeeId: work.employeeId,
        workDate: work.workDate,
        quantity: Number(work.quantity),
        rateCents: work.rate.trim() ? toCents(work.rate) : undefined,
        reference: work.reference.trim() || null,
        notes: work.notes.trim() || null,
      });
      setMsg(`${who?.name ?? 'Work'} — `
        + `${unit(who?.pay_basis ?? 'Hourly', Number(work.quantity))} `
        + `on ${work.workDate}, ${money(r.amountCents)}.`);
      setWork({ ...work, quantity: '', rate: '', reference: '', notes: '' });
    }, 'Could not record the work');
  };

  const removeEntry = async (en: Entry) => {
    if (!await ask(
      `Remove ${en.employee_name}'s ${unit(en.basis, Number(en.quantity))} `
      + `on ${when(en.work_date)}, worth ${money(Number(en.amount_cents))}?`,
      { confirmLabel: 'Remove', danger: true },
    )) return;
    return run(async () => {
      await api.del(`/api/labour/${en.id}`);
      setMsg('Entry removed.');
    }, 'Could not remove the entry');
  };

  // The logins the system already knows, turned into employee records so
  // nobody has to be retyped. Rates are left blank deliberately.
  const importFromLogins = () => run(async () => {
    const r = await api.post<{ created: string[]; skipped: string[] }>(
      '/api/employees/import', {});
    setMsg(r.created.length === 0
      ? 'Everyone with a login is already on the payroll — nothing to add.'
      : `Added ${r.created.join(', ')}. `
        + 'Rates are blank — set each one before recording any work.');
  }, 'Could not add from the logins');

  const reload = () => run(async () => {}, 'Could not reload');

  const active = staff.filter((p) => p.active);
  const left = staff.filter((p) => !p.active);
  const chosen = staff.find((p) => p.id === work.employeeId);

  /** The employee form, shared by "add" and "edit" — a plain function, not a component. */
  const form = (
    f: typeof BLANK,
    setF: (v: typeof BLANK) => void,
    id: string,
  ) => (
    <>
      <div className="row">
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} required value={f.name} style={{ width: '100%' }}
                 onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="field" style={{ flex: '1 1 180px' }}>
          <label htmlFor={`${id}-title`}>Job title</label>
          <input id={`${id}-title`} value={f.jobTitle} style={{ width: '100%' }}
                 placeholder="e.g. Driver, Production"
                 onChange={(e) => setF({ ...f, jobTitle: e.target.value })} />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-basis`}>Paid by</label>
          <select id={`${id}-basis`} value={f.payBasis}
                  onChange={(e) => setF({
                    ...f, payBasis: e.target.value as 'Hourly' | 'PerTrip',
                  })}>
            <option value="Hourly">The hour</option>
            <option value="PerTrip">The trip</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-rate`}>Rate ({per(f.payBasis)})</label>
          <input id={`${id}-rate`} inputMode="decimal" value={f.rate} placeholder="0.00"
                 onChange={(e) => setF({ ...f, rate: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-started`}>Started</label>
          <input id={`${id}-started`} type="date" value={f.startedOn}
                 onChange={(e) => setF({ ...f, startedOn: e.target.value })} />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-phone`}>Phone</label>
          <input id={`${id}-phone`} value={f.phone}
                 onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor={`${id}-email`}>Email</label>
          <input id={`${id}-email`} value={f.email} style={{ width: '100%' }}
                 onChange={(e) => setF({ ...f, email: e.target.value })} />
        </div>
        {logins.length > 0 && (
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label htmlFor={`${id}-login`}>Signs in as</label>
            <select id={`${id}-login`} value={f.userId} style={{ width: '100%' }}
                    onChange={(e) => setF({ ...f, userId: e.target.value })}>
              <option value="">No login</option>
              {logins.filter((u) => u.active).map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor={`${id}-notes`}>Notes</label>
        <input id={`${id}-notes`} value={f.notes} style={{ width: '100%' }}
               onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </div>
    </>
  );

  return (
    <>
      <h1>Employees</h1>
      <p className="subtitle">
        Who works here, what they are paid, and the hours and trips they have done.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="notice info">
        <strong>Not yet in your costs.</strong> A case of water still costs what its
        materials cost — nothing recorded here changes a price, a margin or a report.
        It is being collected now so payroll and true production cost have something
        real to read when they are built.
      </div>

      {/* ---------------- record work ---------------- */}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Record work</h2>
        {active.length === 0 ? (
          <p className="muted">
            Add an employee first — there is nobody to record work against.
          </p>
        ) : (
          <form onSubmit={record}>
            <div className="row">
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="w-who">Who</label>
                <select id="w-who" required value={work.employeeId} style={{ width: '100%' }}
                        onChange={(e) => setWork({ ...work, employeeId: e.target.value })}>
                  <option value="">Choose…</option>
                  {active.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {money(Number(p.rate_cents))} {per(p.pay_basis)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="w-date">Date worked</label>
                <input id="w-date" type="date" required value={work.workDate}
                       max={todayInJamaica()}
                       onChange={(e) => setWork({ ...work, workDate: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="w-qty">
                  {chosen?.pay_basis === 'PerTrip' ? 'Trips' : 'Hours'}
                </label>
                <input id="w-qty" required inputMode="decimal" value={work.quantity}
                       style={{ width: 90 }} placeholder="0"
                       onChange={(e) => setWork({ ...work, quantity: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="w-rate">Rate</label>
                <input id="w-rate" inputMode="decimal" value={work.rate} style={{ width: 110 }}
                       placeholder={chosen
                         ? (Number(chosen.rate_cents) / 100).toFixed(2)
                         : '0.00'}
                       onChange={(e) => setWork({ ...work, rate: e.target.value })} />
              </div>
              <div className="field" style={{ flex: '1 1 160px' }}>
                <label htmlFor="w-ref">Against (optional)</label>
                <input id="w-ref" value={work.reference} style={{ width: '100%' }}
                       placeholder="round, batch…"
                       onChange={(e) => setWork({ ...work, reference: e.target.value })} />
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <button disabled={busy || !work.employeeId || !work.quantity}>Record</button>
              </div>
            </div>

            {chosen && work.quantity && (
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                {unit(chosen.pay_basis, Number(work.quantity) || 0)} at{' '}
                {money(work.rate.trim() ? toCents(work.rate) : Number(chosen.rate_cents))}{' '}
                {per(chosen.pay_basis)} ={' '}
                <strong>
                  {money(Math.round((Number(work.quantity) || 0)
                    * (work.rate.trim() ? toCents(work.rate) : Number(chosen.rate_cents))))}
                </strong>
                {work.rate.trim() && toCents(work.rate) !== Number(chosen.rate_cents)
                  && ' — a one-off rate for this entry only.'}
              </p>
            )}
          </form>
        )}
      </div>

      {/* ---------------- payroll for a period ---------------- */}
      <div className="panel phone-cards">
        <div className="panel-head">
          <h2>What is owed</h2>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', margin: 0 }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="p-from">From</label>
              <input id="p-from" type="date" value={range.from}
                     onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="p-to">To</label>
              <input id="p-to" type="date" value={range.to}
                     onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </div>
            <button className="secondary" disabled={busy} onClick={reload}>Show</button>
          </div>
        </div>

        {!period || period.byEmployee.length === 0 ? (
          <p className="muted">Nothing recorded in this period.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Employee</th><th>Paid by</th>
                  <th className="num">Worked</th><th className="num">Rate</th>
                  <th className="num">Owed</th>
                </tr>
              </thead>
              <tbody>
                {period.byEmployee.map((r) => (
                  <tr key={r.employee_id}>
                    <td className="lead">
                      <span>
                        {r.name}
                        {r.job_title && <div className="muted small">{r.job_title}</div>}
                      </span>
                      <span className="chip neutral phone-only">
                        {money(Number(r.amount_cents))}
                      </span>
                    </td>
                    <td data-label="Paid by" className="small muted">
                      {r.pay_basis === 'Hourly' ? 'The hour' : 'The trip'}
                    </td>
                    <td data-label="Worked" className="num">
                      {Number(r.quantity) === 0
                        ? <span className="muted">—</span>
                        : unit(r.pay_basis, Number(r.quantity))}
                    </td>
                    <td data-label="Rate" className="num">{money(Number(r.rate_cents))}</td>
                    <td data-label="Owed" className="num money on-desktop">
                      {money(Number(r.amount_cents))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{
              justifyContent: 'space-between', borderTop: '2px solid var(--line)',
              paddingTop: 10, marginTop: 4, fontWeight: 700,
            }}>
              <span>Total for the period</span>
              <span>{money(period.totalCents)}</span>
            </div>
            <p className="muted small" style={{ margin: '10px 0 0' }}>
              Each entry is costed at the rate that was in force the day it was recorded,
              so a pay rise never restates an earlier week.
            </p>
          </>
        )}
      </div>

      {/* ---------------- the people ---------------- */}
      <div className="panel phone-cards">
        <div className="panel-head">
          <h2>On the payroll</h2>
          {isAdmin && (
            <div className="row" style={{ gap: 8, margin: 0 }}>
              <button className="secondary" disabled={busy} onClick={importFromLogins}>
                Add from logins
              </button>
              <button className="secondary" onClick={() => setShowNew(!showNew)}>
                {showNew ? 'Cancel' : 'Add an employee'}
              </button>
            </div>
          )}
        </div>

        {showNew && (
          <form onSubmit={add} style={{ marginBottom: 16 }}>
            {form(nw, setNw, 'new')}
            <button disabled={busy || !nw.name.trim()}>Add employee</button>
          </form>
        )}

        {active.length === 0 ? (
          <p className="muted">
            Nobody yet. <strong>Add from logins</strong> brings across everyone the
            system already knows — you then set their rates. Or add someone who has
            no login at all.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Paid by</th><th className="num">Rate</th>
                <th className="num">Recorded to date</th><th />
              </tr>
            </thead>
            <tbody>
              {active.map((p) => (
                  <tr key={p.id}>
                    <td className="lead">
                      <span>
                        <Link to={`/employees/${p.id}`}><strong>{p.name}</strong></Link>
                        <div className="muted small">
                          {p.job_title ?? 'No title'}
                          {p.login_email ? ` · signs in as ${p.login_email}` : ''}
                          {p.phone ? ` · ${p.phone}` : ''}
                        </div>
                      </span>
                      <span className={`chip ${Number(p.rate_cents) === 0 ? 'warn' : 'neutral'} phone-only`}>
                        {Number(p.rate_cents) === 0
                          ? 'Rate not set'
                          : `${money(Number(p.rate_cents))} ${per(p.pay_basis)}`}
                      </span>
                    </td>
                    <td data-label="Paid by" className="small muted">
                      {p.pay_basis === 'Hourly' ? 'The hour' : 'The trip'}
                    </td>
                    <td data-label="Rate" className="num on-desktop">
                      {Number(p.rate_cents) === 0
                        ? <span className="chip warn">Rate not set</span>
                        : money(Number(p.rate_cents))}
                    </td>
                    <td data-label="Recorded to date" className="num money">
                      {money(Number(p.lifetime_cents))}
                    </td>
                    <td className="num actions">
                      <Link to={`/employees/${p.id}`}>Open</Link>
                    </td>
                  </tr>
              ))}
            </tbody>
          </table>
        )}

        {left.length > 0 && (
          <>
            <p style={{ marginBottom: 0 }}>
              <button className="secondary" onClick={() => setShowLeavers(!showLeavers)}>
                {showLeavers ? 'Hide' : 'Show'} {left.length} who have left
              </button>
            </p>
            {showLeavers && (
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Name</th><th>Left</th>
                    <th className="num">Recorded to date</th><th />
                  </tr>
                </thead>
                <tbody>
                  {left.map((p) => (
                    <tr key={p.id}>
                      <td className="lead">
                        <span>
                          <Link to={`/employees/${p.id}`}>{p.name}</Link>
                          <div className="muted small">{p.job_title ?? ''}</div>
                        </span>
                      </td>
                      <td data-label="Left">{when(p.ended_on)}</td>
                      <td data-label="Recorded to date" className="num money">
                        {money(Number(p.lifetime_cents))}
                      </td>
                      <td className="num actions">
                        <Link to={`/employees/${p.id}`}>Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      {/* ---------------- what has been recorded ---------------- */}
      <div className="panel phone-cards">
        <div className="panel-head">
          <h2>Recently recorded</h2>
          <span className="muted small">Newest first</span>
        </div>
        {entries.length === 0 ? (
          <p className="muted">Nothing recorded yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Employee</th><th className="num">Worked</th>
                  <th className="num">Rate</th><th className="num">Cost</th>
                  <th>Against</th><th />
                </tr>
              </thead>
              <tbody>
                {entries.map((en) => (
                  <tr key={en.id}>
                    <td className="lead">
                      <span>
                        {when(en.work_date)}
                        <div className="muted small phone-only">{en.employee_name}</div>
                      </span>
                      <span className="chip neutral phone-only">
                        {money(Number(en.amount_cents))}
                      </span>
                    </td>
                    <td data-label="Employee" className="on-desktop">{en.employee_name}</td>
                    <td data-label="Worked" className="num">
                      {unit(en.basis, Number(en.quantity))}
                    </td>
                    <td data-label="Rate" className="num">{money(Number(en.rate_cents))}</td>
                    <td data-label="Cost" className="num money on-desktop">
                      {money(Number(en.amount_cents))}
                    </td>
                    <td data-label="Against" className="small muted">
                      {en.reference ?? '—'}
                      {en.recorded_by_name && (
                        <div className="small">entered by {en.recorded_by_name}</div>
                      )}
                    </td>
                    <td className="num actions">
                      {isAdmin && (
                        <button className="danger-soft" disabled={busy}
                                onClick={() => removeEntry(en)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
