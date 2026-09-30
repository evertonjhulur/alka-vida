import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, idempotencyKey } from '../lib/api';
import { money, toCents, day } from '../lib/format';
import CustomerPicker, { type PickerCustomer } from '../components/CustomerPicker';

/**
 * Payments: money received outside a round (approved mockup, 29 Sep 2026).
 *
 * Record it once: who, how much, how, the bank reference. Their open
 * invoices are ticked oldest first as the amount is typed, and the line
 * under them says in words what that does ("Clears 2 invoices exactly").
 * Below, money already on an account but not against an invoice, each row
 * with its best invoice chosen (an exact match if there is one) and an
 * Apply button, plus "Apply every exact match" for the end-of-week tidy.
 */

interface Invoice {
  invoice_id: string; invoice_number: string; invoice_date: string; customer_id: string;
  grand_total_cents: number | string; balance_cents: number | string; status: string;
  is_credit_note?: boolean;
}

interface Unapplied {
  id: string; customer_id: string; customer_name: string; amount_cents: number | string;
  payment_date: string; method: string; reference: string | null; notes: string | null;
  round_zone?: string | null;
}

const METHODS: Array<[string, string]> = [
  ['Bank Transfer', 'Bank transfer'], ['Cheque', 'Cheque'], ['Card', 'Card'], ['Cash', 'Cash'], ['Other', 'Other'],
];

const bal = (i: Invoice) => Number(i.balance_cents);
const oldestFirst = (a: Invoice, b: Invoice) =>
  a.invoice_date.localeCompare(b.invoice_date) || a.invoice_number.localeCompare(b.invoice_number);

export default function Payments() {
  const [customers, setCustomers] = useState<PickerCustomer[]>([]);
  const [unapplied, setUnapplied] = useState<Unapplied[]>([]);
  const [open, setOpen] = useState<Invoice[]>([]);
  const [form, setForm] = useState({ customerId: '', amount: '', method: 'Bank Transfer', reference: '', notes: '' });
  const [ticked, setTicked] = useState<string[] | null>(null); // null = follow the amount, oldest first
  const [applyTo, setApplyTo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [c, u, inv] = await Promise.all([
      api.get<PickerCustomer[]>('/api/customers'),
      api.get<Unapplied[]>('/api/payments/unapplied'),
      api.get<Invoice[]>('/api/invoices'),
    ]);
    setCustomers(c);
    setUnapplied(u);
    setOpen(inv.filter((i) => bal(i) > 0 && i.status !== 'Cancelled' && !i.is_credit_note).sort(oldestFirst));
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  const theirs = open.filter((i) => i.customer_id === form.customerId);
  const received = toCents(form.amount || '0');

  /** Which invoices the money goes against, and how much each. */
  const plan = (() => {
    const order = ticked ? theirs.filter((i) => ticked.includes(i.invoice_id)) : theirs;
    let left = received;
    const out: Array<{ inv: Invoice; cents: number }> = [];
    for (const inv of order) {
      if (left <= 0) break;
      const cents = Math.min(bal(inv), left);
      out.push({ inv, cents });
      left -= cents;
    }
    return { rows: out, left };
  })();
  const planned = (id: string) => plan.rows.find((r) => r.inv.invoice_id === id);

  const toggle = (inv: Invoice) => {
    const now = ticked ?? plan.rows.map((r) => r.inv.invoice_id);
    setTicked(now.includes(inv.invoice_id) ? now.filter((x) => x !== inv.invoice_id) : [...now, inv.invoice_id]);
  };

  const summary = (() => {
    if (received <= 0) return 'Type the amount and their invoices are ticked oldest first.';
    const full = plan.rows.filter((r) => r.cents === bal(r.inv));
    const part = plan.rows.find((r) => r.cents < bal(r.inv));
    const bits: string[] = [];
    if (full.length) bits.push(`Clears ${full.length} ${full.length === 1 ? 'invoice' : 'invoices'}${!part && plan.left === 0 ? ' exactly' : ''}`);
    if (part) bits.push(`${full.length ? 'pays' : 'Pays'} ${money(part.cents)} towards ${part.inv.invoice_number}`);
    const first = bits.join(', ') || 'Not against any invoice';
    return `${first}. ${plan.left > 0 ? `${money(plan.left)} left on their account.` : 'Nothing left over.'}`;
  })();

  async function act(what: () => Promise<string>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { setMsg(await what()); await load(); } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  const receive = (e: React.FormEvent) => {
    e.preventDefault();
    const who = customers.find((c) => c.id === form.customerId)?.name ?? 'them';
    act(async () => {
      const out = await api.post<{ allocatedCents: number; unappliedCents: number }>('/api/payments/receive', {
        customerId: form.customerId,
        amountCents: received,
        method: form.method,
        reference: form.reference || null,
        notes: form.notes || null,
        allocations: plan.rows.map((r) => ({ invoiceId: r.inv.invoice_id, amountCents: r.cents })),
        idempotencyKey: idempotencyKey('receive'),
      });
      setForm({ ...form, amount: '', reference: '', notes: '' });
      setTicked(null);
      return `${money(received)} from ${who} recorded. ${money(out.allocatedCents)} against invoices` +
        (out.unappliedCents > 0 ? `, ${money(out.unappliedCents)} on their account.` : '.');
    }, 'Could not record the payment');
  };

  // ---- the "on account" list ----
  const choicesFor = (p: Unapplied) => open.filter((i) => i.customer_id === p.customer_id);
  const exactFor = (p: Unapplied) => choicesFor(p).find((i) => bal(i) === Number(p.amount_cents));
  const chosenFor = (p: Unapplied) => applyTo[p.id] ?? exactFor(p)?.invoice_id ?? choicesFor(p)[0]?.invoice_id ?? '';

  const applyOne = (p: Unapplied) => act(async () => {
    const invoiceId = chosenFor(p);
    const inv = open.find((i) => i.invoice_id === invoiceId);
    const r = await api.post<{ appliedCents: number }>(`/api/payments/${p.id}/apply`, { invoiceId });
    const rest = Number(p.amount_cents) - r.appliedCents;
    return `${money(r.appliedCents)} from ${p.customer_name} put against ${inv?.invoice_number ?? 'the invoice'}` +
      (rest > 0 ? `; ${money(rest)} stays on their account.` : '.');
  }, 'Could not apply that payment');

  const exactRows = unapplied.filter((p) => exactFor(p));
  const applyAllExact = () => act(async () => {
    // One at a time, so two payments of the same amount never pick the same invoice.
    const used = new Set<string>();
    let n = 0;
    let total = 0;
    for (const p of exactRows) {
      const inv = choicesFor(p).find((i) => bal(i) === Number(p.amount_cents) && !used.has(i.invoice_id));
      if (!inv) continue;
      await api.post(`/api/payments/${p.id}/apply`, { invoiceId: inv.invoice_id });
      used.add(inv.invoice_id);
      n += 1; total += Number(p.amount_cents);
    }
    return `${n} ${n === 1 ? 'payment' : 'payments'} (${money(total)}) put against the invoices they match exactly.`;
  }, 'Could not apply them all');

  const onAccountTotal = unapplied.reduce((s, p) => s + Number(p.amount_cents), 0);

  return (
    <>
      <h1>Payments</h1>
      <p className="subtitle">Money received outside a round: bank transfers, cheques, card over the phone.</p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <form className="panel" onSubmit={receive}>
        <h2 style={{ marginTop: 0 }}>Record money received</h2>
        <div className="pay-fields">
          <div className="field">
            <label htmlFor="pcust">From</label>
            <CustomerPicker id="pcust" customers={customers} value={form.customerId}
                            onChange={(id) => { setForm({ ...form, customerId: id }); setTicked(null); }} />
          </div>
          <div className="field">
            <label htmlFor="pamt">Amount</label>
            <input id="pamt" inputMode="decimal" required placeholder="0.00" value={form.amount}
                   onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pmeth">How</label>
            <select id="pmeth" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pref">Bank ref or cheque no.</label>
            <input id="pref" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </div>
        </div>

        {form.customerId && (
          <>
            <div className="small" style={{ margin: '4px 0 8px' }}>
              {theirs.length ? 'Put it against their open invoices, oldest first:' : 'They have no open invoices. It will sit on their account until one is raised.'}
            </div>
            {theirs.length > 0 && (
              <div className="inv-picks">
                {theirs.map((inv) => {
                  const r = planned(inv.invoice_id);
                  const on = !!r;
                  return (
                    <label key={inv.invoice_id} className={`inv-pick${on ? ' on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggle(inv)} />
                      <span>
                        {inv.invoice_number} · {money(bal(inv))}
                        <span className="muted small"> · {day(inv.invoice_date)}</span>
                        {r && r.cents < bal(inv) && <span className="chip warn" style={{ marginLeft: 6 }}>{money(r.cents)} of it</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </>
        )}

        <details className="pay-notes">
          <summary className="small">Add a note</summary>
          <input aria-label="Note" style={{ width: '100%', marginTop: 6 }} value={form.notes}
                 onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </details>

        <div className="pay-foot">
          <span className="small">{form.customerId ? summary : 'Choose who it is from.'}</span>
          <button disabled={busy || !form.customerId || received <= 0}>
            {busy ? 'Recording…' : `Record ${money(received)}`}
          </button>
        </div>
      </form>

      <div className="panel" style={{ padding: 0 }}>
        <div className="panel-pad">
          <h2 style={{ margin: 0 }}>On account, not yet against an invoice</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Already counts towards what they owe. Choose an invoice on the row to tidy the books.
          </p>
        </div>
        {unapplied.length > 0 && (
          <table className="orders-table pay-table">
            <thead>
              <tr><th>Received</th><th>Customer</th><th>How</th><th className="num">Amount</th><th>Put it against</th><th /></tr>
            </thead>
            <tbody>
              {unapplied.map((p) => {
                const choices = choicesFor(p);
                const exact = exactFor(p);
                return (
                  <tr key={p.id}>
                    <td data-label="Received">{day(p.payment_date)}</td>
                    <td data-label="Customer">
                      <Link to={`/customers/${p.customer_id}?tab=payments`}>{p.customer_name}</Link>
                      {p.reference && <div className="muted small">{p.reference}</div>}
                    </td>
                    <td data-label="How" className="small">
                      {p.method === 'Bank Transfer' ? 'Bank transfer' : p.method}{p.round_zone ? ` on the ${p.round_zone} round` : ''}
                    </td>
                    <td data-label="Total" className="num">{money(Number(p.amount_cents))}</td>
                    <td data-label="Against">
                      {choices.length ? (
                        <select aria-label={`Invoice for ${money(Number(p.amount_cents))} from ${p.customer_name}`}
                                value={chosenFor(p)} style={{ width: '100%', maxWidth: 320 }}
                                onChange={(e) => setApplyTo({ ...applyTo, [p.id]: e.target.value })}>
                          {choices.map((i) => (
                            <option key={i.invoice_id} value={i.invoice_id}>
                              {i.invoice_number} · {money(bal(i))}{exact?.invoice_id === i.invoice_id ? ' (exact match)' : ' owing'}
                            </option>
                          ))}
                        </select>
                      ) : <span className="muted small">nothing open to put it against</span>}
                    </td>
                    <td className="num order-actions">
                      {choices.length > 0 && (
                        <button type="button" className={exact && chosenFor(p) === exact.invoice_id ? '' : 'secondary'}
                                disabled={busy} onClick={() => applyOne(p)}>Apply</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {unapplied.length === 0 && (
          <p className="muted" style={{ padding: '0 16px 14px', margin: 0 }}>Every payment received is against an invoice.</p>
        )}
        {unapplied.length > 0 && (
          <div className="list-foot">
            <span>{unapplied.length} {unapplied.length === 1 ? 'payment' : 'payments'}, {money(onAccountTotal)} on account</span>
            <button type="button" className="secondary" disabled={busy || exactRows.length === 0} onClick={applyAllExact}>
              Apply every exact match{exactRows.length ? ` (${exactRows.length})` : ''}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
