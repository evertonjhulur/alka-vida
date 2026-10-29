import { useEffect, useRef } from 'react';

/**
 * The send screen (Everton, 28 Oct 2026): "Email..." opens a screen in a new
 * tab, like View PDF, with the email written and the document attached.
 * Call these straight from the click (a pop-up blocker allows a tab opened
 * inside a click, not after an await).
 */

export type SendKind = 'invoice' | 'invoices' | 'statement' | 'quote' | 'receipt' | 'purchase-order' | 'order';
export type BatchKind = 'invoices' | 'receipts' | 'quotes' | 'purchase-orders';

export interface SendRef {
  kind: SendKind;
  ids: string[];
  from?: string | null;
  to?: string | null;
  filter?: string | null;
  status?: string | null;
}

export function refQuery(ref: SendRef): string {
  const q = new URLSearchParams();
  q.set('kind', ref.kind);
  q.set('ids', ref.ids.join(','));
  if (ref.from) q.set('from', ref.from);
  if (ref.to) q.set('to', ref.to);
  if (ref.filter && ref.filter !== 'All') q.set('filter', ref.filter);
  if (ref.status) q.set('status', ref.status);
  return q.toString();
}

function openTab(hashPath: string): void {
  const url = `${window.location.pathname}${window.location.search}#${hashPath}`;
  const win = window.open(url, '_blank');
  // A blocked pop-up: open it here instead, so the email is never lost.
  if (!win) window.location.hash = hashPath;
}

/** One document's email, in a new tab. */
export function openSend(ref: SendRef): void {
  openTab(`/send?${refQuery(ref)}`);
}

/** Several ticked on a list: one email at a time, in a new tab. */
export function openBatchSend(kind: BatchKind, ids: string[]): void {
  const q = new URLSearchParams();
  q.set('batch', kind);
  q.set('ids', ids.join(','));
  openTab(`/send?${q.toString()}`);
}

const CHANNEL = 'alkavida-sent';

/** Tells the other tabs something was emailed, so their lists show it Sent. */
export function announceSent(ref: SendRef): void {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ kind: ref.kind, ids: ref.ids });
    ch.close();
  } catch { /* an old browser: the list updates when next opened */ }
}

/** Reload this screen's data when the send tab says something went. */
export function useSentRefresh(reload: () => void): void {
  const fn = useRef(reload);
  fn.current = reload;
  useEffect(() => {
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = () => fn.current();
    } catch { /* no BroadcastChannel */ }
    return () => { try { ch?.close(); } catch { /* ignore */ } };
  }, []);
}
