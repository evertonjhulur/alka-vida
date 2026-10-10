import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { time, when } from '../lib/format';
import {
  AddStopPanel, AdditionsList, ConfirmLoadPanel, ReturnsPanel, TruckTable, KIND_WORDS, collectionSummary,
  type Collection, type Truck,
} from '../components/Truck';

interface Stop {
  id: string; customer_name: string; delivery_address: string | null;
  sequence_no: number; stop_outcome: string; line_items_summary: string | null;
  order_ref?: string | null; delivery_instructions?: string | null; order_notes?: string | null;
  remainder_to?: string | null; payment_amount_cents?: number; bottles_empties_picked_up?: number;
  after_stop_id?: string | null;
}

const OUTCOME_WORDS: Record<string, string> = {
  'Customer Not Home': 'Not home', Rescheduled: 'Another day', Other: 'Not delivered', 'Payment Only': 'Payment only',
};
interface Sheet {
  id: string; delivery_date: string; zone: string; status: string;
  assigned_driver_id: string | null; driver_name: string | null;
  started_at: string | null; stops: Stop[]; collections: Collection[]; truck: Truck | null;
}

/** One visit-ordered list: delivery and payment stops, and collection stops. */
type Visit = { kind: 'stop'; seq: number; stop: Stop } | { kind: 'collection'; seq: number; c: Collection };
const visitsOf = (sheet: Sheet): Visit[] => [
  ...sheet.stops.map((stop) => ({ kind: 'stop' as const, seq: Number(stop.sequence_no), stop })),
  ...(sheet.collections ?? []).map((c) => ({ kind: 'collection' as const, seq: Number(c.sequence_no), c })),
].sort((a, b) => a.seq - b.seq);
const pending = (v: Visit) => (v.kind === 'stop' ? v.stop.stop_outcome === 'Pending' : v.c.status === 'Pending');
/** Empties picked up at stops and collected on collection stops: what should be on the truck. */
const emptiesOnRound = (sheet: Sheet) =>
  sheet.stops.reduce((t, s) => t + Number(s.bottles_empties_picked_up ?? 0), 0)
  + (sheet.collections ?? []).filter((c) => c.kind === 'Empties' && c.status === 'Collected')
    .reduce((t, c) => t + Number(c.empties_count), 0);

export default function DriverRoute({ session }: { session: Session }) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** The round whose "+ Add a stop" panel is open. */
  const [addFor, setAddFor] = useState<string | null>(null);
  /** An unclaimed round the driver is loading to start. */
  const [loadingFor, setLoadingFor] = useState<string | null>(null);

  /**
   * The API scopes this list: a driver is served their own routes and any
   * nobody has claimed, never another driver's round.
   */
  const load = useCallback(async () => {
    try {
      const list = await api.get<Array<{ id: string }>>('/api/delivery-sheets?status=Open');
      setSheets(await Promise.all(
        list.map((s) => api.get<Sheet>(`/api/delivery-sheets/${s.id}`)),
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your routes');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const done = (message: string) => {
    setSaved(message); setError(null); setAddFor(null); setLoadingFor(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    load();
  };

  const byDate = (a: Sheet, b: Sheet) => String(a.delivery_date).localeCompare(String(b.delivery_date));
  const mine = sheets.filter((s) => s.assigned_driver_id === session.id).sort(byDate);
  const unclaimed = sheets.filter((s) => !s.assigned_driver_id).sort(byDate);

  /**
   * A round where every stop has an outcome is the driver's work done: it
   * only stays open until the office settles the cash. Listing it in full
   * beside today's round pushed the stops the driver actually has left
   * below the fold, so finished rounds fold away underneath.
   */
  const isFinished = (s: Sheet) => {
    const v = visitsOf(s);
    // A loaded truck still has to be counted back before the work is done.
    return v.length > 0 && !v.some(pending) && (!s.truck || !!s.truck.returnedAt)
      && !(s.truck?.additions ?? []).some((a) => !a.driverConfirmedAt);
  };
  const active = mine.filter((s) => !isFinished(s));
  const finished = mine.filter(isFinished);

  /**
   * Plain functions returning JSX, NOT nested components: a component
   * declared inside another gets a new type every render, so everything
   * under it unmounts and remounts.
   */
  const stopCard = (stop: Stop, i: number) => (
    <Link key={stop.id} to={`/route/stop/${stop.id}`}
          style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="stop-card">
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            {/* Position in the round. sequence_no is the zone's sort
                key (0, 10, 20...), which means nothing to a driver. */}
            <span className="seq">{i + 1}</span>
            <strong>{stop.customer_name}</strong>
            <div className="muted small" style={{ marginLeft: 34 }}>
              {stop.delivery_address ?? 'No address on file'}
            </div>
            {stop.order_ref && (
              <div className="muted small" style={{ marginLeft: 34 }}>{stop.order_ref}</div>
            )}
            {stop.line_items_summary && (
              <div className="small" style={{ marginLeft: 34, marginTop: 4 }}>
                {stop.line_items_summary}
              </div>
            )}
            {(stop.delivery_instructions || (stop.order_notes && !/^Standing order for/.test(stop.order_notes))) && (
              <div className="stop-notes" style={{ marginLeft: 34 }}>
                {[stop.delivery_instructions, stop.order_notes && !/^Standing order for/.test(stop.order_notes) ? stop.order_notes : null]
                  .filter(Boolean).join('\n')}
              </div>
            )}
          </div>
          <span className={`chip ${stop.stop_outcome === 'Delivered' ? (stop.remainder_to ? 'warn' : 'ok')
            : stop.stop_outcome === 'Pending' ? 'neutral' : stop.stop_outcome === 'Payment Only' ? 'info' : 'warn'}`}>
            {stop.stop_outcome === 'Delivered' && stop.remainder_to ? 'Part delivered'
              : stop.stop_outcome === 'Pending' && stop.line_items_summary === 'Collect payment' ? 'Collect payment'
                : OUTCOME_WORDS[stop.stop_outcome] ?? stop.stop_outcome}
          </span>
        </div>
      </div>
    </Link>
  );

  const collectionCard = (c: Collection, i: number) => (
    <Link key={c.id} to={`/route/collection/${c.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="stop-card">
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <span className="seq">{i + 1}</span>
            <strong>{c.kind === 'Supplier' ? c.supplier_name : c.customer_name}</strong>
            <div className="muted small" style={{ marginLeft: 34 }}>
              {(c.kind === 'Supplier' ? c.supplier_address : c.delivery_address) ?? ''}
            </div>
            <div className="small" style={{ marginLeft: 34, marginTop: 4 }}>
              <strong>{KIND_WORDS[c.kind]}</strong>: {collectionSummary(c)}
            </div>
          </div>
          <span className={`chip ${c.status === 'Collected' ? 'ok' : c.status === 'Pending' ? 'neutral' : 'warn'}`}>
            {c.status === 'Pending' ? 'To do' : c.status}
          </span>
        </div>
      </div>
    </Link>
  );

  const stopList = (sheet: Sheet) => {
    const visits = visitsOf(sheet);
    return (
      <>
        {visits.map((v, i) => (v.kind === 'stop' ? stopCard(v.stop, i) : collectionCard(v.c, i)))}
        {visits.length === 0 && <p className="muted">No stops on this route.</p>}
      </>
    );
  };

  const heading = (sheet: Sheet) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <h2>{when(sheet.delivery_date)} — {sheet.zone}</h2>
      <span className="muted small">
        {visitsOf(sheet).filter((v) => !pending(v)).length} of{' '}
        {visitsOf(sheet).length} done
      </span>
    </div>
  );

  return (
    <>
      <h1>My route</h1>
      {error && <div className="notice error">{error}</div>}
      {saved && <div className="notice ok">{saved}</div>}

      {active.map((sheet) => {
        const allDone = visitsOf(sheet).length > 0 && !visitsOf(sheet).some(pending);
        return (
          <div key={sheet.id}>
            {heading(sheet)}
            {sheet.started_at ? (
              <p className="subtitle">
                Started {time(sheet.started_at)}. Stops are in visit order.
                {sheet.truck && <> Load confirmed{sheet.truck.driverConfirmedAt ? ` ${time(sheet.truck.driverConfirmedAt)}` : ''}; loaded by {sheet.truck.loaderNames.join(', ') || '—'}.</>}
              </p>
            ) : (
              <>
                <p className="subtitle">This route is yours. Check the load the office logged, and confirm it when you set off.</p>
                <ConfirmLoadPanel sheetId={sheet.id} onDone={done} />
              </>
            )}
            {/* Added to the load after it was confirmed: the driver reconfirms. */}
            {sheet.truck && (sheet.truck.additions ?? []).some((a) => !a.driverConfirmedAt) && (
              <div className="panel" style={{ borderColor: 'var(--warn)' }}>
                <h2 className="side-h" style={{ marginTop: 0 }}>The office added to your load</h2>
                <AdditionsList additions={(sheet.truck.additions ?? []).filter((a) => !a.driverConfirmedAt)} role="driver" onDone={done} />
              </div>
            )}
            {sheet.started_at && stopList(sheet)}
            {sheet.started_at && (
              <>
                <button type="button" className="secondary" style={{ marginTop: 8 }} aria-expanded={addFor === sheet.id}
                        onClick={() => { setAddFor(addFor === sheet.id ? null : sheet.id); setSaved(null); }}>
                  {addFor === sheet.id ? 'Close' : '+ Add a stop'}
                </button>
                {addFor === sheet.id && <AddStopPanel sheetId={sheet.id} office={false} onDone={done} />}
              </>
            )}
            {sheet.started_at && sheet.truck && (allDone || sheet.truck.returnedAt) && (
              <div className="panel" style={{ marginTop: 14 }}>
                <h2 className="side-h" style={{ marginTop: 0 }}>Back at the yard</h2>
                <TruckTable truck={sheet.truck} />
                {!sheet.truck.returnedAt && (
                  <ReturnsPanel sheetId={sheet.id} truck={sheet.truck} expectedEmpties={emptiesOnRound(sheet)} onDone={done} />
                )}
              </div>
            )}
          </div>
        );
      })}

      {finished.length > 0 && (
        <div style={{ marginTop: active.length ? 32 : 0 }}>
          <h2>Finished, waiting for the office to settle</h2>
          {finished.map((sheet) => (
            <details className="panel" key={sheet.id}>
              <summary style={{ cursor: 'pointer' }}>
                <strong>{when(sheet.delivery_date)} — {sheet.zone}</strong>
                <span className="muted small"> · all {visitsOf(sheet).length} stops done{sheet.truck?.returnedAt ? ', truck counted back' : ''}</span>
              </summary>
              <div style={{ marginTop: 12 }}>{stopList(sheet)}</div>
            </details>
          ))}
        </div>
      )}

      {unclaimed.length > 0 && (
        <div style={{ marginTop: mine.length ? 32 : 0 }}>
          <h2>Routes nobody has taken</h2>
          <p className="subtitle">Starting one puts it in your name.</p>
          {unclaimed.map((sheet) => (
            <div className="panel" key={sheet.id}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
              }}>
                <div>
                  <strong>{when(sheet.delivery_date)} — {sheet.zone}</strong>
                  <div className="muted small">
                    {visitsOf(sheet).length} stop{visitsOf(sheet).length === 1 ? '' : 's'}
                  </div>
                </div>
                <button type="button" onClick={() => setLoadingFor(loadingFor === sheet.id ? null : sheet.id)}>
                  {loadingFor === sheet.id ? 'Close' : 'Start this route'}
                </button>
              </div>
              {loadingFor === sheet.id && <div style={{ marginTop: 10 }}><ConfirmLoadPanel sheetId={sheet.id} onDone={done} /></div>}
            </div>
          ))}
        </div>
      )}

      {sheets.length === 0 && !error && <p className="muted">No open routes today.</p>}
    </>
  );
}
