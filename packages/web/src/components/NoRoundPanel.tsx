/**
 * Delivery orders with no round, and sign-ups with no zone (Everton,
 * 25 Nov 2026): "an alert is created the moment a delivery order has no
 * round ... subtle alert next to delivery rounds and on the number changed
 * on the panel in today. This would automatically change once the orders
 * are assigned."
 *
 * Shown on Today (everything) and on Delivery rounds (the day being
 * planned). Nothing to show, nothing drawn. Each row can be fixed where it
 * is: put on its round (a zone picked if it has none, a new day if its date
 * has passed), or a zone set for a customer who signed up "Not sure".
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { day as dayText, todayInJamaica } from '../lib/format';

interface NoRoundOrder {
  id: string; orderNumber: string; customerId: string; customerName: string;
  day: string | null; zone: string | null; reason: string;
  kind: 'no-zone' | 'off-round' | 'missed' | 'rest' | 'not-placed'; late: boolean;
}
interface NoZoneCustomer { id: string; name: string; phone: string | null; address: string | null; signedUpAt: string }
interface NoRound { orders: NoRoundOrder[]; customers: NoZoneCustomer[]; count: number }
interface Zone { name: string; retired_at?: string | null; run_days?: string[] }

const addDay = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export default function NoRoundPanel({ forDay, onChange }: {
  /** Only orders for this day (the Delivery rounds page); no sign-ups. */
  forDay?: string | null;
  /** Something was put on a round: the page around it may want to reload. */
  onChange?: () => void;
}) {
  const [data, setData] = useState<NoRound | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [zoneFor, setZoneFor] = useState<Record<string, string>>({});
  const [dateFor, setDateFor] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.get<NoRound>('/api/no-round').then(setData).catch(() => {});
  useEffect(() => {
    void load();
    api.get<Zone[]>('/api/zones').then((z) => setZones(z.filter((x) => !x.retired_at))).catch(() => {});
    // Kept up to date while the page is open, like the menu badge.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    // And as soon as the window is looked at again.
    const back = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', back);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', back); };
  }, []);

  if (!data) return null;
  const today = todayInJamaica();
  const orders = forDay ? data.orders.filter((o) => o.day === forDay) : data.orders;
  // A customer whose order already says "No delivery zone" is fixed from the order.
  const noZoneOrderCustomers = new Set(data.orders.filter((o) => o.kind === 'no-zone').map((o) => o.customerId));
  const customers = forDay ? [] : data.customers.filter((c) => !noZoneOrderCustomers.has(c.id));
  if (orders.length === 0 && customers.length === 0) {
    return note ? <div className={`notice ${note.ok ? 'ok' : 'error'}`}>{note.text}</div> : null;
  }

  async function act(key: string, run: () => Promise<string>) {
    setBusy(key); setNote(null);
    try {
      setNote({ ok: true, text: await run() });
      await load();
      onChange?.();
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'That did not work' });
    } finally { setBusy(null); }
  }

  const putOn = (o: NoRoundOrder) => act(o.id, async () => {
    const r = await api.post<{ orderNumber: string; zone: string; day: string }>(
      `/api/orders/${o.id}/put-on-round`, {
        zone: o.kind === 'no-zone' ? zoneFor[o.id] || null : null,
        date: o.late || !o.day ? dateFor[o.id] || null : null,
      });
    return `${r.orderNumber} is on the ${r.zone} round for ${dayText(r.day)}.`;
  });

  const setZone = (c: NoZoneCustomer) => act(c.id, async () => {
    const r = await api.post<{ placed: string[]; emailed: boolean }>(`/api/customers/${c.id}/zone`, { zone: zoneFor[c.id] });
    return [`${c.name} is in ${zoneFor[c.id]}.`,
      r.placed.length ? `${r.placed.join(', ')} put on the round.` : '',
      r.emailed ? 'They were emailed their delivery day.' : ''].filter(Boolean).join(' ');
  });

  const zonePick = (key: string) => (
    <select aria-label="Delivery zone" value={zoneFor[key] ?? ''} style={{ maxWidth: 180 }}
            onChange={(e) => setZoneFor({ ...zoneFor, [key]: e.target.value })}>
      <option value="">Pick a zone…</option>
      {zones.map((z) => (
        <option key={z.name} value={z.name}>{z.name}{z.run_days?.length ? ` (${z.run_days.join(', ')})` : ''}</option>
      ))}
    </select>
  );

  const total = orders.length + customers.length;
  return (
    <div className="panel no-round">
      <div className="panel-head">
        <h2 style={{ margin: 0 }}>
          {forDay ? `Orders for ${dayText(forDay)} not on a round` : 'Deliveries with no round'}{' '}
          <span className="chip warn">{total}</span>
        </h2>
        {!forDay && <Link to="/orders?round=none">See them on Orders</Link>}
      </div>
      {note && <div className={`notice ${note.ok ? 'ok' : 'error'}`}>{note.text}</div>}
      <ul className="todo">
        {orders.map((o) => {
          const needsZone = o.kind === 'no-zone';
          const needsDay = o.late || !o.day;
          const ready = (!needsZone || !!zoneFor[o.id]) && (!needsDay || !!dateFor[o.id]);
          return (
            <li key={o.id}>
              <span>
                <Link to={`/orders?find=${encodeURIComponent(o.orderNumber)}`}><strong>{o.orderNumber}</strong></Link>
                {' · '}<Link to={`/customers/${o.customerId}`}>{o.customerName}</Link>
                {o.day && (
                  <span className={o.late ? 'bad-text' : 'muted'}>{' · '}for {dayText(o.day)}{o.late ? ' (passed)' : ''}</span>
                )}
                <div className="muted small">{o.reason}</div>
              </span>
              <span className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {needsZone && zonePick(o.id)}
                {needsDay && (
                  <input type="date" aria-label={`New day for ${o.orderNumber}`} min={today}
                         value={dateFor[o.id] ?? ''} onChange={(e) => setDateFor({ ...dateFor, [o.id]: e.target.value })} />
                )}
                <button type="button" className="approve-soft" disabled={busy !== null || !ready}
                        title={!ready ? (needsZone ? 'Pick a zone first' : 'Pick a new day first') : undefined}
                        onClick={() => putOn(o)}>
                  {busy === o.id ? 'Placing…' : 'Put on its round'}
                </button>
              </span>
            </li>
          );
        })}
        {customers.map((c) => (
          <li key={c.id}>
            <span>
              <Link to={`/customers/${c.id}`}><strong>{c.name}</strong></Link>
              <div className="muted small">
                Signed up not sure of their zone{c.address ? ` · ${c.address}` : ''}{c.phone ? ` · ${c.phone}` : ''}
              </div>
            </span>
            <span className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {zonePick(c.id)}
              <button type="button" className="approve-soft" disabled={busy !== null || !zoneFor[c.id]}
                      onClick={() => setZone(c)}>
                {busy === c.id ? 'Saving…' : 'Set their zone'}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {orders.some((o) => o.late || !o.day) && (
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          An order whose day has passed needs a new day; tomorrow is {dayText(addDay(today, 1))}.
        </p>
      )}
    </div>
  );
}
