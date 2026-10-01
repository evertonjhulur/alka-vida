import { Fragment, useEffect, useState } from 'react';
import { api, type Role, type Session } from '../lib/api';
import { date, when } from '../lib/format';
import { ask, askText } from '../components/Dialog';

interface User {
  id: string; email: string; name: string; role: Role; active: boolean;
  created_at: string; last_login_at: string | null;
  customer_id: string | null; customer_name: string | null;
}

interface CustomerRef { id: string; name: string }

/** What each role can actually do, in the words the office would use. */
const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator',
  user: 'Office staff',
  driver: 'Driver',
  customer: 'Customer portal',
};

const ROLE_NOTE: Record<Role, string> = {
  admin: 'Everything, including managing logins, approvals and stock counts.',
  user: 'Day-to-day sales and operations. Cannot manage logins or confirm a stock count.',
  driver: 'Their own route only.',
  customer: 'Their own invoices and statement, through the portal.',
};

/** Staff roles. A portal login is made by attaching it to a customer. */
const STAFF_ROLES: Role[] = ['admin', 'user', 'driver'];

const BLANK_NEW = {
  name: '', email: '', role: 'user' as Role, password: '', customerId: '',
  // Preferred: the office never learns a password that can place orders.
  byInvitation: true,
};

export default function Users({ session }: { session: Session }) {
  const [users, setUsers] = useState<User[]>([]);
  const [customers, setCustomers] = useState<CustomerRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [nw, setNw] = useState({ ...BLANK_NEW });

  const [editFor, setEditFor] = useState<string | null>(null);
  const [ed, setEd] = useState({ name: '', email: '', role: 'user' as Role });

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | ''>('');

  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pw, setPw] = useState('');

  /** The link from the most recent invitation, to pass on by hand. */
  const [invite, setInvite] = useState<
    { name: string; link: string; sent: boolean; reason?: string } | null
  >(null);

  async function load() {
    setUsers(await api.get<User[]>('/api/users'));
    setCustomers(await api.get<CustomerRef[]>('/api/customers'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  function say(m: string) { setMsg(m); setError(null); }

  async function run(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try {
      await what();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const made = await api.post<{ id: string }>('/api/users', {
        name: nw.name, email: nw.email, role: nw.role,
        password: nw.password, byInvitation: nw.byInvitation,
        customerId: nw.role === 'customer' ? nw.customerId : undefined,
      });
      if (nw.byInvitation) {
        const inv = await api.post<{ link: string; sent: boolean; reason?: string }>(
          `/api/users/${made.id}/invite`, {},
        );
        setInvite({ name: nw.name, ...inv });
        say(inv.sent
          ? `${nw.name} has been emailed a link to choose their password.`
          : `${nw.name} is set up. Send them the link below to choose a password.`);
      } else {
        say(`${nw.name} can now sign in as ${ROLE_LABEL[nw.role].toLowerCase()}.`);
      }
      setNw({ ...BLANK_NEW });
      setShowNew(false);
    }, 'Could not add the login');
  }

  /**
   * Send (or re-send) an invitation to an existing login.
   *
   * Better than resetting a password for somebody: the office never learns
   * what they choose, and any earlier link stops working the moment this one
   * is issued.
   */
  async function sendInvite(u: User) {
    await run(async () => {
      const inv = await api.post<{ link: string; sent: boolean; reason?: string }>(
        `/api/users/${u.id}/invite`, {},
      );
      setInvite({ name: u.name, ...inv });
      say(inv.sent
        ? `A link has been emailed to ${u.email}.`
        : `Send ${u.name} the link below. Any earlier link has stopped working.`);
    }, 'Could not send an invitation');
  }

  async function saveEdit(u: User) {
    const patch: Record<string, unknown> = {};
    if (ed.name !== u.name) patch.name = ed.name;
    if (ed.email !== u.email) patch.email = ed.email;
    if (ed.role !== u.role) patch.role = ed.role;
    if (Object.keys(patch).length === 0) { setEditFor(null); say('Nothing was changed.'); return; }

    await run(async () => {
      await api.patch(`/api/users/${u.id}`, patch);
      say(`${ed.name} saved.`);
      setEditFor(null);
    }, 'Could not save');
  }

  async function toggleActive(u: User) {
    const question = u.active
      ? `Withdraw access for ${u.name}?\n\n`
        + 'They will not be able to sign in, and will be signed out of anything '
        + 'they have open. Their history stays exactly as it is.'
      : `Give ${u.name} access again?`;
    if (!(await ask(question, u.active ? { confirmLabel: 'Withdraw access', danger: true } : { confirmLabel: 'Give access' }))) return;

    await run(async () => {
      await api.post(`/api/users/${u.id}/active`, { active: !u.active });
      say(u.active ? `${u.name}'s access has been withdrawn.` : `${u.name} can sign in again.`);
    }, 'Could not change access');
  }

  async function savePassword(u: User) {
    await run(async () => {
      await api.post(`/api/users/${u.id}/password`, { password: pw });
      say(`${u.name}'s password has been reset. Tell them what it is — nobody else can see it.`);
      setPwFor(null); setPw('');
    }, 'Could not reset the password');
  }

  const needle = search.trim().toLowerCase();
  const matches = (u: User) => (roleFilter === '' || u.role === roleFilter) && (needle === '' || [
    u.name, u.email, ROLE_LABEL[u.role], u.role, u.customer_name ?? '',
  ].some((f) => f.toLowerCase().includes(needle)));

  const active = users.filter((u) => u.active && matches(u));
  const withdrawn = users.filter((u) => !u.active && matches(u));
  const linkable = customers.filter(
    (c) => !users.some((u) => u.customer_id === c.id && u.active),
  );

  const toggleEdit = (u: User) => {
    const next = editFor === u.id ? null : u.id;
    setEditFor(next); setPwFor(null);
    if (next) setEd({ name: u.name, email: u.email, role: u.role });
  };

  const row = (u: User) => (
    <Fragment key={u.id}>
      <tr>
        <td>
          {/* The name opens the same editor the button does - managing
              somebody should not require finding the right button first. */}
          <button className="as-link" disabled={busy} onClick={() => toggleEdit(u)}>
            <strong>{u.name}</strong>
          </button>
          {u.id === session.id && <span className="chip info" style={{ marginLeft: 6 }}>you</span>}
          <div className="muted small">{u.email}</div>
          {u.customer_name && <div className="muted small">for {u.customer_name}</div>}
        </td>
        <td>
          {ROLE_LABEL[u.role]}
          <div className="muted small">{ROLE_NOTE[u.role]}</div>
        </td>
        <td className="small muted">
          {u.last_login_at ? when(u.last_login_at) : 'never signed in'}
        </td>
        <td className="num">
          <button className="secondary" disabled={busy} onClick={() => toggleEdit(u)}>
            {editFor === u.id ? 'Cancel' : 'Edit'}
          </button>{' '}
          <button className="secondary" disabled={busy || !u.active}
                  onClick={() => sendInvite(u)}>
            Send invitation
          </button>{' '}
          <button className="secondary" disabled={busy}
                  onClick={() => {
                    const next = pwFor === u.id ? null : u.id;
                    setPwFor(next); setEditFor(null); setPw('');
                  }}>
            {pwFor === u.id ? 'Cancel' : 'Reset password'}
          </button>{' '}
          <button className={u.active ? 'danger-soft' : 'secondary'} disabled={busy || u.id === session.id}
                  title={u.id === session.id ? 'You cannot withdraw your own access' : undefined}
                  onClick={() => toggleActive(u)}>
            {u.active ? 'Withdraw access' : 'Give access back'}
          </button>
        </td>
      </tr>

      {editFor === u.id && (
        <tr>
          <td colSpan={4} style={{ background: '#f9fafb' }}>
            <strong>Edit {u.name}</strong>
            <div className="row" style={{ marginTop: 6 }}>
              <div className="field">
                <label>Name</label>
                <input value={ed.name} onChange={(e) => setEd({ ...ed, name: e.target.value })} />
              </div>
              <div className="field">
                <label>Email</label>
                <input type="email" value={ed.email}
                       onChange={(e) => setEd({ ...ed, email: e.target.value })} />
              </div>
              <div className="field">
                <label>Role</label>
                {u.role === 'customer' ? (
                  <input value="Customer portal" disabled />
                ) : (
                  <select value={ed.role} disabled={u.id === session.id}
                          onChange={(e) => setEd({ ...ed, role: e.target.value as Role })}>
                    {STAFF_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="field">
                <button disabled={busy || !ed.name.trim() || !ed.email.trim()}
                        onClick={() => saveEdit(u)}>
                  Save changes
                </button>
              </div>
            </div>
            {u.id === session.id && (
              <p className="muted small" style={{ margin: 0 }}>
                You cannot change your own role. Another administrator has to do it —
                that is what stops the last administrator locking everybody out.
              </p>
            )}
            {u.role === 'customer' && (
              <p className="muted small" style={{ margin: 0 }}>
                A portal login stays a portal login. To give this person staff access,
                withdraw this one and create a staff login instead.
              </p>
            )}
          </td>
        </tr>
      )}

      {pwFor === u.id && (
        <tr>
          <td colSpan={4} style={{ background: '#f9fafb' }}>
            <strong>Set a new password for {u.name}</strong>
            <p className="muted small" style={{ marginTop: 4 }}>
              For somebody locked out. Nobody — not even you — can read an existing
              password, so it can only be replaced. Tell them the new one directly,
              and have them change it.
            </p>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field">
                <label>New password</label>
                <input type="text" value={pw} style={{ width: 240 }}
                       placeholder="at least 8 characters"
                       onChange={(e) => setPw(e.target.value)} />
              </div>
              <div className="field">
                <button disabled={busy || pw.length < 8} onClick={() => savePassword(u)}>
                  Set password
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );

  return (
    <>
      <h1>Logins</h1>
      <p className="subtitle">
        Who can sign in to Alka Vida, and what they are allowed to do.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {invite && (
        <div className="notice info">
          <strong>Link for {invite.name} to choose their password</strong>
          <p className="small" style={{ margin: '6px 0' }}>
            {invite.sent
              ? 'This has been emailed to them. Here it is as well, in case.'
              : `Email is not set up on this machine${invite.reason ? '' : ''}, so pass this `
                + 'on yourself — read it out, or send it on WhatsApp.'}
            {' '}It works once and expires in 7 days.
          </p>
          <input readOnly value={invite.link} style={{ width: '100%' }}
                 onFocus={(e) => e.currentTarget.select()} />
          <button className="secondary" style={{ marginTop: 8 }}
                  onClick={() => setInvite(null)}>
            Done
          </button>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>Active</h2>
          <button className="secondary" onClick={() => { setShowNew(!showNew); setError(null); }}>
            {showNew ? 'Cancel' : 'Add a login'}
          </button>
        </div>

        {showNew && (
          <form onSubmit={create} style={{ marginBottom: 16 }}>
            <div className="row">
              <div className="field">
                <label htmlFor="un">Name</label>
                <input id="un" required value={nw.name}
                       onChange={(e) => setNw({ ...nw, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ue">Email</label>
                <input id="ue" type="email" required value={nw.email}
                       onChange={(e) => setNw({ ...nw, email: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ur">Role</label>
                <select id="ur" value={nw.role}
                        onChange={(e) => setNw({
                          ...nw, role: e.target.value as Role, customerId: '',
                        })}>
                  {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  <option value="customer">{ROLE_LABEL.customer}</option>
                </select>
              </div>
              {nw.role === 'customer' && (
                <div className="field">
                  <label htmlFor="uc">For which customer?</label>
                  <select id="uc" required value={nw.customerId}
                          onChange={(e) => setNw({ ...nw, customerId: e.target.value })}>
                    <option value="">Select…</option>
                    {linkable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="uh">How do they get in?</label>
                <select id="uh" value={nw.byInvitation ? 'invite' : 'password'}
                        onChange={(e) => setNw({
                          ...nw, byInvitation: e.target.value === 'invite', password: '',
                        })}>
                  <option value="invite">Send them a link (recommended)</option>
                  <option value="password">I will set a password</option>
                </select>
              </div>
              {!nw.byInvitation && (
                <div className="field">
                  <label htmlFor="up">Password</label>
                  <input id="up" type="text" required value={nw.password}
                         placeholder="at least 8 characters"
                         onChange={(e) => setNw({ ...nw, password: e.target.value })} />
                </div>
              )}
              <div className="field">
                <button disabled={busy
                  || (!nw.byInvitation && nw.password.length < 8)
                  || (nw.role === 'customer' && !nw.customerId)}>
                  Create
                </button>
              </div>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {ROLE_NOTE[nw.role]}{' '}
              {nw.byInvitation
                ? 'They choose their own password from a one-time link, so nobody here '
                  + 'ever knows it. The link is shown to you as well, in case email is not '
                  + 'set up on this machine.'
                : 'You are typing the password, so you will know it — tell them what it is '
                  + 'and have them change it under My password straight away.'}
            </p>
          </form>
        )}

        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label htmlFor="usearch">Find a login</label>
            <input id="usearch" style={{ width: '100%' }} value={search}
                   placeholder="name, email, or role"
                   onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="urole">Role</label>
            <select id="urole" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as Role | '')}>
              <option value="">Every role</option>
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]} ({users.filter((u) => u.role === r && u.active).length})</option>
              ))}
            </select>
          </div>
          {(search || roleFilter) && (
            <div className="field">
              <button className="secondary" onClick={() => { setSearch(''); setRoleFilter(''); }}>Clear</button>
            </div>
          )}
        </div>

        <table>
          <thead>
            <tr>
              <th>Person</th><th>Role</th><th>Last signed in</th><th />
            </tr>
          </thead>
          <tbody>{active.map(row)}</tbody>
        </table>
        {active.length === 0 && (
          <p className="muted">
            {search ? `Nobody active matches “${search}”.` : 'No active logins.'}
          </p>
        )}
      </div>

      {withdrawn.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Access withdrawn</h2>
          <p className="muted small">
            These people cannot sign in. Everything they did is still on record —
            a login is never deleted, because the history refers back to it.
          </p>
          <table>
            <thead>
              <tr>
                <th>Person</th><th>Role</th><th>Last signed in</th><th />
              </tr>
            </thead>
            <tbody>{withdrawn.map(row)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
