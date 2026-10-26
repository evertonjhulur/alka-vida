import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, openPdf } from '../lib/api';
import { money, toCents, day, date } from '../lib/format';
import { payMethods, useTakeCard } from '../lib/payments';

/*
 * Entering the paper delivery sheet (Everton, 25 Oct 2026: "can this be
 * entered quickly as a short cut to settle the round manually?").
 *
 * One screen laid out like the printed sheet: per stop what happened, the
 * empties collected and the payment, then one Save. Each row is recorded
 * through the same call the driver's phone uses (POST /api/stops/:id/outcome),
 * so stock, bottles, invoices and the settlement come out exactly as if the
 * driver had done it stop by stop. "Delivered" means the whole order as it
 * stands; anything unusual (part delivered, another day, the bottle charge)
 * is done on the stop itself with Open. Stops already recorded are shown, not
 * changed. Empties collection stops take a count here; returned goods and
 * supplier pick-ups are recorded on the round page.
 */

interface SheetStop {
  id: string; customer_name: string; stop_outcome: string; order_id: string | null;
  payment_only?: boolean; after_stop_id?: string | null; order_ref: string | null;
  payment_method?: string | null; payment_amount_cents?: number | null;
  bottles_empties_picked_up?: number | null;
  line_items_summary?: string | null;
}
interface SheetCollection {
  id: string; kind: 'Empties' | 'Returns' | 'Supplier'; status: string;
  customer_name: string | null; supplier_name: string | null; empties_count: number;
}
interface Sheet {
  id: string; zone: string; delivery_date: string; status: string; driver_name: string | null;
  stops: SheetStop[]; collections: SheetCollection[];
}
interface StopLine {
  order_line_id: string; product_name: string; bottles_per_case: number; is_returnable: boolean;
  cases: number; loose_bottles: number;
}
interface StopDetail { id: string; lines: StopLine[]; amountOwedCents: number; empties_expected?: number | null; invoice_cycle?: string | null; pay_when?: string | null }

type Outcome = '' | 'Delivered' | 'Customer Not Home' | 'Refused' | 'Other' | 'Payment Only';
interface Row { outcome: Outcome; empties: string; method: string; amount: string }

const PAY_WAYS = [['', 'None'], ['Cash', 'Cash'], ['Cheque', 'Cheque'], ['Card', 'Card'], ['Bank Transfer', 'Transfer']] as const;
const OUTCOMES: Array<[Outcome, string]> = [
  ['Delivered', 'Delivered'], ['Customer Not Home', 'Not home'], ['Refused', 'Refused'],
  ['Other', 'Not delivered'], ['', 'Leave for now'],
];
const DONE_WORDS: Record<string, string> = {
  Delivered: 'Delivered', 'Customer Not Home': 'Not home', Refused: 'Refused',
  Rescheduled: 'Another day', Other: 'Not delivered', 'Payment Only': 'Payment only',
};

const lineWords = (l: StopLine) => (l.bottles_per_case > 0 ? `${l.cases} cs` : `${l.loose_bottles}`)
  + ` ${l.product_name.replace(/^Alka Vida\s+/i, '')}`;

export default function SheetEntry() {
  const { sheetId } = useParams();
  const takeCard = useTakeCard();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [detail, setDetail] = useState<Record<string, StopDetail>>({});
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [cols, setCols] = useState<Record<string, { got: '' | 'yes' | 'no'; count: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sh = await api.get<Sheet>(`/api/delivery-sheets/${sheetId}`);
    setSheet(sh);
    const todo = sh.stops.filter((s) => s.stop_outcome === 'Pending' && !s.after_stop_id);
    const got = await Promise.all(todo.map((s) => api.get<StopDetail>(`/api/stops/${s.id}`)));
    setDetail(Object.fromEntries(got.map((d) => [d.id, d])));
    setRows(Object.fromEntries(todo.map((s) => [s.id, {
      outcome: (s.payment_only ? 'Payment Only' : 'Delivered') as Outcome, empties: '', method: '', amount: '',
    }])));
    setCols(Object.fromEntries(sh.collections.filter((c) => c.kind === 'Empties' && c.status === 'Pending')
      .map((c) => [c.id, { got: '' as const, count: String(c.empties_count) }])));
  }, [sheetId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  if (error && !sheet) return <div className="notice error">{error}</div>;
  if (!sheet) return <p className="muted">Loading…</p>;

  const open = sheet.status === 'Open';
  const stops = sheet.stops.filter((s) => !s.after_stop_id);
  const todo = stops.filter((s) => s.stop_outcome === 'Pending');
  const set = (id: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const onAccount = (d?: StopDetail) => !!d && (d.pay_when === 'On account' || d.invoice_cycle === 'Weekly' || d.invoice_cycle === 'Monthly');
  const entering = todo.filter((s) => rows[s.id]?.outcome);
  const colsEntering = Object.entries(cols).filter(([, c]) => c.got);
  const takenCents = entering.reduce((t, s) => t + (rows[s.id].method ? toCents(rows[s.id].amount || '0') : 0), 0);
  const emptiesIn = entering.reduce((t, s) => t + (Number(rows[s.id].empties) || 0), 0)
    + colsEntering.reduce((t, [, c]) => t + (c.got === 'yes' ? Number(c.count) || 0 : 0), 0);

  async function saveAll() {
    setBusy(true); setError(null); setMsg(null); setProblems([]);
    const bad: string[] = [];
    let done = 0;
    for (const s of entering) {
      const r = rows[s.id];
      const d = detail[s.id];
      const paid = r.method ? toCents(r.amount || '0') : 0;
      const delivered = r.outcome === 'Delivered';
      const lines = d?.lines ?? [];
      try {
        await api.post(`/api/stops/${s.id}/outcome`, {
          outcome: r.outcome,
          deliveredLines: delivered ? lines.map((l) => (l.bottles_per_case > 0
            ? { orderLineId: l.order_line_id, cases: l.cases, looseBottles: 0 }
            : { orderLineId: l.order_line_id, cases: 0, looseBottles: l.loose_bottles })) : undefined,
          paymentReceived: paid > 0,
          paymentMethod: paid > 0 ? r.method : null,
          paymentAmountCents: paid,
          bottlesDeliveredFull: delivered
            ? lines.filter((l) => l.is_returnable).reduce((t, l) => t + (l.bottles_per_case > 0 ? l.cases * l.bottles_per_case : l.loose_bottles), 0)
            : 0,
          bottlesEmptiesPickedUp: Number(r.empties) || 0,
          bottlesLostDamaged: 0,
          outcomeNotes: 'Entered from the delivery sheet',
        });
        done++;
      } catch (e) {
        bad.push(`${s.customer_name}: ${e instanceof Error ? e.message : 'could not be recorded'}`);
      }
    }
    for (const [id, c] of colsEntering) {
      const who = sheet!.collections.find((x) => x.id === id)?.customer_name ?? 'Collection';
      try {
        await api.post(`/api/collections/${id}/record`, c.got === 'yes'
          ? { status: 'Collected', emptiesCount: Math.max(0, Math.round(Number(c.count) || 0)) }
          : { status: 'Not collected' });
        done++;
      } catch (e) {
        bad.push(`${who}: ${e instanceof Error ? e.message : 'could not be recorded'}`);
      }
    }
    setProblems(bad);
    setMsg(done ? `${done} recorded from the sheet.${bad.length ? '' : ' Count what came back and settle the round when ready.'}` : null);
    try { await load(); } catch { /* the message above still stands */ }
    setBusy(false);
  }

  const ways = payMethods(PAY_WAYS, takeCard);

  return (
    <>
      <Link to={`/delivery/${sheet.id}`} className="back-link">← Back to the round</Link>
      <div className="inv-title">
        <h1>Enter the delivery sheet</h1>
        <button type="button" className="secondary" style={{ marginLeft: 'auto' }}
                onClick={() => openPdf(`/api/delivery-sheets/${sheet.id}/sheet.pdf`).catch((e) => setError(e.message))}>
          Delivery sheet (PDF)
        </button>
      </div>
      <p className="subtitle">
        {sheet.zone} · {day(sheet.delivery_date)} {date(sheet.delivery_date).slice(0, 4)} · {sheet.driver_name ?? 'no driver'}.
        Type in what the driver wrote on the paper sheet. Delivered means the whole order;
        for a part delivery, another day or a bottle charge, use Open on that stop.
      </p>

      {error && <div className="notice error">{error}</div>}
      {problems.length > 0 && (
        <div className="notice error">
          Not recorded:
          <ul style={{ margin: '4px 0 0' }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {msg && <div className="notice ok">{msg}</div>}
      {!open && <div className="notice info">This round has been settled, so nothing more can be entered.</div>}

      <div className="panel table-scroll">
        <table className="sheet-entry phone-cards">
          <thead>
            <tr>
              <th>#</th><th>Customer and order</th><th className="num">To collect</th>
              <th>What happened</th><th>Empties collected</th><th>Payment</th><th className="num">Amount</th><th />
            </tr>
          </thead>
          <tbody>
            {stops.map((s, i) => {
              const d = detail[s.id];
              const r = rows[s.id];
              const pending = s.stop_outcome === 'Pending';
              const what = d?.lines.length ? d.lines.map(lineWords).join(', ')
                : s.payment_only ? 'Payment only' : (s.line_items_summary ?? '');
              return (
                <tr key={s.id}>
                  <td data-label="#">{i + 1}</td>
                  <td data-label="Customer">
                    <strong>{s.customer_name}</strong>
                    <div className="muted small">{[s.order_ref, what].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td data-label="To collect" className="num">
                    {!pending ? <span className="muted">—</span>
                      : onAccount(d) && !s.payment_only ? <span className="muted small">On account</span>
                        : money(d?.amountOwedCents ?? 0)}
                  </td>
                  {pending && r && open ? (
                    <>
                      <td data-label="What happened">
                        <select aria-label={`What happened at ${s.customer_name}`} value={r.outcome} disabled={busy}
                                onChange={(e) => set(s.id, { outcome: e.target.value as Outcome })}>
                          {(s.payment_only ? [['Payment Only', 'Payment taken'] as [Outcome, string], ['Other', 'Not paid'] as [Outcome, string], ['', 'Leave for now'] as [Outcome, string]] : OUTCOMES)
                            .map(([v, label]) => <option key={label} value={v}>{label}</option>)}
                        </select>
                      </td>
                      <td data-label="Empties collected">
                        {!s.payment_only && (
                          <input type="number" min="0" inputMode="numeric" style={{ width: 70 }} disabled={busy || !r.outcome}
                                 aria-label={`Empties collected at ${s.customer_name}`}
                                 placeholder={d?.empties_expected != null ? `exp. ${d.empties_expected}` : '0'}
                                 value={r.empties} onChange={(e) => set(s.id, { empties: e.target.value })} />
                        )}
                      </td>
                      <td data-label="Payment">
                        <select aria-label={`How ${s.customer_name} paid`} value={r.method} disabled={busy || !r.outcome}
                                onChange={(e) => set(s.id, {
                                  method: e.target.value,
                                  // Choosing how they paid fills in what was owed; type over it.
                                  amount: e.target.value && !r.amount && (d?.amountOwedCents ?? 0) > 0
                                    ? ((d!.amountOwedCents) / 100).toFixed(2) : e.target.value ? r.amount : '',
                                })}>
                          {ways.map(([v, label]) => <option key={label} value={v}>{label}</option>)}
                        </select>
                      </td>
                      <td data-label="Amount" className="num">
                        <input type="number" step="0.01" min="0" style={{ width: 110 }} disabled={busy || !r.method || !r.outcome}
                               aria-label={`Amount paid by ${s.customer_name}`} placeholder="0.00"
                               value={r.amount} onChange={(e) => set(s.id, { amount: e.target.value })} />
                      </td>
                    </>
                  ) : (
                    <td colSpan={4} className="small">
                      <span className={`chip ${s.stop_outcome === 'Delivered' ? 'ok' : s.stop_outcome === 'Pending' ? 'neutral' : 'warn'}`}>
                        {DONE_WORDS[s.stop_outcome] ?? s.stop_outcome}
                      </span>
                      {!pending && (
                        <span className="muted">
                          {Number(s.bottles_empties_picked_up) > 0 ? ` · ${s.bottles_empties_picked_up} empties` : ''}
                          {Number(s.payment_amount_cents) > 0 ? ` · ${money(Number(s.payment_amount_cents))} ${(s.payment_method ?? '').toLowerCase()}` : ''}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="num"><Link to={`/route/stop/${s.id}`} className="small">Open</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {stops.length === 0 && <p className="muted">No stops on this round.</p>}
      </div>

      {sheet.collections.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Collection stops</h2>
          <table className="phone-cards">
            <thead><tr><th>Who</th><th>What</th><th>Collected?</th><th>Count</th></tr></thead>
            <tbody>
              {sheet.collections.map((c) => {
                const st = cols[c.id];
                return (
                  <tr key={c.id}>
                    <td data-label="Who"><strong>{c.kind === 'Supplier' ? c.supplier_name : c.customer_name}</strong></td>
                    <td data-label="What" className="small">
                      {c.kind === 'Empties' ? `Empties (${c.empties_count} expected)` : c.kind === 'Returns' ? 'Returned goods' : 'Supplier pick-up'}
                    </td>
                    {st && open ? (
                      <>
                        <td data-label="Collected?">
                          <select aria-label={`Collected from ${c.customer_name}`} value={st.got} disabled={busy}
                                  onChange={(e) => setCols((x) => ({ ...x, [c.id]: { ...st, got: e.target.value as '' | 'yes' | 'no' } }))}>
                            <option value="">Leave for now</option>
                            <option value="yes">Collected</option>
                            <option value="no">Not collected</option>
                          </select>
                        </td>
                        <td data-label="Count">
                          <input type="number" min="0" inputMode="numeric" style={{ width: 70 }} disabled={busy || st.got !== 'yes'}
                                 aria-label={`Empties collected from ${c.customer_name}`}
                                 value={st.count} onChange={(e) => setCols((x) => ({ ...x, [c.id]: { ...st, count: e.target.value } }))} />
                        </td>
                      </>
                    ) : (
                      <td colSpan={2} className="small">
                        {c.status === 'Pending' ? <Link to={`/delivery/${sheet.id}`}>Record it on the round page</Link> : c.status}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="panel">
          <div className="total-line"><span>Stops being entered</span><span>{entering.length + colsEntering.length}</span></div>
          <div className="total-line"><span>Payments being entered</span><span>{money(takenCents)}</span></div>
          <div className="total-line"><span>Empties being entered</span><span>{emptiesIn}</span></div>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button type="button" disabled={busy || entering.length + colsEntering.length === 0} onClick={saveAll}>
              {busy ? 'Recording…' : 'Save the sheet'}
            </button>
            <Link to={`/delivery/${sheet.id}/settlement`} className={`button-link${todo.length === 0 ? '' : ' secondary'}`}>
              Go to settlement
            </Link>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Saving records each stop as if the driver had done it on the phone: stock, bottles and invoices
            follow. If the truck was loaded, count what came back on the settlement page before closing.
          </p>
        </div>
      )}
    </>
  );
}
