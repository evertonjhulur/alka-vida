import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';

/*
 * Start fresh for go-live (Everton, 25 Oct 2026): "All transactions in the
 * system now shall be removed." Settings and wording survive, and the
 * customers and logins ticked here; everything else goes. Admin only, one
 * confirmation typed as CLEAR, all or nothing. The rules are in
 * services/cleanup.ts.
 */

interface Preview {
  counts: Array<{ label: string; count: number }>;
  customers: Array<{ id: string; name: string; active: boolean; hasLogin: boolean; walkIn: boolean }>;
  logins: Array<{ id: string; name: string; email: string; role: string; active: boolean; customerName: string | null; you: boolean }>;
  clientBrands: string[];
  lastInvoiceNumber: string | null;
}
interface Done { customersKept: number; customersRemoved: number; loginsKept: number; loginsRemoved: number; nextInvoiceNumber: string }

const ROLE_WORDS: Record<string, string> = { admin: 'Administrator', user: 'Office', driver: 'Driver', customer: 'Customer portal' };

export default function StartFresh({ session }: { session: Session }) {
  const [p, setP] = useState<Preview | null>(null);
  const [keepC, setKeepC] = useState<Set<string>>(new Set());
  const [keepU, setKeepU] = useState<Set<string>>(new Set());
  const [find, setFind] = useState('');
  const [next, setNext] = useState('16393');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    api.get<Preview>('/api/start-fresh').then(setP).catch((e) => setError(e.message));
  }, []);

  const customers = useMemo(() => (p?.customers ?? []).filter((c) => !c.walkIn
    && (!find.trim() || c.name.toLowerCase().includes(find.trim().toLowerCase()))), [p, find]);

  if (session.role !== 'admin') return <div className="notice error">Only an administrator can start fresh.</div>;
  if (error && !p) return <div className="notice error">{error}</div>;
  if (!p) return <p className="muted">Loading…</p>;

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const n = new Set(set); if (on) n.add(id); else n.delete(id); return n;
  };
  // A kept customer's own portal login stays with them.
  const loginKeptByCustomer = (u: Preview['logins'][number]) => u.role === 'customer'
    && p.customers.some((c) => keepC.has(c.id) && c.hasLogin && c.name === u.customerName);
  const keptLogins = p.logins.filter((u) => u.you || keepU.has(u.id) || loginKeptByCustomer(u));
  const nextNo = Math.round(Number(next));
  const ready = typed.trim().toUpperCase() === 'CLEAR' && nextNo > 0;

  async function go() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<Done>('/api/start-fresh', {
        keepCustomerIds: [...keepC], keepUserIds: [...keepU], nextInvoiceNumber: nextNo, confirm: typed,
      });
      setDone(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nothing was cleared');
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <>
        <h1>Start fresh</h1>
        <div className="notice ok">
          Done. {done.customersRemoved} customers and {done.loginsRemoved} logins removed; {done.customersKept} customer
          {done.customersKept === 1 ? '' : 's'} and {done.loginsKept} login{done.loginsKept === 1 ? '' : 's'} kept.
          The next invoice will be <strong>{done.nextInvoiceNumber}</strong>.
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Next</h2>
          <ol>
            <li><Link to="/customers/import">Upload customers</Link> (the customer upload file, with the open invoices).</li>
            <li><Link to="/products/import">Upload products &amp; prices</Link> (after the customers, so the bottling clients are there).</li>
            <li>Set the run days of the new zones on <Link to="/zones">Delivery zones</Link>.</li>
          </ol>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Start fresh</h1>
      <p className="subtitle">
        Clears the test data before going live. Every transaction goes. Settings and wording stay, and so do
        the customers and logins you tick below. This cannot be undone.
      </p>
      <p className="small"><Link to="/settings">← Settings</Link></p>
      {error && <div className="notice error">{error}</div>}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>What will be removed</h2>
        <table className="phone-cards">
          <tbody>
            {p.counts.map((c) => (
              <tr key={c.label}><td data-label="What">{c.label}</td><td data-label="How many" className="num">{c.count.toLocaleString()}</td></tr>
            ))}
            {p.clientBrands.length > 0 && (
              <tr><td>Brands bottled for clients (the product upload brings them back)</td><td className="num">{p.clientBrands.length}</td></tr>
            )}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Also cleared: finished-goods stock and stock counts, 5-gallon bottle counts, recipes, delivery zones, employees,
          news &amp; offers and lists, notifications. Kept: settings and wording, the price tier names
          (their prices go), the Alka Vida brand, material categories and sizes.
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Customers to keep ({keepC.size} ticked of {p.customers.filter((c) => !c.walkIn).length})</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Their customer information stays (details, addresses, pins, days, terms, portal login). Their orders,
          invoices, payments and bottle history go, and their zone is cleared. Everyone not ticked is removed.
        </p>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input type="search" placeholder="Find a customer" value={find} onChange={(e) => setFind(e.target.value)} style={{ flex: '1 1 220px' }} />
          {keepC.size > 0 && <button type="button" className="secondary" onClick={() => setKeepC(new Set())}>Untick all</button>}
        </div>
        <div className="keep-list" style={{ maxHeight: 320, overflowY: 'auto', marginTop: 8 }}>
          {customers.map((c) => (
            <label key={c.id} className="check" style={{ display: 'block', margin: '4px 0' }}>
              <input type="checkbox" checked={keepC.has(c.id)} onChange={(e) => setKeepC(toggle(keepC, c.id, e.target.checked))} />{' '}
              {c.name}
              {!c.active && <span className="muted small"> · inactive</span>}
              {c.hasLogin && <span className="muted small"> · has a portal login</span>}
            </label>
          ))}
          {customers.length === 0 && <p className="muted">No customers match.</p>}
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Logins to keep</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Your own login always stays, and so does the portal login of a customer you keep. Everyone else not
          ticked is removed; they can be invited again from People &amp; logins.
        </p>
        <table className="phone-cards">
          <thead><tr><th style={{ width: 40 }} /><th>Name</th><th>Email</th><th>Role</th></tr></thead>
          <tbody>
            {p.logins.map((u) => {
              const forced = u.you || loginKeptByCustomer(u);
              return (
                <tr key={u.id}>
                  <td>
                    <input type="checkbox" aria-label={`Keep ${u.name}`} disabled={forced}
                           checked={forced || keepU.has(u.id)} onChange={(e) => setKeepU(toggle(keepU, u.id, e.target.checked))} />
                  </td>
                  <td data-label="Name">
                    <strong>{u.name}</strong>
                    {u.you && <span className="chip info" style={{ marginLeft: 6 }}>you</span>}
                    {!u.active && <span className="muted small"> · withdrawn</span>}
                  </td>
                  <td data-label="Email" className="small">{u.email}</td>
                  <td data-label="Role" className="small">{ROLE_WORDS[u.role] ?? u.role}{u.customerName ? ` · ${u.customerName}` : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small" style={{ marginBottom: 0 }}>{keptLogins.length} login{keptLogins.length === 1 ? '' : 's'} will be kept.</p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Numbering</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor="sf-next">The first new invoice will be number</label>
            <input id="sf-next" type="number" min="1" style={{ width: 140 }} value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div className="muted small" style={{ paddingBottom: 10 }}>
            = INV-{String(Math.max(0, nextNo || 0)).padStart(6, '0')}, carrying on after QuickBooks' last invoice.
            Orders, quotes, receipts and purchase orders start again at 001000.
          </div>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Confirm</h2>
        <p>
          This removes everything listed above and every customer and login not ticked. It cannot be undone.
          Type <strong>CLEAR</strong> to confirm.
        </p>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input aria-label="Type CLEAR to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ width: 160 }} />
          <button type="button" className="danger" disabled={busy || !ready} onClick={go}>
            {busy ? 'Clearing…' : 'Start fresh'}
          </button>
        </div>
      </div>
    </>
  );
}
