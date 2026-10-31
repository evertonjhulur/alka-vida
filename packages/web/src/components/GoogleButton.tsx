import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/**
 * "Continue with Google" (31 Oct 2026): Google's own button, which hands back
 * a signed ID token for the server to check. Shows nothing at all until
 * GOOGLE_CLIENT_ID is set on the server, so the sign-in page never offers a
 * button that cannot work.
 */

interface GsiId {
  initialize(o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: 'popup'; auto_select?: boolean; cancel_on_tap_outside?: boolean }): void;
  renderButton(el: HTMLElement, o: Record<string, unknown>): void;
}
declare global { interface Window { google?: { accounts: { id: GsiId } } } }

let clientIdLookup: Promise<string | null> | null = null;
/** The public client id, asked once per page load. */
export function googleClientId(): Promise<string | null> {
  if (!clientIdLookup) {
    clientIdLookup = api.get<{ googleClientId: string | null }>('/api/public/auth-config')
      .then((r) => r.googleClientId).catch(() => { clientIdLookup = null; return null; });
  }
  return clientIdLookup;
}

let scriptLoad: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!scriptLoad) {
    scriptLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scriptLoad = null; reject(new Error('Google sign-in could not load')); };
      document.head.appendChild(s);
    });
  }
  return scriptLoad;
}

/** Whether the Google button is offered here at all. */
export function useGoogleEnabled(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { let live = true; void googleClientId().then((id) => { if (live) setOn(!!id); }); return () => { live = false; }; }, []);
  return on;
}

export default function GoogleButton({
  onCredential, text = 'continue_with',
}: { onCredential: (credential: string) => void; text?: 'continue_with' | 'signin_with' | 'signup_with' }) {
  const box = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const id = await googleClientId();
      if (!id || !live) return;
      try { await loadScript(); } catch (e) { if (live) setProblem(e instanceof Error ? e.message : 'Google sign-in could not load'); return; }
      const g = window.google?.accounts?.id;
      if (!g || !box.current || !live) return;
      g.initialize({ client_id: id, callback: (r) => callback.current(r.credential), ux_mode: 'popup', auto_select: false });
      const width = Math.min(400, Math.max(200, Math.floor(box.current.getBoundingClientRect().width)));
      g.renderButton(box.current, { type: 'standard', theme: 'outline', size: 'large', text, shape: 'rectangular', logo_alignment: 'center', width });
    })();
    return () => { live = false; };
  }, [text]);

  return (
    <>
      <div ref={box} className="google-btn" />
      {problem && <p className="small muted" style={{ margin: 0 }}>{problem}. Use your email instead.</p>}
    </>
  );
}
