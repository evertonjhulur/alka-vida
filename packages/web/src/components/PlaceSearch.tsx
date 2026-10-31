import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/**
 * Address suggestions as you type, like Google Maps (31 Oct 2026).
 *
 * Type 3+ letters of a street, community, business or landmark; pick one and
 * onPick gets its map position (and Google's best guess at the address). Shows
 * nothing at all until GOOGLE_MAPS_API_KEY is set on the server, so every
 * screen still works without it. The key stays on the server.
 */

export interface PickedPlace {
  lat: number; lng: number; address: string; line1: string; town: string; parish: string;
}
interface Suggestion { id: string; main: string; secondary: string }

let enabledOnce: Promise<boolean> | null = null;
function placesOn(): Promise<boolean> {
  enabledOnce ??= api.get<{ enabled: boolean }>('/api/public/places/config')
    .then((r) => r.enabled).catch(() => false);
  return enabledOnce;
}
const newSession = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`.replace(/\D/g, '')).replace(/[^A-Za-z0-9-]/g, '');

export default function PlaceSearch({
  id, label = 'Search for the address or a place nearby', onPick, placeholder,
}: { id: string; label?: string; onPick: (p: PickedPlace) => void; placeholder?: string }) {
  const [on, setOn] = useState(false);
  const [text, setText] = useState('');
  const [list, setList] = useState<Suggestion[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const session = useRef(newSession());
  const asked = useRef(0);
  /** The words of the place just picked: not searched for again. */
  const chosen = useRef('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { void placesOn().then(setOn); }, []);

  // Ask after a pause in typing, so Google is not asked on every key.
  useEffect(() => {
    const q = text.trim();
    if (!on || q.length < 3 || q === chosen.current) { setList([]); setNote(null); return; }
    const n = ++asked.current;
    const t = setTimeout(() => {
      api.get<{ suggestions: Suggestion[]; note: string | null }>(
        `/api/public/places/suggest?q=${encodeURIComponent(q)}&session=${session.current}`)
        .then((r) => { if (n === asked.current) { setList(r.suggestions); setNote(r.note); setActive(0); setOpen(true); } })
        .catch((e) => { if (n === asked.current) { setList([]); setNote(e instanceof Error ? e.message : 'Suggestions are not working just now.'); setOpen(true); } });
    }, 350);
    return () => clearTimeout(t);
  }, [text, on]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = async (s: Suggestion) => {
    setBusy(true); setOpen(false); setNote(null);
    try {
      const p = await api.get<PickedPlace>(`/api/public/places/lookup?id=${encodeURIComponent(s.id)}&session=${session.current}`);
      const words = [s.main, s.secondary].filter(Boolean).join(', ');
      chosen.current = words;
      setText(words);
      onPick(p);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'That place could not be looked up.'); setOpen(true);
    } finally {
      // A pick ends Google's session; the next search starts a new one.
      session.current = newSession();
      setBusy(false);
    }
  };

  if (!on) return null;
  return (
    <div className="field place-search" style={{ margin: 0 }}>
      <label htmlFor={id}>{label}</label>
      <div className="combo" ref={box} style={{ maxWidth: 'none' }}>
        <input id={id} role="combobox" autoComplete="off" aria-autocomplete="list"
               aria-expanded={open && list.length > 0} aria-controls={`${id}-list`}
               aria-activedescendant={open && list[active] ? `${id}-opt-${active}` : undefined}
               placeholder={placeholder ?? 'e.g. 12 Hope Road, or Sovereign Centre'}
               value={text} disabled={busy}
               onFocus={() => { if (list.length || note) setOpen(true); }}
               onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => {
                 if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, list.length - 1)); }
                 if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                 if (e.key === 'Enter') { e.preventDefault(); if (open && list[active]) void pick(list[active]); }
                 if (e.key === 'Escape') setOpen(false);
               }} />
        {open && text.trim().length >= 3 && text.trim() !== chosen.current && (
          <div id={`${id}-list`} className="deskbar-pop combo-list" role="listbox" style={{ maxWidth: 'none' }}>
            {list.map((s, i) => (
              <button key={s.id} id={`${id}-opt-${i}`} type="button" role="option" aria-selected={i === active}
                      className="pop-item pop-button" style={i === active ? { background: '#f2fafc' } : undefined}
                      onMouseEnter={() => setActive(i)} onClick={() => void pick(s)}>
                <span>{s.main}</span>
                {s.secondary && <span className="pop-meta">{s.secondary}</span>}
              </button>
            ))}
            {list.length === 0 && note && <div className="pop-empty">{note}</div>}
            {list.length === 0 && !note && <div className="pop-empty">Nothing found. Try a street, community or business nearby.</div>}
            {list.length > 0 && <div className="pop-empty" style={{ fontSize: 11 }}>Powered by Google</div>}
          </div>
        )}
      </div>
      {busy && <span className="small muted">Finding it on the map…</span>}
    </div>
  );
}
