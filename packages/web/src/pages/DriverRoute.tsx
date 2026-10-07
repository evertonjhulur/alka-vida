import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { date, money, time, toCents, when } from '../lib/format';

interface Stop {
  id: string; customer_name: string; delivery_address: string | null;
  sequence_no: number; stop_outcome: string; line_items_summary: string | null;
  order_ref?: string | null; delivery_instructions?: string | null; order_notes?: string | null;
  remainder_to?: string | null; payment_amount_cents?: number;
}
interface Cust { id: string; name: string; delivery_zone: string | null; balance_cents: number }

const OUTCOME_WORDS: Record<string, string> = {
  'Customer Not Home': 'Not home', Rescheduled: 'Another day', Other: 'Not delivered', 'Payment Only': 'Payment only',
};
interface Sheet {
  id: string; delivery_date: string; zone: string; status: string;
  assigned_driver_id: string | null; driver_name: string | null;
  started_at: string | null; stops: Stop[];
}

export default function DriverRoute({ session }: { session: Session }) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /** A payment taken where nothing was delivered (7 Oct 2026, point 10). */
  const [payFor, setPayFor] = useState<string | null>(null);
  const [custs, setCusts] = useState<Cust[]>([]);
  const [find, setFind] = useState('');
  const [payCust, setPayCust] = useState('');
  const [payHow, setPayHow] = useState('Cash');
  const [payAmt, setPayAmt] = useState('');

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

  async function start(sheetId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/delivery-sheets/${sheetId}/start`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start that route');
    } finally {
      setBusy(false);
    }
  }

  async function openPayment(sheetId: string) {
    setPayFor(payFor === sheetId ? null : sheetId);
    setPayCust(''); setPayAmt(''); setFind(''); setSaved(null);
    if (custs.length === 0) setCusts(await api.get<Cust[]>('/api/driver/customers').catch(() => []));
  }

  async function takePayment(sheetId: string) {
    setBusy(true); setError(null); setSaved(null);
    try {
      const c = custs.find((x) => x.id === payCust);
      await api.post(`/api/delivery-sheets/${sheetId}/payment-stop`, {
        customerId: payCust, method: payHow, amountCents: toCents(payAmt || '0'),
      });
      setSaved(`${money(toCents(payAmt || '0'))} ${payHow.toLowerCase()} from ${c?.name ?? 'the customer'} recorded. `
        + 'It goes on their account when the office settles the round.');
      setPayFor(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the payment');
    } finally { setBusy(false); }
  }

  const paymentPanel = (sheet: Sheet) => {
    const q = find.trim().toLowerCase();
    const hits = q ? custs.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8) : [];
    const chosen = custs.find((c) => c.id === payCust);
    return (
      <div className="panel" style={{ marginTop: 10 }}>
        <h2 className="side-h">Took a payment, nothing to deliver</h2>
        {!chosen ? (
          <div className="field">
            <label htmlFor={`pf-${sheet.id}`}>Who paid?</label>
            <input id={`pf-${sheet.id}`} value={find} placeholder="Type their name" autoComplete="off"
                   style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setFind(e.target.value)} />
            {hits.map((c) => (
              <button key={c.id} type="button" className="secondary" style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 6 }}
                      onClick={() => { setPayCust(c.id); if (Number(c.balance_cents) > 0) setPayAmt((Number(c.balance_cents) / 100).toFixed(2)); }}>
                {c.name}<span className="muted small">{c.delivery_zone ? ` · ${c.delivery_zone}` : ''} · owes {money(Number(c.balance_cents))}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <p style={{ margin: '0 0 8px' }}>
              <strong>{chosen.name}</strong> <span className="muted small">owes {money(Number(chosen.balance_cents))}</span>{' '}
              <button type="button" className="as-link small" onClick={() => setPayCust('')}>change</button>
            </p>
            <div className="seg pay-ways" role="group" aria-label="How they paid">
              {[['Cash', 'Cash'], ['Cheque', 'Cheque'], ['Card', 'Card'], ['Bank Transfer', 'Transfer']].map(([v, l]) => (
                <button key={v} type="button" className={payHow === v ? 'active' : ''} aria-pressed={payHow === v}
                        onClick={() => setPayHow(v)}>{l}</button>
              ))}
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor={`pa-${sheet.id}`}>Amount taken</label>
              <input id={`pa-${sheet.id}`} inputMode="decimal" value={payAmt} style={{ width: '100%', boxSizing: 'border-box' }}
                     onChange={(e) => setPayAmt(e.target.value)} />
            </div>
            <button type="button" className="big-go" disabled={busy || !(toCents(payAmt || '0') > 0)}
                    onClick={() => takePayment(sheet.id)}>
              {busy ? 'Saving…' : 'Record the payment'}
            </button>
            <p className="muted small" style={{ textAlign: 'center' }}>
              Like the cash from deliveries, it reaches their account when the office settles the round.
            </p>
          </>
        )}
      </div>
    );
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
  const isFinished = (s: Sheet) =>
    s.stops.length > 0 && s.stops.every((st) => st.stop_outcome !== 'Pending');
  const active = mine.filter((s) => !isFinished(s));
  const finished = mine.filter(isFinished);

  /**
   * Plain functions returning JSX, NOT nested components: a component
   * declared inside another gets a new type every render, so everything
   * under it unmounts and remounts.
   */
  const stopList = (sheet: Sheet) => (
    <>
      {sheet.stops.map((stop, i) => (
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
                  : OUTCOME_WORDS[stop.stop_outcome] ?? stop.stop_outcome}
              </span>
            </div>
          </div>
        </Link>
      ))}
      {sheet.stops.length === 0 && <p className="muted">No stops on this route.</p>}
    </>
  );

  const heading = (sheet: Sheet) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <h2>{when(sheet.delivery_date)} — {sheet.zone}</h2>
      <span className="muted small">
        {sheet.stops.filter((s) => s.stop_outcome !== 'Pending').length} of{' '}
        {sheet.stops.length} done
      </span>
    </div>
  );

  return (
    <>
      <h1>My route</h1>
      {error && <div className="notice error">{error}</div>}
      {saved && <div className="notice ok">{saved}</div>}

      {active.map((sheet) => (
        <div key={sheet.id}>
          {heading(sheet)}
          {sheet.started_at ? (
            <p className="subtitle">
              Started {time(sheet.started_at)}. Stops are in visit order.
            </p>
          ) : (
            <div className="panel">
              <p style={{ marginTop: 0 }}>This route is yours. Start it when you set off.</p>
              <button type="button" disabled={busy} onClick={() => start(sheet.id)}>
                Start route
              </button>
            </div>
          )}
          {sheet.started_at && stopList(sheet)}
          {sheet.started_at && (
            <>
              <button type="button" className="secondary" style={{ marginTop: 8 }} aria-expanded={payFor === sheet.id}
                      onClick={() => openPayment(sheet.id)}>
                {payFor === sheet.id ? 'Close' : '+ Took a payment, nothing to deliver'}
              </button>
              {payFor === sheet.id && paymentPanel(sheet)}
            </>
          )}
        </div>
      ))}

      {finished.length > 0 && (
        <div style={{ marginTop: active.length ? 32 : 0 }}>
          <h2>Finished, waiting for the office to settle</h2>
          {finished.map((sheet) => (
            <details className="panel" key={sheet.id}>
              <summary style={{ cursor: 'pointer' }}>
                <strong>{when(sheet.delivery_date)} — {sheet.zone}</strong>
                <span className="muted small"> · all {sheet.stops.length} stops done</span>
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
                    {sheet.stops.length} stop{sheet.stops.length === 1 ? '' : 's'}
                  </div>
                </div>
                <button type="button" disabled={busy} onClick={() => start(sheet.id)}>
                  Start this route
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {sheets.length === 0 && !error && <p className="muted">No open routes today.</p>}
    </>
  );
}
