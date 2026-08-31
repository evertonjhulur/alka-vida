import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';

interface DiscountTotals {
  totalDiscountCents: number; discountedDocumentCount: number; averageDiscountPercent: number;
}
interface PerClient {
  customerId: string; customerName: string; totalDiscountCents: number;
  discountedDocumentCount: number; averageDiscountPercent: number;
}
interface MaterialCost {
  rawMaterialId: string; name: string; unitOfMeasure: string; quantityOnHand: number;
  blendedAverageUnitCostCents: number;
  perSupplier: Array<{ supplierName: string; quantity: number; averageUnitCostCents: number }>;
}

export default function Reports() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [totals, setTotals] = useState<DiscountTotals | null>(null);
  const [byClient, setByClient] = useState<PerClient[]>([]);
  const [materials, setMaterials] = useState<MaterialCost[]>([]);

  useEffect(() => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api.get<{ totals: DiscountTotals; byClient: PerClient[] }>(`/api/reports/discounts?${q}`)
      .then((d) => { setTotals(d.totals); setByClient(d.byClient); })
      .catch(() => {});
  }, [from, to]);

  useEffect(() => {
    api.get<MaterialCost[]>('/api/reports/material-costs').then(setMaterials).catch(() => {});
  }, []);

  function exportCsv(name: string, rows: string[][]) {
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <h1>Reports</h1>
      <p className="subtitle">Discount figures count approved discounts only.</p>

      <div className="panel">
        <div className="row">
          <div className="field">
            <label htmlFor="f">From</label>
            <input id="f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="t">To</label>
            <input id="t" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <button className="secondary" onClick={() => exportCsv('discounts-by-client.csv', [
              ['Customer', 'Total discount', 'Documents', 'Average %'],
              ...byClient.map((r) => [
                r.customerName, (r.totalDiscountCents / 100).toFixed(2),
                String(r.discountedDocumentCount), String(r.averageDiscountPercent),
              ]),
            ])}>Export</button>
          </div>
          <div className="field">
            <button className="secondary" onClick={() => window.print()}>Print / PDF</button>
          </div>
        </div>

        {totals && (
          <div className="row" style={{ gap: 32 }}>
            <div>
              <div className="muted small">Total discounts</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{money(totals.totalDiscountCents)}</div>
            </div>
            <div>
              <div className="muted small">Discounted documents</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{totals.discountedDocumentCount}</div>
            </div>
            <div>
              <div className="muted small">Average discount</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{totals.averageDiscountPercent}%</div>
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Discounts per client</h2>
        <table>
          <thead>
            <tr>
              <th>Customer</th><th className="num">Total discounted</th>
              <th className="num">Documents</th><th className="num">Average %</th>
            </tr>
          </thead>
          <tbody>
            {byClient.map((r) => (
              <tr key={r.customerId}>
                <td>{r.customerName}</td>
                <td className="num">{money(r.totalDiscountCents)}</td>
                <td className="num">{r.discountedDocumentCount}</td>
                <td className="num">{r.averageDiscountPercent}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        {byClient.length === 0 && <p className="muted">No approved discounts in this period.</p>}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Raw material average cost</h2>
        <p className="muted small">
          A blended reporting figure across stock on hand. Production is charged the
          real FIFO cost of the batches it actually draws, which will differ.
        </p>
        <table>
          <thead>
            <tr>
              <th>Material</th><th className="num">On hand</th>
              <th className="num">Blended avg</th><th>Per supplier</th>
            </tr>
          </thead>
          <tbody>
            {materials.filter((m) => m.quantityOnHand > 0).map((m) => (
              <tr key={m.rawMaterialId}>
                <td>{m.name}</td>
                <td className="num">{m.quantityOnHand} {m.unitOfMeasure}</td>
                <td className="num">{money(m.blendedAverageUnitCostCents)}</td>
                <td className="small muted">
                  {m.perSupplier.map((s, i) => (
                    <div key={i}>{s.supplierName}: {money(s.averageUnitCostCents)} ({s.quantity})</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {materials.every((m) => m.quantityOnHand === 0) &&
          <p className="muted">No material batches in stock yet.</p>}
      </div>
    </>
  );
}
