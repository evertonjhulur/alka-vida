import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money } from '../lib/format';

interface Customer {
  id: string; name: string; phone: string; email: string;
  delivery_zone: string | null; route_sequence: number;
  delivery_address: string | null; price_tier: string | null;
  balance_cents: number | null;
}
interface Tier { id: string; name: string }

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

// The terms actually offered. Typed free-hand, "Net 30", "net30" and "30 days"
// all end up in the same column meaning the same thing and none of them sort
// or group, so this is a fixed list.
const PAYMENT_TERMS = [
  'Cash on delivery', 'Net 15', 'Net 30', 'Net 60', 'Net 90',
] as const;

const BLANK = {
  name: '', phone: '', email: '', contactPerson: '', deliveryAddress: '',
  deliveryZone: '', routeSequence: '0', priceTierId: '', paymentTerms: '',
  defaultDeliveryDay: '', notes: '',
};

export default function Customers({ session }: { session: Session }) {
  const [rows, setRows] = useState<Customer[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...BLANK });

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
    setTiers(await api.get<Tier[]>('/api/price-tiers'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  // "+ New > Customer" in the top bar lands here with ?new=1.
  const [params] = useSearchParams();
  useEffect(() => { if (params.get('new') === '1') startNew(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function startNew() {
    setForm({ ...BLANK });
    setEditingId(null);
    setShowForm(true);
    setMsg(null);
  }

  async function startEdit(id: string) {
    setError(null);
    try {
      const c = await api.get<Record<string, unknown>>(`/api/customers/${id}`);
      setForm({
        name: (c.name as string) ?? '',
        phone: (c.phone as string) ?? '',
        email: (c.email as string) ?? '',
        contactPerson: (c.contact_person as string) ?? '',
        deliveryAddress: (c.delivery_address as string) ?? '',
        deliveryZone: (c.delivery_zone as string) ?? '',
        routeSequence: String(c.route_sequence ?? 0),
        priceTierId: (c.price_tier_id as string) ?? '',
        paymentTerms: (c.payment_terms as string) ?? '',
        defaultDeliveryDay: (c.default_delivery_day as string) ?? '',
        notes: (c.notes as string) ?? '',
      });
      setEditingId(id);
      setShowForm(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that customer');
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        phone: form.phone,
        email: form.email,
        contactPerson: form.contactPerson || null,
        deliveryAddress: form.deliveryAddress || null,
        deliveryZone: form.deliveryZone || null,
        routeSequence: Number(form.routeSequence) || 0,
        priceTierId: form.priceTierId || null,
        paymentTerms: form.paymentTerms || null,
        defaultDeliveryDay: form.defaultDeliveryDay || null,
        notes: form.notes || null,
      };

      const result = editingId
        ? await api.patch<{ warnings: string[] }>(`/api/customers/${editingId}`, payload)
        : await api.post<{ warnings: string[] }>('/api/customers', payload);

      setMsg(
        `${form.name} ${editingId ? 'updated' : 'added'}.` +
        (result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''),
      );
      setShowForm(false);
      setEditingId(null);
      setForm({ ...BLANK });
      await load();
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

  const set = (k: keyof typeof BLANK, v: string) => setForm({ ...form, [k]: v });

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
          <h2 style={{ marginTop: 0 }}>
            {showForm ? (editingId ? 'Edit customer' : 'New customer') : 'All customers'}
          </h2>
          <button className={showForm ? 'secondary' : ''}
                  onClick={() => (showForm ? setShowForm(false) : startNew())}>
            {showForm ? 'Cancel' : 'Add customer'}
          </button>
        </div>

        {showForm && (
          <form onSubmit={save}>
            <div className="row">
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor="cn">Business name *</label>
                <input id="cn" required style={{ width: '100%' }} value={form.name}
                       onChange={(e) => set('name', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cp">Phone *</label>
                <input id="cp" required value={form.phone}
                       onChange={(e) => set('phone', e.target.value)} />
              </div>
              <div className="field" style={{ flex: '1 1 200px' }}>
                <label htmlFor="ce">Email *</label>
                <input id="ce" type="email" required style={{ width: '100%' }} value={form.email}
                       onChange={(e) => set('email', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cc">Contact person</label>
                <input id="cc" value={form.contactPerson}
                       onChange={(e) => set('contactPerson', e.target.value)} />
              </div>
            </div>

            <div className="row">
              <div className="field" style={{ flex: '1 1 280px' }}>
                <label htmlFor="ca">Delivery address</label>
                <input id="ca" style={{ width: '100%' }} value={form.deliveryAddress}
                       onChange={(e) => set('deliveryAddress', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cz">Delivery zone</label>
                <input id="cz" value={form.deliveryZone} placeholder="e.g. Kingston"
                       onChange={(e) => set('deliveryZone', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cr">Route order</label>
                <input id="cr" type="number" min="0" style={{ width: 100 }}
                       value={form.routeSequence}
                       onChange={(e) => set('routeSequence', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="cd">Usual delivery day</label>
                <select id="cd" value={form.defaultDeliveryDay}
                        onChange={(e) => set('defaultDeliveryDay', e.target.value)}>
                  <option value="">—</option>
                  {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>

            <div className="row">
              <div className="field">
                <label htmlFor="ct">Price tier</label>
                <select id="ct" value={form.priceTierId}
                        onChange={(e) => set('priceTierId', e.target.value)}>
                  <option value="">List price</option>
                  {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cpt">Payment terms</label>
                <select id="cpt" value={form.paymentTerms}
                        onChange={(e) => set('paymentTerms', e.target.value)}>
                  <option value="">Not set</option>
                  {PAYMENT_TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
                  {/* A record saved before this became a list keeps whatever it
                      has, rather than being silently switched to another term
                      the moment somebody opens it to edit something else. */}
                  {form.paymentTerms
                    && !PAYMENT_TERMS.includes(form.paymentTerms as typeof PAYMENT_TERMS[number])
                    && <option value={form.paymentTerms}>{form.paymentTerms}</option>}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 240px' }}>
                <label htmlFor="cno">Notes</label>
                <input id="cno" style={{ width: '100%' }} value={form.notes}
                       onChange={(e) => set('notes', e.target.value)} />
              </div>
            </div>

            {!form.deliveryZone && (
              <div className="notice warn">
                Without a delivery zone, this customer's delivery orders cannot be
                routed onto a sheet automatically. Leave it blank only for
                pickup-only or walk-in customers.
              </div>
            )}

            <button disabled={busy}>
              {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add customer'}
            </button>
          </form>
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
