import { api } from './api';

/**
 * Push notifications on this device (15 Oct 2026). See packages/api
 * services/push.ts for the server half and public/sw.js for the worker.
 */

export type PushState =
  | 'unsupported'    // this browser cannot do it at all
  | 'needs-https'    // only on the web address, not on the office computer's copy
  | 'needs-homescreen' // an iPhone: add to the Home Screen first
  | 'blocked'        // the person said no; only the browser's settings can undo it
  | 'off' | 'on';

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches
  || (navigator as unknown as { standalone?: boolean }).standalone === true;

export function pushPossible(): Exclude<PushState, 'off' | 'on' | 'blocked'> | null {
  if (!window.isSecureContext) return 'needs-https';
  if (isIos() && !standalone()) return 'needs-homescreen';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return null;
}

/** Make sure the worker is there, so pushes to an already-on device are shown. */
export async function ensureWorker(): Promise<ServiceWorkerRegistration | null> {
  if (pushPossible()) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
}

export async function pushState(): Promise<PushState> {
  const why = pushPossible();
  if (why) return why;
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await ensureWorker();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function keyBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone'
    : /Windows/.test(ua) ? 'Windows computer' : /Mac/.test(ua) ? 'Mac' : 'this device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${what}, ${browser}` : what;
}

export async function turnPushOn(): Promise<PushState> {
  const why = pushPossible();
  if (why) return why;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const reg = await ensureWorker();
  if (!reg) return 'unsupported';
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.get<{ publicKey: string }>('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  }
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await api.post('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys, device: deviceName() });
  return 'on';
}

export async function turnPushOff(): Promise<PushState> {
  const reg = await ensureWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  }
  return 'off';
}

export const PUSH_WORDS: Record<PushState, string> = {
  unsupported: 'This browser cannot show notifications. Chrome or Edge on a computer, Chrome on Android, or Safari on an iPhone can.',
  'needs-https': 'Notifications work on the web address (the Railway site, later your own domain), not on the copy running on the office computer.',
  'needs-homescreen': 'On an iPhone, first add Alka Vida to the Home Screen: tap Share, then Add to Home Screen. Open it from there and turn notifications on.',
  blocked: 'Notifications are blocked for Alka Vida in this browser. Allow them in the browser\'s site settings, then come back here.',
  off: 'Off on this device.',
  on: 'On for this device.',
};
