import { useEffect, useState } from 'react';
import { api, type Session } from '../lib/api';
import { ask } from '../components/Dialog';

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Tap the days a round runs. A plain function, never a nested component. */
function dayPicker(days: string[], onChange: (d: string[]) => void, label: string) {
  return (
    <div className="day-picks" role="group" aria-label={label}>
      {WEEK.map((d) => (
        <button key={d} type="button" aria-pressed={days.includes(d)}
                className={`day-pick${days.includes(d) ? ' on' : ''}`}
                onClick={() => onChange(days.includes(d) ? days.filter((x) => x !== d)
                  : WEEK.filter((x) => x === d || days.includes(x)))}>{d}</button>
      ))}
    </div>
  );
}

interface Zone {
  id: string; name: string; covers: string | null;
  retired_at: string | null; sort_order: number; customer_count: number;
  run_days: string[] | null;
}

/**
 * Delivery zones — the rounds deliveries are grouped into.
 *
 * The zone decides which delivery sheet an order lands on, so two spellings
 * of one round is not a cosmetic problem: it is two half-empty trucks. Making
 * it a managed list is also what automatic zone assignment will eventually
 * assign TO — the "covers" note is where that starts.
 */
export default function Zones({ session }: { session: Session }) {
  const [zones, setZones] = useState<Zone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [nw, setNw] = useState<{ name: string; covers: string; runDays: string[] }>({ name: '', covers: '', runDays: [] });

  const [editFor, setEditFor] = useState<string | null>(null);
  const [ed, setEd] = useState<{ name: string; covers: string; runDays: string[] }>({ name: '', covers: '', runDays: [] });

  const isAdmin = session.role === 'admin';

  async function load() { setZones(await api.get<Zone[]>('/api/zones')); }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function run(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { await what(); await load(); } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally { setBusy(false); }
  }

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api.post('/api/zones', nw);
      setMsg(`${nw.name} added.`);
      setNw({ name: '', covers: '', runDays: [] });
      setShowNew(false);
    }, 'Could not add the zone');
  };

  const save = (z: Zone) => run(async () => {
    await api.patch(`/api/zones/${z.id}`, ed);
    setMsg(ed.name !== z.name
      ? `Renamed to ${ed.name}. Every customer and round on it moved with it.`
      : `${ed.name} saved.`);
    setEditFor(null);
  }, 'Could not save the zone');

  const remove = async (z: Zone) => {
    if (!await ask(
      z.customer_count > 0
        ? `${z.name} has ${z.customer_count} customer(s) on it.\n\n`
          + 'It will be retired rather than deleted: it stops being offered for new '
          + 'customers, and everyone already on it stays exactly where they are.'
        : `Delete ${z.name}? Nobody is on this round.`,
      { confirmLabel: z.customer_count > 0 ? 'Retire it' : 'Delete', danger: true },
    )) return;
    return run(async () => {
      const r = await api.del<{ deleted: boolean; name: string; customerCount: number }>(
        `/api/zones/${z.id}`,
      );
      setMsg(r.deleted
        ? `${r.name} deleted.`
        : `${r.name} retired — ${r.customerCount} customer(s) stay on it.`);
    }, 'Could not remove the zone');
  };

  const restore = (z: Zone) => run(async () => {
    await api.post(`/api/zones/${z.id}/restore`, {});
    setMsg(`${z.name} is back in use.`);
  }, 'Could not restore the zone');

  const live = zones.filter((z) => !z.retired_at);
  const retired = zones.filter((z) => z.retired_at);

  return (
    <>
      <h1>Delivery zones</h1>
      <p className="subtitle">
        The rounds deliveries are grouped into, and the days each one runs. An order goes
        on the round for its customer&rsquo;s zone and date; New order suggests the next day
        the round runs.
      </p>

      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginTop: 0 }}>In use</h2>
          <button className="secondary" onClick={() => setShowNew(!showNew)}>
            {showNew ? 'Cancel' : 'Add a zone'}
          </button>
        </div>

        {showNew && (
          <form onSubmit={create} style={{ marginBottom: 14 }}>
            <div className="row">
              <div className="field">
                <label htmlFor="zn">Name</label>
                <input id="zn" required value={nw.name}
                       placeholder="e.g. Kingston"
                       onChange={(e) => setNw({ ...nw, name: e.target.value })} />
              </div>
              <div className="field" style={{ flex: '1 1 320px' }}>
                <label htmlFor="zc">Which areas does it cover?</label>
                <input id="zc" style={{ width: '100%' }} value={nw.covers}
                       placeholder="e.g. Kingston and St Andrew"
                       onChange={(e) => setNw({ ...nw, covers: e.target.value })} />
              </div>
              <div className="field">
                <span className="label">Days it runs</span>
                {dayPicker(nw.runDays, (d) => setNw({ ...nw, runDays: d }), 'Days it runs')}
              </div>
              <div className="field">
                <button disabled={busy || !nw.name.trim()}>Add</button>
              </div>
            </div>
          </form>
        )}

        <table>
          <thead>
            <tr>
              <th>Zone</th><th>Runs on</th><th>Covers</th><th className="num">Customers</th><th />
            </tr>
          </thead>
          <tbody>
            {live.map((z) => (
              editFor === z.id ? (
                <tr key={z.id}>
                  <td>
                    <input value={ed.name}
                           onChange={(e) => setEd({ ...ed, name: e.target.value })} />
                  </td>
                  <td>{dayPicker(ed.runDays, (d) => setEd({ ...ed, runDays: d }), `Days ${z.name} runs`)}</td>
                  <td>
                    <input style={{ width: '100%' }} value={ed.covers}
                           onChange={(e) => setEd({ ...ed, covers: e.target.value })} />
                  </td>
                  <td className="num">{z.customer_count}</td>
                  <td className="num">
                    <button disabled={busy || !ed.name.trim()} onClick={() => save(z)}>
                      Save
                    </button>{' '}
                    <button className="secondary" onClick={() => setEditFor(null)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={z.id}>
                  <td><strong>{z.name}</strong></td>
                  <td>{z.run_days?.length ? z.run_days.join(', ')
                    : <span className="chip warn">any day</span>}</td>
                  <td className="small muted">{z.covers ?? '—'}</td>
                  <td className="num">{z.customer_count}</td>
                  <td className="num">
                    <button className="secondary" disabled={busy}
                            onClick={() => {
                              setEditFor(z.id);
                              setEd({ name: z.name, covers: z.covers ?? '', runDays: z.run_days ?? [] });
                            }}>
                      Edit
                    </button>{' '}
                    {isAdmin && (
                      <button className="danger-soft" disabled={busy} onClick={() => remove(z)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
        {live.length === 0 && (
          <p className="muted">
            No zones yet. Add one — without a zone an order cannot be put on a round.
          </p>
        )}
      </div>

      {retired.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Retired</h2>
          <p className="muted small">
            Not offered for new customers. Anyone already on one stays there.
          </p>
          <table>
            <thead>
              <tr><th>Zone</th><th>Covers</th><th className="num">Customers</th><th /></tr>
            </thead>
            <tbody>
              {retired.map((z) => (
                <tr key={z.id}>
                  <td>{z.name}</td>
                  <td className="small muted">{z.covers ?? '—'}</td>
                  <td className="num">{z.customer_count}</td>
                  <td className="num">
                    {isAdmin && (
                      <button className="secondary" disabled={busy} onClick={() => restore(z)}>
                        Bring back
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
