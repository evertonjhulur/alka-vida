import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ask } from '../components/Dialog';
import { api, openPdf, type Session } from '../lib/api';
import SortStopsPanel from '../components/SortStopsPanel';
import { otherZones, roundTitle } from '../lib/rounds';
import { money, date, day, time, when } from '../lib/format';
import {
  AddStopPanel, AddToLoadPanel, AdditionsList, LoadingPanel, ReturnsPanel, SamePersonFlag, TruckTable, KIND_WORDS, collectionSummary, loaderWords,
  type Collection, type Truck,
} from '../components/Truck';

interface Stop {
  id: string;
  customer_name: string;
  delivery_address: string | null;
  contact_phone: string | null;
  order_ref: string | null;
  line_items_summary: string | null;
  sequence_no: number;
  stop_outcome: string;
  remainder_to?: string | null;
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
  /** Map pin of the address the order goes to (23 Oct 2026). */
  lat?: number | null;
  location_source?: string | null;
  lng?: number | null;
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
  collections: Collection[];
  truck: Truck | null;
  /** The settlement, once done (27 Oct 2026: the notes were hard to find). */
  expected_cash_cents?: number | string | null; actual_cash_cents?: number | string | null; cash_variance_cents?: number | string | null;
  settlement_notes?: string | null; bottle_actual_returned?: number | null; bottle_variance?: number | null;
  bottle_settle_notes?: string | null; reconciled_date?: string | null; reconciled_by_name?: string | null;
  /** Several rounds a day (27 Nov 2026). */
  name?: string | null; stop_zones?: string[];
  resort_needed_at?: string | null; resort_note?: string | null;
}

interface Target {
  id: string; label: string; zone: string; driverName: string | null; vehicle: string | null;
  started: boolean; stopCount: number; stopZones: string[];
}

/**
 * Move stops to another round the same day, or merge this whole round into
 * one (27 Nov 2026). The reason is optional.
 */
function ToRoundPanel({ sheetId, mode, stopIds, names, onDone, onCancel }: {
  sheetId: string; mode: 'move' | 'merge'; stopIds: string[]; names: string[];
  onDone: (message: string, goTo?: string) => void; onCancel: () => void;
}) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Target[]>(`/api/delivery-sheets/${sheetId}/move-targets`).then(setTargets)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not list the rounds'));
  }, [sheetId]);
  const chosen = targets?.find((t) => t.id === to);
  // Opened from a stop further down the page: bring the panel into view.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [stopIds.join(','), mode]);
  async function go() {
    setBusy(true); setError(null);
    try {
      if (mode === 'move') {
        const r = await api.post<{ moved: string[]; to: string; warnings: string[] }>('/api/stops/move',
          { stopIds, toSheetId: to, reason: reason.trim() || null });
        onDone(`${r.moved.join(', ')} moved to the ${r.to} round.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`);
      } else {
        const r = await api.post<{ into: string; moved: string[]; warnings: string[] }>(`/api/delivery-sheets/${sheetId}/merge`,
          { intoSheetId: to, reason: reason.trim() || null });
        onDone(`Merged into the ${r.into} round${r.moved.length ? ` (${r.moved.length} ${r.moved.length === 1 ? 'stop' : 'stops'})` : ''}.`
          + `${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`, to);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
      setBusy(false);
    }
  }
  return (
    <div className="panel" ref={box} style={{ borderColor: 'var(--info, #2563eb)' }}>
      <h2 className="side-h" style={{ marginTop: 0 }}>
        {mode === 'move'
          ? `Move ${names.length === 1 ? names[0] : `${names.length} stops`} to another round`
          : 'Merge this round into another'}
      </h2>
      {error && <div className="notice error">{error}</div>}
      {targets && targets.length === 0 ? (
        <p className="small">There is no other open round on this day. Make one first with + New round on Delivery rounds.</p>
      ) : (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label htmlFor="to-round">To which round?</label>
            <select id="to-round" value={to} onChange={(e) => setTo(e.target.value)} disabled={!targets}>
              <option value="">{targets ? 'Choose a round…' : 'Loading…'}</option>
              {(targets ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}{t.stopZones.some((z) => z !== t.zone) ? ` (+ ${t.stopZones.filter((z) => z !== t.zone).join(', ')})` : ''}
                  {` · ${t.driverName ?? 'no driver yet'}`}{t.vehicle ? `, ${t.vehicle}` : ''}
                  {` · ${t.stopCount} ${t.stopCount === 1 ? 'stop' : 'stops'}`}{t.started ? ' · out on the road' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label htmlFor="to-reason">Reason (optional)</label>
            <input id="to-reason" value={reason} placeholder="e.g. truck down, driver off" onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
      )}
      {chosen?.started && (
        <p className="small" style={{ color: 'var(--warn)' }}>
          {chosen.label} is out on the road: the water is added to its load for the driver to reconfirm, and the driver is asked to sort the stops left to do.
        </p>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" disabled={busy || !to} onClick={go}>
          {busy ? 'Working…' : mode === 'move' ? 'Move' : 'Merge'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

interface Driver { id: string; name: string; office?: boolean }

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
  outcome === 'Delivered' ? 'ok' : outcome === 'Pending' ? 'neutral' : outcome === 'Payment Only' ? 'info' : 'warn';
const OUTCOME_WORDS: Record<string, string> = {
  'Customer Not Home': 'Not home', Refused: 'Refused', Rescheduled: 'Rescheduled', Other: 'Not delivered',
  'Payment Only': 'Payment only',
};

export default function RouteDetail({ session }: { session: Session }) {
  const { sheetId = '' } = useParams();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [pick, setPick] = useState('');
  /** Warnings about the picked order (19 Nov 2026), shown before it is added. */
  const [pickWarnings, setPickWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Office panels: record the loading, + Add a stop, correct the returns. */
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [fixReturns, setFixReturns] = useState(false);
  /** Adding to a load the driver has already confirmed. */
  const [adding2, setAdding2] = useState(false);
  /** Several rounds a day (27 Nov 2026): stops ticked to move, the move / merge panel, naming the round. */
  const [picked, setPicked] = useState<string[]>([]);
  const [toRound, setToRound] = useState<{ mode: 'move' | 'merge'; stopIds: string[] } | null>(null);
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [vehicleDraft, setVehicleDraft] = useState('');
  const location = useLocation();

  const office = session.role === 'admin' || session.role === 'user';
  const navigate = useNavigate();

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
  // A message carried from the screen that sent us here (a round just made or merged into).
  useEffect(() => {
    const m = (location.state as { made?: string } | null)?.made;
    if (m) setMsg(m);
  }, [location.state]);
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

  /**
   * Adding an order by hand (19 Nov 2026). First ask what to warn about - an
   * order booked for a later day (above all a standing order's next run), or
   * the same items already going to the same customer - and show it here.
   * Only "Add it anyway" then adds it.
   */
  async function addOrder() {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.get<{ warnings: string[] }>(
        `/api/delivery-sheets/${sheetId}/add-order-check?orderId=${encodeURIComponent(pick)}`);
      setBusy(false);
      if (r.warnings.length) { setPickWarnings(r.warnings); return; }
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'That did not work');
      return;
    }
    await reallyAdd(false);
  }
  const reallyAdd = (confirmed: boolean) => act(async () => {
    await api.post(`/api/delivery-sheets/${sheetId}/add-order`, { orderId: pick, confirmed });
    const added = candidates.find((c) => c.id === pick);
    setPick('');
    setPickWarnings([]);
    return `${added?.order_number ?? 'Order'} added to this route.`;
  });

  const removeStop = (stop: Stop) => act(async () => {
    await api.del(`/api/stops/${stop.id}`);
    return `${stop.order_ref ?? stop.customer_name} taken off this route. ` +
           `The order is waiting for delivery again.`;
  });

  /** Delete a round made by mistake (27 Oct 2026): not started, nothing recorded. */
  async function deleteRound() {
    if (!sheet) return;
    const n = sheet.stops.filter((s) => s.order_ref).length;
    const ok = await ask(`Delete the ${sheet.zone} round for ${day(sheet.delivery_date)}?`
      + (n ? (n === 1 ? ' Its order comes off it and waits for delivery again; the order is NOT cancelled (use Cancel order on Orders for that).'
        : ` Its ${n} orders come off it and wait for delivery again; they are NOT cancelled (use Cancel order on Orders for that).`) : ' It has no orders on it.')
      + (sheet.truck ? ' The loading logged for it goes back on the warehouse shelf.' : ''),
    { confirmLabel: 'Delete the round', danger: true });
    if (!ok) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.del(`/api/delivery-sheets/${sheet.id}`);
      navigate('/delivery', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The round could not be deleted');
      setBusy(false);
    }
  }

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

  const done = (message: string) => {
    setMsg(message); setError(null); setLoading(false); setAdding(false); setFixReturns(false); setAdding2(false);
    setPicked([]); setToRound(null);
    load();
  };
  const movedOrMerged = (message: string, goTo?: string) => {
    if (goTo) { navigate(`/delivery/${goTo}`, { replace: true, state: { made: message } }); return; }
    done(message);
  };
  const saveName = () => act(async () => {
    await api.patch(`/api/delivery-sheets/${sheetId}`, { name: nameDraft.trim() || null, vehicle: vehicleDraft.trim() || null });
    setNaming(false);
    return 'Round updated.';
  });
  const keepOrder = () => act(async () => {
    await api.post(`/api/delivery-sheets/${sheetId}/keep-order`);
    return 'Stop order kept as it is.';
  });

  if (error && !sheet) return <div className="notice error">{error}</div>;
  if (!sheet) return <p className="muted">Loading…</p>;

  const open = sheet.status === 'Open';
  const collections = sheet.collections ?? [];
  const worked = sheet.stops.filter((s) => s.stop_outcome !== 'Pending').length
    + collections.filter((c) => c.status !== 'Pending').length;
  const visitCount = sheet.stops.length + collections.length;
  /**
   * The filled button is the NEXT thing to do with this round, so it follows
   * the round's state: start it, then settle it once every stop has an
   * outcome. Settling stays available throughout (as a plain button) - a
   * round can be closed early - but it is no longer the first thing an
   * unstarted round offers.
   */
  const allWorked = visitCount > 0 && worked === visitCount;
  const settleIsNext = !!sheet.started_at && allWorked;

  /*
   * The round as four steps (approved mockup, 29 Sep 2026): assigned,
   * started, delivering (x of y worked), settle. The step that is next is
   * highlighted, so it is plain what the round is waiting for.
   */
  const assigned = !!sheet.assigned_driver_id || !!sheet.driver_name;
  const stage = !open ? 5 : !assigned ? 1 : !sheet.started_at ? 2 : !allWorked ? 3 : 4;
  const statusChip = !open ? ['Settled', 'ok'] : !sheet.started_at ? ['Not started', 'neutral']
    : allWorked ? ['Back, ready to settle', 'warn'] : ['Out on the road', 'info'];
  const firstPending = sheet.stops.findIndex((s) => s.stop_outcome === 'Pending');
  const onTruck = sheet.stops.reduce((t, s) => t + Number(s.order_total_cents ?? 0), 0);
  const cash = sheet.stops.reduce((t, s) => t + Number(s.payment_amount_cents ?? 0), 0);
  const fullOut = sheet.stops.reduce((t, s) => t + Number(s.bottles_delivered_full ?? 0), 0);
  // Delivered stops only: a stop that did not happen moved no bottles (27 Nov 2026).
  const emptiesBack = sheet.stops.filter((s) => s.stop_outcome === 'Delivered')
    .reduce((t, s) => t + Number(s.bottles_empties_picked_up ?? 0), 0)
    + collections.filter((c) => c.kind === 'Empties' && c.status === 'Collected').reduce((t, c) => t + Number(c.empties_count), 0);
  const stillOut = visitCount - worked;
  const truck = sheet.truck;
  const stepClass = (n: number) => `step${stage === n ? ' now' : stage > n ? ' done' : ''}`;

  return (
    <>
      <Link to="/delivery" className="back-link">← Delivery rounds</Link>
      <div className="inv-title">
        <h1>{roundTitle(sheet)} · {day(sheet.delivery_date)} {date(sheet.delivery_date).slice(0, 4)}</h1>
        <span className={`chip ${statusChip[1]}`}>{statusChip[0]}</span>
        {/* The paper copy for the driver (25 Oct 2026): opens in a new tab to print or save. */}
        <button type="button" className="secondary" style={{ marginLeft: 'auto' }}
                onClick={() => openPdf(`/api/delivery-sheets/${sheet.id}/sheet.pdf`).catch((e) => setError(e.message))}>
          Delivery sheet (PDF)
        </button>
      </div>
      <p className="subtitle">
        {[sheet.name ? `${sheet.zone} zone` : null,
          otherZones(sheet).length ? `also ${otherZones(sheet).join(', ')}` : null,
          sheet.driver_name ?? 'No driver yet', sheet.vehicle,
          sheet.started_at ? `started ${time(sheet.started_at)}` : null,
          `${visitCount} ${visitCount === 1 ? 'stop' : 'stops'}`].filter(Boolean).join(' · ')}
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {!open && (
        <div className="notice info">
          This round has been settled. It is shown for reference and cannot be changed.
        </div>
      )}
      {office && open && (
        <p className="small" style={{ marginTop: -6 }}>
          <button type="button" className="as-link small" disabled={busy}
                  onClick={() => { setNaming(!naming); setNameDraft(sheet.name ?? ''); setVehicleDraft(sheet.vehicle ?? ''); }}>
            Name and vehicle
          </button>
          {!sheet.started_at && worked === 0 && (
            <>
              {' · '}
              <button type="button" className="as-link small" disabled={busy}
                      onClick={() => setToRound(toRound?.mode === 'merge' ? null : { mode: 'merge', stopIds: [] })}>
                Merge into another round
              </button>
              {' · '}Made by mistake?{' '}
              <button type="button" className="as-link small bad-text" disabled={busy} onClick={deleteRound}>Delete this round</button>
            </>
          )}
        </p>
      )}
      {naming && office && open && (
        <div className="panel">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field">
              <label htmlFor="rd-name">Name (optional)</label>
              <input id="rd-name" value={nameDraft} placeholder={sheet.zone} onChange={(e) => setNameDraft(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="rd-vehicle">Vehicle</label>
              <input id="rd-vehicle" value={vehicleDraft} onChange={(e) => setVehicleDraft(e.target.value)} />
            </div>
            <div className="field">
              <button type="button" disabled={busy} onClick={saveName}>Save</button>{' '}
              <button type="button" className="secondary" disabled={busy} onClick={() => setNaming(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {toRound && office && open && (
        <ToRoundPanel sheetId={sheet.id} mode={toRound.mode} stopIds={toRound.stopIds}
                      names={sheet.stops.filter((x) => toRound.stopIds.includes(x.id)).map((x) => x.order_ref ?? x.customer_name)}
                      onDone={movedOrMerged} onCancel={() => setToRound(null)} />
      )}
      {open && sheet.started_at && sheet.resort_needed_at && (
        <div className="notice warn">
          <strong>Stops changed while the round is out.</strong>{' '}
          {sheet.resort_note ? `${sheet.resort_note}. ` : ''}
          {sheet.driver_name ?? 'The driver'} is asked to sort the stops left to do on My route.
          {office && <>{' '}<button type="button" className="as-link small" disabled={busy} onClick={keepOrder}>Keep the order as it is</button></>}
        </div>
      )}

      <ol className="steps" aria-label="Round progress">
        <li className={stepClass(1)}>
          <strong>1 · Assigned</strong>
          {office && open ? (
            <select aria-label="Driver" value={sheet.assigned_driver_id ?? ''} disabled={busy}
                    onChange={(e) => assign(e.target.value)}>
              <option value="">Choose a driver…</option>
              {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.office ? ' (office)' : ''}</option>)}
            </select>
          ) : <div className="small">{sheet.driver_name ?? 'no driver'}{sheet.vehicle ? `, ${sheet.vehicle}` : ''}</div>}
        </li>
        <li className={stepClass(2)}>
          <strong>2 · Loaded and started</strong>
          {/* Dual accountability (10 Oct 2026): the office logs the loading and
              confirms it loaded; the driver confirms the totals to start. */}
          {sheet.started_at ? (
            <>
              <div className="small">{time(sheet.started_at)}{truck?.driverConfirmedName ? ` · load confirmed by ${truck.driverConfirmedName}` : ''}</div>
              {truck?.samePerson && <div style={{ marginTop: 4 }}><SamePersonFlag name={truck.samePerson} compact /></div>}
            </>
          ) : !open ? <div className="small">—</div>
            : !truck ? (
              <>
                <button type="button" disabled={busy} onClick={() => setLoading(!loading)}>{loading ? 'Close' : 'Log the loading'}</button>
                <div><button type="button" className="as-link small" disabled={busy} onClick={start}>start without a loading</button></div>
              </>
            ) : (
              <>
                <div className="small">Loaded · waiting for {sheet.driver_name ?? 'the driver'} to confirm the load</div>
                <button type="button" className="as-link small" disabled={busy} onClick={() => setLoading(!loading)}>
                  {loading ? 'Close' : 'Change the loading'}
                </button>
              </>
            )}
        </li>
        <li className={stepClass(3)}>
          <strong>3 · Delivering</strong>
          <div className="small">{worked} of {visitCount} stops worked</div>
          {/* The paper sheet typed in by the office, in one go (25 Oct 2026). */}
          {office && open && worked < visitCount && (
            <Link to={`/delivery/${sheet.id}/enter`} className="small">Enter from the paper sheet</Link>
          )}
        </li>
        <li className={stepClass(4)}>
          <strong>4 · Settle</strong>
          {open && settleIsNext ? (
            <Link to={`/delivery/${sheet.id}/settlement`} className="button-link">Settle now</Link>
          ) : open ? <div className="small">when the driver is back</div> : (
            <div className="small">{sheet.reconciled_date ? `${day(sheet.reconciled_date)}, ${time(sheet.reconciled_date)}` : 'done'}
              {sheet.reconciled_by_name ? ` · ${sheet.reconciled_by_name}` : ''}</div>
          )}
        </li>
      </ol>

      {loading && open && !sheet.started_at && (
        <LoadingPanel sheetId={sheet.id} onDone={done} onCancel={() => setLoading(false)} />
      )}

      {open && office && (!sheet.started_at || sheet.resort_needed_at)
        && sheet.stops.filter((x) => !sheet.started_at || x.stop_outcome === 'Pending').length > 1 && (
        <SortStopsPanel sheetId={sheet.id} onDone={done} />
      )}

      <div className="inv-grid">
        <section className="panel" style={{ padding: 0 }}>
          <div className="panel-pad" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>Stops, in visit order</h2>
            {open && office && picked.length > 0 ? (
              <span className="small">
                {picked.length} ticked ·{' '}
                <button type="button" className="as-link small" onClick={() => setToRound({ mode: 'move', stopIds: picked })}>Move to another round</button>
                {' · '}
                <button type="button" className="as-link small" onClick={() => setPicked([])}>Clear</button>
              </span>
            ) : open && office && sheet.stops.length > 1 && <span className="muted small">↑ ↓ change the order · tick stops to move several</span>}
          </div>
          <table className="orders-table round-table">
            <thead>
              <tr><th style={{ width: 40 }}>#</th><th>Customer</th><th>Load</th><th>Outcome</th><th className="num">Collected</th><th /></tr>
            </thead>
            <tbody>
              {sheet.stops.map((s, i) => (
                <tr key={s.id}>
                  <td data-label="Order">
                    {open && office && s.stop_outcome === 'Pending' && s.order_ref ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" aria-label={`Tick ${s.customer_name} to move`} checked={picked.includes(s.id)}
                               onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
                        <span className="stop-no">{i + 1}</span>
                      </label>
                    ) : <span className="stop-no">{i + 1}</span>}
                  </td>
                  <td data-label="Customer">
                    <strong>{s.customer_name}</strong>
                    {s.lat == null && <span className="chip warn" style={{ marginLeft: 6 }}>no map pin</span>}
                    {s.lat != null && s.location_source === 'Approximate' && <span className="chip" style={{ marginLeft: 6 }} title="Worked out from the typed address; the driver saves the exact spot at the gate">approx. location</span>}
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
                    {s.remainder_to && (
                      <div className="small" style={{ color: 'var(--warn)' }}>part delivered; the rest {day(s.remainder_to)}</div>
                    )}
                    {s.stop_outcome === 'Payment Only' && (
                      <div className="muted small">nothing delivered; settles with the round</div>
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
                        {s.order_ref && (
                          <button type="button" className="secondary" disabled={busy}
                                  onClick={() => setToRound({ mode: 'move', stopIds: [s.id] })}>Move</button>
                        )}
                        <button type="button" className="danger-soft" disabled={busy}
                                onClick={() => removeStop(s)}>Remove</button>
                      </>
                    )}
                    <Link to={`/route/stop/${s.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
              {collections.map((c) => (
                <tr key={c.id}>
                  <td data-label="Order"><span className="stop-no">·</span></td>
                  <td data-label="Customer">
                    <strong>{c.kind === 'Supplier' ? c.supplier_name : c.customer_name}</strong>
                    <div className="muted small">{(c.kind === 'Supplier' ? c.supplier_address : c.delivery_address) ?? ''}</div>
                    <div className="small">{KIND_WORDS[c.kind]}{c.added_by_name ? ` · added by ${c.added_by_name}` : ''}</div>
                  </td>
                  <td data-label="How" className="small">{collectionSummary(c)}</td>
                  <td data-label="Status">
                    <span className={`chip ${c.status === 'Collected' ? 'ok' : c.status === 'Pending' ? 'neutral' : 'warn'}`}>
                      {c.status === 'Pending' ? 'To do' : c.status}
                    </span>
                    {c.kind === 'Returns' && c.credit_decision && (
                      <div className="small">{c.credit_decision}{c.credit_note_number ? ` ${c.credit_note_number}` : ''}</div>
                    )}
                  </td>
                  <td data-label="Total" className="num"><span className="muted">—</span></td>
                  <td className="num order-actions"><Link to={`/route/collection/${c.id}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
          {visitCount === 0 && (
            <p className="muted" style={{ padding: '0 16px 14px', margin: 0 }}>
              No stops on this round yet. Add an order waiting for delivery below.
            </p>
          )}

          {office && open && (
            <div className="add-order">
              <label htmlFor="cand">Add an order waiting for delivery</label>
              <div className="row" style={{ alignItems: 'center' }}>
                <select id="cand" value={pick} style={{ flex: '1 1 320px' }}
                        onChange={(e) => { setPick(e.target.value); setPickWarnings([]); }}>
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
                <button type="button" disabled={busy || !pick || pickWarnings.length > 0} onClick={addOrder}>Add to round</button>
              </div>
              {pickWarnings.length > 0 && (
                <div className="notice warn" role="alert" style={{ marginTop: 8 }}>
                  <strong>Check before adding {candidates.find((c) => c.id === pick)?.order_number ?? 'this order'}:</strong>
                  <ul style={{ margin: '6px 0 8px', paddingLeft: 20 }}>
                    {pickWarnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                  <div className="row" style={{ gap: 8 }}>
                    <button type="button" className="approve-soft" disabled={busy} onClick={() => reallyAdd(true)}>Add it anyway</button>
                    <button type="button" className="secondary" disabled={busy}
                            onClick={() => { setPickWarnings([]); setPick(''); }}>Don't add it</button>
                  </div>
                </div>
              )}
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                Any order not already on an open round, whatever its zone or date: yesterday's missed drop belongs here too.
              </p>
              <button type="button" className="secondary" style={{ marginTop: 10 }} aria-expanded={adding}
                      onClick={() => setAdding(!adding)}>
                {adding ? 'Close' : '+ Add a stop: payment, empties, returned goods or a supplier pick-up'}
              </button>
              {adding && <AddStopPanel sheetId={sheet.id} office onDone={done} />}
            </div>
          )}
        </section>

        <aside className="inv-side">
          {truck && (
            <section className="panel">
              <h2 className="side-h">The truck</h2>
              <p className="muted small" style={{ marginTop: 0 }}>
                {loaderWords(truck.loadedByName, truck.loaderNames)}, {when(truck.loadedAt)} {time(truck.loadedAt)}.
                {truck.driverConfirmedName
                  ? ` Confirmed by ${truck.driverConfirmedName} ${time(truck.driverConfirmedAt)}.`
                  : ' Not yet confirmed by the driver.'}
                {truck.returnedAt ? ` Counted back ${time(truck.returnedAt)} by ${truck.returnedByName ?? '—'}.` : ''}
              </p>
              <SamePersonFlag name={truck.samePerson} />
              <TruckTable truck={truck} />
              <AdditionsList additions={truck.additions ?? []} role="office" onDone={done} />
              {open && office && truck.driverConfirmedAt && !truck.returnedAt && (
                adding2
                  ? <AddToLoadPanel sheetId={sheet.id} onDone={done} onCancel={() => setAdding2(false)} />
                  : <button type="button" className="secondary" style={{ marginTop: 8 }} onClick={() => setAdding2(true)}>+ Add to the load</button>
              )}
              {truck.returnedAt && truck.emptiesBack !== null && (
                <div className="total-line"><span>Empties off the truck</span><span>{truck.emptiesBack}{truck.emptiesBack !== emptiesBack ? ` (recorded ${emptiesBack})` : ''}</span></div>
              )}
              {truck.returnNotes && <div className="small">{truck.returnNotes}</div>}
              {open && office && !truck.returnedAt && !allWorked && !fixReturns && sheet.started_at && (
                <button type="button" className="as-link small" onClick={() => setFixReturns(true)}>
                  Count what came back now (the driver is still out)
                </button>
              )}
              {open && office && sheet.started_at && ((!truck.returnedAt && allWorked) || fixReturns) && (
                <ReturnsPanel sheetId={sheet.id} truck={truck} expectedEmpties={emptiesBack} onDone={done} />
              )}
              {open && office && truck.returnedAt && !fixReturns && (
                <button type="button" className="as-link small" onClick={() => setFixReturns(true)}>Correct what came back</button>
              )}
            </section>
          )}
          <section className="panel">
            <h2 className="side-h">{open ? 'Cash and bottles so far' : 'Cash and bottles'}</h2>
            <div className="total-line"><span>On the truck</span><span>{money(onTruck)}</span></div>
            <div className="total-line"><span>Cash collected</span><span>{money(cash)}</span></div>
            <div className="total-line"><span>Full bottles out</span><span>{fullOut}</span></div>
            <div className="total-line"><span>Empties back</span><span>{emptiesBack}</span></div>
            {!open && (() => {
              const handed = sheet.actual_cash_cents == null ? null : Number(sheet.actual_cash_cents);
              const diff = sheet.cash_variance_cents == null ? 0 : Number(sheet.cash_variance_cents);
              return (
                <>
                  <h3 className="small" style={{ margin: '12px 0 4px' }}>Settled
                    {sheet.reconciled_date ? ` ${day(sheet.reconciled_date)}, ${time(sheet.reconciled_date)}` : ''}
                    {sheet.reconciled_by_name ? ` by ${sheet.reconciled_by_name}` : ''}</h3>
                  {handed !== null && <div className="total-line"><span>Cash handed in</span><span>{money(handed)}</span></div>}
                  {diff !== 0 && <div className="total-line"><span>{diff < 0 ? 'Short' : 'Over'}</span><span className={diff < 0 ? 'bad-text' : ''}>{money(Math.abs(diff))}</span></div>}
                  {sheet.bottle_actual_returned != null && (
                    <div className="total-line"><span>Empties counted</span><span>{sheet.bottle_actual_returned}
                      {sheet.bottle_variance ? ` (${sheet.bottle_variance > 0 ? '+' : ''}${sheet.bottle_variance})` : ''}</span></div>
                  )}
                  {(sheet.settlement_notes || sheet.bottle_settle_notes) ? (
                    <div className="notice info small" style={{ whiteSpace: 'pre-line', marginTop: 8 }}>
                      <strong>Settlement notes</strong>
                      {sheet.settlement_notes ? `\n${sheet.settlement_notes}` : ''}
                      {sheet.bottle_settle_notes ? `\nBottles: ${sheet.bottle_settle_notes}` : ''}
                    </div>
                  ) : <p className="muted small" style={{ marginBottom: 4 }}>No settlement notes.</p>}
                  <Link to={`/delivery/${sheet.id}/settlement`} className="small">Open the settlement</Link>
                </>
              );
            })()}
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
