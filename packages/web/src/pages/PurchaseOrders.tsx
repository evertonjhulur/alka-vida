import { useEffect, useState } from 'react';
import { api, download } from '../lib/api';
import { money, toCents, when, day, todayInJamaica } from '../lib/format';
import { ask } from '../components/Dialog';

/**
 * Purchase orders.
 *
 * Revised 30 Sep 2026 (Everton): GCT and the Environmental Levy (0.375%) are
 * worked out per line from how each product is tagged for the supplier
 * (GCT-exempt, Env-exempt); a PO can be changed or deleted until goods are
 * received against it, downloaded as a PDF, and emailed to the supplier.
 */

interface SupplierMaterial {
  rawMaterialId: string; name: string; unitOfMeasure: string;
  gctExempt?: boolean; envExempt?: boolean;
}
interface Supplier { id: string; name: string; email: string | null; materials: SupplierMaterial[] }
interface PO {
  id: string; po_number: string; supplier_name: string; supplier_id: string; order_date: string;
  status: string; grand_total_cents: number; line_count: number; sent_to?: string | null;
}
interface POLine {
  id: string; raw_material_id: string; raw_material_name: string; unit_of_measure: string;
  quantity_ordered: number; quantity_received: number; unit_cost_cents: number;
  gct_exempt: boolean; env_exempt: boolean; line_total_cents: number;
}
interface PODetail extends PO {
  lines: POLine[]; subtotal_cents: number; gct_cents: number; env_tax_cents: number;
  expected_delivery_date: string | null; notes: string | null; supplier_email: string | null;
}

interface DraftLine {
  rawMaterialId: string; qty: string; unitCost: string; autoPriced: boolean;
  gct: boolean; env: boolean;
}
const BLANK_LINE: DraftLine = { rawMaterialId: '', qty: '', unitCost: '', autoPriced: false, gct: true, env: true };

export default function PurchaseOrders() {
  const [orders, setOrders] = useState<PO[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [envRate, setEnvRate] = useState(0.375);
  const [open, setOpen] = useState<PODetail | null>(null);
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  /** The day it actually arrived (team feedback, point 18); blank = today. */
  const [arrivedOn, setArrivedOn] = useState('');
  const [mailTo, setMailTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState<'new' | string | null>(null); // 'new' or the PO id being changed
  const [supplierId, setSupplierId] = useState('');
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ ...BLANK_LINE }]);

  async function load() {
    setOrders(await api.get<PO[]>('/api/purchase-orders'));
    setSuppliers(await api.get<Supplier[]>('/api/suppliers'));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.get<{ ratePercent: number }>('/api/settings/env-tax').then((r) => setEnvRate(r.ratePercent)).catch(() => {});
  }, []);

  const supplier = suppliers.find((s) => s.id === supplierId);
  const tagOf = (materialId: string) => supplier?.materials.find((m) => m.rawMaterialId === materialId);

  async function autoPrice(index: number, rawMaterialId: string, qty: string) {
    if (!supplierId || !rawMaterialId || !(Number(qty) > 0)) return;
    try {
      const { unitCostCents } = await api.get<{ unitCostCents: number }>(
        `/api/suppliers/${supplierId}/price?materialId=${rawMaterialId}&quantity=${Number(qty)}`,
      );
      setLines((cur) => cur.map((l, i) => (i === index
        ? { ...l, unitCost: (unitCostCents / 100).toFixed(2), autoPriced: true } : l)));
    } catch { /* leave the cost for manual entry */ }
  }
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((cur) => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const lineTotal = (l: DraftLine) => Math.round((Number(l.qty) || 0) * toCents(l.unitCost || '0'));
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const gct = lines.reduce((s, l) => s + (l.gct ? Math.round(lineTotal(l) * 0.15) : 0), 0);
  const env = lines.reduce((s, l) => s + (l.env ? Math.round(lineTotal(l) * envRate / 100) : 0), 0);

  function startNew() {
    setForm('new'); setSupplierId(''); setExpected(''); setNotes('');
    setLines([{ ...BLANK_LINE }]); setOpen(null); setMsg(null);
  }
  function startEdit(p: PODetail) {
    setForm(p.id); setSupplierId(p.supplier_id); setExpected(p.expected_delivery_date ?? '');
    setNotes(p.notes ?? '');
    setLines(p.lines.map((l) => ({
      rawMaterialId: l.raw_material_id, qty: String(Number(l.quantity_ordered)),
      unitCost: (Number(l.unit_cost_cents) / 100).toFixed(2), autoPriced: false,
      gct: !l.gct_exempt, env: !l.env_exempt,
    })));
    setOpen(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function savePO(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const payload = lines
        .filter((l) => l.rawMaterialId && Number(l.qty) > 0)
        .map((l) => ({
          rawMaterialId: l.rawMaterialId,
          quantityOrdered: Number(l.qty),
          ...(l.autoPriced ? {} : { unitCostCents: toCents(l.unitCost || '0') }),
          gctExempt: !l.gct, envExempt: !l.env,
        }));
      if (payload.length === 0) throw new Error('Add at least one material line.');
      const body = { supplierId, expectedDeliveryDate: expected || null, notes: notes || null, lines: payload };
      if (form === 'new') {
        const po = await api.post<{ poNumber: string; grandTotalCents: number }>('/api/purchase-orders', body);
        setMsg(`Created ${po.poNumber} for ${money(po.grandTotalCents)}. Open it to download or email it.`);
      } else {
        const r = await api.patch<{ grandTotalCents: number }>(`/api/purchase-orders/${form}`, body);
        setMsg(`Purchase order changed. New total ${money(r.grandTotalCents)}.`);
      }
      setForm(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the purchase order');
    } finally { setBusy(false); }
  }

  async function openPO(id: string) {
    if (open?.id === id) { setOpen(null); return; }
    const detail = await api.get<PODetail>(`/api/purchase-orders/${id}`);
    setOpen(detail);
    setMailTo(detail.supplier_email ?? '');
    setReceipts(Object.fromEntries(detail.lines.map((l) => [
      l.id, String(Math.max(Number(l.quantity_ordered) - Number(l.quantity_received), 0)),
    ])));
  }

  async function act(what: () => Promise<string>, fallback: string, reopen = true) {
    setBusy(true); setError(null); setMsg(null);
    try {
      const m = await what();
      setMsg(m);
      await load();
      if (reopen && open) {
        const id = open.id;
        setOpen(null);
        const detail = await api.get<PODetail>(`/api/purchase-orders/${id}`).catch(() => null);
        if (detail) setOpen(detail);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  const receive = () => act(async () => {
    const result = await api.post<{ status: string; batchIds: string[] }>(
      `/api/purchase-orders/${open!.id}/receive`, {
        receipts: Object.entries(receipts)
          .map(([poLineItemId, q]) => ({ poLineItemId, quantityReceived: Number(q) || 0 }))
          .filter((r) => r.quantityReceived > 0),
        receivedOn: arrivedOn || null,
      });
    setArrivedOn('');
    return `Received${arrivedOn ? ` (arrived ${day(arrivedOn)})` : ''}. ${result.batchIds.length} stock batch(es) created at this order's prices; production draws from them oldest first.`;
  }, 'Could not record the receipt');

  const emailIt = () => act(async () => {
    const r = await api.post<{ sentTo: string }>(`/api/purchase-orders/${open!.id}/email`, { to: mailTo });
    return `${open!.po_number} emailed to ${r.sentTo}.`;
  }, 'Could not send it');

  const deleteIt = async () => {
    if (!open) return;
    if (!await ask(`Delete ${open.po_number}? Nothing has been received against it.`,
      { confirmLabel: 'Delete it', cancelLabel: 'Keep it', danger: true })) return;
    const n = open.po_number;
    await act(async () => { await api.del(`/api/purchase-orders/${open.id}`); setOpen(null); return `${n} deleted.`; },
      'Could not delete it', false);
  };
  const cancelRest = async () => {
    if (!open) return;
    if (!await ask(`Close ${open.po_number}? Nothing more will be expected against it. What was received stays.`,
      { confirmLabel: 'Close it', cancelLabel: 'Keep it open', danger: true })) return;
    await act(async () => { await api.post(`/api/purchase-orders/${open.id}/cancel`, {}); return `${open.po_number} closed.`; },
      'Could not close it');
  };

  const nothingReceived = open ? open.lines.every((l) => Number(l.quantity_received) === 0) : false;
  const statusChip = (s: string) => (s === 'Received' ? 'ok' : s === 'Partially Received' ? 'warn'
    : s === 'Cancelled' ? 'muted' : s === 'Sent' ? 'info' : 'neutral');

  return (
    <>
      <h1>Purchase orders</h1>
      <p className="subtitle">
        Line prices come from the supplier's pricing and are frozen on the order. GCT and the
        Environmental Levy ({envRate}%) follow how each product is tagged on the Suppliers tab.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>{form === 'new' ? 'New purchase order' : form ? 'Change the purchase order' : 'Orders'}</h2>
          <button className="secondary" onClick={() => (form ? setForm(null) : startNew())}>
            {form ? 'Cancel' : 'New purchase order'}
          </button>
        </div>

        {form && (
          <form onSubmit={savePO} style={{ marginBottom: 18 }}>
            <div className="row">
              <div className="field" style={{ flex: '1 1 240px' }}>
                <label htmlFor="sup">Supplier</label>
                <select id="sup" required value={supplierId} style={{ width: '100%' }}
                        onChange={(e) => { setSupplierId(e.target.value); setLines([{ ...BLANK_LINE }]); }}>
                  <option value="">Select a supplier…</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="exp">Required by</label>
                <input id="exp" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
              </div>
              <div className="field grow">
                <label htmlFor="po-notes">Note to the supplier</label>
                <input id="po-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>

            {supplier && supplier.materials.length === 0 && (
              <div className="notice warn">
                Nothing is recorded for {supplier.name} yet. Add what they sell and what they charge on
                the Suppliers tab, and their prices apply here.
              </div>
            )}

            {supplier && supplier.materials.length > 0 && (
              <>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '34%' }}>Material</th>
                      <th>Quantity</th><th>Cost each</th><th>Taxes</th>
                      <th className="num">Line total</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i}>
                        <td>
                          <select value={l.rawMaterialId} style={{ width: '100%' }}
                                  onChange={(e) => {
                                    const t = tagOf(e.target.value);
                                    setLine(i, { rawMaterialId: e.target.value, autoPriced: false,
                                      gct: !t?.gctExempt, env: !t?.envExempt });
                                    void autoPrice(i, e.target.value, l.qty);
                                  }}>
                            <option value="">Select a material…</option>
                            {supplier.materials.map((m) => (
                              <option key={m.rawMaterialId} value={m.rawMaterialId}>{m.name}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input type="number" min="0" step="any" style={{ width: 100 }} value={l.qty}
                                 onChange={(e) => setLine(i, { qty: e.target.value })}
                                 onBlur={(e) => autoPrice(i, l.rawMaterialId, e.target.value)} />
                        </td>
                        <td>
                          <input type="number" step="0.01" min="0" style={{ width: 100 }} value={l.unitCost}
                                 onChange={(e) => setLine(i, { unitCost: e.target.value, autoPriced: false })} />
                          {l.autoPriced && <div className="muted small">from supplier pricing</div>}
                        </td>
                        <td>
                          <label className="check" style={{ margin: 0 }}>
                            <input type="checkbox" checked={l.gct} onChange={(e) => setLine(i, { gct: e.target.checked })} /> GCT
                          </label>
                          <label className="check" style={{ margin: 0 }}>
                            <input type="checkbox" checked={l.env} onChange={(e) => setLine(i, { env: e.target.checked })} /> Env
                          </label>
                        </td>
                        <td className="num">{money(lineTotal(l))}</td>
                        <td className="num">
                          {lines.length > 1 && (
                            <button type="button" className="danger-soft"
                                    onClick={() => setLines((c) => c.filter((_, x) => x !== i))}>Remove</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="secondary" onClick={() => setLines((c) => [...c, { ...BLANK_LINE }])}>Add line</button>
                </div>
                <div style={{ maxWidth: 340, marginLeft: 'auto', marginTop: 12 }}>
                  <div className="total-line"><span>Subtotal</span><span>{money(subtotal)}</span></div>
                  <div className="total-line"><span>GCT 15%</span><span>{money(gct)}</span></div>
                  <div className="total-line"><span>Environmental Levy {envRate}%</span><span>{money(env)}</span></div>
                  <div className="total-line grand"><span>Order total</span><span>{money(subtotal + gct + env)}</span></div>
                  <button style={{ width: '100%', marginTop: 10 }} disabled={busy || !supplierId}>
                    {busy ? 'Saving…' : form === 'new' ? 'Create purchase order' : 'Save changes'}
                  </button>
                </div>
              </>
            )}
          </form>
        )}

        {!form && (
          <>
            <table>
              <thead>
                <tr><th>PO</th><th>Supplier</th><th>Ordered</th><th>Lines</th><th>Status</th><th className="num">Total</th><th /></tr>
              </thead>
              <tbody>
                {orders.map((p) => (
                  <tr key={p.id}>
                    <td>{p.po_number}</td>
                    <td>{p.supplier_name}</td>
                    <td>{when(p.order_date)}</td>
                    <td>{p.line_count}</td>
                    <td><span className={`chip ${statusChip(p.status)}`}>{p.status}</span></td>
                    <td className="num">{money(Number(p.grand_total_cents))}</td>
                    <td className="num">
                      <button className="secondary" onClick={() => openPO(p.id)}>{open?.id === p.id ? 'Close' : 'Open'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {orders.length === 0 && <p className="muted">No purchase orders yet.</p>}
          </>
        )}
      </div>

      {open && !form && (
        <div className="panel">
          <div className="panel-head">
            <h2>{open.po_number} · {open.supplier_name}</h2>
            <span className="row" style={{ gap: 6 }}>
              <button className="secondary" disabled={busy}
                      onClick={() => download(`/api/purchase-orders/${open.id}/pdf`, `${open.po_number}.pdf`).catch((e) => setError(e.message))}>
                Download PDF</button>
              {nothingReceived && open.status !== 'Cancelled' && (
                <button className="secondary" disabled={busy} onClick={() => startEdit(open)}>Change it</button>
              )}
              {nothingReceived
                ? <button className="danger-soft" disabled={busy} onClick={deleteIt}>Delete</button>
                : !['Received', 'Cancelled'].includes(open.status) && (
                  <button className="danger-soft" disabled={busy} onClick={cancelRest}>Close it (nothing more coming)</button>
                )}
            </span>
          </div>

          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field grow" style={{ maxWidth: 360 }}>
              <label htmlFor="po-to">Email it to the supplier</label>
              <input id="po-to" type="email" value={mailTo} placeholder="no address on file"
                     onChange={(e) => setMailTo(e.target.value)} />
            </div>
            <div className="field">
              <button disabled={busy || !mailTo.trim() || open.status === 'Cancelled'} onClick={emailIt}>Send it</button>
            </div>
            {open.sent_to && <div className="field muted small">Last sent to {open.sent_to}</div>}
          </div>

          <table>
            <thead>
              <tr><th>Material</th><th className="num">Ordered</th><th className="num">Already received</th>
                <th className="num">Cost each</th><th>Taxes</th><th>Receiving now</th></tr>
            </thead>
            <tbody>
              {open.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.raw_material_name}</td>
                  <td className="num">{Number(l.quantity_ordered)} {l.unit_of_measure}</td>
                  <td className="num">{Number(l.quantity_received)}</td>
                  <td className="num">{money(Number(l.unit_cost_cents))}</td>
                  <td className="small">{[l.gct_exempt ? null : 'GCT', l.env_exempt ? null : 'Env'].filter(Boolean).join(', ') || 'none'}</td>
                  <td>
                    <input type="number" min="0" style={{ width: 100 }} value={receipts[l.id] ?? ''}
                           disabled={['Received', 'Cancelled'].includes(open.status)}
                           onChange={(e) => setReceipts({ ...receipts, [l.id]: e.target.value })} />
                    {Number(receipts[l.id] ?? 0) > Number(l.quantity_ordered) - Number(l.quantity_received) && (
                      <div className="chip warn" style={{ marginTop: 4 }}>more than ordered</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
            <div className="small muted">
              Subtotal {money(Number(open.subtotal_cents))} · GCT {money(Number(open.gct_cents))} ·
              Env levy {money(Number(open.env_tax_cents))} · <strong>Total {money(Number(open.grand_total_cents))}</strong>
            </div>
            {!['Received', 'Cancelled'].includes(open.status) && (
              <span className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <span className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="arr">Arrived on</label>
                  <input id="arr" type="date" value={arrivedOn} max={todayInJamaica()}
                         onChange={(e) => setArrivedOn(e.target.value)} />
                </span>
                <button disabled={busy} onClick={receive}>{busy ? 'Recording…' : 'Record what arrived'}</button>
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}
