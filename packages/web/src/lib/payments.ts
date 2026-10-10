import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * "We take card payments" (Everton, 10 Oct 2026, point 6). Off by default.
 * While it is off, Card is left out of every list of ways to pay - driver's
 * stop, My route, counter sale, New order, Payments, invoice, customer
 * record. A card payment already recorded still shows as Card wherever it
 * is listed; `keep` leaves Card in a list that is showing one.
 */
let cached: boolean | null = null;
let pending: Promise<boolean> | null = null;

export function loadTakeCard(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (!pending) {
    pending = api.get<{ takeCard: boolean }>('/api/settings/payments')
      .then((r) => { cached = !!r.takeCard; return cached; })
      .catch(() => false)
      .finally(() => { pending = null; });
  }
  return pending;
}

/** After Settings changes it, so every list picks it up without a reload. */
export function setTakeCard(on: boolean): void { cached = on; }

export function useTakeCard(): boolean {
  const [on, setOn] = useState<boolean>(cached ?? false);
  useEffect(() => { let live = true; loadTakeCard().then((v) => { if (live) setOn(v); }); return () => { live = false; }; }, []);
  return on;
}

type Method = string | readonly [string, string];
const valueOf = (m: Method) => (typeof m === 'string' ? m : m[0]);

/** The list without Card, unless card payments are on (or `keep` is Card). */
export function payMethods<T extends Method>(list: readonly T[], takeCard: boolean, keep?: string | null): T[] {
  if (takeCard || keep === 'Card') return [...list];
  return list.filter((m) => valueOf(m) !== 'Card');
}
