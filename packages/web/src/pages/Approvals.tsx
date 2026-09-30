import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { money, date } from '../lib/format';

interface Approval {
  id: string; requestType: string; entityLabel: string | null;
  customerName: string | null; amountCents: number;
  discountPercent: number | null; reason: string | null;
  /** For a stop correction, the proposed changes awaiting a decision. */
  payload: Record<string, number | string> | null;
  requestedByName: string | null; requestedDate: string;
}

const TYPE_LABEL: Record<string, string> = {
  Discount: 'Discount',
  CreditNote: 'Credit note',
  StopCorrection: 'Stop correction',
};

const FIELD_LABEL: Record<string, string> = {
  paymentAmountCents: 'Cash collected',
  bottlesDeliveredFull: 'Bottles delivered',
  bottlesEmptiesPickedUp: 'Empties collected',
  bottlesLostDamaged: 'Lost or damaged',
  paymentMethod: 'Method',
};

/** Render a proposed correction as the figures an admin has to judge. */
function describe(payload: Record<string, number | string> | null): string {
  if (!payload) return 'no changes recorded';
  return Object.entries(payload)
    .map(([k, v]) => {
      const label = FIELD_LABEL[k] ?? k;
      const value = k === 'paymentAmountCents' ? money(Number(v)) : String(v);
      return `${label}: ${value}`;
    })
    .join(' · ');
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
        Discounts, credit notes and stop corrections raised by office staff. Sales
        and deliveries are
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
                <td><span className="chip info">{TYPE_LABEL[r.requestType] ?? r.requestType}</span></td>
                <td>{r.customerName ?? '—'}</td>
                <td className="small">{r.entityLabel ?? '—'}</td>
                <td className="small">{r.reason ?? '—'}</td>
                <td className="small muted">
                  {r.requestedByName ?? '—'}<br />{date(r.requestedDate)}
                </td>
                <td className="num">
                  {/* A correction changes recorded figures, not a value owed,
                      so show what would actually change rather than a total
                      that reads like money moving. */}
                  {r.requestType === 'StopCorrection'
                    ? <div className="small" style={{ textAlign: 'left' }}>{describe(r.payload)}</div>
                    : <>
                        {money(r.amountCents)}
                        {r.discountPercent
                          ? <div className="muted small">{r.discountPercent}%</div> : null}
                      </>}
                </td>
                {session.role === 'admin' && (
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="approve-soft" disabled={busy} onClick={() => review(r.id, 'Approved')}>Approve</button>{' '}
                    <button className="danger-soft" disabled={busy}
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
