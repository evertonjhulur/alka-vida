import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { when } from '../lib/format';
import MapView, { type LatLng } from './MapView';

/**
 * Map pins on a customer's delivery addresses (23 Oct 2026). One pin per
 * address: the main one and each extra delivery address. The driver's pin,
 * saved at the door, is the one to trust; here the office can place, move,
 * paste or remove one.
 */

interface Pin {
  address_id: string | null; label: string; address: string | null;
  lat: number | null; lng: number | null; location_accuracy_m: number | null;
  location_source: 'Driver' | 'Office' | 'Link' | 'Customer' | null; location_set_at: string | null; location_set_by: string | null;
}

function where(p: Pin): string {
  if (p.lat == null) return '';
  const who = p.location_set_by ? ` by ${p.location_set_by}` : '';
  const at = p.location_set_at ? ` · ${when(p.location_set_at)}` : '';
  const acc = p.location_accuracy_m != null ? ` · accurate to about ${p.location_accuracy_m} m` : '';
  if (p.location_source === 'Driver') return `Saved at the stop${who}${at}${acc}`;
  if (p.location_source === 'Link') return `From a pasted link${who}${at}`;
  if (p.location_source === 'Customer') return `Dropped by the customer when they signed up${at}${acc}. The driver can save the exact spot at the gate`;
  return `Placed on the map${who}${at}${acc}`;
}

function PinCard({ customerId, pin, onSaved }: { customerId: string; pin: Pin; onSaved: () => void }) {
  const [draft, setDraft] = useState<LatLng | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const shown = draft ?? (pin.lat != null && pin.lng != null ? { lat: pin.lat, lng: pin.lng } : null);

  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); setMsg(null);
    try {
      await api.put(`/api/customers/${customerId}/pin`, { addressId: pin.address_id, ...body });
      setDraft(null); setText(''); setMsg({ ok: true, text: done }); onSaved();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save the pin' }); }
    finally { setBusy(false); }
  };
  const here = () => {
    if (!navigator.geolocation) { setMsg({ ok: false, text: 'This device cannot tell where it is.' }); return; }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setBusy(false); setDraft({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      () => { setBusy(false); setMsg({ ok: false, text: 'Could not get this device\'s location. Allow location for this site and try again.' }); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  return (
    <section className="panel" aria-label={`Map pin for ${pin.label}`}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>{pin.label}</h3>
        {pin.lat != null ? <span className="chip ok">Pinned</span> : <span className="chip warn">No pin yet</span>}
      </div>
      <p style={{ margin: '4px 0 10px' }}>{pin.address || <span className="muted">No address typed</span>}</p>
      <MapView label={`Map for ${pin.label}`} pick={shown} onPick={setDraft} height={260} />
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        {draft ? 'Not saved yet. ' : ''}{draft || !shown ? 'Click the map where the truck stops, or drag the pin.' : where(pin)}
      </p>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'error'} small`} style={{ marginTop: 8 }}>{msg.text}</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {draft && <button type="button" disabled={busy} onClick={() => save({ lat: draft.lat, lng: draft.lng }, 'Pin saved.')}>Save the pin</button>}
        {draft && <button type="button" className="secondary" disabled={busy} onClick={() => setDraft(null)}>Undo</button>}
        <button type="button" className="secondary" disabled={busy} onClick={here}>Use where I am now</button>
        {pin.lat != null && !draft && (
          <a className="button-link secondary" href={`https://www.google.com/maps?q=${pin.lat},${pin.lng}`} target="_blank" rel="noopener">Open in Google Maps</a>
        )}
        {pin.lat != null && !draft && (
          <button type="button" className="danger-soft" disabled={busy} onClick={() => save({ clear: true }, 'Pin removed.')}>Remove pin</button>
        )}
      </div>
      <form className="row" style={{ gap: 8, marginTop: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}
            onSubmit={(e) => { e.preventDefault(); if (text.trim()) void save({ text }, 'Pin saved from the link.'); }}>
        <div className="field" style={{ flex: '1 1 280px', margin: 0 }}>
          <label htmlFor={`link-${pin.address_id ?? 'main'}`}>Or paste a Google Maps link or coordinates</label>
          <input id={`link-${pin.address_id ?? 'main'}`} style={{ width: '100%' }} placeholder="18.0123, -76.9456" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <button className="secondary" disabled={busy || !text.trim()}>Use it</button>
      </form>
    </section>
  );
}

export default function LocationPinsPanel({ customerId }: { customerId: string }) {
  const [pins, setPins] = useState<Pin[] | null>(null);
  const load = () => api.get<Pin[]>(`/api/customers/${customerId}/pins`).then(setPins).catch(() => setPins([]));
  useEffect(() => { void load(); }, [customerId]);
  if (!pins) return null;
  return (
    <div>
      <h2>Map pins</h2>
      <p className="muted small" style={{ marginTop: -6 }}>
        Where the truck stops for each delivery address, so rounds can be sorted. The driver can also save it at the stop - that one is the most accurate.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 18 }}>
        {pins.map((p) => <PinCard key={p.address_id ?? 'main'} customerId={customerId} pin={p} onSaved={load} />)}
      </div>
    </div>
  );
}
