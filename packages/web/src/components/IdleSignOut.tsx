import { useEffect, useRef, useState } from 'react';
import { api, rememberReturnPath, type Session } from '../lib/api';
import {
  idleAppliesTo, idleState, markIdleSignedOut, readLastActive, writeLastActive, type IdleState,
} from '../lib/idle';

/**
 * Signs an admin or office login out after 15 minutes with nobody at the
 * screen (Everton, 28 Oct 2026), with a minute's warning and a button to stay
 * signed in. Signing back in returns them to the screen they were on.
 * Drivers and customers are never timed out here.
 */
export default function IdleSignOut({ session }: { session: Session }) {
  const applies = idleAppliesTo(session.role);
  const [state, setState] = useState<IdleState>({ kind: 'active' });
  const lastWrite = useRef(0);
  const gone = useRef(false);

  useEffect(() => {
    if (!applies) return;
    if (readLastActive() === null) writeLastActive(Date.now());

    // Activity anywhere on the page counts. Written at most every 5 seconds
    // so moving the mouse does not hammer localStorage.
    const touch = () => {
      const now = Date.now();
      if (now - lastWrite.current < 5000) return;
      lastWrite.current = now;
      writeLastActive(now);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true, capture: true });

    const signOut = () => {
      if (gone.current) return;
      gone.current = true;
      rememberReturnPath();
      markIdleSignedOut();
      void api.logout().finally(() => {
        window.location.hash = '#/login';
        window.location.reload();
      });
    };

    const check = () => {
      // Another tab of Alka Vida signed out already: follow it.
      const last = readLastActive() ?? Date.now();
      const s = idleState(last, Date.now());
      if (s.kind === 'expired') signOut();
      setState(s);
    };
    check();
    const t = setInterval(check, 1000);
    // A computer waking from sleep: check at once, before anyone acts on a
    // screen left open overnight.
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', check);
      for (const e of events) window.removeEventListener(e, touch, { capture: true });
    };
  }, [applies]);

  if (!applies || state.kind !== 'warning') return null;

  const stay = () => {
    lastWrite.current = Date.now();
    writeLastActive(lastWrite.current);
    setState({ kind: 'active' });
  };

  return (
    <div className="idle-overlay" role="alertdialog" aria-live="assertive" aria-label="About to sign out">
      <div className="idle-card">
        <h2>Still there?</h2>
        <p>
          Nobody has used Alka Vida on this computer for a while. You will be signed
          out in <strong>{state.secondsLeft} second{state.secondsLeft === 1 ? '' : 's'}</strong>.
        </p>
        <p className="muted small">Anything not yet saved on this screen will be lost.</p>
        <div className="idle-actions">
          <button className="go" onClick={stay} autoFocus>Stay signed in</button>
        </div>
      </div>
    </div>
  );
}
