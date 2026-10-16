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
import { businessTimeNow, contactEmail, getSetting, requireRole } from './core.ts';
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

/** Inside quiet hours now? from 22:00 to 06:00 runs over midnight. */
export function inQuietHours(from: string | null, to: string | null, now = businessTimeNow()): boolean {
  if (!from || !to || from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * Leave a note for each person and knock on every device they turned
 * notifications on for. Someone inside their quiet hours gets the note but
 * no knock: knockHeld() knocks once their quiet hours are over, and their
 * phone then shows everything that came in.
 */
export async function notifyUsers(db: Db, userIds: readonly string[], note: Note): Promise<{ notes: number; knocked: number }> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return { notes: 0, knocked: 0 };
  const people = await db.query<{ id: string; quiet_from: string | null; quiet_to: string | null }>(
    `SELECT id, quiet_from, quiet_to FROM users WHERE id = ANY($1::uuid[])`, [ids]);
  const awake = people.filter((p) => !inQuietHours(p.quiet_from, p.quiet_to)).map((p) => p.id);
  for (const id of ids) {
    await db.query(
      `INSERT INTO staff_notifications (user_id, title, body, url, tag, knocked_at)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $6 THEN now() END)`,
      [id, note.title, note.body ?? '', note.url ?? null, note.tag ?? null, awake.includes(id)],
    );
  }
  return { notes: ids.length, knocked: await knock(db, awake) };
}

/** Knock on every device these people have. */
async function knock(db: Db, userIds: readonly string[]): Promise<number> {
  if (userIds.length === 0) return 0;
  const subs = await db.query<{ id: string; endpoint: string }>(
    `SELECT s.id, s.endpoint FROM push_subscriptions s JOIN users u ON u.id = s.user_id
     WHERE s.user_id = ANY($1::uuid[]) AND u.active`, [[...userIds]],
  );
  if (subs.length === 0) return 0;
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
  return knocked;
}

/** Quiet hours over: knock once for whatever was held for each person. */
export async function knockHeld(db: Db): Promise<number> {
  const held = await db.query<{ user_id: string; quiet_from: string | null; quiet_to: string | null }>(
    `SELECT DISTINCT n.user_id, u.quiet_from, u.quiet_to
     FROM staff_notifications n JOIN users u ON u.id = n.user_id
     WHERE n.knocked_at IS NULL AND n.shown_at IS NULL AND n.created_at > now() - interval '1 day'`,
  );
  const due = held.filter((h) => !inQuietHours(h.quiet_from, h.quiet_to)).map((h) => h.user_id);
  if (due.length === 0) return 0;
  await db.query(`UPDATE staff_notifications SET knocked_at = now() WHERE user_id = ANY($1::uuid[]) AND knocked_at IS NULL`, [due]);
  return knock(db, due);
}

/** Everyone active in these roles. */
export interface AlertPerson {
  id: string; name: string; email: string; role: string;
  decision_emails: boolean; notify_orders: boolean; notify_decisions: boolean; notify_load: boolean;
}
export async function usersInRoles(t: Queryable, roles: readonly string[]): Promise<AlertPerson[]> {
  return t.query(
    `SELECT id, name, email, role, decision_emails, notify_orders, notify_decisions, notify_load
     FROM users WHERE active AND role = ANY($1::text[])`, [[...roles]],
  );
}

/* ---------------- who gets what (15 Oct 2026) ---------------- */

/** The kinds, and who can have each. */
export const ALERT_KINDS = {
  orders: { roles: ['admin', 'user'], column: 'notify_orders' },
  decisions: { roles: ['admin'], column: 'notify_decisions' },
  decisionEmails: { roles: ['admin'], column: 'decision_emails' },
  load: { roles: ['driver'], column: 'notify_load' },
} as const;
export type AlertKind = keyof typeof ALERT_KINDS;

export interface AlertSettings {
  userId: string; name: string; email: string; role: string; active: boolean;
  orders: boolean; decisions: boolean; decisionEmails: boolean; load: boolean;
  quietFrom: string | null; quietTo: string | null; devices: number;
}

const SETTINGS_SQL = `
  SELECT u.id, u.name, u.email, u.role, u.active, u.notify_orders, u.notify_decisions, u.decision_emails,
         u.notify_load, u.quiet_from, u.quiet_to,
         (SELECT COUNT(*)::int FROM push_subscriptions s WHERE s.user_id = u.id) AS devices
  FROM users u`;
const toSettings = (r: Record<string, unknown>): AlertSettings => ({
  userId: r.id as string, name: r.name as string, email: r.email as string, role: r.role as string,
  active: !!r.active, orders: !!r.notify_orders, decisions: !!r.notify_decisions,
  decisionEmails: !!r.decision_emails, load: !!r.notify_load,
  quietFrom: (r.quiet_from as string) ?? null, quietTo: (r.quiet_to as string) ?? null, devices: Number(r.devices) || 0,
});

export async function alertSettingsFor(db: Db, userId: string): Promise<AlertSettings> {
  return toSettings(await db.one(`${SETTINGS_SQL} WHERE u.id = $1`, [userId]));
}

/** Every staff login, for an admin setting who gets what. */
export async function allAlertSettings(db: Db, actor: Actor): Promise<AlertSettings[]> {
  requireRole(actor, 'admin');
  const rows = await db.query(`${SETTINGS_SQL} WHERE u.role IN ('admin','user','driver') AND u.active ORDER BY
    CASE u.role WHEN 'admin' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, u.name`);
  return rows.map(toSettings);
}

const HM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Change someone's notification settings: their own, or anyone's for an
 * admin. Only the kinds their role can receive are changed.
 */
export async function setAlertSettings(
  db: Db, actor: Actor, userId: string,
  input: Partial<Pick<AlertSettings, 'orders' | 'decisions' | 'decisionEmails' | 'load' | 'quietFrom' | 'quietTo'>>,
): Promise<AlertSettings> {
  if (userId !== actor.id) requireRole(actor, 'admin');
  const u = await db.maybeOne<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [userId]);
  if (!u) throw new RuleViolation('that login no longer exists');
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  for (const k of ['orders', 'decisions', 'decisionEmails', 'load'] as const) {
    if (input[k] === undefined) continue;
    const def = ALERT_KINDS[k];
    if (!(def.roles as readonly string[]).includes(u.role)) continue;
    vals.push(input[k] === true);
    sets.push(`${def.column} = $${vals.length}`);
  }
  if (input.quietFrom !== undefined || input.quietTo !== undefined) {
    const from = (input.quietFrom ?? '').trim() || null;
    const to = (input.quietTo ?? '').trim() || null;
    if ((from && !HM.test(from)) || (to && !HM.test(to))) throw new RuleViolation('quiet hours need times like 22:00');
    if ((from === null) !== (to === null)) throw new RuleViolation('give quiet hours both a start and an end, or neither');
    vals.push(from); sets.push(`quiet_from = $${vals.length}`);
    vals.push(to); sets.push(`quiet_to = $${vals.length}`);
  }
  if (sets.length) await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
  return alertSettingsFor(db, userId);
}

/** Take a device off: the person's own, or anyone's for an admin. */
export async function removeDevice(db: Db, actor: Actor, deviceId: string): Promise<{ ok: true }> {
  const d = await db.maybeOne<{ user_id: string }>(`SELECT user_id FROM push_subscriptions WHERE id = $1`, [deviceId]);
  if (!d) return { ok: true };
  if (d.user_id !== actor.id) requireRole(actor, 'admin');
  await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [deviceId]);
  return { ok: true };
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

export async function myDevices(db: Db, actor: Actor, userId: string = actor.id) {
  if (userId !== actor.id) requireRole(actor, 'admin');
  return db.query(
    `SELECT id, device, created_at, last_ok_at, last_error, endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
}
