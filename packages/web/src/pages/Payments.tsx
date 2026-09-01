import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { money, toCents, date } from '../lib/format';

interface Customer { id: string; name: string }

interface Invoice {
  invoice_id: string; invoice_number: string; invoice_date: string;
  grand_total_cents: number; balance_cents: number; status: string;
}

interface Unapplied {
  id: string; customer_id: string; customer_name: string; amount_cents: number;
  payment_date: string; method: string; reference: string | null; notes: string | null;
}

const METHODS = ['Cash', 'Card', 'Bank Transfer', 'Cheque', 'Other'] as const;

export default function Payments() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [unapplied, setUnapplied] = useState<Unapplied[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({
    customerId: '', amount: '', method: 'Bank Transfer', reference: '', notes: '',
  });
  const [split, setSplit] = useState<Record<string, string>>({});
  const [applyTo, setApplyTo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadInvoices = useCallback(async (customerId: string) => {
    if (!customerId) { setInvoices([]); return; }
    const rows = await api.get<Invoice[]>(`/api/invoices?customerId=${customerId}`);
    setInvoices(rows.filter(
      (i) => Number(i.balance_cents) > 0 && i.status !== 'Cancelled'));
  }, []);

  const load = useCallback(async () => {
    setCustomers(await api.get<Customer[]>('/api/customers'));
    setUnapplied(await api.get<Unapplied[]>('/api/payments/unapplied'));
    // Balances have just moved, so anything on screen showing one is stale.
    await loadInvoices(form.customerId);
  }, [form.customerId, loadInvoices]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // Whose invoices to offer follows whoever is selected.
  useEffect(() => {
    loadInvoices(form.customerId).catch(() => setInvoices([]));
    setSplit({});
  }, [form.customerId, loadInvoices]);

  const received = toCents(form.amount || '0');
  const allocated = invoices.reduce((s, i) => s + toCents(split[i.invoice_id] || '0'), 0);
  const left = received - allocated;

  /**
   * Ticking an invoice settles it in full when the money stretches that far,
   * and takes whatever is left when it does not. Typing a figure is only
   * needed to fine-tune a part payment.
   */
  function toggle(inv: Invoice, on: boolean) {
    setSplit((cur) => {
      const next = { ...cur };
      if (!on) { delete next[inv.invoice_id]; return next; }
      const usedElsewhere = invoices
        .filter((i) => i.invoice_id !== inv.invoice_id)
        .reduce((s, i) => s + toCents(next[i.invoice_id] || '0'), 0);
      const remaining = Math.max(received - usedElsewhere, 0);
      next[inv.invoice_id] = (Math.min(Number(inv.balance_cents), remaining) / 100).toFixed(2);
      return next;
    });
  }

  /** Fill every invoice from oldest first, until the money runs out. */
  function autoApply() {
    let remaining = received;
    const next: Record<string, string> = {};
    for (const inv of [...invoices].sort((a, b) =>
      a.invoice_date.localeCompare(b.invoice_date))) {
      if (remaining <= 0) break;
      const take = Math.min(Number(inv.balance_cents), remaining);
      next[inv.invoice_id] = (take / 100).toFixed(2);
      remaining -= take;
    }
    setSplit(next);
  }

  async function receive(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setMsg(null);
    try {
      const out = await api.post<{ allocatedCents: number; unappliedCents: number }>(
        '/api/payments/receive', {
          customerId: form.customerId,
          amountCents: received,
          method: form.method,
          reference: form.reference || null,
          notes: form.notes || null,
          allocations: Object.entries(split)
            .filter(([, v]) => toCents(v) > 0)
            .map(([invoiceId, v]) => ({ invoiceId, amountCents: toCents(v) })),
        });
      setMsg(
        `Received ${money(received)}. ${money(out.allocatedCents)} applied to invoices` +
        (out.unappliedCents > 0
          ? `, ${money(out.unappliedCents)} left on the account.`
          : '.'),
      );
      setForm({ ...form, amount: '', reference: '', notes: '' });
      setSplit({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the payment');
    } finally { setBusy(false); }
  }

  /** Put an earlier receipt against an invoice raised since. */
  async function applyLater(p: Unapplied) {
    const invoiceId = applyTo[p.id];
    if (!invoiceId) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      await api.post(`/api/payments/${p.id}/reassign`, { invoiceId });
      setMsg(`${money(Number(p.amount_cents))} from ${p.customer_name} applied.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply that payment');
    } finally { setBusy(false); }
  }

  const shown = customers.filter((c) =>
    c.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <>
      <h1>Payments</h1>
      <p className="subtitle">
        Money received outside a delivery — a bank transfer, a card payment over
        the phone, a cheque dropped in. Apply it to invoices now, or record it
        now and apply it once the invoice exists.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <form onSubmit={receive}>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Record money received</h2>
          <div className="row">
            <div className="field" style={{ flex: '1 1 240px' }}>
              <label htmlFor="pcust">Customer</label>
              <input placeholder="Search by name…" value={search} style={{ width: '100%' }}
                     onChange={(e) => setSearch(e.target.value)} />
              <select id="pcust" required value={form.customerId} style={{ width: '100%' }}
                      onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
                <option value="">Select a customer…</option>
                {shown.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pamt">Amount received</label>
              <input id="pamt" type="number" step="0.01" min="0" required style={{ width: 150 }}
                     value={form.amount}
                     onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="pmeth">Method</label>
              <select id="pmeth" value={form.method}
                      onChange={(e) => setForm({ ...form, method: e.target.value })}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pref">Reference</label>
              <input id="pref" placeholder="bank ref, cheque no." value={form.reference}
                     onChange={(e) => setForm({ ...form, reference: e.target.value })} />
            </div>
          </div>

          {form.customerId && (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ marginBottom: 4 }}>What it settles</h3>
                <button type="button" className="secondary" disabled={received <= 0}
                        onClick={autoApply}>
                  Apply oldest first
                </button>
              </div>
              {invoices.length === 0 && (
                <p className="muted">
                  This customer has nothing outstanding. The payment will sit on
                  their account until an invoice is raised.
                </p>
              )}
              {invoices.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 40 }} />
                      <th>Invoice</th><th>Date</th>
                      <th className="num">Owing</th><th className="num">Applying</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => {
                      const applying = toCents(split[inv.invoice_id] || '0');
                      return (
                        <tr key={inv.invoice_id}>
                          <td>
                            <input type="checkbox" checked={applying > 0} disabled={busy}
                                   onChange={(e) => toggle(inv, e.target.checked)} />
                          </td>
                          <td>
                            <Link to={`/invoices/${inv.invoice_id}`}>{inv.invoice_number}</Link>
                            {applying > 0 && applying < Number(inv.balance_cents) && (
                              <div><span className="chip warn">part payment</span></div>
                            )}
                          </td>
                          <td className="small muted">{date(inv.invoice_date)}</td>
                          <td className="num">{money(Number(inv.balance_cents))}</td>
                          <td className="num">
                            <input type="number" step="0.01" min="0" style={{ width: 120 }}
                                   placeholder="0.00" disabled={busy}
                                   value={split[inv.invoice_id] ?? ''}
                                   onChange={(e) => setSplit({
                                     ...split, [inv.invoice_id]: e.target.value,
                                   })} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              <div className="total-line"><span>Received</span><span>{money(received)}</span></div>
              <div className="total-line">
                <span>Applied to invoices</span><span>{money(allocated)}</span>
              </div>
              <div className="total-line grand">
                <span>{left < 0 ? 'Over-applied' : 'Left on account'}</span>
                <span>{money(Math.abs(left))}</span>
              </div>
              {left < 0 && (
                <div className="notice error">
                  More has been applied than was received. Reduce a figure before saving.
                </div>
              )}
            </>
          )}

          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="pnotes">Notes</label>
            <input id="pnotes" style={{ width: '100%' }} value={form.notes}
                   onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>

          <button disabled={busy || !form.customerId || received <= 0 || left < 0}>
            {busy ? 'Recording…' : 'Record payment'}
          </button>
        </div>
      </form>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Not yet against an invoice</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Money already received and on the customer's account. It reduces what
          they owe overall — putting it against a specific invoice is for tidying
          the books, most often once the invoice it was meant for exists.
        </p>
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Customer</th><th>Method</th><th>Reference</th>
              <th className="num">Amount</th><th>Apply to</th><th />
            </tr>
          </thead>
          <tbody>
            {unapplied.map((p) => (
              <tr key={p.id}>
                <td>{date(p.payment_date)}</td>
                <td>{p.customer_name}</td>
                <td className="small">{p.method}</td>
                <td className="small muted">{p.reference ?? '—'}</td>
                <td className="num">{money(Number(p.amount_cents))}</td>
                <td>
                  <select value={applyTo[p.id] ?? ''} style={{ width: '100%' }}
                          onChange={(e) => setApplyTo({ ...applyTo, [p.id]: e.target.value })}>
                    <option value="">Select an invoice…</option>
                    {invoices
                      .filter(() => form.customerId === p.customer_id)
                      .map((i) => (
                        <option key={i.invoice_id} value={i.invoice_id}>
                          {i.invoice_number} — {money(Number(i.balance_cents))} owing
                        </option>
                      ))}
                  </select>
                  {form.customerId !== p.customer_id && (
                    <div className="muted small">
                      select {p.customer_name} above to list their invoices
                    </div>
                  )}
                </td>
                <td className="num">
                  <button type="button" className="secondary"
                          disabled={busy || !applyTo[p.id]}
                          onClick={() => applyLater(p)}>
                    Apply
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {unapplied.length === 0 && (
          <p className="muted">Every payment received is against an invoice.</p>
        )}
      </div>
    </>
  );
}
