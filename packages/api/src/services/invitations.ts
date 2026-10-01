/**
 * Invitations: how somebody gets into an account without anyone handing them
 * a password.
 *
 * The office used to type a customer's password and read it down the phone.
 * That leaves the office knowing a password that can place credit orders, and
 * nothing ever obliged the customer to change it. Instead the account is
 * created with a password hash that cannot match anything, and a one-time
 * link lets the person set their own. Nobody else ever knows it.
 *
 * The token is treated exactly like a password: generated from real random
 * bytes, and only its HASH is stored. A copy of the invitations table must
 * not be a working set of keys to customer accounts.
 *
 * Email is a convenience, not the mechanism. The link is always returned to
 * whoever asked for the invitation, so an office with no mail account set up
 * can still read it down the phone or send it on WhatsApp - which is how this
 * will actually be used on day one.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mailConfigured, sendMail } from './documents.ts';
import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole, siteUrl } from './core.ts';
import { hashPassword } from '../lib/auth.ts';
import { RuleViolation } from '@alka/shared';

/** Long enough that guessing is hopeless; a URL-safe single token. */
const TOKEN_BYTES = 32;
const VALID_FOR_DAYS = 7;
const MIN_PASSWORD = 8;

/**
 * A password hash that can never match any password.
 *
 * verifyPassword only accepts `scrypt$salt$hash`, so anything else fails
 * closed. An account waiting on its invitation therefore cannot be signed
 * into at all, rather than being signed into with something guessable.
 */
export const UNUSABLE_PASSWORD = 'invited-not-yet-set';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export { mailConfigured };

/** Where the customer should be sent. Configurable for a real deployment. */
function portalBaseUrl(): string {
  return siteUrl();
}

export const invitationLink = (token: string) =>
  `${portalBaseUrl()}/#/set-password?token=${token}`;

/**
 * Issue an invitation for a user, replacing any outstanding one.
 *
 * Superseding rather than accumulating matters: if the office sends a second
 * invitation because the first went astray, the first must stop working. Two
 * live links to one account is one more than anybody intended.
 */
export async function createInvitation(
  db: Db, actor: Actor, userId: string,
): Promise<{ token: string; link: string; expiresAt: string; email: string; name: string }> {
  requireRole(actor, 'admin');

  const user = await db.one<{ email: string; name: string; active: boolean }>(
    `SELECT email, name, active FROM users WHERE id = $1`, [userId],
  );
  if (!user.active) {
    throw new RuleViolation(
      `${user.name}'s access has been withdrawn. Give it back before inviting them.`,
    );
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + VALID_FOR_DAYS * 24 * 3600 * 1000);

  await db.tx(async (t) => {
    // Any earlier link stops working now.
    await t.query(
      `UPDATE user_invitations SET used_at = now()
       WHERE user_id = $1 AND used_at IS NULL`, [userId],
    );
    await t.query(
      `INSERT INTO user_invitations (user_id, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3,$4)`,
      [userId, hashToken(token), expiresAt.toISOString(), actor.id],
    );
    await audit(t, actor, 'create', 'User', userId, user.name, { invitationSent: true });
  });

  return {
    token,
    link: invitationLink(token),
    expiresAt: expiresAt.toISOString(),
    email: user.email,
    name: user.name,
  };
}

/**
 * Who an unused invitation belongs to, for the page that asks them to choose
 * a password.
 *
 * Public, and therefore says as little as possible: a valid token returns the
 * name and address it was issued for, and anything else returns null. It
 * never reports WHY - expired, used, or invented - because that difference
 * only helps somebody testing tokens.
 */
export async function inviteeFor(
  db: Db, token: string,
): Promise<{ name: string; email: string; purpose: string } | null> {
  if (!token) return null;
  const row = await db.maybeOne<{ name: string; email: string; purpose: string }>(
    `SELECT u.name, u.email, i.purpose
     FROM user_invitations i JOIN users u ON u.id = i.user_id
     WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()
       AND u.active`,
    [hashToken(token)],
  );
  return row ?? null;
}

/**
 * Set a password from an invitation link. Public - the whole point is that
 * the person has no way in yet.
 */
export async function acceptInvitation(
  db: Db, token: string, newPassword: string,
): Promise<{ email: string }> {
  if (!newPassword || newPassword.length < MIN_PASSWORD) {
    throw new RuleViolation(`a password must be at least ${MIN_PASSWORD} characters`);
  }

  const hash = await hashPassword(newPassword);

  return db.tx(async (t) => {
    // Claim the invitation and the user together, so two submissions of the
    // same link cannot both succeed.
    const inv = await t.maybeOne<{ id: string; user_id: string }>(
      `SELECT i.id, i.user_id
       FROM user_invitations i JOIN users u ON u.id = i.user_id
       WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()
         AND u.active
       FOR UPDATE OF i`,
      [hashToken(token)],
    );
    if (!inv) {
      throw new RuleViolation(
        'this link is no longer valid. It may have been used already or expired - '
        + 'ask for a new one.',
      );
    }

    const user = await t.one<{ email: string; name: string }>(
      `SELECT email, name FROM users WHERE id = $1`, [inv.user_id],
    );
    await t.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [inv.user_id, hash]);
    await t.query(`UPDATE user_invitations SET used_at = now() WHERE id = $1`, [inv.id]);

    // Attributed to the person themselves - they are the one who acted.
    await audit(t, { id: inv.user_id, name: user.name, role: 'customer' },
      'update', 'User', inv.user_id, user.name, { passwordSetFromInvitation: true });

    return { email: user.email };
  });
}

/** Has this account got a live invitation outstanding? For the Logins screen. */
export async function pendingInvitations(db: Db): Promise<Record<string, string>> {
  const rows = await db.query<{ user_id: string; expires_at: string }>(
    `SELECT user_id, expires_at FROM user_invitations
     WHERE used_at IS NULL AND expires_at > now()`,
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, r.expires_at]));
}

/**
 * Send the link by email when a mail account is set up. Never throws: a
 * failure to send must not lose the invitation, because the link is valid
 * whether or not the email arrives, and the office has it either way.
 */
export async function emailInvitation(
  to: string, name: string, link: string,
): Promise<{ sent: boolean; reason?: string }> {
  if (!mailConfigured()) {
    return { sent: false, reason: 'no mail account is set up on this machine' };
  }
  try {
    await sendMail({
      to,
      subject: 'Your Alka Vida account',
      text:
        `Good day ${name},\n\n`
        + 'Your Alka Vida account is ready. Use the link below to choose your '
        + 'password and sign in:\n\n'
        + `${link}\n\n`
        + `The link works once and expires in ${VALID_FOR_DAYS} days.\n\n`
        + 'If you were not expecting this, you can ignore it.\n\n'
        + '1506 Investments Limited\n',
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : 'sending failed' };
  }
}

/**
 * "Forgotten your password?" on the sign-in page (team feedback, 1 Oct 2026).
 *
 * Anybody can ask, so the answer never says whether the address has an
 * account: it is the same whether a link went or not. The link is the same
 * one-time, hashed kind an invitation uses, valid for a day, and asking again
 * replaces it. Nothing happens to the current password until the link is used,
 * so a stranger asking on somebody's behalf achieves nothing.
 */
export async function requestPasswordReset(
  db: Db, email: string,
): Promise<{ sent: boolean; reason?: string }> {
  const address = (email ?? '').trim().toLowerCase();
  if (!address.includes('@')) return { sent: false, reason: 'no address' };

  const user = await db.maybeOne<{ id: string; name: string; email: string }>(
    `SELECT id, name, email FROM users
     WHERE lower(email) = $1 AND active AND email NOT LIKE '%@alkavida.local'`,
    [address],
  );
  if (!user) return { sent: false, reason: 'no such login' };

  // One a minute is plenty; this also stops the button being used to flood
  // somebody's inbox.
  const recent = await db.maybeOne(
    `SELECT 1 FROM user_invitations
     WHERE user_id = $1 AND purpose = 'reset' AND created_at > now() - interval '1 minute'`,
    [user.id],
  );
  if (recent) return { sent: false, reason: 'asked a moment ago' };
  if (!mailConfigured()) return { sent: false, reason: 'no mail account is set up' };

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await db.tx(async (t) => {
    await t.query(
      `UPDATE user_invitations SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );
    await t.query(
      `INSERT INTO user_invitations (user_id, token_hash, expires_at, created_by, purpose)
       VALUES ($1,$2,$3,$1,'reset')`,
      [user.id, hashToken(token), expiresAt.toISOString()],
    );
    await audit(t, { id: user.id, name: user.name, role: 'customer' },
      'update', 'User', user.id, user.name, { passwordResetRequested: true });
  });

  try {
    await sendMail({
      to: user.email,
      subject: 'Reset your Alka Vida password',
      text:
        `Good day ${user.name},\n\n`
        + 'Somebody (hopefully you) asked to reset the password for your Alka Vida '
        + 'account. Use the link below to choose a new one:\n\n'
        + `${invitationLink(token)}\n\n`
        + 'The link works once and expires in 24 hours. If you did not ask for this, '
        + 'ignore this email: your password has not changed.\n\n'
        + '1506 Investments Limited\n',
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : 'sending failed' };
  }
}
