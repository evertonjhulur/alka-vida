import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * "Save this location" on the driver's stop (23 Oct 2026).
 *
 * The phone's GPS works without signal, so a pin taken with no signal is
 * kept on the phone and sent as soon as it can be (on the next screen that
 * loads, or when the phone comes back online). Only pins are kept this way
 * for now; the rest of the stop still needs signal.
 */

interface Waiting { stopId: string; lat: number; lng: number; accuracyM: number; at: string }
const KEY = 'alkavida.pendingPins';

function readWaiting(): Waiting[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Waiting[]; } catch { return []; }
}
function writeWaiting(list: Waiting[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

/** Send any pins taken with no signal. Safe to call often. */
export async function sendWaitingPins(): Promise<number> {
  const list = readWaiting();
  if (!list.length || !navigator.onLine) return list.length;
  const left: Waiting[] = [];
  for (const w of list) {
    try { await api.post(`/api/stops/${w.stopId}/location`, { lat: w.lat, lng: w.lng, accuracyM: w.accuracyM }); }
    catch (e) {
      // A refusal (not on their round any more, a bad fix) will never succeed: drop it.
      // No connection: keep it for later.
      if (e instanceof Error && /reach Alka Vida|not answering/i.test(e.message)) left.push(w);
    }
  }
  writeWaiting(left);
  return left.length;
}
if (typeof window !== 'undefined') window.addEventListener('online', () => { void sendWaitingPins(); });

export default function StopLocation({
  stopId, pinned, source, onSaved,
}: { stopId: string; pinned: boolean; source?: string | null; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [again, setAgain] = useState(false);
  const waiting = readWaiting().some((w) => w.stopId === stopId);

  useEffect(() => { void sendWaitingPins(); }, []);

  const save = () => {
    if (!navigator.geolocation) { setMsg({ tone: 'error', text: 'This phone cannot tell where it is.' }); return; }
    setBusy(true); setMsg(null);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const w: Waiting = { stopId, lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracyM: Math.round(pos.coords.accuracy), at: new Date().toISOString() };
      try {
        await api.post(`/api/stops/${stopId}/location`, { lat: w.lat, lng: w.lng, accuracyM: w.accuracyM });
        setMsg({ tone: 'ok', text: `Location saved, accurate to about ${w.accuracyM} m.` });
        setAgain(false); onSaved();
      } catch (e) {
        const m = e instanceof Error ? e.message : '';
        if (/reach Alka Vida|not answering/i.test(m)) {
          writeWaiting([...readWaiting().filter((x) => x.stopId !== stopId), w]);
          setMsg({ tone: 'warn', text: `Location kept on this phone (about ${w.accuracyM} m). It is sent when the signal comes back.` });
        } else setMsg({ tone: 'error', text: m || 'Could not save the location' });
      } finally { setBusy(false); }
    }, () => {
      setBusy(false);
      setMsg({ tone: 'error', text: 'The phone could not get its location. Allow location for Alka Vida, step outside and try again.' });
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  };

  // The customer dropped this pin when they signed up: good enough to sort
  // by, but the driver at the gate knows the exact spot (23 Oct 2026).
  const fromCustomer = pinned && source === 'Customer';
  if (pinned && !fromCustomer && !again && !msg) {
    return (
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        Location saved for this address. <button type="button" className="as-link" onClick={() => setAgain(true)}>Wrong spot? Save it again</button>
      </p>
    );
  }
  return (
    <div className="stop-location" style={{ marginTop: 10, padding: 12, borderRadius: 8, background: '#f2fafc', border: '1px solid var(--line)' }}>
      {!pinned && !msg && !waiting && <p style={{ margin: '0 0 8px' }}><strong>No location saved for this customer yet.</strong> Stand at their gate or door, then tap the button. It works without signal.</p>}
      {fromCustomer && !msg && !waiting && <p style={{ margin: '0 0 8px' }}><strong>The customer dropped this pin when they signed up.</strong> Standing at their gate? Save the exact spot for next time.</p>}
      {waiting && !msg && <p className="small" style={{ margin: '0 0 8px', color: 'var(--warn)' }}>A location for this stop is waiting on this phone to be sent.</p>}
      {msg && <div className={`notice ${msg.tone}`} style={{ margin: '0 0 8px' }}>{msg.text}</div>}
      {(!msg || msg.tone === 'error') && (
        <button type="button" className="wide big" disabled={busy} onClick={save}>{busy ? 'Finding where you are…' : 'Save this location'}</button>
      )}
    </div>
  );
}
