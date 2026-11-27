import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, day } from '../lib/format';

/**
 * Stray cents on credit (Everton, 27 Nov 2026). The J$0.01 left on accounts
 * from before GCT was rounded per bottle keeps coming back: the cent goes on
 * the next invoice and the whole-dollar cash leaves a new one. Admins tick
 * who to clear; each becomes a "Rounding adjustment" on the account, and the
 * receipts stay as they were. Odd cents of J$0.04 or less only.
 */
interface Stray {
  customerId: string; name: string; active: boolean; strayCents: number; creditCents: number;
  balanceCents: number; balanceAfterCents: number;
  from: Array<{ paymentId: string; receiptNumber: string | null; day: string; amountCents: number; cents: number }>;
}

/** "J$0.01 credit", "owes J$999.99", "J$0.00". */
const position = (c: number) => (c < 0 ? `${money(-c)} credit` : c > 0 ? `owes ${money(c)}` : money(0));

export default function StrayCents({ onDone }: { onDone?: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Stray[] | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.get<Stray[]>('/api/stray-cents').then((r) => { setRows(r); setTicked(r.map((x) => x.customerId)); })
    .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the list'));
  useEffect(() => { void load(); }, []);

  async function clear() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ cleared: Array<{ name: string; cents: number }> }>('/api/stray-cents/clear', { customerIds: ticked });
      const total = r.cleared.reduce((s, x) => s + x.cents, 0);
      onDone?.(`Stray cents cleared for ${r.cleared.length} ${r.cleared.length === 1 ? 'customer' : 'customers'} (${money(total)} in all), `
        + 'each as a rounding adjustment on their account.');
      setOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear them');
    } finally { setBusy(false); }
  }

  if (!rows || rows.length === 0) return null;
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ marginTop: 0 }}>Stray cents on credit ({rows.length})</h2>
        <button type="button" className="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Close' : 'Review and clear…'}
        </button>
      </div>
      {!open && (
        <p className="muted small" style={{ margin: 0 }}>
          Odd cents (J$0.04 or less) left on customers' credit, mostly J$0.01 from before GCT was rounded per bottle.
          They make the driver ask for J$999.99 instead of J$1,000.
        </p>
      )}
      {open && (
        <>
          {error && <div className="notice error">{error}</div>}
          <table>
            <thead>
              <tr>
                <th><input type="checkbox" aria-label="Tick all" checked={ticked.length === rows.length}
                           onChange={(e) => setTicked(e.target.checked ? rows.map((x) => x.customerId) : [])} /></th>
                <th>Customer</th><th className="num">Cents</th><th>From</th><th>Now</th><th>After</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.customerId}>
                  <td><input type="checkbox" aria-label={`Tick ${r.name}`} checked={ticked.includes(r.customerId)}
                             onChange={(e) => setTicked(e.target.checked ? [...ticked, r.customerId] : ticked.filter((x) => x !== r.customerId))} /></td>
                  <td>{r.name}{!r.active && <span className="muted small"> (inactive)</span>}</td>
                  <td className="num">{money(r.strayCents)}</td>
                  <td className="small">{r.from.map((f) => `${f.receiptNumber ?? 'payment'}, ${day(f.day)}`).join('; ')}</td>
                  <td className="small">{position(r.balanceCents)}</td>
                  <td className="small">{position(r.balanceAfterCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Each is cleared as a "Rounding adjustment" on the customer's account and statement, with your name. Receipts stay as they were.
          </p>
          <button type="button" disabled={busy || ticked.length === 0} onClick={clear}>
            {busy ? 'Clearing…' : `Clear the stray cents for ${ticked.length} ${ticked.length === 1 ? 'customer' : 'customers'}`}
          </button>
        </>
      )}
    </div>
  );
}
