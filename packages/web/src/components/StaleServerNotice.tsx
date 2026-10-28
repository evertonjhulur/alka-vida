import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { staleKind, type StaleKind } from '../lib/version';

/**
 * Keeps every open screen on the version of Alka Vida that is live.
 *
 * Two ways a screen falls behind:
 *
 *  - 'page' (28 Oct 2026): a new version went live while this tab stayed
 *    open. The tab keeps running the old screens - Collin's New order kept
 *    taking payment at order entry for two days after that was fixed, because
 *    his tab was opened before the update. The check now runs every two
 *    minutes and whenever the window comes back into view; when it finds a
 *    new version it shows a bar with Reload, and the next time the person
 *    moves to another screen the page reloads by itself (never mid-form).
 *
 *  - 'server': on the office computer, the app was rebuilt after the server
 *    started, so the screens ask a server that is older than they are.
 *    Restarting Alka Vida fixes it; a reload does not.
 */
export default function StaleServerNotice() {
  const [stale, setStale] = useState<StaleKind>(null);
  const { pathname } = useLocation();
  const first = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const k = await staleKind(fetch.bind(window), runningBuild());
      if (!cancelled && k) setStale(k);
    };
    void check();
    const t = setInterval(() => { void check(); }, 120_000);
    const onShow = () => { void check(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
    };
  }, []);

  // Moving to another screen is the safe moment: nothing half-typed is lost.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (stale === 'page') window.location.reload();
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!stale) return null;

  if (stale === 'page') {
    return (
      <div className="notice warn update-bar" style={{ margin: '0 0 12px' }}>
        <span>
          <strong>A new version of Alka Vida is ready.</strong>{' '}
          Reload to use it. It loads by itself when you next move to another screen.
        </span>
        <button className="go" onClick={() => window.location.reload()}>Reload now</button>
      </div>
    );
  }

  return (
    <div className="notice warn" style={{ margin: '0 0 12px' }}>
      <strong>Alka Vida has been updated since it was started.</strong>{' '}
      Close this window and open Alka Vida again. Until you do, some screens
      will not work — they are asking a copy that is still running the older
      version for things it does not have.
    </div>
  );
}

/** Which bundle this page is actually running. */
function runningBuild(): string | null {
  return [...document.querySelectorAll('script[src]')]
    .map((s) => (s as HTMLScriptElement).src)
    .map((src) => src.split('/assets/')[1])
    .find(Boolean) ?? null;
}
