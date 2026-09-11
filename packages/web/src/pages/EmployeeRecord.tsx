import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date, toCents, todayInJamaica } from '../lib/format';

interface Employee {
  id: string; name: string; job_title: string | null;
  pay_basis: 'Hourly' | 'PerTrip'; rate_cents: string;
  phone: string | null; email: string | null;
  user_id: string | null; login_email: string | null; login_role: string | null;
  started_on: string | null; ended_on: string | null;
  active: boolean; notes: string | null;
  lifetime_cents: string; lifetime_quantity: string; entry_count: number;
}

interface Entry {
  id: string; work_date: string; basis: 'Hourly' | 'PerTrip';
  quantity: string; rate_cents: string; amount_cents: string;
  reference: string | null; notes: string | null;
  employee_name: string; recorded_by_name: string | null;
}

interface Record_ { employee: Employee; entries: Entry[] }

interface Login { id: string; name: string; email: string; role: string; active: boolean }

const per = (basis: string) => (basis === 'Hourly' ? 'per hour' : 'per trip');
const unit = (basis: string, n: number) => (basis === 'Hourly'
  ? `${n} hour${n === 1 ? '' : 's'}`
  : `${n} trip${n === 1 ? '' : 's'}`);

/**
 * One employee, everything about them.
 *
 * The list answers "who?"; this answers "what has this person done, and what
 * are we paying them for it?" — which is the question actually being asked
 * when payroll is being worked out or somebody queries their money.
 *
 * Editing lives here rather than on the list, so managing a person is one
 * click from their name, the way a customer record works.
 */
export default function EmployeeRecord({ session }: { session: Session }) {
  const { employeeId } = useParams();
  const navigate = useNavigate();

  const [r, setR] = useState<Record_ | null>(null);
  const [logins, setLogins] = useState<Login[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const [ed, setEd] = useState({
    name: '', jobTitle: '', payBasis: 'Hourly' as 'Hourly' | 'PerTrip',
    rate: '', phone: '', email: '', userId: '', startedOn: '', notes: '',
  });

  const [work, setWork] = useState({
    workDate: todayInJamaica(), quantity: '', rate: '', reference: '', notes: '',
  });

  const isAdmin = session.role === 'admin';

  const load = useCallback(async () => {
    setR(await api.get<Record_>(`/api/employees/${employeeId}`));
  }, [employeeId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

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

  if (error && !r) return <div className="notice error">{error}</div>;
  if (!r) return <p className="muted">Loading…</p>;

  const e = r.employee;
  const rateSet = Number(e.rate_cents) > 0;

  const startEdit = () => {
    setEd({
      name: e.name,
      jobTitle: e.job_title ?? '',
      payBasis: e.pay_basis,
      rate: (Number(e.rate_cents) / 100).toFixed(2),
      phone: e.phone ?? '',
      email: e.email ?? '',
      userId: e.user_id ?? '',
      startedOn: e.started_on ? date(e.started_on) : '',
      notes: e.notes ?? '',
    });
    setEditing(true);
  };

  const save = (ev: React.FormEvent) => {
    ev.preventDefault();
    return run(async () => {
      await api.patch(`/api/employees/${e.id}`, {
        name: ed.name.trim(),
        jobTitle: ed.jobTitle.trim() || null,
        payBasis: ed.payBasis,
        rateCents: toCents(ed.rate || '0'),
        phone: ed.phone.trim() || null,
        email: ed.email.trim() || null,
        userId: ed.userId || null,
        startedOn: ed.startedOn || null,
        notes: ed.notes.trim() || null,
      });
      setMsg(toCents(ed.rate || '0') !== Number(e.rate_cents)
        ? 'Saved. The new rate applies to work recorded from now on — entries '
          + 'already made keep the rate they were paid at.'
        : 'Saved.');
      setEditing(false);
    }, 'Could not save');
  };

  const setActive = (active: boolean) => {
    if (!active && !window.confirm(
      `Mark ${e.name} as having left?\n\n`
      + 'Their record and every hour or trip already recorded stay exactly as they are — '
      + 'that work is part of what production cost.',
    )) return;
    return run(async () => {
      await api.post(`/api/employees/${e.id}/active`,
        { active, endedOn: active ? null : todayInJamaica() });
      setMsg(active ? `${e.name} is back on the payroll.` : `${e.name} marked as left.`);
    }, 'Could not change the employee');
  };

  const record = (ev: React.FormEvent) => {
    ev.preventDefault();
    return run(async () => {
      const res = await api.post<{ amountCents: number }>('/api/labour', {
        employeeId: e.id,
        workDate: work.workDate,
        quantity: Number(work.quantity),
        rateCents: work.rate.trim() ? toCents(work.rate) : undefined,
        reference: work.reference.trim() || null,
        notes: work.notes.trim() || null,
      });
      setMsg(`${unit(e.pay_basis, Number(work.quantity))} on ${work.workDate}, `
        + `${money(res.amountCents)}.`);
      setWork({ ...work, quantity: '', rate: '', reference: '', notes: '' });
    }, 'Could not record the work');
  };

  const removeEntry = (en: Entry) => {
    if (!window.confirm(
      `Remove ${unit(en.basis, Number(en.quantity))} on ${date(en.work_date)}, `
      + `worth ${money(Number(en.amount_cents))}?`,
    )) return;
    return run(async () => {
      await api.del(`/api/labour/${en.id}`);
      setMsg('Entry removed.');
    }, 'Could not remove the entry');
  };

  return (
    <>
      <p><Link to="/employees">← All employees</Link></p>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ marginBottom: 4 }}>
          {e.name}{' '}
          {!e.active && <span className="chip muted">Left {date(e.ended_on)}</span>}
        </h1>
        {isAdmin && (
          <div className="row" style={{ gap: 8, margin: 0 }}>
            <button className="secondary" disabled={busy}
                    onClick={() => (editing ? setEditing(false) : startEdit())}>
              {editing ? 'Cancel' : 'Edit details'}
            </button>
            <button className="secondary" disabled={busy}
                    onClick={() => setActive(!e.active)}>
              {e.active ? 'Mark as left' : 'Bring back'}
            </button>
          </div>
        )}
      </div>
      <p className="subtitle" style={{ marginTop: 0 }}>
        {e.job_title ?? 'No job title'} · paid by {e.pay_basis === 'Hourly' ? 'the hour' : 'the trip'}
        {e.login_email ? ` · signs in as ${e.login_email}` : ' · no login'}
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {!rateSet && (
        <div className="notice warn">
          <strong>No rate set.</strong> Work cannot be recorded against {e.name} until
          there is one — costing their week at nothing would look exactly like it
          had worked.{' '}
          {isAdmin && !editing && (
            <button className="secondary" onClick={startEdit}>Set the rate</button>
          )}
        </div>
      )}

      <div className="figures">
        <div className="fig">
          <div className="fig-label">Rate</div>
          <div className="fig-value">{rateSet ? money(Number(e.rate_cents)) : '—'}</div>
          <div className="fig-sub">{per(e.pay_basis)}</div>
        </div>
        <div className="fig">
          <div className="fig-label">Recorded to date</div>
          <div className="fig-value">{money(Number(e.lifetime_cents))}</div>
          <div className="fig-sub">
            {e.entry_count} {e.entry_count === 1 ? 'entry' : 'entries'}
          </div>
        </div>
        <div className="fig">
          <div className="fig-label">
            {e.pay_basis === 'Hourly' ? 'Hours worked' : 'Trips run'}
          </div>
          <div className="fig-value">{Number(e.lifetime_quantity).toLocaleString()}</div>
          <div className="fig-sub">since they started</div>
        </div>
        <div className="fig">
          <div className="fig-label">Started</div>
          <div className="fig-value" style={{ fontSize: 20 }}>
            {e.started_on ? date(e.started_on) : '—'}
          </div>
          <div className="fig-sub">{e.phone ?? e.email ?? 'no contact details'}</div>
        </div>
      </div>

      {editing && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Details</h2>
          <form onSubmit={save}>
            <div className="row">
              <div className="field" style={{ flex: '1 1 200px' }}>
                <label htmlFor="r-name">Name</label>
                <input id="r-name" required value={ed.name} style={{ width: '100%' }}
                       onChange={(ev) => setEd({ ...ed, name: ev.target.value })} />
              </div>
              <div className="field" style={{ flex: '1 1 180px' }}>
                <label htmlFor="r-title">Job title</label>
                <input id="r-title" value={ed.jobTitle} style={{ width: '100%' }}
                       onChange={(ev) => setEd({ ...ed, jobTitle: ev.target.value })} />
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="r-basis">Paid by</label>
                <select id="r-basis" value={ed.payBasis}
                        onChange={(ev) => setEd({
                          ...ed, payBasis: ev.target.value as 'Hourly' | 'PerTrip',
                        })}>
                  <option value="Hourly">The hour</option>
                  <option value="PerTrip">The trip</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="r-rate">Rate ({per(ed.payBasis)})</label>
                <input id="r-rate" inputMode="decimal" value={ed.rate} placeholder="0.00"
                       onChange={(ev) => setEd({ ...ed, rate: ev.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="r-started">Started</label>
                <input id="r-started" type="date" value={ed.startedOn}
                       onChange={(ev) => setEd({ ...ed, startedOn: ev.target.value })} />
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="r-phone">Phone</label>
                <input id="r-phone" value={ed.phone}
                       onChange={(ev) => setEd({ ...ed, phone: ev.target.value })} />
              </div>
              <div className="field" style={{ flex: '1 1 200px' }}>
                <label htmlFor="r-email">Email</label>
                <input id="r-email" value={ed.email} style={{ width: '100%' }}
                       onChange={(ev) => setEd({ ...ed, email: ev.target.value })} />
              </div>
              {logins.length > 0 && (
                <div className="field" style={{ flex: '1 1 220px' }}>
                  <label htmlFor="r-login">Signs in as</label>
                  <select id="r-login" value={ed.userId} style={{ width: '100%' }}
                          onChange={(ev) => setEd({ ...ed, userId: ev.target.value })}>
                    <option value="">No login</option>
                    {logins.filter((u) => u.active).map((u) => (
                      <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="field">
              <label htmlFor="r-notes">Notes</label>
              <input id="r-notes" value={ed.notes} style={{ width: '100%' }}
                     onChange={(ev) => setEd({ ...ed, notes: ev.target.value })} />
            </div>
            <button disabled={busy || !ed.name.trim()}>Save</button>{' '}
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        </div>
      )}

      {e.active && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Record work</h2>
          <form onSubmit={record}>
            <div className="row">
              <div className="field">
                <label htmlFor="r-date">Date worked</label>
                <input id="r-date" type="date" required value={work.workDate}
                       max={todayInJamaica()}
                       onChange={(ev) => setWork({ ...work, workDate: ev.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="r-qty">
                  {e.pay_basis === 'PerTrip' ? 'Trips' : 'Hours'}
                </label>
                <input id="r-qty" required inputMode="decimal" value={work.quantity}
                       style={{ width: 90 }} placeholder="0"
                       onChange={(ev) => setWork({ ...work, quantity: ev.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="r-wrate">Rate</label>
                <input id="r-wrate" inputMode="decimal" value={work.rate} style={{ width: 110 }}
                       placeholder={(Number(e.rate_cents) / 100).toFixed(2)}
                       onChange={(ev) => setWork({ ...work, rate: ev.target.value })} />
              </div>
              <div className="field" style={{ flex: '1 1 160px' }}>
                <label htmlFor="r-ref">Against (optional)</label>
                <input id="r-ref" value={work.reference} style={{ width: '100%' }}
                       placeholder="round, batch…"
                       onChange={(ev) => setWork({ ...work, reference: ev.target.value })} />
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <button disabled={busy || !work.quantity}>Record</button>
              </div>
            </div>
            {work.quantity && (
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                {unit(e.pay_basis, Number(work.quantity) || 0)} at{' '}
                {money(work.rate.trim() ? toCents(work.rate) : Number(e.rate_cents))}{' '}
                {per(e.pay_basis)} ={' '}
                <strong>
                  {money(Math.round((Number(work.quantity) || 0)
                    * (work.rate.trim() ? toCents(work.rate) : Number(e.rate_cents))))}
                </strong>
              </p>
            )}
          </form>
        </div>
      )}

      <div className="panel phone-cards">
        <div className="panel-head">
          <h2>Work recorded</h2>
          <span className="muted small">Newest first</span>
        </div>
        {r.entries.length === 0 ? (
          <p className="muted">Nothing recorded against {e.name} yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th><th className="num">Worked</th><th className="num">Rate</th>
                <th className="num">Cost</th><th>Against</th><th />
              </tr>
            </thead>
            <tbody>
              {r.entries.map((en) => (
                <tr key={en.id}>
                  <td className="lead">
                    <span>{date(en.work_date)}</span>
                    <span className="chip neutral phone-only">
                      {money(Number(en.amount_cents))}
                    </span>
                  </td>
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
                      <button className="secondary" disabled={busy}
                              onClick={() => removeEntry(en)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {e.notes && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Notes</h2>
          <p style={{ margin: 0 }}>{e.notes}</p>
        </div>
      )}

      <p className="muted small">
        {e.login_email
          ? <>Access is managed separately, on <Link to="/users">Logins</Link> —
             this page is what they are paid, not what they may see.</>
          : <>{e.name} has no login. If they need one, add it on{' '}
             <Link to="/users">Logins</Link> and tie it to them here.</>}
      </p>

      <p>
        <button className="secondary" onClick={() => navigate('/employees')}>
          Back to employees
        </button>
      </p>
    </>
  );
}
