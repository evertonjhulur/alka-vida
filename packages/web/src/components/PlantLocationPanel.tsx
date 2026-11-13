import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { downloadCsv } from '../lib/csv';
import MapView, { type LatLng } from './MapView';
import PlaceSearch from './PlaceSearch';

/**
 * Where the plant is (23 Oct 2026): every round is sorted from here and
 * back. Set once by an administrator - click the map, drag the pin, use this
 * device's location while at the plant, or paste a Google Maps link.
 * Also says whether road-map sorting is switched on.
 */
interface MissingPin {
  customerId: string; customer: string; address: string; kind: 'main' | 'extra';
  text: string | null; zone: string | null; phone: string | null; why: 'no-address' | 'not-found' | 'not-tried';
}
const WHY: Record<MissingPin['why'], string> = {
  'not-found': 'Google could not place it', 'no-address': 'No address typed', 'not-tried': 'Not looked up yet',
};

/**
 * The addresses still without a pin, and why (13 Nov 2026). These still go
 * last when a round is sorted: fix the address on the customer, place the
 * pin by hand, or the driver saves it at the gate.
 */
function MissingPins({ refresh }: { refresh: number }) {
  const [rows, setRows] = useState<MissingPin[] | null>(null);
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState<'all' | MissingPin['why']>('not-found');
  useEffect(() => { if (open) api.get<MissingPin[]>('/api/settings/approximate-pins/missing').then(setRows).catch(() => setRows([])); }, [open, refresh]);
  const list = (rows ?? []).filter((r) => show === 'all' || r.why === show);
  const count = (w: MissingPin['why']) => (rows ?? []).filter((r) => r.why === w).length;
  const exportIt = () => downloadCsv('alka-vida-addresses-without-a-pin.csv', [
    ['Customer', 'Address', 'As typed', 'Zone', 'Phone', 'Why'],
    ...list.map((r) => [r.customer, r.address, r.text ?? '', r.zone ?? '', r.phone ?? '', WHY[r.why]]),
  ]);
  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" className="as-link small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} the addresses without a pin
      </button>
      {open && rows === null && <p className="muted small">Loading…</p>}
      {open && rows && (
        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <div className="pills" role="group" aria-label="Which" style={{ margin: 0 }}>
              {([['not-found', `Could not be placed (${count('not-found')})`], ['no-address', `No address (${count('no-address')})`],
                ['not-tried', `Not looked up yet (${count('not-tried')})`], ['all', `All (${rows.length})`]] as const).map(([k, label]) => (
                <button key={k} type="button" className={`pill${show === k ? ' active' : ''}`} aria-pressed={show === k} onClick={() => setShow(k)}>{label}</button>
              ))}
            </div>
            <button type="button" className="secondary small" disabled={list.length === 0} onClick={exportIt}>Export to Excel</button>
          </div>
          <p className="muted small" style={{ margin: '0 0 6px' }}>
            These still go to the end when a round is sorted. Open the customer to correct the address (it is looked up again) or place
            the pin on the map; or the driver taps "Save this location" at the gate.
          </p>
          {list.length === 0 ? <p className="muted small">None.</p> : (
            <div className="table-scroll">
              <table className="report-table phone-cards">
                <thead><tr><th>Customer</th><th>Address</th><th>As typed</th><th>Zone</th><th>Why</th></tr></thead>
                <tbody>
                  {list.map((r, i) => (
                    <tr key={`${r.customerId}-${r.address}-${i}`}>
                      <td data-label="Customer"><Link to={`/customers/${r.customerId}`}>{r.customer}</Link></td>
                      <td data-label="Address">{r.address}</td>
                      <td data-label="As typed" className="small">{r.text ?? <span className="muted">—</span>}</td>
                      <td data-label="Zone">{r.zone ?? '—'}</td>
                      <td data-label="Why" className="small">{WHY[r.why]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Rough pins for every customer with none, from their typed address
 * (31 Oct 2026). Rounds do this for their own stops when sorted; this does
 * everyone, up to 100 a click, within the daily allowance.
 */
function ApproximatePins() {
  const [c, setC] = useState<{ noPin: number; approximate: number; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const load = () => api.get<{ noPin: number; approximate: number; enabled: boolean }>('/api/settings/approximate-pins').then(setC).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!c || !c.enabled) return null;
  const go = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post<{ placed: number; notFound: number; left: number; stopped: string | null }>('/api/settings/approximate-pins', { max: 100 });
      const parts = [
        `${r.placed} placed`,
        r.notFound ? `${r.notFound} could not be found from the address (pin those by hand, or the driver saves them)` : '',
        r.left ? `${r.left} still to do - click again` : '',
      ].filter(Boolean).join('; ');
      setMsg({ ok: !r.stopped, text: `${parts}.${r.stopped ? ` ${r.stopped}` : ''}` });
      await load(); setRefresh((n) => n + 1);
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not do that' }); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Pins from the typed address</h3>
      <p className="muted small" style={{ margin: '0 0 8px' }}>
        {c.noPin} delivery address{c.noPin === 1 ? ' has' : 'es have'} no pin; {c.approximate} {c.approximate === 1 ? 'is' : 'are'} placed approximately.
        Google can place the rest roughly from the typed address, so rounds sort properly. The driver's "Save this location" at the gate replaces a rough pin. Each address is looked up once.
      </p>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'warn'} small`} style={{ margin: '0 0 8px' }}>{msg.text}</div>}
      <button type="button" className="secondary" disabled={busy || c.noPin === 0} onClick={go}>
        {busy ? 'Looking up addresses…' : 'Find approximate pins'}
      </button>
      {c.noPin > 0 && <MissingPins refresh={refresh} />}
    </div>
  );
}

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
      {isAdmin && (
        <div style={{ marginBottom: 10 }}>
          <PlaceSearch id="plant-find" label="Search for the plant's address" placeholder="e.g. FCJ Complex, White Marl"
                       onPick={(p) => { setMsg(null); setDraft({ lat: p.lat, lng: p.lng }); }} />
        </div>
      )}
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
          <ApproximatePins />
        </>
      )}
    </section>
  );
}
