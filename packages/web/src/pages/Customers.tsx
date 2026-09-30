import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money } from '../lib/format';
import CustomerForm, { BLANK_CUSTOMER, formToPayload, type CustomerFormValues } from '../components/CustomerForm';

interface Customer {
  id: string; name: string; phone: string; email: string;
  delivery_zone: string | null; route_sequence: number;
  delivery_address: string | null; price_tier: string | null;
  balance_cents: number | null;
}
export default function Customers({ session }: { session: Session }) {
  const [rows, setRows] = useState<Customer[]>([]);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [blank] = useState<CustomerFormValues>({ ...BLANK_CUSTOMER });

  const [survivor, setSurvivor] = useState('');
  const [merged, setMerged] = useState('');

  const [search, setSearch] = useState('');

  /*
   * Matched across every field somebody might have to hand: a customer rings
   * up and gives a phone number, or the driver knows only the street.
   */
  const needle = search.trim().toLowerCase();
  const found = needle === '' ? rows : rows.filter((c) => [
    c.name, c.phone, c.email, c.delivery_zone, c.delivery_address, c.price_tier,
  ].some((f) => (f ?? '').toLowerCase().includes(needle)));

  async function load() {
    setRows(await api.get<Customer[]>('/api/customers'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  // "+ New > Customer" in the top bar lands here with ?new=1.
  const [params] = useSearchParams();
  useEffect(() => { if (params.get('new') === '1') startNew(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function startNew() {
    setShowForm(true);
    setMsg(null);
  }

  /** Editing happens on the customer's own page, Details tab. */
  const startEdit = (id: string) => navigate(`/customers/${id}?tab=details`);

  async function save(v: CustomerFormValues) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ id: string; warnings: string[] }>('/api/customers', formToPayload(v));
      setMsg(`${v.name} added.` + (result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''));
      setShowForm(false);
      await load();
      navigate(`/customers/${result.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the customer');
    } finally { setBusy(false); }
  }

  async function merge() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/customers/merge', { survivorId: survivor, mergedId: merged });
      setMsg('Merged. All history moved to the surviving record; the other was deactivated, not deleted.');
      setSurvivor(''); setMerged('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not merge');
    } finally { setBusy(false); }
  }


  return (
    <>
      <h1>Customers</h1>
      <p className="subtitle">
        Every sale is tied to a customer record, so a receipt can always be issued —
        including cash walk-ins.
      </p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>{showForm ? 'New customer' : 'All customers'}</h2>
          <button className={showForm ? 'secondary' : ''}
                  onClick={() => (showForm ? setShowForm(false) : startNew())}>
            {showForm ? 'Cancel' : 'Add customer'}
          </button>
        </div>

        {showForm && (
          <CustomerForm initial={blank} isNew busy={busy} onSubmit={save}
                        onCancel={() => setShowForm(false)} />
        )}

        {!showForm && (
          <>
            {/* Finding one customer among hundreds by reading down the page is
                the sort of thing that quietly stops people using a screen. */}
            <div className="row" style={{ marginBottom: 12 }}>
              <div className="field" style={{ flex: '1 1 320px', marginBottom: 0 }}>
                <label htmlFor="csearch">Find a customer</label>
                <input id="csearch" style={{ width: '100%' }} value={search}
                       placeholder="name, phone, email, zone or address"
                       onChange={(e) => setSearch(e.target.value)} />
              </div>
              {search && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <button className="secondary" onClick={() => setSearch('')}>Clear</button>
                </div>
              )}
              <div className="field" style={{ marginBottom: 0 }}>
                <div className="muted small">
                  {search
                    ? `${found.length} of ${rows.length}`
                    : `${rows.length} customer${rows.length === 1 ? '' : 's'}`}
                </div>
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Contact</th><th>Zone</th><th>Route #</th>
                  <th>Tier</th><th className="num">Balance</th><th />
                </tr>
              </thead>
              <tbody>
                {found.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {/* The name opens the record. A customer is something you
                          look INTO - their orders, invoices, payments and
                          bottles - not just a row to edit. */}
                      <Link to={`/customers/${c.id}`}><strong>{c.name}</strong></Link>
                      {c.delivery_address && (
                        <div className="muted small">{c.delivery_address}</div>
                      )}
                    </td>
                    <td className="small muted">{c.phone}<br />{c.email}</td>
                    <td>{c.delivery_zone ?? <span className="chip warn">none set</span>}</td>
                    <td>{c.route_sequence}</td>
                    <td>{c.price_tier ?? <span className="muted">list price</span>}</td>
                    <td className="num">{money(Number(c.balance_cents ?? 0))}</td>
                    <td className="num">
                      <Link to={`/customers/${c.id}`}>Open</Link>{' '}
                      <button className="secondary" onClick={() => startEdit(c.id)}>Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {!showForm && rows.length === 0 && <p className="muted">No customers yet.</p>}
        {!showForm && rows.length > 0 && found.length === 0 && (
          <p className="muted">Nobody matches “{search}”.</p>
        )}
      </div>

      {session.role === 'admin' && !showForm && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Merge duplicate customers</h2>
          <p className="muted small">
            All orders, invoices and payments move to the survivor. The other record
            is deactivated so its history stays intact.
          </p>
          <div className="row">
            <div className="field" style={{ flex: '1 1 240px' }}>
              <label htmlFor="surv">Keep this record</label>
              <select id="surv" value={survivor} style={{ width: '100%' }}
                      onChange={(e) => setSurvivor(e.target.value)}>
                <option value="">Select…</option>
                {rows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '1 1 240px' }}>
              <label htmlFor="merg">Merge away this one</label>
              <select id="merg" value={merged} style={{ width: '100%' }}
                      onChange={(e) => setMerged(e.target.value)}>
                <option value="">Select…</option>
                {rows.filter((c) => c.id !== survivor)
                     .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <button className="danger-soft" disabled={busy || !survivor || !merged} onClick={merge}>Merge</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
