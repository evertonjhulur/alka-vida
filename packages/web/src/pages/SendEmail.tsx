import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, openPdf } from '../lib/api';
import { type BatchKind, type SendKind, type SendRef, announceSent, refQuery } from '../lib/send';

/**
 * The send screen (Everton, 28 Oct 2026).
 *
 * "Email..." on any document opens this in a new tab, the way QuickBooks and
 * Zoho do it: To, Cc and Bcc, the subject and message already written (and
 * changeable for this one email), the document attached, "Send me a copy",
 * and other files. A browser cannot attach a file to Outlook or Gmail, so
 * Alka Vida sends it from its own address; replies come to the office.
 *
 * Several ticked on a list go ONE AT A TIME (his "Option B"): Email 1 of 3,
 * then Send and go to the next, Skip this one, or Stop here. Anyone with no
 * email address is listed before the first and left out of the run.
 */

interface Draft {
  kind: SendKind;
  docLabel: string;
  recipientName: string;
  recipientType: 'customer' | 'supplier';
  recipientId: string | null;
  emailOnFile: string | null;
  to: string[];
  cc: string[];
  ccSaved: boolean;
  subject: string;
  message: string;
  attachments: Array<{ filename: string; bytes: number }>;
  wordingLabel: string;
  mailConfigured: boolean;
  me: string | null;
  maxBytes: number;
  blocked?: string | null;
  note?: string | null;
}

interface PlanStep { name: string; what: string; email: string | null; ref: SendRef }
interface Plan { steps: PlanStep[]; cannot: Array<{ name: string; what: string; why: string }> }
interface Outcome { name: string; what: string; result: 'sent' | 'skipped' | 'failed' | 'not sent'; detail: string }

interface Picked { filename: string; contentType: string; bytes: number; data: string }

const MB = 1024 * 1024;
const size = (b: number) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

const BATCH_WORDS: Record<BatchKind, string> = {
  invoices: 'invoices', receipts: 'receipts', quotes: 'quotes', 'purchase-orders': 'purchase orders',
};

function refFromQuery(q: URLSearchParams): SendRef {
  return {
    kind: (q.get('kind') ?? '') as SendKind,
    ids: (q.get('ids') ?? '').split(',').filter(Boolean),
    from: q.get('from'), to: q.get('to'), filter: q.get('filter'), status: q.get('status'),
  };
}

function readFile(file: File): Promise<Picked> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result ?? '');
      resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', bytes: file.size, data: url.slice(url.indexOf(',') + 1) });
    };
    r.onerror = () => reject(new Error(`${file.name} could not be read`));
    r.readAsDataURL(file);
  });
}

export default function SendEmail() {
  const loc = useLocation();
  const q = useMemo(() => new URLSearchParams(loc.search), [loc.search]);
  const batch = q.get('batch') as BatchKind | null;

  useEffect(() => { document.title = 'Send an email · Alka Vida'; }, []);

  if (batch) return <BatchSend kind={batch} ids={(q.get('ids') ?? '').split(',').filter(Boolean)} />;
  return <SingleSend sendRef={refFromQuery(q)} />;
}

/* ------------------------------------------------------------------ */
/* One document                                                         */
/* ------------------------------------------------------------------ */

function SingleSend({ sendRef }: { sendRef: SendRef }) {
  const [done, setDone] = useState<{ sentTo: string; label: string; link?: string; copies: string } | null>(null);
  if (done) {
    return (
      <div className="send-page">
        <div className="panel send-done">
          <h1>Sent</h1>
          <p><strong>{done.label}</strong> went to {done.sentTo}{done.copies}.</p>
          {done.link && (
            <p className="small">The customer can accept the quote from the email. The same link, to share another way:{' '}
              <a href={done.link} target="_blank" rel="noreferrer">{done.link}</a></p>
          )}
          <p className="muted small">It is on the document's history, with the copies and any other files.</p>
          <div className="row">
            <button type="button" onClick={() => window.close()}>Close this tab</button>
            <Link to="/" className="send-link">Go to the home screen</Link>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="send-page">
      <Composer sendRef={sendRef} mode="single"
                onSent={(r) => setDone(r)} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Several, one at a time                                               */
/* ------------------------------------------------------------------ */

function BatchSend({ kind, ids }: { kind: BatchKind; ids: string[] }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    api.post<Plan>('/api/send/plan', { kind, ids })
      .then(setPlan)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not work out who these go to'));
  }, [kind, ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="send-page"><div className="notice error">{error}</div></div>;
  if (!plan) return <div className="send-page"><p className="muted">Getting the emails ready…</p></div>;

  const total = plan.steps.length;
  const finished = stopped || at >= total;
  const step = plan.steps[at];
  const next = (o: Outcome) => { setOutcomes((list) => [...list, o]); setAt((i) => i + 1); };

  if (finished) {
    const sentCount = outcomes.filter((o) => o.result === 'sent').length;
    const left = plan.steps.slice(at).map((s) => ({ name: s.name, what: s.what, result: 'not sent' as const, detail: 'stopped before this one' }));
    const all: Outcome[] = [
      ...outcomes, ...left,
      ...plan.cannot.map((c) => ({ name: c.name, what: c.what, result: 'not sent' as const, detail: c.why })),
    ];
    return (
      <div className="send-page">
        <div className="panel send-done">
          <h1>{sentCount === 0 ? 'Nothing was sent' : `${sentCount} of ${total + plan.cannot.length} emailed`}</h1>
          <table className="send-results">
            <thead><tr><th>To</th><th>What</th><th>Result</th></tr></thead>
            <tbody>
              {all.map((o, i) => (
                <tr key={i}>
                  <td>{o.name}</td>
                  <td>{o.what}</td>
                  <td className={`send-result ${o.result.replace(' ', '-')}`}>
                    <strong>{o.result === 'sent' ? 'Sent' : o.result === 'skipped' ? 'Skipped' : o.result === 'failed' ? 'Failed' : 'Not sent'}</strong>
                    {o.detail ? ` · ${o.detail}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {all.some((o) => o.result !== 'sent') && (
            <p className="muted small">Anything not sent can be printed, sent by WhatsApp, or emailed again from its own screen.</p>
          )}
          <div className="row">
            <button type="button" onClick={() => window.close()}>Close this tab</button>
            <Link to="/" className="send-link">Go to the home screen</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="send-page">
      <div className="send-batch-head">
        <h1>Email {at + 1} of {total}: {step.name}</h1>
        <span className="muted small">
          {at + 1 < total
            ? `Next: ${plan.steps.slice(at + 1, at + 3).map((s) => s.name).join(', then ')}${total - at - 1 > 2 ? `, and ${total - at - 3} more` : ''}`
            : 'This is the last one.'}
        </span>
      </div>
      <div className="send-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={at}
           aria-label={`${at} of ${total} done`}>
        {plan.steps.map((_, i) => <span key={i} className={i < at ? 'done' : i === at ? 'now' : ''} />)}
      </div>
      {at === 0 && plan.cannot.length > 0 && (
        <div className="notice warn">
          <strong>{plan.cannot.length === 1 ? 'One is' : `${plan.cannot.length} are`} not in this run:</strong>
          <ul className="send-cannot">
            {plan.cannot.map((c, i) => <li key={i}>{c.name} ({c.what}): {c.why}</li>)}
          </ul>
          Print {plan.cannot.length === 1 ? 'it' : 'them'} or send by WhatsApp instead.
        </div>
      )}
      {total === 0 ? (
        <div className="panel">
          <p>None of the {BATCH_WORDS[kind]} you ticked can be emailed.</p>
          <button type="button" className="secondary" onClick={() => setStopped(true)}>See the list</button>
        </div>
      ) : (
        <Composer key={at} sendRef={step.ref} mode="batch" isLast={at + 1 === total}
                  onSent={(r) => next({ name: step.name, what: step.what, result: 'sent', detail: `to ${r.sentTo}${r.copies}` })}
                  onSkip={(why) => next({ name: step.name, what: step.what, result: why ? 'failed' : 'skipped', detail: why ?? '' })}
                  onStop={() => setStopped(true)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The email itself                                                     */
/* ------------------------------------------------------------------ */

function Composer({ sendRef, mode, isLast, onSent, onSkip, onStop }: {
  sendRef: SendRef;
  mode: 'single' | 'batch';
  isLast?: boolean;
  onSent: (r: { sentTo: string; label: string; link?: string; copies: string }) => void;
  onSkip?: (failedBecause?: string) => void;
  onStop?: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showBcc, setShowBcc] = useState(false);
  const [meCopy, setMeCopy] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const query = refQuery(sendRef);

  useEffect(() => {
    let live = true;
    setDraft(null); setLoadError(null);
    api.get<Draft>(`/api/send/draft?${query}`)
      .then((d) => {
        if (!live) return;
        setDraft(d);
        setTo(d.to.join(', '));
        setCc(d.cc.join(', '));
        setSubject(d.subject);
        setMessage(d.message);
        document.title = `Email ${d.docLabel} · Alka Vida`;
      })
      .catch((e) => { if (live) setLoadError(e instanceof Error ? e.message : 'Could not get the email ready'); });
    return () => { live = false; };
  }, [query]);

  if (loadError) {
    return (
      <div className="panel">
        <div className="notice error">{loadError}</div>
        {mode === 'batch' && (
          <div className="row">
            <button type="button" className="secondary" onClick={onStop}>Stop here</button>
            <button type="button" className="secondary" onClick={() => onSkip?.(loadError)}>Skip this one</button>
          </div>
        )}
      </div>
    );
  }
  if (!draft) return <div className="panel"><p className="muted">Getting the email ready…</p></div>;

  const docBytes = draft.attachments.reduce((a, f) => a + f.bytes, 0);
  const totalBytes = docBytes + files.reduce((a, f) => a + f.bytes, 0);
  const over = totalBytes > draft.maxBytes;
  const canSend = draft.mailConfigured && !draft.blocked && !over && !!to.trim() && !!subject.trim() && !!message.trim();

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError(null);
    try {
      const read = await Promise.all(Array.from(list).map(readFile));
      setFiles((f) => [...f, ...read]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A file could not be read');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function send() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ sentTo: string; label: string; link?: string }>('/api/send', {
        ref: sendRef,
        compose: {
          to, cc, bcc, sendMeCopy: meCopy, subject, message,
          extra: files.map((f) => ({ filename: f.filename, contentType: f.contentType, data: f.data })),
        },
      });
      announceSent(sendRef);
      const copies = [
        cc.trim() ? `, copied to ${cc.trim()}` : '',
        bcc.trim() ? `, blind copy to ${bcc.trim()}` : '',
        meCopy && draft?.me ? `, a copy to you` : '',
      ].join('');
      onSent({ ...r, copies });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The email could not be sent');
    } finally { setBusy(false); }
  }

  const backToStandard = () => { setSubject(draft.subject); setMessage(draft.message); };
  const changedWords = subject !== draft.subject || message !== draft.message;

  return (
    <div className="panel send-form">
      {mode === 'single' && <h1>Email {draft.docLabel}</h1>}
      <p className="muted small send-sub">
        To {draft.recipientType === 'supplier' ? 'supplier ' : ''}<strong>{draft.recipientName}</strong>
        {mode === 'batch' && <> · {draft.docLabel}</>}
        {' · '}sent from the Alka Vida email address; replies come to the office.
      </p>

      {!draft.mailConfigured && (
        <div className="notice warn">
          Email is not set up on this copy of Alka Vida yet, so nothing can be sent. View the PDF and send it yourself for now.
        </div>
      )}
      {draft.blocked && <div className="notice error">{draft.blocked}</div>}
      {draft.note && !draft.blocked && <div className="notice info">{draft.note}</div>}
      {!draft.emailOnFile && (
        <div className="notice warn">
          {draft.recipientName} has no email address on file. Type one in To to send this one
          {draft.recipientType === 'customer' && draft.recipientId
            ? <>, or <Link to={`/customers/${draft.recipientId}`} target="_blank">add it to their account</Link></> : ''}.
        </div>
      )}

      <div className="send-grid">
        <label htmlFor="s-to">To</label>
        <div>
          <input id="s-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.com" autoComplete="off" />
          <div className="muted small">Separate several addresses with commas.</div>
        </div>

        <label htmlFor="s-cc">Cc</label>
        <div>
          <input id="s-cc" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Copies (optional)" autoComplete="off" />
          {draft.ccSaved && (
            <div className="muted small">
              Filled in from the copy addresses saved on their account. Remove any you do not want on this email
              {draft.recipientId ? <>; <Link to={`/customers/${draft.recipientId}`} target="_blank">change them on the account</Link></> : ''}.
            </div>
          )}
        </div>

        {showBcc ? (
          <>
            <label htmlFor="s-bcc">Bcc</label>
            <input id="s-bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="Blind copies (optional)" autoComplete="off" />
          </>
        ) : (
          <>
            <span />
            <div><button type="button" className="as-link" onClick={() => setShowBcc(true)}>Add Bcc</button></div>
          </>
        )}

        <span />
        <label className="check send-me">
          <input type="checkbox" checked={meCopy} disabled={!draft.me} onChange={(e) => setMeCopy(e.target.checked)} />
          {draft.me ? `Send me a copy (${draft.me})` : 'Send me a copy (your login has no email address)'}
        </label>

        <label htmlFor="s-subject">Subject</label>
        <input id="s-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />

        <label htmlFor="s-message">Message</label>
        <div>
          <textarea id="s-message" rows={10} value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="muted small">
            The figures and the "See it online" button go below your message, as always.
            {' '}{changedWords
              ? <>Changed for this email only. <button type="button" className="as-link" onClick={backToStandard}>Use the standard wording</button></>
              : <>The standard {draft.wordingLabel.toLowerCase()} wording is set in Settings › Emails &amp; ordering.</>}
          </div>
        </div>

        <span className="send-attach-label">Attached</span>
        <div className="send-files">
          {draft.attachments.map((a) => (
            <div key={a.filename} className="send-file">
              <strong>{a.filename}</strong>
              <span className="muted small">{size(a.bytes)}</span>
              <span className="send-spacer" />
              <button type="button" className="secondary" onClick={() => openPdf(`/api/send/preview.pdf?${query}`)}>View</button>
            </div>
          ))}
          {files.map((f, i) => (
            <div key={`${f.filename}-${i}`} className="send-file extra">
              <strong>{f.filename}</strong>
              <span className="muted small">{size(f.bytes)}, added by you</span>
              <span className="send-spacer" />
              <button type="button" className="danger-soft" onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div className="row send-attach-row">
            <input ref={fileInput} id="s-files" type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
            <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>Attach a file…</button>
            <span className={`small ${over ? 'send-over' : 'muted'}`}>
              {size(totalBytes)} of 10 MB{over ? ': too much for one email. Remove a file.' : ''}
            </span>
          </div>
        </div>
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}

      {mode === 'single' ? (
        <div className="send-actions">
          <button type="button" className="secondary" onClick={() => window.close()}>Close without sending</button>
          <span className="send-spacer" />
          <button type="button" className="go" disabled={busy || !canSend} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
      ) : (
        <div className="send-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onStop}>Stop here</button>
          <span className="send-spacer" />
          <button type="button" className="secondary" disabled={busy} onClick={() => onSkip?.()}>Skip this one</button>
          <button type="button" className="go" disabled={busy || !canSend} onClick={send}>
            {busy ? 'Sending…' : isLast ? 'Send (the last one)' : 'Send and go to the next'}
          </button>
        </div>
      )}
    </div>
  );
}
