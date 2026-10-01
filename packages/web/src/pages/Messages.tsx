import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Session } from '../lib/api';
import { money, when } from '../lib/format';
import { ask } from '../components/Dialog';
import { DAYS } from '../components/CustomerForm';

/**
 * Messages & news (team feedback, 1 Oct 2026, points 8.2 and 23).
 *
 * Everton's ruling: News & offers on the customer's portal home, messages to
 * all customers or to lists (by zone or any other rule), and WhatsApp as
 * well as email. Email goes from the app; WhatsApp is a link per customer
 * with the words already typed, because sending WhatsApp messages in bulk
 * needs Meta's paid business service.
 */

interface Criteria {
  zones?: string[]; days?: string[]; accountTypes?: string[]; cycles?: string[]; priceTierIds?: string[];
  owes?: boolean; overdue?: boolean; orderedWithinDays?: number | null; quietForDays?: number | null; onPortal?: boolean;
}
interface SavedList {
  id: string; name: string; criteria: Criteria; include_ids: string[]; exclude_ids: string[];
  size: number; withEmail: number;
}
interface Member {
  id: string; name: string; email: string | null; phone: string | null; delivery_zone: string | null;
  marketing_opt_out: boolean; balance_cents: number; whatsappLink: string | null;
}
interface News {
  id: string; kind: string; title: string; body: string; starts_on: string; ends_on: string | null;
  published: boolean; pinned: boolean; live: boolean;
}
interface Broadcast {
  id: string; subject: string; purpose: string; list_name: string | null; created_at: string;
  created_by_name: string | null; recipients: number; sent: number; queued: number; failed: number; skipped: number;
}
interface BroadcastDetail {
  id: string; subject: string; body: string; purpose: string; list_name: string | null; created_at: string;
  recipients: Array<{ customer_id: string; name: string; email: string | null; status: string; error: string | null; whatsappLink: string | null }>;
}
interface Zone { id: string; name: string; retired_at: string | null }
interface Tier { id: string; name: string }
interface Cust { id: string; name: string }

const TABS = [['send', 'Send a message'], ['lists', 'Customer lists'], ['news', 'News & offers'], ['sent', 'Sent']] as const;
type Tab = (typeof TABS)[number][0];
const KINDS = ['News', 'Promotion', 'Closure', 'Update'];
const BLANK_NEWS = { id: '', kind: 'News', title: '', body: '', startsOn: '', endsOn: '', published: true, pinned: false };

export default function Messages({ session }: { session: Session }) {
  void session;
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'send') as Tab;
  const setTab = (t: Tab) => setParams(t === 'send' ? {} : { tab: t }, { replace: true });

  const [lists, setLists] = useState<SavedList[]>([]);
  const [news, setNews] = useState<News[]>([]);
  const [sentList, setSentList] = useState<Broadcast[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [customers, setCustomers] = useState<Cust[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sending
  const [to, setTo] = useState<string>('all');
  const [purpose, setPurpose] = useState<'Marketing' | 'Service'>('Marketing');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [alsoNews, setAlsoNews] = useState(true);
  const [newsEnds, setNewsEnds] = useState('');
  const [preview, setPreview] = useState<Member[] | null>(null);
  const [detail, setDetail] = useState<BroadcastDetail | null>(null);

  // Lists
  const [editList, setEditList] = useState<{ id: string | null; name: string; criteria: Criteria; include: string[]; exclude: string[] } | null>(null);
  const [listPreview, setListPreview] = useState<Member[]>([]);
  const [addPick, setAddPick] = useState('');

  // News
  const [editNews, setEditNews] = useState<typeof BLANK_NEWS | null>(null);

  async function load() {
    const [l, n, b] = await Promise.all([
      api.get<SavedList[]>('/api/customer-lists'),
      api.get<News[]>('/api/news'),
      api.get<Broadcast[]>('/api/broadcasts'),
    ]);
    setLists(l); setNews(n); setSentList(b);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.get<Zone[]>('/api/zones').then((z) => setZones(z.filter((x) => !x.retired_at))).catch(() => {});
    api.get<Tier[]>('/api/price-tiers').then(setTiers).catch(() => {});
    api.get<Cust[]>('/api/customers').then(setCustomers).catch(() => {});
  }, []);

  async function run(what: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null); setMsg(null);
    try { await what(); await load(); } catch (e) { setError(e instanceof Error ? e.message : fallback); } finally { setBusy(false); }
  }

  /* -------- who a message goes to -------- */
  const audience = (): { listId?: string; criteria?: Criteria } =>
    (to === 'all' ? { criteria: {} } : { listId: to });
  async function loadPreview() {
    const list = lists.find((l) => l.id === to);
    const members = await api.post<Member[]>('/api/customer-lists/preview', list
      ? { criteria: list.criteria, includeIds: list.include_ids, excludeIds: list.exclude_ids }
      : { criteria: {} });
    setPreview(members);
  }
  useEffect(() => { if (tab === 'send') loadPreview().catch(() => setPreview(null)); }, [to, tab, lists.length]);

  const willEmail = (preview ?? []).filter((m) => m.email?.trim() && !(purpose === 'Marketing' && m.marketing_opt_out)).length;

  const send = () => run(async () => {
    if (!await ask(`Send "${subject}" to ${willEmail} customer${willEmail === 1 ? '' : 's'} by email?`,
      { confirmLabel: 'Send it' })) return;
    const r = await api.post<{ id: string; recipients: number; sentNow: number; stillQueued: number; problem?: string }>(
      '/api/broadcasts', {
        subject, body, purpose, ...audience(),
        postAsNews: alsoNews ? { kind: purpose === 'Service' ? 'Update' : 'Promotion', endsOn: newsEnds || null } : null,
      });
    setMsg(`Sent to ${r.sentNow} by email.`
      + (r.stillQueued ? ` ${r.stillQueued} more will go over the next hours (the daily email allowance).` : '')
      + (r.problem ? ` ${r.problem}.` : '')
      + ' WhatsApp links for each customer are below.');
    setDetail(await api.get<BroadcastDetail>(`/api/broadcasts/${r.id}`));
    setSubject(''); setBody('');
  }, 'Could not send the message');

  /* -------- lists -------- */
  useEffect(() => {
    if (!editList) { setListPreview([]); return; }
    const t = setTimeout(() => {
      api.post<Member[]>('/api/customer-lists/preview', {
        criteria: editList.criteria, includeIds: editList.include, excludeIds: editList.exclude,
      }).then(setListPreview).catch(() => setListPreview([]));
    }, 250);
    return () => clearTimeout(t);
  }, [editList]);

  const saveList = () => run(async () => {
    if (!editList) return;
    const payload = { name: editList.name, criteria: editList.criteria, includeIds: editList.include, excludeIds: editList.exclude };
    if (editList.id) await api.patch(`/api/customer-lists/${editList.id}`, payload);
    else await api.post('/api/customer-lists', payload);
    setMsg(`List "${editList.name}" saved.`);
    setEditList(null);
  }, 'Could not save the list');

  const crit = editList?.criteria ?? {};
  const setCrit = (c: Criteria) => editList && setEditList({ ...editList, criteria: c });
  const toggleIn = (key: keyof Criteria, value: string) => {
    const cur = ((crit[key] as string[] | undefined) ?? []);
    setCrit({ ...crit, [key]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] });
  };
  const chips = (key: keyof Criteria, options: Array<[string, string]>) => (
    <div className="day-picks">
      {options.map(([v, label]) => {
        const on = ((crit[key] as string[] | undefined) ?? []).includes(v);
        return (
          <button key={v} type="button" className={`day-pick${on ? ' on' : ''}`} aria-pressed={on}
                  onClick={() => toggleIn(key, v)}>{label}</button>
        );
      })}
    </div>
  );

  /* -------- news -------- */
  const saveNews = () => run(async () => {
    if (!editNews) return;
    const payload = {
      kind: editNews.kind, title: editNews.title, body: editNews.body,
      startsOn: editNews.startsOn || null, endsOn: editNews.endsOn || null,
      published: editNews.published, pinned: editNews.pinned,
    };
    if (editNews.id) await api.patch(`/api/news/${editNews.id}`, payload);
    else await api.post('/api/news', payload);
    setMsg(`"${editNews.title}" saved. ${editNews.published ? 'Customers see it on their portal home.' : 'It is hidden until you publish it.'}`);
    setEditNews(null);
  }, 'Could not save the post');

  const memberTable = (rows: Member[], showWhatsapp: boolean) => (
    <table>
      <thead><tr><th>Customer</th><th>Zone</th><th>Email</th><th className="num">Owes</th>{showWhatsapp && <th />}</tr></thead>
      <tbody>
        {rows.slice(0, 200).map((m) => (
          <tr key={m.id}>
            <td>{m.name}{m.marketing_opt_out && <div className="muted small">no offers</div>}</td>
            <td className="small">{m.delivery_zone ?? '—'}</td>
            <td className="small">{m.email || <span className="muted">none</span>}</td>
            <td className="num">{money(Number(m.balance_cents))}</td>
            {showWhatsapp && (
              <td className="num">
                {m.whatsappLink ? <a href={m.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a> : <span className="muted small">no number</span>}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <h1>Messages &amp; news</h1>
      <p className="subtitle">Tell customers about closures, blackout days and offers, by email and WhatsApp, and post news on their portal.</p>
      {error && <div className="notice error">{error}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      <nav className="tabs" aria-label="Messages sections">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className={`tab${tab === k ? ' active' : ''}`} aria-current={tab === k ? 'page' : undefined}
                  onClick={() => { setTab(k); setDetail(null); }}>{label}</button>
        ))}
      </nav>

      {tab === 'send' && (
        <div className="split">
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>New message</h2>
            <div className="row">
              <div className="field grow">
                <label htmlFor="to">Send to</label>
                <select id="to" value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="all">Every customer</option>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.size})</option>)}
                </select>
              </div>
              <div className="field">
                <span className="label">What kind of message?</span>
                <div className="seg" role="group">
                  <button type="button" className={purpose === 'Marketing' ? 'active' : ''} onClick={() => setPurpose('Marketing')}>Offer or news</button>
                  <button type="button" className={purpose === 'Service' ? 'active' : ''} onClick={() => setPurpose('Service')}>Service notice</button>
                </div>
              </div>
            </div>
            <p className="muted small" style={{ marginTop: 0 }}>
              {purpose === 'Marketing'
                ? 'Offers skip customers who said no to offers.'
                : 'For closures, blackout days or a change to deliveries: goes to everyone on the list.'}
              {' '}<button type="button" className="as-link small" onClick={() => { setTab('lists'); setEditList({ id: null, name: '', criteria: {}, include: [], exclude: [] }); }}>Make a new list</button>
            </p>
            <div className="field">
              <label htmlFor="subj">Subject</label>
              <input id="subj" style={{ width: '100%' }} value={subject} placeholder="e.g. Closed on Heroes Day, Monday 19 October"
                     onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="body">Message</label>
              <textarea id="body" rows={7} style={{ width: '100%', boxSizing: 'border-box' }} value={body}
                        onChange={(e) => setBody(e.target.value)} />
              <div className="muted small">"Good day (their name)," goes at the top and a link to order online at the bottom.</div>
            </div>
            <label className="check"><input type="checkbox" checked={alsoNews} onChange={(e) => setAlsoNews(e.target.checked)} />
              Also show it under News &amp; offers on the customer portal</label>
            {alsoNews && (
              <div className="field">
                <label htmlFor="ne">Show it until (optional)</label>
                <input id="ne" type="date" value={newsEnds} onChange={(e) => setNewsEnds(e.target.value)} />
              </div>
            )}
            <button disabled={busy || !subject.trim() || !body.trim() || willEmail === 0} onClick={send}>
              {busy ? 'Sending…' : `Email ${willEmail} customer${willEmail === 1 ? '' : 's'}`}
            </button>
          </div>
          <div className="panel">
            {detail ? (
              <>
                <h2 style={{ marginTop: 0 }}>Send it on WhatsApp too</h2>
                <p className="muted small">Each link opens WhatsApp with the message typed for that customer; press send in WhatsApp.</p>
                {broadcastRecipients(detail)}
              </>
            ) : (
              <>
                <h2 style={{ marginTop: 0 }}>Who it goes to</h2>
                {preview === null ? <p className="muted">Loading…</p> : (
                  <>
                    <p className="small" style={{ marginTop: 0 }}>
                      {preview.length} customer{preview.length === 1 ? '' : 's'}; {willEmail} by email
                      {preview.length - willEmail > 0 ? ` (${preview.length - willEmail} have no email${purpose === 'Marketing' ? ' or said no to offers' : ''})` : ''}.
                    </p>
                    {memberTable(preview, false)}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'lists' && (
        <>
          {!editList && (
            <div className="panel">
              <div className="panel-head">
                <h2>Customer lists</h2>
                <button type="button" onClick={() => setEditList({ id: null, name: '', criteria: {}, include: [], exclude: [] })}>+ New list</button>
              </div>
              <p className="muted small" style={{ marginTop: 0 }}>
                A list is a rule (zone, delivery day, business or individual, what they owe…) plus anyone added by hand.
                It keeps itself up to date: a new customer in Kingston joins "Kingston" automatically.
              </p>
              <table>
                <thead><tr><th>List</th><th className="num">Customers</th><th className="num">With email</th><th /></tr></thead>
                <tbody>
                  {lists.map((l) => (
                    <tr key={l.id}>
                      <td><strong>{l.name}</strong></td>
                      <td className="num">{l.size}</td>
                      <td className="num">{l.withEmail}</td>
                      <td className="num">
                        <button type="button" className="secondary" onClick={() => setEditList({
                          id: l.id, name: l.name, criteria: l.criteria ?? {}, include: l.include_ids ?? [], exclude: l.exclude_ids ?? [],
                        })}>Change</button>{' '}
                        <button type="button" className="danger-soft" disabled={busy} onClick={async () => {
                          if (!await ask(`Delete the list "${l.name}"?`, { confirmLabel: 'Delete', danger: true })) return;
                          await run(async () => { await api.del(`/api/customer-lists/${l.id}`); setMsg('List deleted.'); }, 'Could not delete');
                        }}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {lists.length === 0 && <p className="muted">No lists yet.</p>}
            </div>
          )}
          {editList && (
            <div className="split">
              <div className="panel">
                <h2 style={{ marginTop: 0 }}>{editList.id ? 'Change list' : 'New list'}</h2>
                <div className="field">
                  <label htmlFor="ln">Name</label>
                  <input id="ln" style={{ width: '100%' }} value={editList.name} placeholder="e.g. Kingston businesses"
                         onChange={(e) => setEditList({ ...editList, name: e.target.value })} />
                </div>
                <fieldset className="form-block">
                  <legend>Who is on it (leave a section blank for "any")</legend>
                  <span className="label">Delivery zone</span>
                  {chips('zones', zones.map((z) => [z.name, z.name]))}
                  <span className="label" style={{ marginTop: 10 }}>Delivery day</span>
                  {chips('days', DAYS.map((d) => [d, d]))}
                  <span className="label" style={{ marginTop: 10 }}>Account</span>
                  {chips('accountTypes', [['Corporate', 'Business'], ['Individual', 'Individual']])}
                  <span className="label" style={{ marginTop: 10 }}>Invoiced</span>
                  {chips('cycles', [['PerDelivery', 'Each delivery'], ['Weekly', 'Weekly'], ['Monthly', 'Monthly']])}
                  {tiers.length > 0 && (<>
                    <span className="label" style={{ marginTop: 10 }}>Price list</span>
                    {chips('priceTierIds', tiers.map((t) => [t.id, t.name]))}
                  </>)}
                  <div style={{ marginTop: 10 }}>
                    <label className="check"><input type="checkbox" checked={!!crit.owes} onChange={(e) => setCrit({ ...crit, owes: e.target.checked })} /> Owes money</label>
                    <label className="check"><input type="checkbox" checked={!!crit.overdue} onChange={(e) => setCrit({ ...crit, overdue: e.target.checked })} /> Has an overdue invoice</label>
                    <label className="check"><input type="checkbox" checked={!!crit.onPortal} onChange={(e) => setCrit({ ...crit, onPortal: e.target.checked })} /> Signed up to the portal</label>
                  </div>
                  <div className="row">
                    <div className="field">
                      <label htmlFor="ow">Ordered in the last … days</label>
                      <input id="ow" type="number" min="0" style={{ width: 110 }} value={crit.orderedWithinDays ?? ''}
                             onChange={(e) => setCrit({ ...crit, orderedWithinDays: e.target.value === '' ? null : Number(e.target.value) })} />
                    </div>
                    <div className="field">
                      <label htmlFor="qd">Not ordered for … days</label>
                      <input id="qd" type="number" min="0" style={{ width: 110 }} value={crit.quietForDays ?? ''}
                             onChange={(e) => setCrit({ ...crit, quietForDays: e.target.value === '' ? null : Number(e.target.value) })} />
                    </div>
                  </div>
                </fieldset>
                <fieldset className="form-block">
                  <legend>Add someone by hand</legend>
                  <div className="row">
                    <select value={addPick} onChange={(e) => setAddPick(e.target.value)} style={{ flex: '1 1 220px' }}>
                      <option value="">Choose a customer…</option>
                      {customers.filter((c) => !editList.include.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button type="button" className="secondary" disabled={!addPick}
                            onClick={() => { setEditList({ ...editList, include: [...editList.include, addPick], exclude: editList.exclude.filter((x) => x !== addPick) }); setAddPick(''); }}>Add</button>
                  </div>
                  {editList.include.length > 0 && (
                    <p className="small">Added by hand: {editList.include.map((idv) => customers.find((c) => c.id === idv)?.name ?? '?').join(', ')}{' '}
                      <button type="button" className="as-link small" onClick={() => setEditList({ ...editList, include: [] })}>clear</button></p>
                  )}
                  {editList.exclude.length > 0 && (
                    <p className="small">Left out: {editList.exclude.map((idv) => customers.find((c) => c.id === idv)?.name ?? '?').join(', ')}{' '}
                      <button type="button" className="as-link small" onClick={() => setEditList({ ...editList, exclude: [] })}>clear</button></p>
                  )}
                </fieldset>
                <div className="row" style={{ gap: 8 }}>
                  <button disabled={busy || !editList.name.trim()} onClick={saveList}>Save list</button>
                  <button type="button" className="secondary" onClick={() => setEditList(null)}>Cancel</button>
                </div>
              </div>
              <div className="panel">
                <h2 style={{ marginTop: 0 }}>{listPreview.length} customer{listPreview.length === 1 ? '' : 's'} on it now</h2>
                <table>
                  <thead><tr><th>Customer</th><th>Zone</th><th>Email</th><th /></tr></thead>
                  <tbody>
                    {listPreview.slice(0, 200).map((m) => (
                      <tr key={m.id}>
                        <td>{m.name}</td><td className="small">{m.delivery_zone ?? '—'}</td>
                        <td className="small">{m.email || <span className="muted">none</span>}</td>
                        <td className="num">
                          <button type="button" className="as-link small"
                                  onClick={() => setEditList({ ...editList, exclude: [...editList.exclude, m.id], include: editList.include.filter((x) => x !== m.id) })}>
                            leave out
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'news' && (
        <div className="split">
          <div className="panel">
            <div className="panel-head">
              <h2>News &amp; offers on the portal</h2>
              {!editNews && <button type="button" onClick={() => setEditNews({ ...BLANK_NEWS })}>+ New post</button>}
            </div>
            <table>
              <thead><tr><th>Post</th><th>Showing</th><th /></tr></thead>
              <tbody>
                {news.map((n) => (
                  <tr key={n.id}>
                    <td><span className="chip neutral">{n.kind}</span> <strong>{n.title}</strong>{n.pinned && <span className="muted small"> · pinned</span>}</td>
                    <td className="small">
                      {n.live ? <span className="chip ok">On the portal</span> : <span className="chip neutral">{n.published ? 'Not showing' : 'Hidden'}</span>}
                      <div className="muted">{when(n.starts_on)}{n.ends_on ? ` to ${when(n.ends_on)}` : ' onwards'}</div>
                    </td>
                    <td className="num">
                      <button type="button" className="secondary" onClick={() => setEditNews({
                        id: n.id, kind: n.kind, title: n.title, body: n.body, startsOn: n.starts_on, endsOn: n.ends_on ?? '',
                        published: n.published, pinned: n.pinned,
                      })}>Change</button>{' '}
                      <button type="button" className="danger-soft" disabled={busy} onClick={async () => {
                        if (!await ask(`Delete "${n.title}"?`, { confirmLabel: 'Delete', danger: true })) return;
                        await run(async () => { await api.del(`/api/news/${n.id}`); setMsg('Post deleted.'); }, 'Could not delete');
                      }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {news.length === 0 && <p className="muted">Nothing posted yet.</p>}
          </div>
          {editNews && (
            <div className="panel">
              <h2 style={{ marginTop: 0 }}>{editNews.id ? 'Change post' : 'New post'}</h2>
              <div className="row">
                <div className="field">
                  <label htmlFor="nk">Kind</label>
                  <select id="nk" value={editNews.kind} onChange={(e) => setEditNews({ ...editNews, kind: e.target.value })}>
                    {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
                <div className="field grow">
                  <label htmlFor="nt">Headline</label>
                  <input id="nt" value={editNews.title} onChange={(e) => setEditNews({ ...editNews, title: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="nb">Text</label>
                <textarea id="nb" rows={6} style={{ width: '100%', boxSizing: 'border-box' }} value={editNews.body}
                          onChange={(e) => setEditNews({ ...editNews, body: e.target.value })} />
              </div>
              <div className="row">
                <div className="field">
                  <label htmlFor="ns">Show from</label>
                  <input id="ns" type="date" value={editNews.startsOn} onChange={(e) => setEditNews({ ...editNews, startsOn: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="ne2">Until (optional)</label>
                  <input id="ne2" type="date" value={editNews.endsOn} onChange={(e) => setEditNews({ ...editNews, endsOn: e.target.value })} />
                </div>
              </div>
              <label className="check"><input type="checkbox" checked={editNews.published} onChange={(e) => setEditNews({ ...editNews, published: e.target.checked })} /> Show it on the portal</label>
              <label className="check"><input type="checkbox" checked={editNews.pinned} onChange={(e) => setEditNews({ ...editNews, pinned: e.target.checked })} /> Keep it at the top</label>
              <div className="row" style={{ gap: 8 }}>
                <button disabled={busy || !editNews.title.trim()} onClick={saveNews}>Save post</button>
                <button type="button" className="secondary" onClick={() => setEditNews(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'sent' && (
        detail ? (
          <div className="panel">
            <p style={{ marginTop: 0 }}><button type="button" className="as-link" onClick={() => setDetail(null)}>‹ All messages</button></p>
            <h2 style={{ marginTop: 0 }}>{detail.subject}</h2>
            <p className="muted small">{detail.list_name} · {when(detail.created_at)} · {detail.purpose === 'Service' ? 'Service notice' : 'Offer or news'}</p>
            <p style={{ whiteSpace: 'pre-line' }}>{detail.body}</p>
            {broadcastRecipients(detail)}
          </div>
        ) : (
          <div className="panel">
            <div className="panel-head">
              <h2>Messages sent</h2>
              {sentList.some((b) => b.queued > 0) && (
                <button type="button" className="secondary" disabled={busy} onClick={() => run(async () => {
                  const r = await api.post<{ sentNow: number; stillQueued: number; problem?: string }>('/api/broadcasts/send-queued');
                  setMsg(`${r.sentNow} sent now${r.stillQueued ? `, ${r.stillQueued} still waiting for tomorrow's allowance` : ''}.${r.problem ? ` ${r.problem}.` : ''}`);
                }, 'Could not send')}>Send what is waiting</button>
              )}
            </div>
            <table>
              <thead><tr><th>Message</th><th>To</th><th className="num">Sent</th><th className="num">Waiting</th><th className="num">Not sent</th><th /></tr></thead>
              <tbody>
                {sentList.map((b) => (
                  <tr key={b.id}>
                    <td><strong>{b.subject}</strong><div className="muted small">{when(b.created_at)}{b.created_by_name ? ` · ${b.created_by_name}` : ''}</div></td>
                    <td className="small">{b.list_name}</td>
                    <td className="num">{b.sent}</td>
                    <td className="num">{b.queued || '—'}</td>
                    <td className="num">{b.failed + b.skipped || '—'}</td>
                    <td className="num"><button type="button" className="secondary"
                      onClick={() => api.get<BroadcastDetail>(`/api/broadcasts/${b.id}`).then(setDetail).catch((e) => setError(e.message))}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sentList.length === 0 && <p className="muted">Nothing sent yet.</p>}
          </div>
        )
      )}
    </>
  );

  function broadcastRecipients(d: BroadcastDetail) {
    return (
      <table>
        <thead><tr><th>Customer</th><th>Email</th><th /></tr></thead>
        <tbody>
          {d.recipients.map((r) => (
            <tr key={r.customer_id}>
              <td>{r.name}</td>
              <td className="small">
                <span className={`chip ${r.status === 'Sent' ? 'ok' : r.status === 'Queued' ? 'info' : r.status === 'Failed' ? 'bad' : 'neutral'}`}>
                  {r.status === 'Queued' ? 'Waiting' : r.status === 'Skipped' ? 'Not emailed' : r.status}
                </span>
                {r.error && <div className="muted">{r.error}</div>}
              </td>
              <td className="num">
                {r.whatsappLink
                  ? <a className="button-link whatsapp" href={r.whatsappLink} target="_blank" rel="noreferrer">WhatsApp</a>
                  : <span className="muted small">no number</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
}
