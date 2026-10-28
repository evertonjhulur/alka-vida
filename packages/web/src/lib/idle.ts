/**
 * Signing the office out after a spell with nobody at the screen (Everton,
 * 28 Oct 2026): 15 minutes for admin and office logins, with a warning a
 * minute before. Drivers and customers are left alone - a driver's phone
 * sits idle between stops for longer than that mid-round.
 *
 * The last activity is shared through localStorage, so working in one tab
 * keeps another tab of Alka Vida signed in too.
 */
import type { Role } from './api';

export const IDLE_LIMIT_MS = 15 * 60_000;
export const IDLE_WARNING_MS = 60_000;
const LAST_ACTIVE_KEY = 'alkavida.lastActive';
const IDLE_FLAG_KEY = 'alkavida.idleSignedOut';

/** Only admin and office logins time out. */
export function idleAppliesTo(role: Role): boolean {
  return role === 'admin' || role === 'user';
}

export type IdleState = { kind: 'active' } | { kind: 'warning'; secondsLeft: number } | { kind: 'expired' };

/** Where somebody stands, given when they last did something. */
export function idleState(lastActive: number, now: number,
  limit = IDLE_LIMIT_MS, warning = IDLE_WARNING_MS): IdleState {
  const idle = Math.max(0, now - lastActive);
  if (idle >= limit) return { kind: 'expired' };
  if (idle >= limit - warning) return { kind: 'warning', secondsLeft: Math.ceil((limit - idle) / 1000) };
  return { kind: 'active' };
}

export function readLastActive(): number | null {
  try {
    const n = Number(localStorage.getItem(LAST_ACTIVE_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

export function writeLastActive(at: number): void {
  try { localStorage.setItem(LAST_ACTIVE_KEY, String(at)); } catch { /* private mode */ }
}

/** Remembered so the sign-in page can say why they are there. */
export function markIdleSignedOut(): void {
  try { sessionStorage.setItem(IDLE_FLAG_KEY, '1'); } catch { /* ignore */ }
}

export function takeIdleSignedOut(): boolean {
  try {
    const v = sessionStorage.getItem(IDLE_FLAG_KEY) === '1';
    sessionStorage.removeItem(IDLE_FLAG_KEY);
    return v;
  } catch { return false; }
}
