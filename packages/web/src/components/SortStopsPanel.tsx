import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import MapView, { type LatLng } from './MapView';

/**
 * "Sort the stops" on a delivery round, before it starts (23 Oct 2026).
 *
 * Sorted from the plant and back: along real roads when road-map sorting is
 * switched on (openrouteservice), otherwise by straight-line distance. The
 * office sees the proposal on a map with the distance before and after, and
 * chooses to use it or keep the current order. Stops with no pin go last.
 */

interface Proposal {
  method: 'Road' | 'Straight'; note: string | null; plant: LatLng; order: string[];
  stops: Array<{ id: string; name: string; lat: number | null; lng: number | null; was: number; now: number; approximate?: boolean }>;
  currentKm: number; sortedKm: number; roadDurationS: number | null; roadDistanceM: number | null; missing: number;
  approximate?: number; approxPlaced?: number;
}

const ordinal = (n: number) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};
const hm = (s: number) => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

export default function SortStopsPanel({
  sheetId, onDone, driver = false,
}: { sheetId: string; onDone: (message: string) => void; driver?: boolean }) {
  const [settings, setSettings] = useState<{ plant: LatLng | null; roadSort: boolean } | null>(null);
  const [method, setMethod] = useState<'Road' | 'Straight'>('Road');
  const [p, setP] = useState<Proposal | null>(null);
  const [usual, setUsual] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ plant: LatLng | null; roadSort: boolean }>('/api/settings/routing')
      .then((s) => { setSettings(s); if (!s.roadSort) setMethod('Straight'); })
      .catch(() => setSettings({ plant: null, roadSort: false }));
  }, []);

  const sort = async () => {
    setBusy(true); setError(null);
    try { setP(await api.post<Proposal>(`/api/delivery-sheets/${sheetId}/sort`, { method })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not sort the stops'); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!p) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/delivery-sheets/${sheetId}/sort/apply`, { order: p.order, saveAsUsual: !driver && usual });
      setP(null);
      onDone(`Stops sorted${p.method === 'Road' ? ' by road' : ' by straight-line distance'}.${!driver && usual ? ' This is now the usual order for these customers.' : ''}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the order'); }
    finally { setBusy(false); }
  };

  const points = useMemo(() => (p ? p.stops.filter((s) => s.lat != null && s.lng != null)
    .map((s) => ({ lat: s.lat as number, lng: s.lng as number, n: s.now, label: s.name, approximate: !!s.approximate })) : []), [p]);

  if (!settings) return null;
  if (!settings.plant) {
    return (
      <div className="notice info">
        To sort stops, first set where the plant is: <Link to="/zones">Settings › Delivery zones</Link>. Rounds start and finish there.
      </div>
    );
  }

  return (
    <section className="panel" aria-labelledby="sort-h">
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <h2 id="sort-h" style={{ margin: 0, fontSize: 17, flex: '1 1 200px' }}>Sort the stops</h2>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="sort-how">Sort with</label>
          <select id="sort-how" value={method} onChange={(e) => setMethod(e.target.value as 'Road' | 'Straight')}>
            <option value="Road" disabled={!settings.roadSort}>Road map (needs internet){settings.roadSort ? '' : ' - not switched on'}</option>
            <option value="Straight">Straight-line distance (no internet needed)</option>
          </select>
        </div>
        <button type="button" disabled={busy} onClick={sort}>{busy && !p ? 'Sorting…' : p ? 'Sort again' : 'Sort'}</button>
      </div>
      <p className="muted small" style={{ margin: '6px 0 0' }}>From the plant and back. Stops with no map pin go last.</p>
      {error && <div className="notice error" style={{ marginTop: 10 }}>{error}</div>}

      {p && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 14, alignItems: 'flex-start' }}>
          <div style={{ flex: '3 1 420px', minWidth: 0 }}>
            <MapView label="The sorted round on a map" points={points} plant={p.plant} line height={380} />
          </div>
          <div style={{ flex: '2 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {p.note && <div className="notice info small" style={{ margin: 0 }}>{p.note}</div>}
            {(p.approximate ?? 0) > 0 && (
              <div className="notice info small" style={{ margin: 0 }}>
                {p.approxPlaced ? `${p.approxPlaced === 1 ? '1 stop had' : `${p.approxPlaced} stops had`} no pin, so Google placed ${p.approxPlaced === 1 ? 'it' : 'them'} from the typed address. ` : ''}
                {p.approximate === 1 ? '1 stop is' : `${p.approximate} stops are`} placed only approximately (paler on the map). The driver saves the exact spot at the gate.
              </div>
            )}
            {p.missing > 0 && (
              <div className="notice warn small" style={{ margin: 0 }}>
                {p.missing === 1 ? '1 stop has' : `${p.missing} stops have`} no map pin, so {p.missing === 1 ? 'it goes' : 'they go'} last.
                The driver can save the location at the stop, or pin it on the customer's Addresses.
              </div>
            )}
            <div className="stat-row" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
              <div className="stat"><div className="stat-label">Now</div><div className="stat-value">{p.currentKm} km</div><div className="stat-note">straight line</div></div>
              <div className="stat"><div className="stat-label">Sorted</div><div className="stat-value">{p.sortedKm} km</div>
                <div className="stat-note">{p.method === 'Road' && p.roadDurationS ? `about ${hm(p.roadDurationS)} driving${p.roadDistanceM ? `, ${Math.round(p.roadDistanceM / 100) / 10} km by road` : ''}` : 'straight line'}</div></div>
            </div>
            <ol className="sort-list" style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--line)', borderRadius: 8 }}>
              {p.stops.map((s) => (
                <li key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 12px', borderBottom: '1px solid #eef1f4' }}>
                  <span className="stop-no">{s.now}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{s.name}</strong>
                    <div className="muted small">{s.lat == null ? 'no map pin' : s.was === s.now ? 'same place' : `was ${ordinal(s.was)}`}{s.approximate ? ' · approximate location' : ''}</div>
                  </span>
                </li>
              ))}
            </ol>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" disabled={busy} onClick={apply}>Use the sorted order</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setP(null)}>Keep the current order</button>
            </div>
            {!driver && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, color: 'var(--ink)', fontSize: 14 }}>
                <input type="checkbox" checked={usual} onChange={(e) => setUsual(e.target.checked)} /> Also make it these customers' usual order
              </label>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
