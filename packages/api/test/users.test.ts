/**
 * User administration.
 *
 * The rules worth pinning are the ones that keep the business able to get
 * back in: an administrator must not be able to lock everybody out, and
 * withdrawing access must actually withdraw it rather than wait for a token
 * to expire.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import {
  listUsers, createUser, updateUser, setUserActive, resetPassword, changeOwnPassword,
  SYSTEM_USER_EMAIL,
} from '../src/services/users.ts';
import { loadSigningKey, login, userAccess } from '../src/lib/auth.ts';
import type { Actor } from '../src/services/core.ts';

let db: Db;
let admin: Actor;
let office: Actor;

const actorFor = async (email: string): Promise<Actor> => {
  const u = await db.one<{ id: string; name: string; role: Actor['role'] }>(
    `SELECT id, name, role FROM users WHERE email = $1`, [email]);
  return { id: u.id, name: u.name, role: u.role };
};

before(async () => {
  db = await createPgliteDb();
  await migrate(db, { quiet: true });
  await seed(db, { quiet: true });
  // login() mints a token, so the per-install signing key has to be loaded.
  await loadSigningKey(db);
  admin = await actorFor('admin@alkavida.jm');
  office = await actorFor('office@alkavida.jm');
});
after(async () => { await db.close(); });

describe('Only an administrator may manage logins', () => {
  test('office staff cannot list, create or deactivate', async () => {
    await assert.rejects(() => listUsers(db, office), /requires role admin/);
    await assert.rejects(
      () => createUser(db, office, {
        email: 'x@alkavida.jm', name: 'X', role: 'user', password: 'password1',
      }),
      /requires role admin/,
    );
    await assert.rejects(() => setUserActive(db, office, admin.id, false), /requires role admin/);
  });
});

describe('Adding a member of staff', () => {
  test('a new login can sign in, and shows as never used until they do', async () => {
    const { id } = await createUser(db, admin, {
      email: 'Nadia@alkavida.jm', name: 'Nadia Brown', role: 'user', password: 'freshpass1',
    });

    const before = (await listUsers(db, admin))
      .find((u) => (u as { id: string }).id === id) as { last_login_at: string | null };
    assert.equal(before.last_login_at, null, 'a login nobody has used reads as never used');

    const signedIn = await login(db, 'nadia@alkavida.jm', 'freshpass1');
    assert.ok(signedIn, 'the address is matched however it was capitalised');
    assert.equal(signedIn.session.role, 'user');

    const after = (await listUsers(db, admin))
      .find((u) => (u as { id: string }).id === id) as { last_login_at: string | null };
    assert.notEqual(after.last_login_at, null, 'and stamps the moment once used');
  });

  test('an address already in use is refused, whatever its capitals', async () => {
    await assert.rejects(
      () => createUser(db, admin, {
        email: 'ADMIN@alkavida.jm', name: 'Impostor', role: 'admin', password: 'password1',
      }),
      /already used/,
      'login matches an address case-insensitively, so two rows would be ambiguous',
    );
  });

  test('a password that is too short is refused', async () => {
    await assert.rejects(
      () => createUser(db, admin, {
        email: 'short@alkavida.jm', name: 'Short', role: 'driver', password: 'abc',
      }),
      /at least 8/,
    );
  });

  test('a portal login must say which customer it is for', async () => {
    await assert.rejects(
      () => createUser(db, admin, {
        email: 'portal2@alkavida.jm', name: 'No Customer', role: 'customer',
        password: 'password1',
      }),
      /must say which customer/,
      'a portal login with no customer signs in and then sees nothing at all',
    );
  });

  test('a staff login cannot be attached to a customer', async () => {
    const c = await db.one<{ id: string }>(`SELECT id FROM customers LIMIT 1`);
    await assert.rejects(
      () => createUser(db, admin, {
        email: 'mixed@alkavida.jm', name: 'Mixed', role: 'driver',
        password: 'password1', customerId: c.id,
      }),
      /only a customer login/,
    );
  });
});

describe('The system can never be locked out', () => {
  test('the last active administrator cannot be deactivated', async () => {
    const others = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'admin' AND active AND id <> $1`, [admin.id]);
    for (const o of others) await setUserActive(db, admin, o.id, false);

    const second = await createUser(db, admin, {
      email: 'second.admin@alkavida.jm', name: 'Second Admin', role: 'admin',
      password: 'password1',
    });
    // With a second admin in place the first may go...
    await setUserActive(db, admin, second.id, false);

    // ...but now the original is the only one left, and may not.
    const secondActor = await actorFor('second.admin@alkavida.jm');
    await setUserActive(db, admin, second.id, true);
    await setUserActive(db, secondActor, admin.id, false);

    await assert.rejects(
      () => setUserActive(db, admin, second.id, false),
      /only active administrator/,
      'deactivating the last administrator would lock the business out',
    );
    await setUserActive(db, secondActor, admin.id, true);
  });

  test('an administrator cannot deactivate themselves', async () => {
    await assert.rejects(
      () => setUserActive(db, admin, admin.id, false),
      /cannot deactivate yourself/,
    );
  });

  test('an administrator cannot change their own role', async () => {
    await assert.rejects(
      () => updateUser(db, admin, admin.id, { role: 'user' }),
      /cannot change your own role/,
      'demoting yourself is the quiet way to lock yourself out',
    );
  });

  test('a portal login cannot be turned into staff, or the other way about', async () => {
    const portal = await db.one<{ id: string }>(
      `SELECT id FROM users WHERE role = 'customer' LIMIT 1`);
    await assert.rejects(
      () => updateUser(db, admin, portal.id, { role: 'admin' }),
      /cannot be turned into/,
    );
  });
});

/**
 * Found by opening the screen: the account the system attributes its own
 * overnight work to was listed as though it were a member of staff. Reset
 * its password and switch it on and you have a live administrator called
 * "Alka Vida (automatic)" that nobody created.
 */
describe("Alka Vida's own account is not a person", () => {
  const systemId = async () => (await db.one<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`, [SYSTEM_USER_EMAIL])).id;

  before(async () => {
    await db.query(
      `INSERT INTO users (email, name, password_hash, role, active)
       VALUES ($1, 'Alka Vida (automatic)', 'x-not-a-login', 'admin', false)
       ON CONFLICT (email) DO NOTHING`, [SYSTEM_USER_EMAIL]);
  });

  test('it is not offered as a login to manage', async () => {
    const listed = await listUsers(db, admin);
    assert.equal(
      listed.some((u) => (u as { email: string }).email === SYSTEM_USER_EMAIL), false,
    );
  });

  test('its password cannot be reset into a working one', async () => {
    const id = await systemId();
    await assert.rejects(
      () => resetPassword(db, admin, id, 'password1'),
      /not a person/,
      'a valid hash would turn the machine account into a real admin login',
    );
  });

  test('it cannot be switched on, nor edited', async () => {
    const id = await systemId();
    await assert.rejects(() => setUserActive(db, admin, id, true), /not a person/);
    await assert.rejects(() => updateUser(db, admin, id, { name: 'Mine now' }), /not a person/);
  });

  test('and it still cannot be signed into', async () => {
    assert.equal(await login(db, SYSTEM_USER_EMAIL, 'password1'), null);
    assert.equal(await login(db, SYSTEM_USER_EMAIL, 'x-not-a-login'), null);
  });
});

describe('Withdrawing access', () => {
  test('a deactivated user cannot sign in, and a token they already hold stops working',
    async () => {
      const { id } = await createUser(db, admin, {
        email: 'leaver@alkavida.jm', name: 'A Leaver', role: 'driver', password: 'password1',
      });
      const signedIn = await login(db, 'leaver@alkavida.jm', 'password1');
      assert.ok(signedIn, 'signs in while still employed');
      assert.equal(await userAccess(db, id), 'ok');

      await setUserActive(db, admin, id, false);

      assert.equal(await login(db, 'leaver@alkavida.jm', 'password1'), null,
        'cannot sign in again');
      assert.equal(await userAccess(db, id), 'disabled',
        'and the token they are still holding is refused on the next request, '
        + 'rather than working until it expires that evening');
    });

  test('access can be given back', async () => {
    const u = await db.one<{ id: string }>(
      `SELECT id FROM users WHERE email = 'leaver@alkavida.jm'`);
    await setUserActive(db, admin, u.id, true);
    assert.equal(await userAccess(db, u.id), 'ok');
  });
});

describe('Passwords', () => {
  test('an administrator can reset somebody who is locked out', async () => {
    const { id } = await createUser(db, admin, {
      email: 'forgot@alkavida.jm', name: 'Forgetful', role: 'user', password: 'oldpassword',
    });
    await resetPassword(db, admin, id, 'brandnewpass');

    assert.equal(await login(db, 'forgot@alkavida.jm', 'oldpassword'), null);
    assert.ok(await login(db, 'forgot@alkavida.jm', 'brandnewpass'));
  });

  test('the password itself is never written to the audit trail', async () => {
    const rows = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log
       WHERE entity_type = 'User' AND details::text ILIKE '%brandnewpass%'`);
    assert.equal(Number(rows[0].n), 0, 'a password must never be recoverable from the log');
  });

  test('changing your own password needs the current one', async () => {
    const { id } = await createUser(db, admin, {
      email: 'self@alkavida.jm', name: 'Self Server', role: 'user', password: 'mycurrent1',
    });
    const self: Actor = { id, name: 'Self Server', role: 'user' };

    await assert.rejects(
      () => changeOwnPassword(db, self, 'notmypassword', 'mynewpass1'),
      /current password is not right/,
      'a browser left signed in must not be enough to take the account over',
    );

    await changeOwnPassword(db, self, 'mycurrent1', 'mynewpass1');
    assert.ok(await login(db, 'self@alkavida.jm', 'mynewpass1'));
  });

  test('the new password must actually be different', async () => {
    const u = await db.one<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE email = 'self@alkavida.jm'`);
    await assert.rejects(
      () => changeOwnPassword(db, { id: u.id, name: u.name, role: 'user' },
        'mynewpass1', 'mynewpass1'),
      /must be different/,
    );
  });
});
