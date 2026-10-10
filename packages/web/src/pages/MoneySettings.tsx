import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { setTakeCard } from '../lib/payments';

/**
 * Settings › Invoices & payments (Everton, 10 Oct 2026, points 5 and 6).
 *
 *  - The bank details and note printed at the foot of every invoice PDF and
 *    every statement PDF (not quotes, not credit notes), exactly as typed.
 *  - Whether we take card payments. Off: Card is left out of every list of
 *    ways to pay; card payments already recorded still show as recorded.
 */
interface Money { takeCard: boolean; documentFooter: string; defaultFooter: string }

export default function MoneySettings({ session }: { session: Session }) {
  const [m, setM] = useState<Money | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isAdmin = session.role === 'admin';

  useEffect(() => { api.get<Money>('/api/settings/money').then(setM).catch((e) => setErr(e.message)); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setNote(null);
    try {
      const out = await api.put<Money>('/api/settings/money', { takeCard: m!.takeCard, documentFooter: m!.documentFooter });
      setM(out);
      setTakeCard(out.takeCard);
      setNote('Saved. The next invoice or statement printed carries it.');
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : 'Could not save'); } finally { setBusy(false); }
  }

  if (!m) return err ? <div className="notice error">{err}</div> : <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Invoices &amp; payments</h1>
      <p className="subtitle">What every invoice and statement says about paying, and the ways customers can pay.</p>
      <form className="panel" onSubmit={save}>
        {err && <div className="notice error">{err}</div>}
        {note && <div className="notice ok">{note}</div>}
        <fieldset className="form-block" disabled={!isAdmin}>
          <legend>Footer on invoices and statements</legend>
          <div className="field">
            <label htmlFor="foot">Printed at the foot of every invoice PDF and every statement PDF</label>
            <textarea id="foot" rows={11} style={{ width: '100%', maxWidth: 560, boxSizing: 'border-box', fontFamily: 'inherit' }}
                      value={m.documentFooter} onChange={(e) => setM({ ...m, documentFooter: e.target.value })} />
            <div className="muted small">
              Printed line for line as typed. "Electronic Transfers:" and "Note to customer" are set in bold.
              Not printed on quotes or credit notes.{' '}
              {m.documentFooter.trim() !== m.defaultFooter.trim() && isAdmin && (
                <button type="button" className="as-link small" onClick={() => setM({ ...m, documentFooter: m.defaultFooter })}>
                  Put back the original wording
                </button>
              )}
            </div>
          </div>
        </fieldset>
        <fieldset className="form-block" disabled={!isAdmin}>
          <legend>Card payments</legend>
          <label className="check">
            <input type="checkbox" checked={m.takeCard} onChange={(e) => setM({ ...m, takeCard: e.target.checked })} />
            We take card payments
          </label>
          <div className="muted small">
            Off: "Card" is left out of every list of ways to pay (driver's stop, My route, counter sale, New order,
            Payments, invoice, customer record). Card payments already recorded still show as recorded.
          </div>
        </fieldset>
        {isAdmin ? <button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          : <p className="muted small">Only an administrator can change these.</p>}
      </form>
    </>
  );
}
