/**
 * User administration (Section 10).
 *
 * Who can sign in, as what, and whether they still may. Admin only, with one
 * exception: anybody may change their own password.
 *
 * Two rules shape everything here.
 *
 * A user is NEVER deleted. Every write in the system ends by inserting an
 * audit_log row that references users(id), so removing a person would either
 * be refused by the database or would take their history with them. Access
 * is withdrawn by clearing `active`, which is checked at login and on every
 * authenticated request, so it bites immediately.
 *
 * The system must always be reachable. It is far too easy for the only
 * administrator to deactivate themselves, or to demote themselves in a
 * moment of tidying, and lock the business out of its own operations system
 * with no way back in short of editing the database by hand. Every path that
 * could do that is refused.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole } from './core.ts';
import { hashPassword, verifyPassword } from '../lib/auth.ts';
import { ROLES, type Role, RuleViolation } from '@alka/shared';

/** Short enough to be typed by hand, long enough not to be guessed at once. */
const MIN_PASSWORD = 8;

/**
 * The account the system attributes its own work to - raising standing
 * orders overnight, for instance. Not a person: its password hash is
 * deliberately not a valid one and it is kept inactive, so it can never be
 * signed into.
 *
 * It is hidden from user administration and refused by every write here.
 * Listing it would invite somebody to reset its password and switch it back
 * on, and between them those two buttons turn a machine account into a live
 * administrator called "Alka Vida (automatic)". It still appears in the
 * audit log, which is the entire reason it exists.
 */
export const SYSTEM_USER_EMAIL = 'system@alkavida.local';

async function assertNotSystemAccount(db: Db, userId: string): Promise<void> {
  const row = await db.maybeOne<{ email: string }>(
    `SELECT email FROM users WHERE id = $1`, [userId],
  );
  if (row?.email === SYSTEM_USER_EMAIL) {
    throw new RuleViolation(
      'that is Alka Vida\'s own account for work it does automatically, not a person. '
      + 'It cannot be signed into and must not be changed.',
    );
  }
}

export interface UserInput {
  email: string;
  name: string;
  role: Role;
  password: string;
  /** Required for a portal login, refused for any other role. */
  customerId?: string | null;
}

function assertPassword(password: string): void {
  if (!password || password.length < MIN_PASSWORD) {
    throw new RuleViolation(`a password must be at least ${MIN_PASSWORD} characters`);
  }
}

function assertRole(role: string): asserts role is Role {
  if (!ROLES.includes(role as Role)) {
    throw new RuleViolation(`"${role}" is not a role`);
  }
}

/**
 * Refuse anything that would leave the system with no way in.
 *
 * Counts only OTHER administrators, so it catches both halves of the
 * problem: deactivating the last admin, and demoting them to office staff.
 */
async function assertNotLastAdmin(db: Db, userId: string, what: string): Promise<void> {
  const target = await db.maybeOne<{ role: Role; active: boolean }>(
    `SELECT role, active FROM users WHERE id = $1`, [userId],
  );
  if (!target || target.role !== 'admin' || !target.active) return;

  const others = await db.one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM users
     WHERE role = 'admin' AND active AND id <> $1`, [userId],
  );
  if (Number(others.n) === 0) {
    throw new RuleViolation(
      `this is the only active administrator - ${what} would lock everybody out. `
      + 'Make somebody else an administrator first.',
    );
  }
}

/** Case-insensitive, because that is how login looks an address up. */
async function assertEmailFree(db: Db, email: string, exceptUserId?: string): Promise<void> {
  const clash = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [email, exceptUserId ?? null],
  );
  if (clash.length > 0) {
    throw new RuleViolation(`${email} is already used by another login`);
  }
}

export async function listUsers(db: Db, actor: Actor) {
  requireRole(actor, 'admin');
  return db.query(
    `SELECT u.id, u.email, u.name, u.role, u.active,
            u.created_at, u.last_login_at,
            c.id   AS customer_id,
            c.name AS customer_name
     FROM users u
     LEFT JOIN customers c ON c.user_id = u.id AND c.active
     WHERE u.email <> $1
     ORDER BY u.active DESC, u.role, u.name`,
    [SYSTEM_USER_EMAIL],
  );
}

export async function createUser(
  db: Db, actor: Actor, input: UserInput,
): Promise<{ id: string }> {
  requireRole(actor, 'admin');

  const email = input.email?.trim();
  const name = input.name?.trim();
  if (!email) throw new RuleViolation('a login needs an email address');
  if (!name) throw new RuleViolation('a login needs a name');
  assertRole(input.role);
  assertPassword(input.password);
  await assertEmailFree(db, email);

  // A portal login that is not attached to a customer can sign in and then
  // see nothing at all, which looks like a broken system rather than a
  // half-finished setup. Attach it here or not at all.
  if (input.role === 'customer' && !input.customerId) {
    throw new RuleViolation('a customer login must say which customer it is for');
  }
  if (input.role !== 'customer' && input.customerId) {
    throw new RuleViolation('only a customer login can be attached to a customer');
  }

  const hash = await hashPassword(input.password);

  return db.tx(async (t) => {
    if (input.customerId) {
      const taken = await t.query<{ id: string }>(
        `SELECT id FROM customers WHERE id = $1 AND user_id IS NOT NULL`, [input.customerId],
      );
      if (taken.length > 0) {
        throw new RuleViolation('that customer already has a portal login');
      }
    }

    const row = await t.one<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, name, hash, input.role],
    );
    if (input.customerId) {
      await t.query(`UPDATE customers SET user_id = $2 WHERE id = $1`,
        [input.customerId, row.id]);
    }
    await audit(t, actor, 'create', 'User', row.id, name,
      { email, role: input.role, customerId: input.customerId ?? null });
    return { id: row.id };
  });
}

/**
 * Change a person's name, address or role. Not their password - that is
 * `resetPassword`, so that a routine edit cannot change it by accident.
 */
export async function updateUser(
  db: Db, actor: Actor, userId: string,
  input: Partial<Pick<UserInput, 'email' | 'name' | 'role'>>,
): Promise<void> {
  requireRole(actor, 'admin');
  await assertNotSystemAccount(db, userId);

  const before = await db.one<{ name: string; role: Role }>(
    `SELECT name, role FROM users WHERE id = $1`, [userId],
  );

  const sets: string[] = [];
  const args: unknown[] = [userId];
  const set = (col: string, value: unknown) => {
    args.push(value);
    sets.push(`${col} = $${args.length}`);
  };

  if ('email' in input) {
    const email = input.email?.trim();
    if (!email) throw new RuleViolation('a login needs an email address');
    await assertEmailFree(db, email, userId);
    set('email', email);
  }
  if ('name' in input) {
    if (!input.name?.trim()) throw new RuleViolation('a login needs a name');
    set('name', input.name.trim());
  }
  if ('role' in input && input.role != null && input.role !== before.role) {
    assertRole(input.role);
    if (userId === actor.id) {
      throw new RuleViolation(
        'you cannot change your own role - ask another administrator to do it',
      );
    }
    if (before.role === 'customer' || input.role === 'customer') {
      throw new RuleViolation(
        'a portal login cannot be turned into a staff login, or the other way about. '
        + 'Deactivate it and create the one you want.',
      );
    }
    await assertNotLastAdmin(db, userId, 'changing their role');
    set('role', input.role);
  }

  if (sets.length === 0) return;

  await db.tx(async (t) => {
    await t.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, args);
    await audit(t, actor, 'update', 'User', userId, input.name ?? before.name, input);
  });
}

/**
 * Withdraw or restore access.
 *
 * Deactivating is how somebody leaves: the account and everything they did
 * stays, and they can no longer sign in or use a token they already hold.
 */
export async function setUserActive(
  db: Db, actor: Actor, userId: string, active: boolean,
): Promise<void> {
  requireRole(actor, 'admin');
  await assertNotSystemAccount(db, userId);

  if (!active) {
    if (userId === actor.id) {
      throw new RuleViolation('you cannot deactivate yourself');
    }
    await assertNotLastAdmin(db, userId, 'deactivating them');
  }

  await db.tx(async (t) => {
    const u = await t.one<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [userId]);
    await t.query(`UPDATE users SET active = $2 WHERE id = $1`, [userId, active]);
    await audit(t, actor, 'update', 'User', userId, u.name, { active });
  });
}

/** An administrator setting somebody else's password, for a person locked out. */
export async function resetPassword(
  db: Db, actor: Actor, userId: string, newPassword: string,
): Promise<void> {
  requireRole(actor, 'admin');
  await assertNotSystemAccount(db, userId);
  assertPassword(newPassword);
  const hash = await hashPassword(newPassword);

  await db.tx(async (t) => {
    const u = await t.one<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [userId]);
    await t.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, hash]);
    // Never record the password itself, only that it was changed and by whom.
    await audit(t, actor, 'update', 'User', userId, u.name, { passwordReset: true });
  });
}

/**
 * Anybody changing their own password, which is why this is the one function
 * here that is not admin-only. The current password is required: a browser
 * left signed in on the packing floor must not be enough to take an account
 * over permanently.
 */
export async function changeOwnPassword(
  db: Db, actor: Actor, currentPassword: string, newPassword: string,
): Promise<void> {
  assertPassword(newPassword);
  if (currentPassword === newPassword) {
    throw new RuleViolation('the new password must be different from the current one');
  }

  const me = await db.one<{ password_hash: string; name: string }>(
    `SELECT password_hash, name FROM users WHERE id = $1`, [actor.id],
  );
  if (!(await verifyPassword(currentPassword, me.password_hash))) {
    throw new RuleViolation('the current password is not right');
  }

  const hash = await hashPassword(newPassword);
  await db.tx(async (t) => {
    await t.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [actor.id, hash]);
    await audit(t, actor, 'update', 'User', actor.id, me.name, { passwordChanged: true });
  });
}
