import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, openPdfPost, idempotencyKey } from '../lib/api';
import { BatchBar, SortTh, MultiStatusSelect, passes, TickAllTh, TickTd, sendSummary, useSort, useTicks } from '../components/ListTools';
import { downloadCsv, dollars } from '../lib/csv';
import { payMethods, useTakeCard } from '../lib/payments';
import { money, toCents, day } from '../lib/format';
import { todayInJamaica as todayJa } from '../lib/format';
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
  /** Paid with an order still to be delivered: it waits for that order's invoice. */
  order_number?: string | null; order_open?: boolean | null;
}

const METHODS: Array<[string, string]> = [
  ['Bank Transfer', 'Bank transfer'], ['Cheque', 'Cheque'], ['Card', 'Card'], ['Cash', 'Cash'], ['Other', 'Other'],
];

const bal = (i: Invoice) => Number(i.balance_cents);
const oldestFirst = (a: Invoice, b: Invoice) =>
  a.invoice_date.localeCompare(b.invoice_date) || a.invoice_number.localeCompare(b.invoice_number);

export default function Payments() {
  const takeCard = useTakeCard();
  const [customers, setCustomers] = useState<PickerCustomer[]>([]);
  const [unapplied, setUnapplied] = useState<Unapplied[]>([]);
  const [open, setOpen] = useState<Invoice[]>([]);
  const [form, setForm] = useState({ customerId: '', amount: '', method: 'Bank Transfer', reference: '', notes: '', receipt: true, date: '' });
  const [ticked, setTicked] = useState<string[] | null>(null); // null = follow the amount, oldest first
  const [applyTo, setApplyTo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped after anything changes, so the list of payments received reloads. */
  const [stamp, setStamp] = useState(0);

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
    try { setMsg(await what()); await load(); setStamp((n) => n + 1); } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  const receive = (e: React.FormEvent) => {
    e.preventDefault();
    const who = customers.find((c) => c.id === form.customerId)?.name ?? 'them';
    act(async () => {
      const out = await api.post<{
        allocatedCents: number; unappliedCents: number;
        receipt?: { sentTo: string; receiptNumber: string }; receiptError?: string;
      }>('/api/payments/receive', {
        customerId: form.customerId,
        amountCents: received,
        method: form.method,
        paymentDate: form.date || null,
        reference: form.reference || null,
        notes: form.notes || null,
        allocations: plan.rows.map((r) => ({ invoiceId: r.inv.invoice_id, amountCents: r.cents })),
        idempotencyKey: idempotencyKey('receive'),
        sendReceipt: form.receipt,
      });
      setForm({ ...form, amount: '', reference: '', notes: '', date: '' });
      setTicked(null);
      return `${money(received)} from ${who} recorded. ${money(out.allocatedCents)} against invoices` +
        (out.unappliedCents > 0 ? `, ${money(out.unappliedCents)} on their account.` : '.') +
        (out.receipt ? ` Receipt ${out.receipt.receiptNumber} emailed to ${out.receipt.sentTo}.`
          : out.receiptError ? ` No receipt was sent: ${out.receiptError}` : '');
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
              {payMethods(METHODS, takeCard, form.method).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pdate">Date paid</label>
            <input id="pdate" type="date" value={form.date} max={todayJa()}
                   onChange={(e) => setForm({ ...form, date: e.target.value })} />
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

        <label className="check">
          <input type="checkbox" checked={form.receipt}
                 onChange={(e) => setForm({ ...form, receipt: e.target.checked })} />
          Email the customer a receipt
        </label>

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
                      <Link to={`/customers/${p.customer_id}?tab=transactions`}>{p.customer_name}</Link>
                      {p.reference && <div className="muted small">{p.reference}</div>}
                      {p.order_number && p.order_open && (
                        <div className="small" style={{ color: 'var(--info)' }}>paid with {p.order_number}: goes on its invoice when delivered</div>
                      )}
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
      <Received stamp={stamp} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Every payment received: status, sort, batch actions (11 Oct 2026)   */
/* ------------------------------------------------------------------ */

interface Paid {
  id: string; customer_id: string; customer_name: string; payment_date: string;
  amount_cents: number | string; method: string | null; reference: string | null;
  receipt_number: string | null; invoice_id: string | null; invoice_number: string | null;
  is_reversal: boolean; reversed: boolean; order_number: string | null; round_zone: string | null;
}

const PAID_FILTERS = [
  ['', 'Any'], ['invoice', 'Against an invoice'], ['account', 'Left on the account'], ['reversed', 'Reversed'],
] as const;

const startOfMonth = () => `${todayJa().slice(0, 8)}01`;

function Received({ stamp }: { stamp: number }) {
  const [rows, setRows] = useState<Paid[]>([]);
  const [from, setFrom] = useState(startOfMonth());
  const [to, setTo] = useState('');
  const [state, setState] = useState<string[]>([]);
  const [how, setHow] = useState('');
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api.get<Paid[]>(`/api/payments?${q}`).then(setRows).catch((e) => setError(e.message));
  }, [from, to, stamp]);

  const needle = find.trim().toLowerCase();
  const filtered = rows.filter((p) => passes(state, (v) => (v === 'invoice' ? !!p.invoice_id && !p.is_reversal
    : v === 'account' ? !p.invoice_id && !p.is_reversal
      : p.is_reversal || p.reversed))
    && (!how || p.method === how)
    && (!needle || p.customer_name.toLowerCase().includes(needle)
      || (p.reference ?? '').toLowerCase().includes(needle) || (p.invoice_number ?? '').toLowerCase().includes(needle)));
  const { sorted, sort, onSort } = useSort(filtered, {
    date: (p) => p.payment_date, customer: (p) => p.customer_name, against: (p) => p.invoice_number ?? '',
    how: (p) => p.method ?? '', reference: (p) => p.reference ?? '', amount: (p) => Number(p.amount_cents),
  });
  const ticks = useTicks(sorted.filter((p) => !p.is_reversal && Number(p.amount_cents) > 0).map((p) => p.id));
  const picked = sorted.filter((p) => ticks.has(p.id));
  const methods = [...new Set(rows.map((p) => p.method).filter(Boolean))] as string[];

  async function batch(fn: () => Promise<string | null>, failed: string) {
    setBusy(true); setError(null); setMsg(null);
    try { const m = await fn(); if (m) setMsg(m); } catch (e) { setError(e instanceof Error ? e.message : failed); }
    finally { setBusy(false); }
  }
  /**
   * The receipt for one payment, in a new tab (Everton, 23 Oct 2026). A
   * payment spread over several invoices is several rows with one number:
   * the receipt covers them all, as on the customer page.
   */
  const viewReceipt = (p: Paid) => batch(async () => {
    // The server widens one row to its whole payment (paperwork.drawReceipt).
    await openPdfPost('/api/receipts.pdf', { paymentIds: [p.id] }, `Receipt-${p.receipt_number ?? 'payment'}.pdf`);
    return null;
  }, 'Could not open the receipt');
  const exportRows = (list: Paid[]) => downloadCsv(`payments${from ? `-${from}` : ''}${to ? `-to-${to}` : ''}`, [
    ['Date', 'Customer', 'Against', 'How', 'Reference', 'Receipt', 'Amount', 'Reversed'],
    ...list.map((p) => [p.payment_date, p.customer_name, p.invoice_number ?? 'On account', p.method ?? '',
      p.reference ?? '', p.receipt_number ?? '', dollars(Number(p.amount_cents)), p.is_reversal ? 'reversal' : p.reversed ? 'yes' : '']),
  ]);

  return (
    <div className="panel" style={{ padding: 0 }}>
      <div className="panel-pad">
        <h2 style={{ margin: 0 }}>Payments received</h2>
        <p className="muted small" style={{ margin: '4px 0 0' }}>Every payment recorded, newest first. Click a heading to sort.</p>
      </div>
      {error && <div className="notice error" style={{ margin: '0 16px 10px' }}>{error}</div>}
      {msg && <div className="notice ok" style={{ margin: '0 16px 10px' }}>{msg}</div>}
      <div className="list-filters">
        <div className="field">
          <label htmlFor="pr-find">Find</label>
          <input id="pr-find" type="search" placeholder="Customer, reference or invoice" value={find} onChange={(e) => setFind(e.target.value)} />
        </div>
        <MultiStatusSelect id="pr-state" label="Show" value={state} onChange={setState} options={PAID_FILTERS} />
        <div className="field">
          <label htmlFor="pr-how">How</label>
          <select id="pr-how" value={how} onChange={(e) => setHow(e.target.value)}>
            <option value="">Any way</option>
            {methods.map((m) => <option key={m} value={m}>{m === 'Bank Transfer' ? 'Bank transfer' : m}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pr-from">From</label>
          <input id="pr-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pr-to">To</label>
          <input id="pr-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
        <BatchBar inset count={picked.length} noun={['payment', 'payments']} busy={busy}
                  summary={money(picked.reduce((a, p) => a + Number(p.amount_cents), 0))}
                  onClear={ticks.clear}
                  actions={[
                    { label: 'Print receipts (one PDF)', run: () => batch(async () => {
                      await openPdfPost('/api/batch/receipts/print.pdf', { ids: ticks.picked }, `Receipts-${picked.length}.pdf`);
                      return `${picked.length} receipt${picked.length === 1 ? '' : 's'} in one PDF.`;
                    }, 'Could not build the receipts') },
                    { label: 'Email receipts (one per customer)', run: () => batch(async () => {
                      const r = await api.post<Array<{ label: string; sentTo?: string; error?: string }>>('/api/batch/receipts/send', { ids: ticks.picked });
                      const s = sendSummary(r);
                      if (s.problems.length) setError(`Not sent: ${s.problems.join(' · ')}`);
                      return s.ok;
                    }, 'Could not send the receipts') },
                    { label: 'Export to Excel', run: () => exportRows(picked) },
                  ]} />
      <table className="orders-table">
        <thead>
          <tr>
            <TickAllTh all={ticks.all} some={ticks.some} onToggle={ticks.toggleAll} disabled={sorted.length === 0} />
            <SortTh label="Received" k="date" sort={sort} onSort={onSort} />
            <SortTh label="Customer" k="customer" sort={sort} onSort={onSort} />
            <SortTh label="Against" k="against" sort={sort} onSort={onSort} />
            <SortTh label="How" k="how" sort={sort} onSort={onSort} />
            <SortTh label="Reference" k="reference" sort={sort} onSort={onSort} />
            <SortTh label="Amount" k="amount" sort={sort} onSort={onSort} className="num" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const tickable = !p.is_reversal && Number(p.amount_cents) > 0;
            return (
              <tr key={p.id}>
                {tickable
                  ? <TickTd checked={ticks.has(p.id)} onToggle={() => ticks.toggle(p.id)} label={`Tick ${money(Number(p.amount_cents))} from ${p.customer_name}`} />
                  : <td className="tick-col" />}
                <td data-label="Received">
                  {day(p.payment_date)}
                  {p.is_reversal && <> <span className="chip bad">reversal</span></>}
                  {p.reversed && <> <span className="chip bad">reversed</span></>}
                </td>
                <td data-label="Customer"><Link to={`/customers/${p.customer_id}?tab=transactions`}>{p.customer_name}</Link></td>
                <td data-label="Against">
                  {p.invoice_id ? <Link to={`/invoices/${p.invoice_id}`}>{p.invoice_number}</Link>
                    : <span className="muted">on account{p.order_number ? ` (with ${p.order_number})` : ''}</span>}
                </td>
                <td data-label="How" className="small">{p.method === 'Bank Transfer' ? 'Bank transfer' : p.method}{p.round_zone ? ` · ${p.round_zone} round` : ''}</td>
                <td data-label="Reference" className="small muted">
                  {p.reference ?? '—'}{p.receipt_number ? ` · ${p.receipt_number}` : ''}
                  {tickable && (
                    <> · <button type="button" className="as-link small" disabled={busy} onClick={() => viewReceipt(p)}>Receipt</button></>
                  )}
                </td>
                <td data-label="Amount" className="num">{money(Number(p.amount_cents))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && <p className="muted" style={{ padding: '0 16px 14px', margin: 0 }}>{rows.length ? 'Nothing matches.' : 'No payments in these dates.'}</p>}
      <div className="list-foot">
        <span>{sorted.length} shown · {money(sorted.filter((p) => !p.is_reversal).reduce((a, p) => a + Number(p.amount_cents), 0))}</span>
        <button type="button" className="secondary" disabled={sorted.length === 0} onClick={() => exportRows(sorted)}>Export to Excel ({sorted.length})</button>
      </div>
    </div>
  );
}
