import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, time, toCents } from '../lib/format';
import { payMethods, useTakeCard } from '../lib/payments';

/*
 * Truck loading, returns and "+ Add a stop" (Everton, 10 Oct 2026, points 3
 * and 4). Shared by the driver's My route and the office's round page, so
 * both say the same thing the same way. Top-level components only - never
 * declared inside another (see HANDOFF: inputs lose focus).
 */

export interface TruckLine {
  productId: string; name: string; bottlesPerCase: number;
  orderedBottles: number; extraBottles: number; loadedBottles: number;
  /** Of loadedBottles, what was added after the driver confirmed the load. */
  addedBottles?: number;
  returnedBottles: number | null; deliveredBottles: number;
  expectedBackBottles: number; differenceBottles: number | null;
}
export interface Truck {
  loadedAt: string; loadedByName: string | null; loaderNames: string[];
  /** The driver confirmed the totals and took responsibility (dual accountability). */
  driverConfirmedAt?: string | null; driverConfirmedName?: string | null;
  /** Last-minute additions after the driver confirmed, each reconfirmed by the driver. */
  additions?: Addition[];
  returnedAt: string | null; returnedByName: string | null; emptiesBack: number | null; returnNotes: string | null;
  lines: TruckLine[];
}
export interface Addition {
  id: string; note: string | null; addedAt: string; addedByName: string | null; loaderNames: string[];
  driverConfirmedAt: string | null; driverConfirmedName: string | null;
  lines: Array<{ productId: string; name: string; bottlesPerCase: number; bottles: number }>;
}
export interface Collection {
  id: string; kind: 'Empties' | 'Returns' | 'Supplier'; status: 'Pending' | 'Collected' | 'Not collected';
  customer_id: string | null; customer_name: string | null; delivery_address: string | null;
  supplier_name: string | null; supplier_address: string | null; po_number: string | null;
  purchase_order_id: string | null;
  empties_count: number; reason: string | null; description: string | null; notes: string | null;
  lines: Array<{ productId?: string; name: string; bottlesPerCase?: number; cases?: number; looseBottles?: number;
                 poLineId?: string; quantity?: number; unit?: string }>;
  sequence_no: number; added_by_name: string | null; collected_by_name: string | null; collected_at: string | null;
  settled_at: string | null; credit_decision: string | null; credit_note_number: string | null; credit_status: string | null;
  restock: boolean; received_at: string | null;
}

export const KIND_WORDS: Record<string, string> = {
  Empties: 'Collect empties', Returns: 'Collect returned goods', Supplier: 'Pick up from supplier',
};

/** Bottles shown the way the product is counted: cases, or bottles. */
export function units(bpc: number, bottles: number): string {
  if (bpc > 0) {
    const cs = Math.trunc(bottles / bpc);
    const rest = bottles - cs * bpc;
    return `${cs} cs${rest ? ` + ${rest} btl` : ''}`;
  }
  return `${bottles}`;
}
const toUnits = (bpc: number, bottles: number) => (bpc > 0 ? Math.round(bottles / bpc) : bottles);
const shortName = (n: string) => n.replace(/^Alka Vida\s+/i, '');

/** What a collection stop says in a list. */
export function collectionSummary(c: Collection): string {
  if (c.kind === 'Empties') return `${c.empties_count} empt${Number(c.empties_count) === 1 ? 'y' : 'ies'}`;
  if (c.kind === 'Returns') {
    const what = (c.lines ?? []).map((l) => `${Number(l.bottlesPerCase) > 0 ? `${l.cases} cs` : `${l.looseBottles} x`} ${shortName(l.name)}`).join(', ');
    return [what || 'goods', c.reason ? `(${c.reason})` : ''].filter(Boolean).join(' ');
  }
  const what = (c.lines ?? []).map((l) => `${l.quantity} ${l.unit ?? ''} ${l.name}`.replace(/\s+/g, ' ').trim()).join(', ');
  return [c.po_number, what || c.description].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ loading */

interface LoadingSummary {
  lines: Array<{ productId: string; name: string; bottlesPerCase: number; orderedBottles: number }>;
  products: Array<{ productId: string; name: string; bottlesPerCase: number }>;
  loaders: Array<{ id: string; name: string; job_title: string | null }>;
  load: Truck | null;
  startedAt: string | null;
}

/**
 * The OFFICE logs the loading (Everton, 10 Oct 2026: dual accountability):
 * totals per product from the round's orders, an Extras line, who loaded the
 * truck. Saving confirms it was loaded, in the office user's name, and moves
 * the goods from the warehouse onto the truck. The driver then confirms the
 * totals and starts (ConfirmLoadPanel).
 */
export function LoadingPanel({ sheetId, onDone, onCancel }: {
  sheetId: string; onDone: (message: string) => void; onCancel?: () => void;
}) {
  const [s, setS] = useState<LoadingSummary | null>(null);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [addPick, setAddPick] = useState('');
  const [loaders, setLoaders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<LoadingSummary>(`/api/delivery-sheets/${sheetId}/loading`).then((r) => {
      setS(r);
      if (r.load) {
        setExtra(Object.fromEntries(r.load.lines.filter((l) => l.extraBottles > 0)
          .map((l) => [l.productId, String(toUnits(l.bottlesPerCase, l.extraBottles))])));
        setAdded(r.load.lines.filter((l) => l.orderedBottles === 0).map((l) => l.productId));
        setLoaders(r.loaders.filter((p) => r.load!.loaderNames.includes(p.name)).map((p) => p.id));
      }
    }).catch((e) => setError(e.message));
  }, [sheetId]);

  if (!s) return error ? <div className="notice error">{error}</div> : <p className="muted">Loading the summary…</p>;

  const rows = [
    ...s.lines,
    ...added.filter((id) => !s.lines.some((l) => l.productId === id)).map((id) => {
      const p = s.products.find((x) => x.productId === id)!;
      return { productId: id, name: p?.name ?? 'Product', bottlesPerCase: p?.bottlesPerCase ?? 0, orderedBottles: 0 };
    }),
  ];
  const extraUnits = (id: string) => Math.max(0, Math.round(Number(extra[id] || 0)));
  const step = (id: string, by: number) => setExtra((x) => ({ ...x, [id]: String(Math.max(0, extraUnits(id) + by)) }));
  const notListed = s.products.filter((p) => !rows.some((r) => r.productId === p.productId));

  async function confirm() {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/delivery-sheets/${sheetId}/load`, {
        extras: rows.map((r) => ({ productId: r.productId, extraUnits: extraUnits(r.productId) }))
          .filter((x) => x.extraUnits > 0),
        loaderIds: loaders,
      });
      onDone('Loading logged and confirmed loaded. The driver confirms the totals to start the route.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the loading');
    } finally { setBusy(false); }
  }

  return (
    <div className="panel load-panel">
      <h2 className="side-h" style={{ marginTop: 0 }}>Loading the truck</h2>
      {s.load && (
        <p className="muted small" style={{ marginTop: 0 }}>
          Logged by {s.load.loadedByName ?? '—'}; loaded by {s.load.loaderNames.join(', ') || '—'}. You can change it until the driver confirms it.
        </p>
      )}
      {error && <div className="notice error">{error}</div>}
      {rows.length === 0 && <p className="muted">No orders on this round to load. Add extras if you are taking any.</p>}
      {rows.map((r) => {
        const total = r.orderedBottles + extraUnits(r.productId) * (r.bottlesPerCase > 0 ? r.bottlesPerCase : 1);
        return (
          <div key={r.productId} className="drop-row">
            <div>
              <strong>{shortName(r.name)}</strong>
              <div className="muted small">
                {r.orderedBottles > 0 ? `on orders ${units(r.bottlesPerCase, r.orderedBottles)}` : 'extra only'}
                {' · '}loading <strong>{units(r.bottlesPerCase, total)}</strong>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="muted small">Extra {r.bottlesPerCase > 0 ? 'cases' : 'bottles'}</div>
              <div className="stepper">
                <button type="button" className="secondary" aria-label={`One fewer extra ${r.name}`} onClick={() => step(r.productId, -1)}>−</button>
                <input type="number" min="0" inputMode="numeric" aria-label={`Extra ${r.name}`} value={extra[r.productId] ?? '0'}
                       onChange={(e) => setExtra((x) => ({ ...x, [r.productId]: e.target.value }))} />
                <button type="button" className="secondary" aria-label={`One more extra ${r.name}`} onClick={() => step(r.productId, 1)}>+</button>
              </div>
            </div>
          </div>
        );
      })}
      {notListed.length > 0 && (
        <div className="row" style={{ alignItems: 'center', marginTop: 8, gap: 8 }}>
          <select aria-label="Add an extra product" value={addPick} onChange={(e) => setAddPick(e.target.value)} style={{ flex: '1 1 200px' }}>
            <option value="">Extras: add a product not on the orders…</option>
            {notListed.map((p) => <option key={p.productId} value={p.productId}>{shortName(p.name)}</option>)}
          </select>
          <button type="button" className="secondary" disabled={!addPick}
                  onClick={() => { setAdded((a) => [...a, addPick]); setExtra((x) => ({ ...x, [addPick]: '1' })); setAddPick(''); }}>
            Add
          </button>
        </div>
      )}

      <div className="field" style={{ marginTop: 12 }}>
        <label>Who loaded the truck?</label>
        {s.loaders.length === 0 && <div className="notice warn">No employees yet. Add them under Settings › People.</div>}
        <div className="loader-picks">
          {s.loaders.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={loaders.includes(p.id)}
                     onChange={(e) => setLoaders((l) => (e.target.checked ? [...l, p.id] : l.filter((x) => x !== p.id)))} />
              {p.name}{p.job_title ? <span className="muted small"> · {p.job_title}</span> : null}
            </label>
          ))}
        </div>
      </div>
      <button type="button" className="big-go" disabled={busy || loaders.length === 0} onClick={confirm}>
        {busy ? 'Saving…' : s.load ? 'Save the change' : 'Confirm loaded: log it'}
      </button>
      <p className="muted small" style={{ textAlign: 'center', margin: '6px 0 0' }}>
        Saving confirms, in your name, that the truck was loaded as shown; the date and time are saved for you.
        It takes these goods off the warehouse stock and onto the truck. The driver then confirms the totals to start.
      </p>
      {onCancel && <button type="button" className="secondary wide" style={{ marginTop: 8 }} onClick={onCancel}>Not now</button>}
    </div>
  );
}

/**
 * The driver's part of the loading: confirm the totals the office logged and
 * start the route, taking responsibility for what is on the truck. Nothing
 * here changes a quantity; a wrong count is put right by the office first.
 */
export function ConfirmLoadPanel({ sheetId, onDone }: { sheetId: string; onDone: (message: string) => void }) {
  const [load, setLoad] = useState<Truck | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchLoad = () => api.get<LoadingSummary>(`/api/delivery-sheets/${sheetId}/loading`)
    .then((r) => setLoad(r.load)).catch((e) => setError(e.message));
  useEffect(() => { fetchLoad(); }, [sheetId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function confirm() {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/delivery-sheets/${sheetId}/confirm-load`);
      onDone('Load confirmed and the route started.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm the load');
    } finally { setBusy(false); }
  }

  if (load === undefined) return error ? <div className="notice error">{error}</div> : <p className="muted">Loading…</p>;
  if (load === null) {
    return (
      <div className="panel load-panel">
        <h2 className="side-h" style={{ marginTop: 0 }}>The load</h2>
        <div className="notice warn" style={{ margin: 0 }}>
          The office has not logged the loading for this round yet. Ask them to, then confirm it here to start.
        </div>
        <button type="button" className="secondary wide" style={{ marginTop: 10 }} onClick={() => { setLoad(undefined); fetchLoad(); }}>
          Check again
        </button>
      </div>
    );
  }
  const totalCases = load.lines.reduce((t, l) => t + (l.bottlesPerCase > 0 ? Math.trunc(l.loadedBottles / l.bottlesPerCase) : 0), 0);
  const totalBottles = load.lines.reduce((t, l) => t + (l.bottlesPerCase > 0 ? 0 : l.loadedBottles), 0);
  return (
    <div className="panel load-panel">
      <h2 className="side-h" style={{ marginTop: 0 }}>Confirm the load</h2>
      {error && <div className="notice error">{error}</div>}
      <p className="muted small" style={{ marginTop: 0 }}>
        Logged by {load.loadedByName ?? 'the office'} at {time(load.loadedAt)}; loaded by {load.loaderNames.join(', ') || '—'}.
      </p>
      {load.lines.map((l) => (
        <div key={l.productId} className="drop-row">
          <strong>{shortName(l.name)}</strong>
          <span className="load-qty">{units(l.bottlesPerCase, l.loadedBottles)}</span>
        </div>
      ))}
      {load.lines.length === 0 && <p className="muted">Nothing loaded.</p>}
      {load.lines.length > 0 && (
        <div className="total-line grand">
          <span>On the truck</span>
          <span>{[totalCases ? `${totalCases} cases` : null, totalBottles ? `${totalBottles} bottles` : null].filter(Boolean).join(' + ')}</span>
        </div>
      )}
      <button type="button" className="big-go" disabled={busy} onClick={confirm}>
        {busy ? 'Saving…' : 'I confirm this load: start route'}
      </button>
      <p className="muted small" style={{ textAlign: 'center', margin: '6px 0 0' }}>
        By confirming you take responsibility for these goods until they are delivered or counted back.
        If a count is wrong, ask the office to correct it before you confirm.
      </p>
    </div>
  );
}

/* ------------------------------------------------- additions after locking */

/**
 * Last-minute changes (Everton, 10 Oct 2026): once the driver has confirmed
 * the load it is locked, but the office can still ADD to it - with who
 * loaded it - and the driver reconfirms. Stock moves when the office logs it.
 */
export function AddToLoadPanel({ sheetId, onDone, onCancel }: {
  sheetId: string; onDone: (message: string) => void; onCancel: () => void;
}) {
  const [s, setS] = useState<LoadingSummary | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<string[]>([]);
  const [pick, setPick] = useState('');
  const [loaders, setLoaders] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<LoadingSummary>(`/api/delivery-sheets/${sheetId}/loading`)
      .then((r) => { setS(r); setShown((r.load?.lines ?? []).map((l) => l.productId)); })
      .catch((e) => setError(e.message));
  }, [sheetId]);
  if (!s) return error ? <div className="notice error">{error}</div> : <p className="muted">Loading…</p>;
  const productOf = (id: string) => s.products.find((p) => p.productId === id);
  const n = (id: string) => Math.max(0, Math.round(Number(qty[id] || 0)));
  const step = (id: string, by: number) => setQty((q) => ({ ...q, [id]: String(Math.max(0, n(id) + by)) }));
  const notShown = s.products.filter((p) => !shown.includes(p.productId));

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/delivery-sheets/${sheetId}/load-additions`, {
        extras: shown.map((id) => ({ productId: id, extraUnits: n(id) })).filter((x) => x.extraUnits > 0),
        loaderIds: loaders, note: note || null,
      });
      onDone('Added to the load. The driver confirms it on My route.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add to the load');
    } finally { setBusy(false); }
  }

  return (
    <div className="returns-box">
      <h3 style={{ marginTop: 0 }}>Add to the load</h3>
      <p className="muted small" style={{ marginTop: 0 }}>The driver has confirmed the load, so it can only be added to. They reconfirm what you add.</p>
      {error && <div className="notice error">{error}</div>}
      {shown.map((id) => {
        const p = productOf(id);
        return (
          <div key={id} className="drop-row">
            <strong>{shortName(p?.name ?? 'Product')}</strong>
            <div style={{ textAlign: 'right' }}>
              <div className="muted small">Add {Number(p?.bottlesPerCase) > 0 ? 'cases' : 'bottles'}</div>
              <div className="stepper">
                <button type="button" className="secondary" aria-label={`One fewer ${p?.name}`} onClick={() => step(id, -1)}>−</button>
                <input type="number" min="0" inputMode="numeric" aria-label={`Add ${p?.name}`} value={qty[id] ?? '0'}
                       onChange={(e) => setQty((q) => ({ ...q, [id]: e.target.value }))} />
                <button type="button" className="secondary" aria-label={`One more ${p?.name}`} onClick={() => step(id, 1)}>+</button>
              </div>
            </div>
          </div>
        );
      })}
      {notShown.length > 0 && (
        <div className="row" style={{ alignItems: 'center', marginTop: 8, gap: 8 }}>
          <select aria-label="Another product" value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: '1 1 180px' }}>
            <option value="">Another product…</option>
            {notShown.map((p) => <option key={p.productId} value={p.productId}>{shortName(p.name)}</option>)}
          </select>
          <button type="button" className="secondary" disabled={!pick}
                  onClick={() => { setShown((x) => [...x, pick]); setQty((q) => ({ ...q, [pick]: '1' })); setPick(''); }}>Add</button>
        </div>
      )}
      <div className="field" style={{ marginTop: 10 }}>
        <label>Who loaded it?</label>
        <div className="loader-picks">
          {s.loaders.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={loaders.includes(p.id)}
                     onChange={(e) => setLoaders((l) => (e.target.checked ? [...l, p.id] : l.filter((x) => x !== p.id)))} />
              {p.name}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor={`an-${sheetId}`}>Why (optional)</label>
        <input id={`an-${sheetId}`} value={note} style={{ width: '100%', boxSizing: 'border-box' }}
               placeholder="e.g. customer called for 2 more cases" onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" disabled={busy || loaders.length === 0 || !shown.some((id) => n(id) > 0)} onClick={save}>
          {busy ? 'Saving…' : 'Confirm loaded: add it'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * The additions on a round. The driver confirms each one; the office can
 * take back one the driver has not confirmed.
 */
export function AdditionsList({ additions, role, onDone }: {
  additions: Addition[]; role: 'office' | 'driver'; onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!additions.length) return null;
  async function act(a: Addition, what: 'confirm' | 'cancel') {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/load-additions/${a.id}/${what}`);
      onDone(what === 'confirm' ? 'Thanks: the addition to your load is confirmed.' : 'Addition cancelled; the stock is back in the warehouse.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally { setBusy(false); }
  }
  return (
    <div className="additions">
      {error && <div className="notice error">{error}</div>}
      {additions.map((a) => (
        <div key={a.id} className={`addition${a.driverConfirmedAt ? '' : ' waiting'}`}>
          <div>
            <strong>Added {time(a.addedAt)}: </strong>
            {a.lines.map((l) => `${units(l.bottlesPerCase, l.bottles)} ${shortName(l.name)}`).join(', ')}
            <div className="muted small">
              logged by {a.addedByName ?? '—'}; loaded by {a.loaderNames.join(', ') || '—'}{a.note ? ` · ${a.note}` : ''}
            </div>
            <div className="small">
              {a.driverConfirmedAt
                ? <span className="chip ok">Confirmed by {a.driverConfirmedName} {time(a.driverConfirmedAt)}</span>
                : <span className="chip warn">Waiting for the driver to confirm</span>}
            </div>
          </div>
          {!a.driverConfirmedAt && role === 'driver' && (
            <button type="button" className="big-go" disabled={busy} onClick={() => act(a, 'confirm')}>
              I confirm this was added
            </button>
          )}
          {!a.driverConfirmedAt && role === 'office' && (
            <button type="button" className="danger-soft" disabled={busy} onClick={() => act(a, 'cancel')}>Cancel it</button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- the truck */

/** Loaded - delivered - back, per product. A difference stands out. */
export function TruckTable({ truck }: { truck: Truck }) {
  const back = !!truck.returnedAt;
  if (truck.lines.length === 0) return <p className="muted small">Nothing was loaded.</p>;
  return (
    <div className="table-scroll">
      <table className="truck-table">
        <thead>
          <tr>
            <th>Product</th><th className="num">Loaded</th><th className="num">Delivered</th>
            <th className="num">{back ? 'Back' : 'On truck'}</th>{back && <th className="num">Difference</th>}
          </tr>
        </thead>
        <tbody>
          {truck.lines.map((l) => {
            const diff = l.differenceBottles ?? 0;
            return (
              <tr key={l.productId} className={back && diff !== 0 ? 'truck-diff' : ''}>
                <td>{shortName(l.name)}
                  {l.extraBottles > 0 && <div className="muted small">incl. {units(l.bottlesPerCase, l.extraBottles)} extra</div>}
                  {(l.addedBottles ?? 0) > 0 && <div className="muted small">incl. {units(l.bottlesPerCase, l.addedBottles!)} added later</div>}
                </td>
                <td className="num">{units(l.bottlesPerCase, l.loadedBottles)}</td>
                <td className="num">{units(l.bottlesPerCase, l.deliveredBottles)}</td>
                <td className="num">{back ? units(l.bottlesPerCase, l.returnedBottles ?? 0)
                  : <span className={l.expectedBackBottles < 0 ? 'chip bad' : ''}>{units(l.bottlesPerCase, l.expectedBackBottles)}</span>}</td>
                {back && (
                  <td className="num">
                    {diff === 0 ? <span className="muted">—</span>
                      : <span className="chip bad">{diff > 0 ? `${units(l.bottlesPerCase, diff)} missing` : `${units(l.bottlesPerCase, -diff)} over`}</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What came back: full goods per product (back on the warehouse) and the
 * empties counted off the truck. Prefilled with what should be there.
 */
export function ReturnsPanel({ sheetId, truck, expectedEmpties, onDone }: {
  sheetId: string; truck: Truck; expectedEmpties: number; onDone: (message: string) => void;
}) {
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(truck.lines.map((l) => [
    l.productId, String(toUnits(l.bottlesPerCase, l.returnedBottles ?? Math.max(l.expectedBackBottles, 0))),
  ])));
  const [empties, setEmpties] = useState(String(truck.emptiesBack ?? expectedEmpties));
  const [notes, setNotes] = useState(truck.returnNotes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/delivery-sheets/${sheetId}/returns`, {
        lines: truck.lines.map((l) => ({ productId: l.productId, returnedUnits: Math.max(0, Math.round(Number(qty[l.productId] || 0))) })),
        emptiesBack: empties === '' ? null : Number(empties), notes: notes || null,
      });
      onDone('What came back is recorded and back on the warehouse stock.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record what came back');
    } finally { setBusy(false); }
  }

  return (
    <div className="returns-box">
      <h3 style={{ marginTop: 0 }}>{truck.returnedAt ? 'Correct what came back' : 'What came back on the truck'}</h3>
      {error && <div className="notice error">{error}</div>}
      {truck.lines.map((l) => {
        const typed = Math.max(0, Math.round(Number(qty[l.productId] || 0))) * (l.bottlesPerCase > 0 ? l.bottlesPerCase : 1);
        const diff = l.expectedBackBottles - typed;
        return (
          <div key={l.productId} className="drop-row">
            <div>
              <strong>{shortName(l.name)}</strong>
              <div className="muted small">should be {units(l.bottlesPerCase, Math.max(l.expectedBackBottles, 0))}</div>
              {diff !== 0 && <div className="small" style={{ color: 'var(--bad)' }}>{diff > 0 ? `${units(l.bottlesPerCase, diff)} missing` : `${units(l.bottlesPerCase, -diff)} more than expected`}</div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="muted small">Full {l.bottlesPerCase > 0 ? 'cases' : 'bottles'} back</div>
              <input type="number" min="0" inputMode="numeric" style={{ width: 90 }} aria-label={`${l.name} back`}
                     value={qty[l.productId] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [l.productId]: e.target.value }))} />
            </div>
          </div>
        );
      })}
      <div className="drop-row">
        <div>
          <strong>5-gallon empties</strong>
          <div className="muted small">picked up and collected on this round: {expectedEmpties}</div>
        </div>
        <input type="number" min="0" inputMode="numeric" style={{ width: 90 }} aria-label="Empties back" value={empties}
               onChange={(e) => setEmpties(e.target.value)} />
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label htmlFor={`rn-${sheetId}`}>Note (optional)</label>
        <input id={`rn-${sheetId}`} value={notes} style={{ width: '100%', boxSizing: 'border-box' }}
               placeholder="e.g. 1 case damaged in the truck" onChange={(e) => setNotes(e.target.value)} />
      </div>
      <button type="button" disabled={busy} onClick={confirm}>{busy ? 'Saving…' : truck.returnedAt ? 'Save the correction' : 'Confirm what came back'}</button>
    </div>
  );
}

/* ---------------------------------------------------------- + Add a stop */

interface StopOptions {
  customers: Array<{ id: string; name: string; delivery_zone: string | null; balance_cents: number }>;
  products: Array<{ id: string; name: string; bottles_per_case: number }>;
  suppliers: Array<{ id: string; name: string }>;
  purchaseOrders: Array<{ id: string; po_number: string; supplier_id: string; status: string;
    lines: Array<{ poLineId: string; name: string; unit: string; outstanding: number }> }>;
}
type Kind = 'Payment' | 'Empties' | 'Returns' | 'Supplier';

/**
 * "+ Add a stop". A driver records something already done; the office plans
 * it for the driver (a payment to collect, empties, returns or a pick-up).
 */
export function AddStopPanel({ sheetId, office, onDone }: { sheetId: string; office: boolean; onDone: (message: string) => void }) {
  const takeCard = useTakeCard();
  const [opts, setOpts] = useState<StopOptions | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [find, setFind] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [poId, setPoId] = useState('');
  const [poQty, setPoQty] = useState<Record<string, string>>({});
  const [count, setCount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [amount, setAmount] = useState('');
  const [retLines, setRetLines] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.get<StopOptions>('/api/rounds/stop-options').then(setOpts).catch((e) => setError(e.message)); }, []);
  if (!opts) return error ? <div className="notice error">{error}</div> : <p className="muted">Loading…</p>;

  const customer = opts.customers.find((c) => c.id === customerId);
  const q = find.trim().toLowerCase();
  const hits = q ? opts.customers.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8) : [];
  const supplierPos = opts.purchaseOrders.filter((p) => p.supplier_id === supplierId);
  const po = opts.purchaseOrders.find((p) => p.id === poId);
  const ways = payMethods([['Cash', 'Cash'], ['Cheque', 'Cheque'], ['Card', 'Card'], ['Bank Transfer', 'Transfer']] as Array<[string, string]>, takeCard);

  async function save() {
    setBusy(true); setError(null);
    try {
      if (kind === 'Payment') {
        await api.post(`/api/delivery-sheets/${sheetId}/payment-stop`, office && !amount
          ? { customerId, planned: true }
          : { customerId, method, amountCents: toCents(amount || '0') });
        onDone(office && !amount ? `Collect payment from ${customer?.name} added to the round.`
          : `${money(toCents(amount || '0'))} ${method.toLowerCase()} from ${customer?.name} recorded. It goes on their account when the office settles the round.`);
      } else {
        const body: Record<string, unknown> = { kind };
        if (kind === 'Supplier') {
          body.supplierId = supplierId; body.purchaseOrderId = poId || null; body.description = description || null;
          body.lines = (po?.lines ?? []).map((l) => ({ poLineId: l.poLineId, quantity: Number(poQty[l.poLineId] || 0) }))
            .filter((l) => l.quantity > 0);
        } else {
          body.customerId = customerId;
          if (kind === 'Empties') body.emptiesCount = Number(count || 0);
          if (kind === 'Returns') {
            body.reason = reason;
            body.lines = opts!.products.map((p) => {
              const n = Math.max(0, Math.round(Number(retLines[p.id] || 0)));
              return Number(p.bottles_per_case) > 0 ? { productId: p.id, cases: n } : { productId: p.id, looseBottles: n };
            }).filter((l) => (l.cases ?? l.looseBottles ?? 0) > 0);
          }
        }
        await api.post(`/api/delivery-sheets/${sheetId}/collections`, body);
        onDone(`${KIND_WORDS[kind!]} ${office ? 'added to the round' : 'recorded'}${kind === 'Supplier' ? '' : ` for ${customer?.name}`}.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the stop');
    } finally { setBusy(false); }
  }

  const customerPicker = (label: string) => (!customer ? (
    <div className="field">
      <label htmlFor={`as-c-${sheetId}`}>{label}</label>
      <input id={`as-c-${sheetId}`} value={find} placeholder="Type their name" autoComplete="off"
             style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setFind(e.target.value)} />
      {hits.map((c) => (
        <button key={c.id} type="button" className="secondary" style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 6 }}
                onClick={() => setCustomerId(c.id)}>
          {c.name}<span className="muted small">{c.delivery_zone ? ` · ${c.delivery_zone}` : ''}{Number(c.balance_cents) > 0 ? ` · owes ${money(Number(c.balance_cents))}` : ''}</span>
        </button>
      ))}
    </div>
  ) : (
    <p style={{ margin: '0 0 8px' }}>
      <strong>{customer.name}</strong>{Number(customer.balance_cents) > 0 && <span className="muted small"> owes {money(Number(customer.balance_cents))}</span>}{' '}
      <button type="button" className="as-link small" onClick={() => { setCustomerId(''); setFind(''); }}>change</button>
    </p>
  ));

  const ready = kind === 'Payment' ? !!customerId && (office || toCents(amount || '0') > 0)
    : kind === 'Empties' ? !!customerId && Number(count) > 0
      : kind === 'Returns' ? !!customerId && Object.values(retLines).some((v) => Number(v) > 0) && !!reason.trim()
        : kind === 'Supplier' ? !!supplierId && (Object.values(poQty).some((v) => Number(v) > 0) || !!description.trim()) : false;

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <h2 className="side-h" style={{ marginTop: 0 }}>Add a stop</h2>
      {error && <div className="notice error">{error}</div>}
      <div className="seg seg-even" role="group" aria-label="What kind of stop">
        {(['Payment', 'Empties', 'Returns', 'Supplier'] as Kind[]).map((k) => (
          <button key={k} type="button" className={kind === k ? 'active' : ''} aria-pressed={kind === k}
                  onClick={() => { setKind(k); setError(null); }}>
            {k === 'Payment' ? 'Collect payment' : KIND_WORDS[k]}
          </button>
        ))}
      </div>

      {kind && <div style={{ marginTop: 12 }}>
        {kind !== 'Supplier' && customerPicker(kind === 'Payment' ? 'Who is paying?' : 'Which customer?')}

        {kind === 'Payment' && customer && (
          <>
            {office && <p className="muted small" style={{ marginTop: 0 }}>Leave the amount blank to send the driver to collect; fill it in if the money is already taken.</p>}
            <div className="seg pay-ways" role="group" aria-label="How they paid">
              {ways.map(([v, l]) => (
                <button key={v} type="button" className={method === v ? 'active' : ''} aria-pressed={method === v} onClick={() => setMethod(v)}>{l}</button>
              ))}
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor={`as-amt-${sheetId}`}>Amount {office ? 'already taken' : 'taken'}</label>
              <input id={`as-amt-${sheetId}`} inputMode="decimal" value={amount} style={{ width: '100%', boxSizing: 'border-box' }}
                     placeholder={customer && Number(customer.balance_cents) > 0 ? (Number(customer.balance_cents) / 100).toFixed(2) : '0.00'}
                     onChange={(e) => setAmount(e.target.value)} />
            </div>
          </>
        )}

        {kind === 'Empties' && customer && (
          <div className="field">
            <label htmlFor={`as-n-${sheetId}`}>How many empties{office ? ' to collect' : ''}?</label>
            <input id={`as-n-${sheetId}`} type="number" min="1" inputMode="numeric" style={{ width: 120 }} value={count}
                   onChange={(e) => setCount(e.target.value)} />
            <div className="muted small">They go back into the bottle pool when the office settles the round.</div>
          </div>
        )}

        {kind === 'Returns' && customer && (
          <>
            {opts.products.map((p) => (
              <div key={p.id} className="drop-row">
                <strong>{shortName(p.name)}</strong>
                <span>
                  <input type="number" min="0" inputMode="numeric" style={{ width: 80 }} aria-label={`${p.name} returned`}
                         value={retLines[p.id] ?? ''} placeholder="0"
                         onChange={(e) => setRetLines((r) => ({ ...r, [p.id]: e.target.value }))} />
                  <span className="muted small"> {Number(p.bottles_per_case) > 0 ? 'cases' : 'bottles'}</span>
                </span>
              </div>
            ))}
            <div className="field" style={{ marginTop: 8 }}>
              <label htmlFor={`as-why-${sheetId}`}>Why did they come back?</label>
              <input id={`as-why-${sheetId}`} value={reason} placeholder="e.g. damaged, wrong product, expired"
                     style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setReason(e.target.value)} />
              <div className="muted small">The office decides on a credit note when it settles the round.</div>
            </div>
          </>
        )}

        {kind === 'Supplier' && (
          <>
            <div className="field">
              <label htmlFor={`as-s-${sheetId}`}>Which supplier?</label>
              <select id={`as-s-${sheetId}`} value={supplierId} style={{ width: '100%' }}
                      onChange={(e) => { setSupplierId(e.target.value); setPoId(''); setPoQty({}); }}>
                <option value="">Choose…</option>
                {opts.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            {supplierId && (
              <div className="field">
                <label htmlFor={`as-po-${sheetId}`}>Purchase order (optional)</label>
                <select id={`as-po-${sheetId}`} value={poId} style={{ width: '100%' }}
                        onChange={(e) => { setPoId(e.target.value); setPoQty({}); }}>
                  <option value="">{supplierPos.length ? 'No PO' : 'No open PO for this supplier'}</option>
                  {supplierPos.map((p) => <option key={p.id} value={p.id}>{p.po_number} · {p.status}</option>)}
                </select>
              </div>
            )}
            {po && po.lines.map((l) => (
              <div key={l.poLineId} className="drop-row">
                <div><strong>{l.name}</strong><div className="muted small">still to come {l.outstanding} {l.unit}</div></div>
                <span>
                  <input type="number" min="0" step="any" inputMode="decimal" style={{ width: 90 }} aria-label={`${l.name} collected`}
                         value={poQty[l.poLineId] ?? ''} placeholder="0" onChange={(e) => setPoQty((x) => ({ ...x, [l.poLineId]: e.target.value }))} />
                  <span className="muted small"> {l.unit}</span>
                </span>
              </div>
            ))}
            {supplierId && (
              <div className="field" style={{ marginTop: 8 }}>
                <label htmlFor={`as-d-${sheetId}`}>What was collected{po ? ' (anything else)' : ''}</label>
                <input id={`as-d-${sheetId}`} value={description} style={{ width: '100%', boxSizing: 'border-box' }}
                       placeholder="e.g. 2 boxes of caps" onChange={(e) => setDescription(e.target.value)} />
                <div className="muted small">The office receives the goods on the PO; the pick-up fills it in for them.</div>
              </div>
            )}
          </>
        )}

        <button type="button" className="big-go" disabled={busy || !ready} onClick={save}>
          {busy ? 'Saving…' : office && !(kind === 'Payment' && amount) ? 'Add to the round' : 'Record it'}
        </button>
      </div>}
    </div>
  );
}
