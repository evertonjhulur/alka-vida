import { useEffect, useState } from 'react';

/**
 * Warns when Alka Vida is running a server older than the app it is serving.
 *
 * The server hands the browser whatever is on disk, but keeps running the API
 * it started with. After an update those two are different: new screens call
 * endpoints the running copy has never heard of, and the page dies with no
 * explanation. That has cost several testing sessions here, each one looking
 * like a fresh bug.
 *
 * The check is a comparison of one string: the script filename the server saw
 * at startup, against the one this browser actually loaded. Vite renames the
 * bundle on every build, so they differ if and only if the app was rebuilt
 * after the server came up.
 */
export default function StaleServerNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/version');
        // A server old enough not to have this endpoint IS the stale server
        // this warns about - which is the case that has caught us out so far.
        // 404 when it routes normally; 401 when its auth hook guards every
        // /api/ path before routing, which older builds do.
        if (res.status === 404 || res.status === 401) {
          if (!cancelled) setStale(true);
          return;
        }
        if (!res.ok) return;
        const { build } = (await res.json()) as { build: string | null };
        if (!build) return; // dev server, or no build on disk: nothing to compare

        // Which bundle is this page actually running?
        const running = [...document.querySelectorAll('script[src]')]
          .map((s) => (s as HTMLScriptElement).src)
          .map((src) => src.split('/assets/')[1])
          .find(Boolean);
        if (!running) return;

        if (!cancelled && running !== build) setStale(true);
      } catch { /* offline or starting up: say nothing rather than cry wolf */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!stale) return null;

  return (
    <div className="notice warn" style={{ margin: '0 0 12px' }}>
      <strong>Alka Vida has been updated since it was started.</strong>{' '}
      Close this window and open Alka Vida again. Until you do, some screens
      will not work — they are asking a copy that is still running the older
      version for things it does not have.
    </div>
  );
}
