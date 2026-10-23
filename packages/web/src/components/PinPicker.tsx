import { useState } from 'react';
import MapView, { type LatLng } from './MapView';

/**
 * "Help our driver find you" on the Open an account form and the website's
 * quick order (23 Oct 2026). Optional: use the phone's location while at the
 * delivery address, or click the map / drag the pin. The office sees it as
 * the customer's pin; the driver saves the exact spot on the first delivery.
 */
export interface DroppedPin extends LatLng { accuracyM: number | null }

export default function PinPicker({
  value, onChange, className,
}: { value: DroppedPin | null; onChange: (p: DroppedPin | null) => void; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);

  const here = () => {
    if (!navigator.geolocation) { setProblem('This device cannot tell where it is. Use the map instead.'); setShowMap(true); return; }
    setBusy(true); setProblem(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false); setShowMap(true);
        onChange({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy) });
      },
      () => { setBusy(false); setShowMap(true); setProblem('Could not get your location. Allow location for this site, or click the map instead.'); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  };

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <strong>Help our driver find you</strong> <span className="muted small">(optional)</span>
        <p className="muted small" style={{ margin: '2px 0 0' }}>
          If you are at the delivery address now, use your location. Otherwise, find the spot on the map and click it.
        </p>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="secondary pin-btn" disabled={busy} onClick={here}>
          {busy ? 'Finding where you are…' : 'I\'m there now: use my location'}
        </button>
        {!showMap && !value && <button type="button" className="secondary pin-btn" onClick={() => setShowMap(true)}>Pick the spot on a map</button>}
        {value && <button type="button" className="secondary pin-btn" onClick={() => onChange(null)}>Remove the pin</button>}
      </div>
      {problem && <p className="small" style={{ margin: 0, color: 'var(--bad)' }}>{problem}</p>}
      {(showMap || value) && (
        <>
          <MapView label="Pick your delivery spot" pick={value} height={260}
                   onPick={(p) => onChange({ ...p, accuracyM: null })} />
          <p className="small" style={{ margin: 0 }}>
            {value
              ? <>Pin dropped{value.accuracyM != null ? `, accurate to about ${value.accuracyM} m` : ''}. Drag it if it is not quite right.</>
              : <span className="muted">Click the map where our truck should stop.</span>}
          </p>
        </>
      )}
    </div>
  );
}
