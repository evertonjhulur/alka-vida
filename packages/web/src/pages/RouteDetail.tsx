import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, date, day, time } from '../lib/format';

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
  payment_method?: string | null;
  bottles_delivered_full?: number;
  bottles_empties_picked_up?: number;
  order_total_cents?: number | null;
  invoice_number?: string | null;
  invoice_id?: string | null;
  delivery_instructions?: string | null;
  order_notes?: string | null;
  customer_po?: string | null;
  rescheduled_to?: string | null;
  reschedule_reason?: string | null;
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
const OUTCOME_WORDS: Record<string, string> = {
  'Customer Not Home': 'Not home', Refused: 'Refused', Rescheduled: 'Rescheduled', Other: 'Not delivered',
};

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
  /**
   * The filled button is the NEXT thing to do with this round, so it follows
   * the round's state: start it, then settle it once every stop has an
   * outcome. Settling stays available throughout (as a plain button) - a
   * round can be closed early - but it is no longer the first thing an
   * unstarted round offers.
   */
  const allWorked = sheet.stops.length > 0 && worked === sheet.stops.length;
  const settleIsNext = !!sheet.started_at && allWorked;

  /*
   * The round as four steps (approved mockup, 29 Sep 2026): assigned,
   * started, delivering (x of y worked), settle. The step that is next is
   * highlighted, so it is plain what the round is waiting for.
   */
  const assigned = !!sheet.assigned_driver_id || !!sheet.driver_name;
  const stage = !open ? 5 : !assigned ? 1 : !sheet.started_at ? 2 : !allWorked ? 3 : 4;
  const statusChip = !open ? ['Settled', 'ok'] : !sheet.started_at ? ['Not started', 'neutral']
    : allWorked ? ['Back, ready to settle', 'warn'] : ['On the road', 'info'];
  const firstPending = sheet.stops.findIndex((s) => s.stop_outcome === 'Pending');
  const onTruck = sheet.stops.reduce((t, s) => t + Number(s.order_total_cents ?? 0), 0);
  const cash = sheet.stops.reduce((t, s) => t + Number(s.payment_amount_cents ?? 0), 0);
  const fullOut = sheet.stops.reduce((t, s) => t + Number(s.bottles_delivered_full ?? 0), 0);
  const emptiesBack = sheet.stops.reduce((t, s) => t + Number(s.bottles_empties_picked_up ?? 0), 0);
  const stillOut = sheet.stops.length - worked;
  const stepClass = (n: number) => `step${stage === n ? ' now' : stage > n ? ' done' : ''}`;

  return (
    <>
      <Link to="/delivery" className="back-link">← Delivery rounds</Link>
      <div className="inv-title">
        <h1>{sheet.zone} · {day(sheet.delivery_date)} {date(sheet.delivery_date).slice(0, 4)}</h1>
        <span className={`chip ${statusChip[1]}`}>{statusChip[0]}</span>
      </div>
      <p className="subtitle">
        {[sheet.driver_name ?? 'No driver yet', sheet.vehicle,
          sheet.started_at ? `started ${time(sheet.started_at)}` : null,
          `${sheet.stops.length} ${sheet.stops.length === 1 ? 'stop' : 'stops'}`].filter(Boolean).join(' · ')}
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {!open && (
        <div className="notice info">
          This round has been settled. It is shown for reference and cannot be changed.
        </div>
      )}

      <ol className="steps" aria-label="Round progress">
        <li className={stepClass(1)}>
          <strong>1 · Assigned</strong>
          {office && open ? (
            <select aria-label="Driver" value={sheet.assigned_driver_id ?? ''} disabled={busy}
                    onChange={(e) => assign(e.target.value)}>
              <option value="">Choose a driver…</option>
              {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          ) : <div className="small">{sheet.driver_name ?? 'no driver'}{sheet.vehicle ? `, ${sheet.vehicle}` : ''}</div>}
        </li>
        <li className={stepClass(2)}>
          <strong>2 · Started</strong>
          {sheet.started_at ? <div className="small">{time(sheet.started_at)}</div>
            : open ? <button type="button" disabled={busy} onClick={start}>Start round</button>
              : <div className="small">—</div>}
        </li>
        <li className={stepClass(3)}>
          <strong>3 · Delivering</strong>
          <div className="small">{worked} of {sheet.stops.length} stops worked</div>
        </li>
        <li className={stepClass(4)}>
          <strong>4 · Settle</strong>
          {open && settleIsNext ? (
            <Link to={`/delivery/${sheet.id}/settlement`} className="button-link">Settle now</Link>
          ) : <div className="small">{open ? 'when the driver is back' : 'done'}</div>}
        </li>
      </ol>

      <div className="inv-grid">
        <section className="panel" style={{ padding: 0 }}>
          <div className="panel-pad" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>Stops, in visit order</h2>
            {open && office && sheet.stops.length > 1 && <span className="muted small">↑ ↓ change the order</span>}
          </div>
          <table className="orders-table round-table">
            <thead>
              <tr><th style={{ width: 40 }}>#</th><th>Customer</th><th>Load</th><th>Outcome</th><th className="num">Collected</th><th /></tr>
            </thead>
            <tbody>
              {sheet.stops.map((s, i) => (
                <tr key={s.id}>
                  <td data-label="Order"><span className="stop-no">{i + 1}</span></td>
                  <td data-label="Customer">
                    <strong>{s.customer_name}</strong>
                    <div className="muted small">{s.delivery_address ?? 'No address on file'}</div>
                    <div className="small">{[s.order_ref, s.customer_po ? `PO ${s.customer_po}` : null].filter(Boolean).join(' · ')}</div>
                    {(s.delivery_instructions || (s.order_notes && !/^Standing order for/.test(s.order_notes))) && (
                      <div className="stop-notes">
                        {s.delivery_instructions}
                        {s.delivery_instructions && s.order_notes && !/^Standing order for/.test(s.order_notes) ? '\n' : ''}
                        {s.order_notes && !/^Standing order for/.test(s.order_notes) ? s.order_notes : ''}
                      </div>
                    )}
                  </td>
                  <td data-label="How" className="small">{s.line_items_summary ? s.line_items_summary.replace(/Alka Vida\s+/gi, '') : '—'}</td>
                  <td data-label="Status">
                    {s.stop_outcome === 'Pending' && open && i === firstPending && sheet.started_at
                      ? <span className="chip info">Next stop</span>
                      : <span className={`chip ${outcomeTone(s.stop_outcome)}`}>{OUTCOME_WORDS[s.stop_outcome] ?? (s.stop_outcome === 'Pending' ? 'To do' : s.stop_outcome)}</span>}
                    {s.rescheduled_to && (
                      <div className="small">to {day(s.rescheduled_to)}{s.reschedule_reason ? `: ${s.reschedule_reason}` : ''}</div>
                    )}
                    {s.invoice_number && s.invoice_id && (
                      <div className="small"><Link to={`/invoices/${s.invoice_id}`}>{s.invoice_number}</Link></div>
                    )}
                  </td>
                  <td data-label="Total" className="num">
                    {Number(s.payment_amount_cents) > 0 ? (
                      <>{money(Number(s.payment_amount_cents))}<div className="muted small">{(s.payment_method ?? '').toLowerCase()}</div></>
                    ) : s.stop_outcome === 'Delivered' ? <span className="muted small">on account</span> : <span className="muted">—</span>}
                  </td>
                  <td className="num order-actions">
                    {open && office && s.stop_outcome === 'Pending' && (
                      <>
                        <button type="button" className="secondary more-button" disabled={busy || i === 0}
                                onClick={() => move(i, -1)} aria-label={`Visit ${s.customer_name} earlier`}>↑</button>
                        <button type="button" className="secondary more-button"
                                disabled={busy || i === sheet.stops.length - 1}
                                onClick={() => move(i, 1)} aria-label={`Visit ${s.customer_name} later`}>↓</button>
                        <button type="button" className="danger-soft" disabled={busy}
                                onClick={() => removeStop(s)}>Remove</button>
                      </>
                    )}
                    <Link to={`/route/stop/${s.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sheet.stops.length === 0 && (
            <p className="muted" style={{ padding: '0 16px 14px', margin: 0 }}>
              No stops on this round yet. Add an order waiting for delivery below.
            </p>
          )}

          {office && open && (
            <div className="add-order">
              <label htmlFor="cand">Add an order waiting for delivery</label>
              <div className="row" style={{ alignItems: 'center' }}>
                <select id="cand" value={pick} style={{ flex: '1 1 320px' }}
                        onChange={(e) => setPick(e.target.value)}>
                  <option value="">{candidates.length ? 'Choose an order…' : 'Every waiting order is already on a round'}</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.order_number} · {c.customer_name}
                      {c.delivery_zone ? ` (${c.delivery_zone})` : ''}
                      {c.requested_delivery_date ? ` for ${day(c.requested_delivery_date)}` : ''}
                      {` · ${money(Number(c.grand_total_cents))}`}
                    </option>
                  ))}
                </select>
                <button type="button" disabled={busy || !pick} onClick={addOrder}>Add to round</button>
              </div>
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                Any order not already on an open round, whatever its zone or date: yesterday's missed drop belongs here too.
              </p>
            </div>
          )}
        </section>

        <aside className="inv-side">
          <section className="panel">
            <h2 className="side-h">Cash and bottles so far</h2>
            <div className="total-line"><span>On the truck</span><span>{money(onTruck)}</span></div>
            <div className="total-line"><span>Cash collected</span><span>{money(cash)}</span></div>
            <div className="total-line"><span>Full bottles out</span><span>{fullOut}</span></div>
            <div className="total-line"><span>Empties back</span><span>{emptiesBack}</span></div>
            {open && (
              <>
                <p className="muted small">
                  {stillOut > 0
                    ? `${stillOut} ${stillOut === 1 ? 'stop' : 'stops'} still to do. Settle when the driver is back; you can close it early if a stop won't be made.`
                    : sheet.stops.length ? 'Every stop has an outcome. Count the cash and bottles and settle.' : 'Nothing on it yet.'}
                </p>
                <Link to={`/delivery/${sheet.id}/settlement`} className={`button-link wide${settleIsNext ? '' : ' secondary'}`}>
                  {settleIsNext ? 'Settle round' : 'Settle round early'}
                </Link>
              </>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
