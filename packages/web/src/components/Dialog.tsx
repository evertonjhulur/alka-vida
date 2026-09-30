import { useEffect, useRef, useState } from 'react';

/**
 * The app's own "Are you sure?" box, in place of the browser's.
 *
 * The browser's confirm() and prompt() look like a warning from the computer
 * rather than a question from Alka Vida, cannot be styled (no red for a
 * delete), and block the whole page. `ask()` and `askText()` are drop-in
 * replacements that return a Promise; <DialogHost /> draws them.
 */

interface Request {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  input?: { label: string; value: string };
  resolve: (v: { ok: boolean; text: string }) => void;
}

let show: ((r: Request) => void) | null = null;

function open(message: string, opts: Partial<Omit<Request, 'message' | 'resolve'>>) {
  return new Promise<{ ok: boolean; text: string }>((resolve) => {
    const req: Request = {
      message,
      confirmLabel: opts.confirmLabel ?? 'OK',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      danger: opts.danger ?? false,
      input: opts.input,
      resolve,
    };
    // No host mounted (should not happen): fall back to the browser.
    if (!show) {
      if (req.input) {
        const t = window.prompt(message, req.input.value);
        resolve({ ok: t !== null, text: t ?? '' });
      } else resolve({ ok: window.confirm(message), text: '' });
      return;
    }
    show(req);
  });
}

/** Yes or no. `danger` makes the yes button red. */
export async function ask(
  message: string,
  opts: { confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return (await open(message, opts)).ok;
}

/** A short piece of text, or null if they cancel. */
export async function askText(
  message: string,
  opts: { label?: string; value?: string; confirmLabel?: string } = {},
): Promise<string | null> {
  const r = await open(message, {
    confirmLabel: opts.confirmLabel ?? 'OK',
    input: { label: opts.label ?? '', value: opts.value ?? '' },
  });
  return r.ok ? r.text : null;
}

export function DialogHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [text, setText] = useState('');
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    show = (r) => { setText(r.input?.value ?? ''); setReq(r); };
    return () => { show = null; };
  }, []);

  useEffect(() => {
    if (!req) return;
    (req.input ? inputRef.current : okRef.current)?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [req]);

  if (!req) return null;

  function finish(ok: boolean) {
    req!.resolve({ ok, text });
    setReq(null);
  }

  const [first, ...rest] = req.message.split('\n\n');
  return (
    <div className="dialog-back" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(false); }}>
      <form className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-q"
            onSubmit={(e) => { e.preventDefault(); finish(true); }}>
        <p id="dialog-q" className="dialog-q">{first}</p>
        {rest.map((p, i) => <p key={i} className="dialog-more">{p}</p>)}
        {req.input && (
          <div className="field">
            {req.input.label && <label htmlFor="dialog-in">{req.input.label}</label>}
            <input id="dialog-in" ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
                   style={{ width: '100%', boxSizing: 'border-box' }} />
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => finish(false)}>{req.cancelLabel}</button>
          <button ref={okRef} className={req.danger ? 'danger-soft' : undefined}>{req.confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
