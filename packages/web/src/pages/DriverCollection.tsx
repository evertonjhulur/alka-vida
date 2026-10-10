import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getSession } from '../lib/api';
import { time, when } from '../lib/format';
import { KIND_WORDS, collectionSummary, type Collection } from '../components/Truck';

interface Options {
  products: Array<{ id: string; name: string; bottles_per_case: number }>;
  purchaseOrders: Array<{ id: string; po_number: string;
    lines: Array<{ poLineId: string; name: string; unit: string; outstanding: number }> }>;
}
type Full = Collection & { delivery_sheet_id: string; sheet_zone: string; sheet_status: string; sheet_date: string };

const shortName = (n: string) => n.replace(/^Alka Vida\s+/i, '');

/**
 * One collection stop on the driver's phone (Everton, 10 Oct 2026, point 3):
 * empties, returned goods, or a supplier pick-up. A stop the office planned
 * is recorded here - what was actually collected, or Not collected.
 */
export default function DriverCollection() {
  const { collectionId } = useParams();
  const office = ['admin', 'user'].includes(getSession()?.role ?? '');
  const navigate = useNavigate();
  const [c, setC] = useState<Full | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [count, setCount] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function load() {
    const r = await api.get<Full>(`/api/collections/${collectionId}`);
    setC(r);
    setCount(String(r.empties_count ?? ''));
    setReason(r.reason ?? '');
    setDescription(r.description ?? '');
    const q: Record<string, string> = {};
    for (const l of r.lines ?? []) {
      if (r.kind === 'Returns' && l.productId) q[l.productId] = String(Number(l.bottlesPerCase) > 0 ? l.cases : l.looseBottles);
      if (r.kind === 'Supplier' && l.poLineId) q[l.poLineId] = String(l.quantity ?? '');
    }
    setQty(q);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.get<Options>('/api/rounds/stop-options').then(setOpts).catch(() => {});
  }, [collectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !c) return <div className="notice error">{error}</div>;
  if (!c) return <p className="muted">Loading…</p>;

  const back = office ? `/delivery/${c.delivery_sheet_id}` : '/route';
  const open = c.sheet_status === 'Open' && !c.settled_at;
  const po = opts?.purchaseOrders.find((p) => p.id === c.purchase_order_id);

  async function record(status: 'Collected' | 'Not collected') {
    setBusy(true); setError(null); setSaved(null);
    try {
      const body: Record<string, unknown> = { status, notes: notes || null };
      if (status === 'Collected') {
        if (c!.kind === 'Empties') body.emptiesCount = Number(count || 0);
        if (c!.kind === 'Returns') {
          body.reason = reason;
          body.lines = (opts?.products ?? []).map((p) => {
            const n = Math.max(0, Math.round(Number(qty[p.id] || 0)));
            return Number(p.bottles_per_case) > 0 ? { productId: p.id, cases: n } : { productId: p.id, looseBottles: n };
          }).filter((l) => ((l as { cases?: number }).cases ?? (l as { looseBottles?: number }).looseBottles ?? 0) > 0);
        }
        if (c!.kind === 'Supplier') {
          body.description = description || null;
          body.lines = (po?.lines ?? []).map((l) => ({ poLineId: l.poLineId, quantity: Number(qty[l.poLineId] || 0) }))
            .filter((l) => l.quantity > 0);
        }
      }
      await api.post(`/api/collections/${c!.id}/record`, body);
      setSaved(status === 'Collected' ? 'Recorded as collected.' : 'Recorded as not collected.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record it');
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setError(null);
    try {
      await api.del(`/api/collections/${c!.id}`);
      navigate(back);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove it');
      setBusy(false);
    }
  }

  const who = c.kind === 'Supplier' ? c.supplier_name : c.customer_name;
  const where = c.kind === 'Supplier' ? c.supplier_address : c.delivery_address;

  return (
    <div className="stop-screen">
      <div className="stop-bar">
        <Link to={back}>‹ {office ? 'The round' : 'My route'}</Link>
        <strong>{KIND_WORDS[c.kind]}</strong>
        <span className="muted small">{c.sheet_zone ?? ''}</span>
      </div>
      {error && <div className="notice error">{error}</div>}
      {saved && <div className="notice ok">{saved} <Link to={back}>Back to {office ? 'the round' : 'my route'}</Link></div>}

      <section className="panel stop-who">
        <div className="stop-name">{who}</div>
        {where && <div className="muted">{where}</div>}
        {c.po_number && <div className="muted small">PO {c.po_number}</div>}
        <div className="small" style={{ marginTop: 6 }}>
          {c.status === 'Pending'
            ? <>Added by {c.added_by_name ?? 'the office'}: <strong>{collectionSummary(c)}</strong></>
            : <>
                <span className={`chip ${c.status === 'Collected' ? 'ok' : 'warn'}`}>{c.status}</span>{' '}
                {collectionSummary(c)}
                {c.collected_at && <span className="muted"> · {c.collected_by_name ?? ''} {when(c.collected_at)} {time(c.collected_at)}</span>}
              </>}
        </div>
        {c.notes && <div className="stop-notes" style={{ marginTop: 8 }}>{c.notes}</div>}
      </section>

      {c.kind === 'Returns' && c.status === 'Collected' && (
        <section className="panel small">
          {c.credit_decision
            ? <>Office decision: <strong>{c.credit_decision}</strong>{c.credit_note_number ? ` (${c.credit_note_number}${c.credit_status === 'Pending' ? ', awaiting approval' : ''})` : ''}{c.restock ? '; goods back in stock' : ''}.</>
            : 'The office decides on a credit note when it settles the round.'}
        </section>
      )}
      {c.kind === 'Supplier' && c.status === 'Collected' && (
        <section className="panel small">
          {c.received_at ? 'Received on the PO by the office.' : 'The office receives these goods on the PO.'}
        </section>
      )}

      {open && c.status !== 'Collected' && c.credit_decision === null && (
        <section className="panel">
          <h2 className="side-h" style={{ marginTop: 0 }}>What did you collect?</h2>
          {c.kind === 'Empties' && (
            <div className="drop-row">
              <strong>Empties</strong>
              <div className="stepper big">
                <button type="button" className="secondary" aria-label="One fewer" onClick={() => setCount(String(Math.max(0, (Number(count) || 0) - 1)))}>−</button>
                <input type="number" min="0" inputMode="numeric" aria-label="Empties collected" value={count} onChange={(e) => setCount(e.target.value)} />
                <button type="button" className="secondary" aria-label="One more" onClick={() => setCount(String((Number(count) || 0) + 1))}>+</button>
              </div>
            </div>
          )}
          {c.kind === 'Returns' && (
            <>
              {(opts?.products ?? []).map((p) => (
                <div key={p.id} className="drop-row">
                  <strong>{shortName(p.name)}</strong>
                  <span>
                    <input type="number" min="0" inputMode="numeric" style={{ width: 80 }} aria-label={`${p.name} returned`}
                           value={qty[p.id] ?? ''} placeholder="0" onChange={(e) => setQty((x) => ({ ...x, [p.id]: e.target.value }))} />
                    <span className="muted small"> {Number(p.bottles_per_case) > 0 ? 'cases' : 'bottles'}</span>
                  </span>
                </div>
              ))}
              <div className="field" style={{ marginTop: 8 }}>
                <label htmlFor="why">Why did they come back?</label>
                <input id="why" value={reason} style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setReason(e.target.value)} />
              </div>
            </>
          )}
          {c.kind === 'Supplier' && (
            <>
              {po?.lines.map((l) => (
                <div key={l.poLineId} className="drop-row">
                  <div><strong>{l.name}</strong><div className="muted small">still to come {l.outstanding} {l.unit}</div></div>
                  <span>
                    <input type="number" min="0" step="any" inputMode="decimal" style={{ width: 90 }} aria-label={`${l.name} collected`}
                           value={qty[l.poLineId] ?? ''} placeholder="0" onChange={(e) => setQty((x) => ({ ...x, [l.poLineId]: e.target.value }))} />
                    <span className="muted small"> {l.unit}</span>
                  </span>
                </div>
              ))}
              <div className="field" style={{ marginTop: 8 }}>
                <label htmlFor="desc">What was collected{po ? ' (anything else)' : ''}</label>
                <input id="desc" value={description} style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </>
          )}
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="cn">Note (optional)</label>
            <input id="cn" value={notes} style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <button type="button" className="big-go" disabled={busy} onClick={() => record('Collected')}>{busy ? 'Saving…' : 'Collected'}</button>
          {c.status === 'Pending' && (
            <div className="not-delivered">
              <button type="button" className="secondary" disabled={busy} onClick={() => record('Not collected')}>Not collected</button>
            </div>
          )}
        </section>
      )}

      {office && open && c.credit_decision === null && (
        <p style={{ textAlign: 'center' }}>
          <button type="button" className="danger-soft" disabled={busy} onClick={remove}>Take this stop off the round</button>
        </p>
      )}
    </div>
  );
}
