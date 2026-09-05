/**
 * Registration, invitations, and a customer running their own standing order.
 *
 * The security-shaped tests are the point of this file. Two of these routes
 * are PUBLIC - anybody on the network can call them - and one of them sets a
 * password.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import {
  submitApplication, listApplications, approveApplication, declineApplication,
} from '../src/services/registration.ts';
import {
  createInvitation, inviteeFor, acceptInvitation, UNUSABLE_PASSWORD,
} from '../src/services/invitations.ts';
import { createUser } from '../src/services/users.ts';
import { createZone, updateZone, deleteZone } from '../src/services/zones.ts';
import { loadSigningKey, login } from '../src/lib/auth.ts';
import { createPortalOrder, cancelOwnOrder } from '../src/services/orders.ts';
import {
  startOwnSchedule, endOwnSchedule, listSchedulesForCustomer,
} from '../src/services/recurring.ts';
import type { Actor } from '../src/services/core.ts';

let db: Db;
let admin: Actor;
let office: Actor;

before(async () => {
  db = await createPgliteDb();
  await migrate(db, { quiet: true });
  await seed(db, { quiet: true });
  await loadSigningKey(db);
  const a = await db.one<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE role = 'admin' AND email <> 'system@alkavida.local'`);
  admin = { id: a.id, name: a.name, role: 'admin' };
  const o = await db.one<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE role = 'user' LIMIT 1`);
  office = { id: o.id, name: o.name, role: 'user' };
});
after(async () => { await db.close(); });

const corporate = (email: string) => ({
  accountType: 'Corporate' as const,
  businessName: 'Runaway Bay Hotel', contactPerson: 'P. Grant',
  email, phone: '876-555-0300',
  addressLine1: '5 Main Street', addressLine2: 'Block B',
  city: 'Runaway Bay', parish: 'St Ann',
});

describe('Asking for an account', () => {
  test('a business is asked for its name and a contact person', async () => {
    const r = await submitApplication(db, corporate('hotel@runaway.jm'));
    assert.equal(r.name, 'Runaway Bay Hotel', 'the business name is what goes on an invoice');

    await assert.rejects(
      () => submitApplication(db, { ...corporate('x@y.jm'), businessName: '' }),
      /business name is needed/,
    );
    await assert.rejects(
      () => submitApplication(db, { ...corporate('x@y.jm'), contactPerson: '' }),
      /contact person is needed/,
    );
  });

  test('a person is asked for their own first and last name', async () => {
    const r = await submitApplication(db, {
      accountType: 'Individual', firstName: 'Marcia', lastName: 'Reid',
      email: 'marcia.reid@example.jm', phone: '876-555-0301',
    });
    assert.equal(r.name, 'Marcia Reid');

    await assert.rejects(
      () => submitApplication(db, {
        accountType: 'Individual', firstName: 'OnlyOne',
        email: 'one@example.jm', phone: '876-555-0302',
      }),
      /last name is needed/,
    );
  });

  test('applying does NOT create a customer, a login, or any way in', async () => {
    const users = await db.query(
      `SELECT id FROM users WHERE lower(email) = 'hotel@runaway.jm'`);
    const customers = await db.query(
      `SELECT id FROM customers WHERE lower(email) = 'hotel@runaway.jm'`);
    assert.equal(users.length, 0, 'a request is not an account');
    assert.equal(customers.length, 0);
    assert.equal(await login(db, 'hotel@runaway.jm', 'anything'), null);
  });

  test('the same address cannot queue a second request', async () => {
    await assert.rejects(
      () => submitApplication(db, corporate('hotel@runaway.jm')),
      /already an account or a request/,
    );
  });

  test('an address that already trades is refused in the same words', async () => {
    await assert.rejects(
      () => submitApplication(db, corporate('admin@alkavida.jm')),
      /already an account or a request/,
      'a public form must not report who does and does not already have an account',
    );
  });
});

describe('Approving an application', () => {
  let applicationId: string;

  before(async () => {
    applicationId = (await db.one<{ id: string }>(
      `SELECT id FROM customer_applications WHERE lower(email) = 'hotel@runaway.jm'`)).id;
  });

  test('the office sets the terms, not the applicant', async () => {
    const tier = await db.one<{ id: string }>(`SELECT id FROM price_tiers LIMIT 1`);

    const out = await approveApplication(db, admin, applicationId, {
      priceTierId: tier.id, deliveryZone: 'North Coast', paymentTerms: 'Net 30',
    });

    const c = await db.one<{
      name: string; account_type: string; contact_person: string;
      price_tier_id: string; delivery_zone: string; payment_terms: string;
    }>(
      `SELECT name, account_type, contact_person, price_tier_id, delivery_zone, payment_terms
       FROM customers WHERE id = $1`, [out.customerId]);

    assert.equal(c.name, 'Runaway Bay Hotel');
    assert.equal(c.account_type, 'Corporate');
    assert.equal(c.contact_person, 'P. Grant');
    assert.equal(c.price_tier_id, tier.id, 'the tier is the office\'s decision');
    assert.equal(c.delivery_zone, 'North Coast');
    assert.equal(c.payment_terms, 'Net 30');
    assert.notEqual(out.invitation, null, 'approval carries them in');
  });

  test('the address arrives in parts AND as the one line everything else reads', async () => {
    const c = await db.one<{
      address_line1: string; address_line2: string; city: string; parish: string;
      delivery_address: string;
    }>(
      `SELECT address_line1, address_line2, city, parish, delivery_address
       FROM customers WHERE lower(email) = 'hotel@runaway.jm'`,
    );
    assert.equal(c.address_line1, '5 Main Street');
    assert.equal(c.address_line2, 'Block B');
    assert.equal(c.city, 'Runaway Bay');
    assert.equal(c.parish, 'St Ann');
    assert.equal(c.delivery_address, '5 Main Street, Block B, Runaway Bay, St Ann',
      'the delivery stop and the invoice PDF both read this one line');
  });

  test('the login it creates cannot be signed into until the invitation is used',
    async () => {
      const u = await db.one<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE lower(email) = 'hotel@runaway.jm'`);
      assert.equal(u.password_hash, UNUSABLE_PASSWORD,
        'nobody - the office included - should know this account\'s password');
      assert.equal(await login(db, 'hotel@runaway.jm', UNUSABLE_PASSWORD), null,
        'and the sentinel itself must not work as a password');
    });

  test('it cannot be approved twice', async () => {
    await assert.rejects(
      () => approveApplication(db, admin, applicationId, {}),
      /already been approved/,
    );
  });

  test('office staff cannot approve - terms are an administrator\'s call', async () => {
    const id = (await submitApplication(db, corporate('second@runaway.jm'))).id;
    await assert.rejects(() => approveApplication(db, office, id, {}), /requires role admin/);
    await declineApplication(db, admin, id, 'duplicate');
    const row = await db.one<{ status: string; decline_reason: string }>(
      `SELECT status, decline_reason FROM customer_applications WHERE id = $1`, [id]);
    assert.equal(row.status, 'Declined');
    assert.equal(row.decline_reason, 'duplicate');
  });

  test('a declined application leaves no customer behind', async () => {
    const customers = await db.query(
      `SELECT id FROM customers WHERE lower(email) = 'second@runaway.jm'`);
    assert.equal(customers.length, 0);
  });

  test('the office can see what is waiting', async () => {
    const pending = await listApplications(db, office, 'Pending');
    assert.equal(pending.every((a) => (a as { status: string }).status === 'Pending'), true);
  });
});

describe('Delivery zones are a list, not a spelling', () => {
  test('a zone that does not exist cannot be given to a customer', async () => {
    const id = (await submitApplication(db, corporate('zonetest@runaway.jm'))).id;
    await assert.rejects(
      () => approveApplication(db, admin, id, { deliveryZone: 'Narnia' }),
      /no delivery zone called/,
      'a mistyped zone is worse than none - it creates a round nobody drives',
    );
    // and the application is untouched, so it can be approved properly after
    const row = await db.one<{ status: string }>(
      `SELECT status FROM customer_applications WHERE id = $1`, [id]);
    assert.equal(row.status, 'Pending');
  });

  test('renaming a zone carries every customer and round with it', async () => {
    const z = await createZone(db, admin, { name: 'Old Harbour', covers: 'St Catherine' });
    const app = (await submitApplication(db, corporate('harbour@runaway.jm'))).id;
    const out = await approveApplication(db, admin, app, { deliveryZone: 'Old Harbour' });

    await updateZone(db, admin, z.id, { name: 'Old Harbour Bay' });

    const c = await db.one<{ delivery_zone: string }>(
      `SELECT delivery_zone FROM customers WHERE id = $1`, [out.customerId]);
    assert.equal(c.delivery_zone, 'Old Harbour Bay',
      'a customer left on the old spelling silently stops grouping onto a round');
  });

  test('a zone with customers on it is retired, not deleted', async () => {
    const z = await db.one<{ id: string }>(
      `SELECT id FROM delivery_zones WHERE name = 'Old Harbour Bay'`);
    const r = await deleteZone(db, admin, z.id);
    assert.equal(r.deleted, false);
    assert.equal(r.retired, true);
    assert.ok(r.customerCount > 0);

    const waiting = (await submitApplication(db, corporate('retired@runaway.jm'))).id;
    await assert.rejects(
      () => approveApplication(db, admin, waiting, { deliveryZone: 'Old Harbour Bay' }),
      /has been retired/,
    );
  });

  test('an unused zone is deleted outright', async () => {
    const z = await createZone(db, admin, { name: 'Nobody Lives Here' });
    const r = await deleteZone(db, admin, z.id);
    assert.equal(r.deleted, true);
    assert.equal(
      (await db.query(`SELECT id FROM delivery_zones WHERE id = $1`, [z.id])).length, 0);
  });

  test('two zones cannot share a name, whatever the capitals', async () => {
    await assert.rejects(
      () => createZone(db, admin, { name: 'kingston' }),
      /already a zone called/,
      '"Kingston" and "kingston" would be two half-empty trucks',
    );
  });
});

describe('Invitations', () => {
  let userId: string;
  let token: string;

  before(async () => {
    userId = (await createUser(db, admin, {
      email: 'invited@alkavida.jm', name: 'Invited Person', role: 'user',
      password: '', byInvitation: true,
    })).id;
  });

  test('an invited account exists but has no usable password', async () => {
    assert.equal(await login(db, 'invited@alkavida.jm', 'password1'), null);
    const u = await db.one<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`, [userId]);
    assert.equal(u.password_hash, UNUSABLE_PASSWORD);
  });

  test('the link identifies who it is for', async () => {
    const inv = await createInvitation(db, admin, userId);
    token = inv.token;
    const who = await inviteeFor(db, token);
    assert.equal(who?.email, 'invited@alkavida.jm');
    assert.equal(who?.name, 'Invited Person');
  });

  test('only a HASH of the token is stored', async () => {
    const rows = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_invitations WHERE token_hash = $1`, [token]);
    assert.equal(Number(rows[0].n), 0,
      'a copy of this table must not be a set of working keys');
  });

  test('an invented token gives nothing away', async () => {
    assert.equal(await inviteeFor(db, 'not-a-real-token'), null);
    assert.equal(await inviteeFor(db, ''), null);
    await assert.rejects(
      () => acceptInvitation(db, 'not-a-real-token', 'password1'),
      /no longer valid/,
    );
  });

  test('accepting it sets the password they chose', async () => {
    await acceptInvitation(db, token, 'chosenbyme1');
    const signedIn = await login(db, 'invited@alkavida.jm', 'chosenbyme1');
    assert.ok(signedIn, 'they can now sign in with a password only they know');
  });

  /**
   * Found in testing: a password set from an invitation was right, the login
   * returned 200, and the customer still could not get in. Two separate
   * causes, both of which show as "it would not let me log in".
   */
  test('the address is matched with surrounding space trimmed', async () => {
    assert.ok(await login(db, ' invited@alkavida.jm ', 'chosenbyme1'),
      'a phone keyboard and a browser autofill both add a trailing space, and '
      + '"wrong email or password" for an address that is plainly right is the '
      + 'least debuggable message in the system');
    assert.ok(await login(db, '\tINVITED@alkavida.jm\n', 'chosenbyme1'),
      'capitals were already forgiven; whitespace was not');
  });

  test('the password itself is NOT trimmed', async () => {
    const u = (await createUser(db, admin, {
      email: 'spacey@alkavida.jm', name: 'Spacey', role: 'user',
      password: '', byInvitation: true,
    })).id;
    const inv = await createInvitation(db, admin, u);
    await acceptInvitation(db, inv.token, ' pass word ');

    assert.ok(await login(db, 'spacey@alkavida.jm', ' pass word '),
      'a space is a legitimate character in a password');
    assert.equal(await login(db, 'spacey@alkavida.jm', 'pass word'), null,
      'so it must never be quietly stripped from one');
  });

  test('the link works ONCE', async () => {
    await assert.rejects(
      () => acceptInvitation(db, token, 'anotherpass1'),
      /no longer valid/,
    );
    assert.ok(await login(db, 'invited@alkavida.jm', 'chosenbyme1'),
      'and the password they set is untouched');
  });

  test('a new invitation kills the outstanding one', async () => {
    const first = await createInvitation(db, admin, userId);
    const second = await createInvitation(db, admin, userId);
    assert.equal(await inviteeFor(db, first.token), null,
      'two live links to one account is one more than anybody intended');
    assert.notEqual(await inviteeFor(db, second.token), null);
  });

  test('an expired link is refused', async () => {
    const inv = await createInvitation(db, admin, userId);
    await db.query(
      `UPDATE user_invitations SET expires_at = now() - interval '1 day'
       WHERE used_at IS NULL AND user_id = $1`, [userId]);
    assert.equal(await inviteeFor(db, inv.token), null);
    await assert.rejects(() => acceptInvitation(db, inv.token, 'password1'), /no longer valid/);
  });

  test('a withdrawn account cannot be invited back in', async () => {
    await db.query(`UPDATE users SET active = false WHERE id = $1`, [userId]);
    await assert.rejects(() => createInvitation(db, admin, userId), /access has been withdrawn/);
    await db.query(`UPDATE users SET active = true WHERE id = $1`, [userId]);
  });

  test('a short password is refused at the point it is set', async () => {
    const inv = await createInvitation(db, admin, userId);
    await assert.rejects(() => acceptInvitation(db, inv.token, 'abc'), /at least 8/);
  });
});

describe('A customer running their own standing order', () => {
  let customerId: string;
  let portal: Actor;

  before(async () => {
    customerId = (await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE lower(email) = 'hotel@runaway.jm'`)).id;
    const u = await db.one<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE lower(email) = 'hotel@runaway.jm'`);
    portal = { id: u.id, name: u.name, role: 'customer' };
  });

  const anOrder = async () => {
    const p = await db.one<{ id: string }>(
      `SELECT id FROM products WHERE active AND bottles_per_case > 0 LIMIT 1`);
    return createPortalOrder(db, portal, customerId, {
      lines: [{ productId: p.id, cases: 3 }],
      requestedDeliveryDate: null,
    });
  };

  test('they can turn their own pending order into a weekly repeat', async () => {
    const order = await anOrder();
    await db.query(
      `UPDATE customer_orders SET requested_delivery_date = business_today() WHERE id = $1`,
      [order.id]);

    const started = await startOwnSchedule(db, portal, customerId, order.id,
      { pattern: 'Weekly' });
    assert.ok(started.nextDeliveryDate);

    const mine = await listSchedulesForCustomer(db, customerId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].pattern, 'Weekly');
  });

  test('they can stop it, and the arrangement stays on record', async () => {
    const mine = await listSchedulesForCustomer(db, customerId);
    await endOwnSchedule(db, portal, customerId, mine[0].id);

    const row = await db.one<{ is_recurring: boolean; recurrence_last_note: string }>(
      `SELECT is_recurring, recurrence_last_note FROM customer_orders WHERE id = $1`,
      [mine[0].id]);
    assert.equal(row.is_recurring, false, 'it stops producing work');
    assert.match(row.recurrence_last_note, /cancelled by the customer/,
      'but the arrangement and its history are kept, not deleted');
  });

  test('somebody else\'s standing order cannot be touched, or even detected', async () => {
    const other = await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE id <> $1 LIMIT 1`, [customerId]);
    const theirOrder = await createPortalOrder(db, portal, other.id, {
      lines: [{ productId: (await db.one<{ id: string }>(
        `SELECT id FROM products WHERE active LIMIT 1`)).id, cases: 1 }],
    });
    await assert.rejects(
      () => startOwnSchedule(db, portal, customerId, theirOrder.id, { pattern: 'Weekly' }),
      /could not be found on your account/,
    );
  });
});

describe('A customer cancelling their own order', () => {
  let customerId: string;
  let portal: Actor;

  before(async () => {
    customerId = (await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE lower(email) = 'hotel@runaway.jm'`)).id;
    const u = await db.one<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE lower(email) = 'hotel@runaway.jm'`);
    portal = { id: u.id, name: u.name, role: 'customer' };
  });

  test('a pending order can be cancelled, and leaves the round', async () => {
    const p = await db.one<{ id: string }>(`SELECT id FROM products WHERE active LIMIT 1`);
    const order = await createPortalOrder(db, portal, customerId, {
      lines: [{ productId: p.id, cases: 2 }],
    });

    await cancelOwnOrder(db, portal, customerId, order.id, 'changed my mind');

    const row = await db.one<{ status: string }>(
      `SELECT status FROM customer_orders WHERE id = $1`, [order.id]);
    assert.equal(row.status, 'Cancelled');
    const stops = await db.query(
      `SELECT id FROM delivery_stops WHERE order_id = $1`, [order.id]);
    assert.equal(stops.length, 0, 'and it comes off the driver\'s round');
  });

  /**
   * The rule that must not bend. A delivered order has been invoiced and the
   * water has left the building; unwinding that is a credit note, which is
   * the office's to raise.
   */
  test('a DELIVERED order cannot be cancelled by the customer', async () => {
    const p = await db.one<{ id: string }>(`SELECT id FROM products WHERE active LIMIT 1`);
    const order = await createPortalOrder(db, portal, customerId, {
      lines: [{ productId: p.id, cases: 1 }],
    });
    await db.query(`UPDATE customer_orders SET status = 'Delivered' WHERE id = $1`, [order.id]);

    await assert.rejects(
      () => cancelOwnOrder(db, portal, customerId, order.id),
      /already been delivered/,
    );
    const row = await db.one<{ status: string }>(
      `SELECT status FROM customer_orders WHERE id = $1`, [order.id]);
    assert.equal(row.status, 'Delivered', 'and it stays delivered');
  });

  test('another customer\'s order cannot be cancelled, or discovered', async () => {
    const other = await db.one<{ id: string }>(
      `SELECT id FROM customers WHERE id <> $1 LIMIT 1`, [customerId]);
    const p = await db.one<{ id: string }>(`SELECT id FROM products WHERE active LIMIT 1`);
    const theirs = await createPortalOrder(db, portal, other.id, {
      lines: [{ productId: p.id, cases: 1 }],
    });

    await assert.rejects(
      () => cancelOwnOrder(db, portal, customerId, theirs.id),
      /could not be found on your account/,
      'the same answer as for an order that does not exist',
    );
    const row = await db.one<{ status: string }>(
      `SELECT status FROM customer_orders WHERE id = $1`, [theirs.id]);
    assert.equal(row.status, 'Pending');
  });
});
