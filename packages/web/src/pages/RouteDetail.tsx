import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date } from '../lib/format';

interface Stop {
  id: string;
  customer_name: string;
  delivery_address: string | null;
  contact_phone: string | null;
  order_ref: string | null;
  line_items_summary: string | null;
  sequence_no: number;
  stop_outcome: string;
  payment_amount_cents: number;
}

interface Sheet {
  id: string;
  delivery_date: string;
  zone: string;
  status: string;
  driver_name: string | null;
  assigned_driver_id: string | null;
  started_at: string | null;
  vehicle: string | null;
  stops: Stop[];
}

interface Driver { id: string; name: string }

interface Candidate {
  id: string;
  order_number: string;
  customer_name: string;
  requested_delivery_date: string | null;
  delivery_zone: string | null;
  grand_total_cents: number;
  summary: string | null;
}

const outcomeTone = (outcome: string) =>
  outcome === 'Delivered' ? 'ok' : outcome === 'Pending' ? 'neutral' : 'warn';

export default function RouteDetail({ session }: { session: Session }) {
  const { sheetId = '' } = useParams();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const office = session.role === 'admin' || session.role === 'user';

  const load = useCallback(async () => {
    try {
      const s = await api.get<Sheet>(`/api/delivery-sheets/${sheetId}`);
      setSheet(s);
      if (office && s.status === 'Open') {
        setCandidates(await api.get<Candidate[]>(`/api/delivery-sheets/${sheetId}/candidates`));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this route');
    }
  }, [sheetId, office]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (office) api.get<Driver[]>('/api/drivers').then(setDrivers).catch(() => {});
  }, [office]);

  /** Every action here is the same shape: do it, say what happened, reload. */
  async function act(what: () => Promise<string>) {
    setBusy(true); setError(null); setMsg(null);
    try {
      setMsg(await what());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  const assign = (driverId: string) => act(async () => {
    const out = await api.post<{ driverName: string | null }>(
      `/api/delivery-sheets/${sheetId}/assign`, { driverId: driverId || null },
    );
    return out.driverName ? `Route assigned to ${out.driverName}.` : 'Driver removed.';
  });

  const start = () => act(async () => {
    await api.post(`/api/delivery-sheets/${sheetId}/start`);
    return 'Route started.';
  });

  const addOrder = () => act(async () => {
    await api.post(`/api/delivery-sheets/${sheetId}/add-order`, { orderId: pick });
    const added = candidates.find((c) => c.id === pick);
    setPick('');
    return `${added?.order_number ?? 'Order'} added to this route.`;
  });

  const removeStop = (stop: Stop) => act(async () => {
    await api.del(`/api/stops/${stop.id}`);
    return `${stop.order_ref ?? stop.customer_name} taken off this route. ` +
           `The order is waiting for delivery again.`;
  });

  /** Move a stop up or down, then persist the whole visit order. */
  const move = (index: number, by: number) => act(async () => {
    const ordered = [...sheet!.stops];
    const target = index + by;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    await api.post(`/api/delivery-sheets/${sheetId}/resequence`, {
      order: ordered.map((s, i) => ({ stopId: s.id, sequenceNo: (i + 1) * 10 })),
    });
    return 'Visit order updated.';
  });

  if (error && !sheet) return <div className="notice error">{error}</div>;
  if (!sheet) return <p className="muted">Loading…</p>;

  const open = sheet.status === 'Open';
  const worked = sheet.stops.filter((s) => s.stop_outcome !== 'Pending').length;

  return (
    <>
      <h1>{date(sheet.delivery_date)} — {sheet.zone}</h1>
      <p className="subtitle">
        {sheet.stops.length} stop{sheet.stops.length === 1 ? '' : 's'}
        {worked > 0 && `, ${worked} already worked`}
        {sheet.started_at
          ? ` · started ${String(sheet.started_at).slice(11, 16)}`
          : ' · not started'}
        {sheet.vehicle ? ` · ${sheet.vehicle}` : ''}
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {!open && (
        <div className="notice info">
          This route has been settled. It is shown for reference and cannot be changed.
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label htmlFor="drv">Driver</label>
            {office ? (
              <select id="drv" value={sheet.assigned_driver_id ?? ''} disabled={busy || !open}
                      onChange={(e) => assign(e.target.value)}>
                <option value="">Not assigned</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            ) : (
              <p style={{ margin: 0 }}>{sheet.driver_name ?? 'Not assigned'}</p>
            )}
          </div>

          {open && !sheet.started_at && (
            <div className="field">
              <button type="button" className="secondary" disabled={busy} onClick={start}>
                Start route
              </button>
            </div>
          )}

          {open && (
            <div className="field">
              <Link to={`/delivery/${sheet.id}/settlement`}>
                <button type="button" disabled={busy}>Settle route</button>
              </Link>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Stops, in visit order</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>Customer</th><th>Order</th><th>Load</th>
              <th>Outcome</th><th className="num">Collected</th><th />
            </tr>
          </thead>
          <tbody>
            {sheet.stops.map((s, i) => (
              <tr key={s.id}>
                <td>{i + 1}</td>
                <td>
                  <strong>{s.customer_name}</strong>
                  <div className="muted small">{s.delivery_address ?? 'No address on file'}</div>
                </td>
                <td>{s.order_ref ?? '—'}</td>
                <td className="small">{s.line_items_summary ?? '—'}</td>
                <td><span className={`chip ${outcomeTone(s.stop_outcome)}`}>{s.stop_outcome}</span></td>
                <td className="num">
                  {s.payment_amount_cents ? money(Number(s.payment_amount_cents))
                    : <span className="muted">—</span>}
                </td>
                <td className="num">
                  {open && office && s.stop_outcome === 'Pending' && (
                    <>
                      <button type="button" className="secondary" disabled={busy || i === 0}
                              onClick={() => move(i, -1)} title="Visit earlier">↑</button>
                      {' '}
                      <button type="button" className="secondary"
                              disabled={busy || i === sheet.stops.length - 1}
                              onClick={() => move(i, 1)} title="Visit later">↓</button>
                      {' '}
                      <button type="button" className="secondary" disabled={busy}
                              onClick={() => removeStop(s)}>Remove</button>
                    </>
                  )}
                  {' '}
                  <Link to={`/route/stop/${s.id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.stops.length === 0 && (
          <p className="muted">
            No stops on this route yet. Add an order waiting for delivery below.
          </p>
        )}
      </div>

      {office && open && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Add an order waiting for delivery</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Any order not already on an open route, whatever its zone or requested
            date — a missed drop from yesterday belongs here just as much as today's.
          </p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '1 1 420px' }}>
              <label htmlFor="cand">Order</label>
              <select id="cand" value={pick} style={{ width: '100%' }}
                      onChange={(e) => setPick(e.target.value)}>
                <option value="">Select an order…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.order_number} — {c.customer_name}
                    {c.delivery_zone ? ` (${c.delivery_zone})` : ''}
                    {c.requested_delivery_date ? ` for ${date(c.requested_delivery_date)}` : ''}
                    {` — ${money(Number(c.grand_total_cents))}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <button type="button" disabled={busy || !pick} onClick={addOrder}>
                Add to route
              </button>
            </div>
          </div>
          {candidates.length === 0 && (
            <p className="muted">Every order awaiting delivery is already on a route.</p>
          )}
        </div>
      )}
    </>
  );
}
