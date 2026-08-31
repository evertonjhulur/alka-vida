import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';

interface SuppliedMaterial {
  rawMaterialId: string;
  name: string;
  unitOfMeasure: string;
  unitCostCents: number;
  priceBreaks: Array<{ minQty: number; unitCostCents: number }>;
}

interface Supplier {
  id: string; name: string; contact_person: string | null;
  phone: string | null; email: string | null; address: string | null;
  notes: string | null; materials: SuppliedMaterial[];
}

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({
    name: '', contactPerson: '', phone: '', email: '', address: '',
  });

  async function load() {
    setSuppliers(await api.get<Supplier[]>('/api/suppliers'));
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/suppliers', form);
      setMsg(`Added ${form.name}.`);
      setForm({ name: '', contactPerson: '', phone: '', email: '', address: '' });
      setShowNew(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the supplier');
    } finally { setBusy(false); }
  }

  async function unlink(supplierId: string, materialId: string, materialName: string) {
    if (!window.confirm(`Stop buying ${materialName} from this supplier?`)) return;
    setBusy(true);
    try {
      await api.del(`/api/suppliers/${supplierId}/materials/${materialId}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the material');
    } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Suppliers</h1>
      <p className="subtitle">
        Who supplies each raw material, at what price, and at what volumes.
        Purchase orders price their lines from this.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>All suppliers</h2>
          <button className="secondary" onClick={() => setShowNew(!showNew)}>
            {showNew ? 'Cancel' : 'Add supplier'}
          </button>
        </div>

        {showNew && (
          <form onSubmit={create} style={{ marginBottom: 16 }}>
            <div className="row">
              <div className="field">
                <label htmlFor="sn">Name</label>
                <input id="sn" required value={form.name}
                       onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="sc">Contact person</label>
                <input id="sc" value={form.contactPerson}
                       onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="sp">Phone</label>
                <input id="sp" value={form.phone}
                       onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="se">Email</label>
                <input id="se" type="email" value={form.email}
                       onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="sa">Address</label>
                <input id="sa" value={form.address}
                       onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="field"><button disabled={busy}>Save</button></div>
            </div>
          </form>
        )}
      </div>

      {suppliers.map((s) => (
        <div className="panel" key={s.id}>
          <h2 style={{ marginTop: 0 }}>{s.name}</h2>
          <p className="muted small" style={{ marginTop: -6 }}>
            {[s.contact_person, s.phone, s.email, s.address].filter(Boolean).join(' · ') || 'No contact details'}
          </p>

          <table>
            <thead>
              <tr>
                <th>Material</th>
                <th className="num">Standard cost</th>
                <th>Volume breaks</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.materials.map((m) => (
                <tr key={m.rawMaterialId}>
                  <td>{m.name}</td>
                  <td className="num">{money(m.unitCostCents)} / {m.unitOfMeasure}</td>
                  <td className="small">
                    {m.priceBreaks.length === 0
                      ? <span className="muted">none</span>
                      : m.priceBreaks.map((b, i) => (
                          <div key={i}>
                            {b.minQty.toLocaleString()}+ → {money(b.unitCostCents)}
                          </div>
                        ))}
                  </td>
                  <td className="num">
                    <button className="secondary" disabled={busy}
                            onClick={() => unlink(s.id, m.rawMaterialId, m.name)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.materials.length === 0 && (
            <p className="muted">
              No materials linked yet. Link them from the Raw materials screen.
            </p>
          )}
        </div>
      ))}

      {suppliers.length === 0 && (
        <div className="panel"><p className="muted">No suppliers yet.</p></div>
      )}
    </>
  );
}
