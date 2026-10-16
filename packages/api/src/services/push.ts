/**
 * Push notifications to staff phones and computers (Everton, 15 Oct 2026).
 *
 * Web push, the way a web app reaches a lock screen without an app store:
 * the browser gives us an address at its push service (Google's for Chrome
 * and Android, Apple's for iPhone, Mozilla's for Firefox) and we knock on it.
 *
 * The knock carries NO message. That keeps this free of any library and of
 * the encryption a message would need: the phone's service worker wakes,
 * asks /api/push/inbox for its unread notes (signed in as that person, with
 * their own cookie) and shows them. The knock is signed with this install's
 * own VAPID key pair, made the first time it is needed and kept in
 * system_settings, so nothing has to be set up on Railway by hand.
 */

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { contactEmail, getSetting } from './core.ts';
import { RuleViolation } from '@alka/shared';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** This install's key pair: the public half goes to browsers, the private half signs. */
export async function vapidKeys(db: Db): Promise<{ publicKey: string; privatePem: string }> {
  const pub = await getSetting(db, 'vapid_public_key', '');
  const priv = await getSetting(db, 'vapid_private_pem', '');
  if (pub && priv) return { publicKey: pub, privatePem: priv };
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const keys = { publicKey: b64url(raw), privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
  // Two copies starting at once must not end with different keys: keep whichever landed first.
  await db.query(`INSERT INTO system_settings (key, value) VALUES ('vapid_public_key', $1) ON CONFLICT (key) DO NOTHING`, [keys.publicKey]);
  await db.query(`INSERT INTO system_settings (key, value) VALUES ('vapid_private_pem', $1) ON CONFLICT (key) DO NOTHING`, [keys.privatePem]);
  return { publicKey: await getSetting(db, 'vapid_public_key', keys.publicKey), privatePem: await getSetting(db, 'vapid_private_pem', keys.privatePem) };
}

/** The signed "it is us" header for one push service. */
function vapidHeader(endpoint: string, keys: { publicKey: string; privatePem: string }, subject: string): string {
  const aud = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const data = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(data), { key: createPrivateKey(keys.privatePem), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** Tests replace the network with this. */
let knockSink: ((endpoint: string, headers: Record<string, string>) => Promise<number>) | null = null;
export function setPushSink(fn: typeof knockSink): void { knockSink = fn; }

export interface Note { title: string; body?: string; url?: string; tag?: string }

/**
 * Leave a note for each person and knock on every device they turned
 * notifications on for. Best effort: a device that has gone away (404/410)
 * is forgotten; anything else is recorded on the subscription and tried
 * again next time.
 */
export async function notifyUsers(db: Db, userIds: readonly string[], note: Note): Promise<{ notes: number; knocked: number }> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return { notes: 0, knocked: 0 };
  for (const id of ids) {
    await db.query(
      `INSERT INTO staff_notifications (user_id, title, body, url, tag) VALUES ($1,$2,$3,$4,$5)`,
      [id, note.title, note.body ?? '', note.url ?? null, note.tag ?? null],
    );
  }
  const subs = await db.query<{ id: string; endpoint: string }>(
    `SELECT s.id, s.endpoint FROM push_subscriptions s JOIN users u ON u.id = s.user_id
     WHERE s.user_id = ANY($1::uuid[]) AND u.active`, [ids],
  );
  if (subs.length === 0) return { notes: ids.length, knocked: 0 };
  const keys = await vapidKeys(db);
  const subject = `mailto:${await contactEmail(db)}`;
  let knocked = 0;
  for (const s of subs) {
    const headers = { TTL: '86400', Urgency: 'high', Authorization: vapidHeader(s.endpoint, keys, subject), 'Content-Length': '0' };
    try {
      const status = knockSink
        ? await knockSink(s.endpoint, headers)
        : (await fetch(s.endpoint, { method: 'POST', headers, signal: AbortSignal.timeout(10_000) })).status;
      if (status === 404 || status === 410) {
        await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
      } else if (status >= 200 && status < 300) {
        knocked++;
        await db.query(`UPDATE push_subscriptions SET last_ok_at = now(), last_error = NULL WHERE id = $1`, [s.id]);
      } else {
        await db.query(`UPDATE push_subscriptions SET last_error = $2 WHERE id = $1`, [s.id, `push service said ${status}`]);
      }
    } catch (err) {
      await db.query(`UPDATE push_subscriptions SET last_error = $2 WHERE id = $1`, [s.id, (err as Error).message.slice(0, 200)]);
    }
  }
  return { notes: ids.length, knocked };
}

/** Everyone active in these roles. */
export async function usersInRoles(t: Queryable, roles: readonly string[]): Promise<Array<{ id: string; name: string; email: string; decision_emails: boolean }>> {
  return t.query(
    `SELECT id, name, email, decision_emails FROM users WHERE active AND role = ANY($1::text[])`, [[...roles]],
  );
}

/* ---------------- what the browser calls ---------------- */

export async function subscribe(
  db: Db, actor: Actor,
  input: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; device?: string | null },
): Promise<{ ok: true }> {
  if (actor.role === 'customer') throw new RuleViolation('notifications are for staff logins for now');
  const endpoint = String(input.endpoint ?? '').trim();
  if (!/^https:\/\//.test(endpoint)) throw new RuleViolation('this browser did not give a push address');
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth, device = EXCLUDED.device, last_error = NULL`,
    [actor.id, endpoint, input.keys?.p256dh ?? null, input.keys?.auth ?? null, (input.device ?? '').slice(0, 120) || null],
  );
  return { ok: true };
}

export async function unsubscribe(db: Db, actor: Actor, endpoint: string): Promise<{ ok: true }> {
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, actor.id]);
  return { ok: true };
}

/**
 * The unread notes for whoever is signed in on this device; read once. With
 * none unread (a second device, or a second knock for notes already taken),
 * the latest one again: a phone must show something for every knock, and
 * shown under the same tag it replaces itself rather than doubling up.
 */
export async function takeInbox(db: Db, actor: Actor) {
  const fresh = await db.query<{ id: string; title: string; body: string; url: string | null; tag: string | null }>(
    `UPDATE staff_notifications SET shown_at = now()
     WHERE id IN (SELECT id FROM staff_notifications
                  WHERE user_id = $1 AND shown_at IS NULL AND created_at > now() - interval '2 days'
                  ORDER BY created_at LIMIT 10)
     RETURNING id, title, body, url, tag`, [actor.id],
  );
  if (fresh.length) return fresh;
  return db.query<{ id: string; title: string; body: string; url: string | null; tag: string | null }>(
    `SELECT id, title, body, url, tag FROM staff_notifications
     WHERE user_id = $1 AND created_at > now() - interval '10 minutes' ORDER BY created_at DESC LIMIT 1`, [actor.id],
  );
}

export async function myDevices(db: Db, actor: Actor) {
  return db.query(
    `SELECT id, device, created_at, last_ok_at, last_error, endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
    [actor.id],
  );
}
