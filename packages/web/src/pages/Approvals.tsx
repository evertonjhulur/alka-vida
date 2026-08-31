import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { money, date } from '../lib/format';

interface Approval {
  id: string; requestType: string; entityLabel: string | null;
  customerName: string | null; amountCents: number;
  discountPercent: number | null; reason: string | null;
  requestedByName: string | null; requestedDate: string;
}

export default function Approvals({ session }: { session: Session }) {
  const [rows, setRows] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() { setRows(await api.get<Approval[]>('/api/approvals')); }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function review(id: string, decision: 'Approved' | 'Rejected') {
    setBusy(true);
    try {
      await api.post(`/api/approvals/${id}/review`, { decision });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the decision');
    } finally { setBusy(false); }
  }

  return (
    <>
      <h1>Approvals</h1>
      <p className="subtitle">
        Discounts and credit notes raised by office staff. Sales and deliveries are
        never held up waiting on these — the amount owed simply stays unchanged
        until a decision is made.
      </p>
      {error && <div className="notice error">{error}</div>}
      {session.role !== 'admin' && (
        <div className="notice info">
          You can raise requests here, but only an administrator can approve them.
        </div>
      )}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Type</th><th>Customer</th><th>Reference</th><th>Reason</th>
              <th>Requested by</th><th className="num">Impact</th>
              {session.role === 'admin' && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><span className="chip info">{r.requestType}</span></td>
                <td>{r.customerName ?? '—'}</td>
                <td className="small">{r.entityLabel ?? '—'}</td>
                <td className="small">{r.reason ?? '—'}</td>
                <td className="small muted">
                  {r.requestedByName ?? '—'}<br />{date(r.requestedDate)}
                </td>
                <td className="num">
                  {money(r.amountCents)}
                  {r.discountPercent ? <div className="muted small">{r.discountPercent}%</div> : null}
                </td>
                {session.role === 'admin' && (
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button disabled={busy} onClick={() => review(r.id, 'Approved')}>Approve</button>{' '}
                    <button className="secondary" disabled={busy}
                            onClick={() => review(r.id, 'Rejected')}>Reject</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted">Nothing awaiting approval.</p>}
      </div>
    </>
  );
}
