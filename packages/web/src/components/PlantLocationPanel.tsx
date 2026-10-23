import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import MapView, { type LatLng } from './MapView';

/**
 * Where the plant is (23 Oct 2026): every round is sorted from here and
 * back. Set once by an administrator - click the map, drag the pin, use this
 * device's location while at the plant, or paste a Google Maps link.
 * Also says whether road-map sorting is switched on.
 */
export default function PlantLocationPanel({ isAdmin }: { isAdmin: boolean }) {
  const [plant, setPlant] = useState<LatLng | null>(null);
  const [road, setRoad] = useState(false);
  const [draft, setDraft] = useState<LatLng | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.get<{ plant: LatLng | null; roadSort: boolean }>('/api/settings/routing')
    .then((s) => { setPlant(s.plant); setRoad(s.roadSort); }).catch(() => {});
  useEffect(() => { void load(); }, []);

  const save = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try { await api.put('/api/settings/plant-location', body); setDraft(null); setText(''); setMsg({ ok: true, text: 'Plant location saved.' }); await load(); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save' }); }
    finally { setBusy(false); }
  };
  const here = () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => setDraft({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setMsg({ ok: false, text: 'Could not get this device\'s location.' }),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  const shown = draft ?? plant;

  return (
    <section className="panel" aria-labelledby="plant-h">
      <h2 id="plant-h" style={{ marginTop: 0 }}>The plant, where rounds start and finish</h2>
      <p className="muted small" style={{ marginTop: -6 }}>
        Used to sort each round's stops. {road
          ? 'Road-map sorting is on.'
          : 'Road-map sorting is off, so stops are sorted by straight-line distance. To sort along real roads, add an openrouteservice key (ORS_API_KEY) - see "Alka Vida settings.example.txt".'}
      </p>
      <MapView label="The plant on a map" pick={shown} onPick={isAdmin ? setDraft : undefined} plant={isAdmin ? null : shown} height={260} />
      {!shown && <p className="small" style={{ color: 'var(--warn)' }}>Not set yet.{isAdmin ? ' Click the map at the plant, or use the buttons below.' : ' An administrator sets it.'}</p>}
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'error'} small`} style={{ marginTop: 8 }}>{msg.text}</div>}
      {isAdmin && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {draft && <button type="button" disabled={busy} onClick={() => save({ lat: draft.lat, lng: draft.lng })}>Save the plant's location</button>}
            {draft && <button type="button" className="secondary" onClick={() => setDraft(null)}>Undo</button>}
            <button type="button" className="secondary" onClick={here}>Use where I am now (at the plant)</button>
          </div>
          <form className="row" style={{ gap: 8, marginTop: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}
                onSubmit={(e) => { e.preventDefault(); if (text.trim()) void save({ text }); }}>
            <div className="field" style={{ flex: '1 1 280px', margin: 0 }}>
              <label htmlFor="plant-link">Or paste a Google Maps link or coordinates</label>
              <input id="plant-link" style={{ width: '100%' }} placeholder="18.0123, -76.9456" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            <button className="secondary" disabled={busy || !text.trim()}>Use it</button>
          </form>
        </>
      )}
    </section>
  );
}
