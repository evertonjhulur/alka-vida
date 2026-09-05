/**
 * Customers asking for a trading account.
 *
 * Registration is deliberately an APPLICATION rather than a sign-up. A portal
 * order is a credit order against agreed rates, so somebody has to decide the
 * price tier, the delivery zone and the payment terms before the account can
 * trade at all. Until the office approves, an application is a request and
 * nothing more - no customer record, no login, no way in.
 *
 * Corporate and individual applicants are asked for different things: a
 * business has a name and a contact person, a person has their own name. Both
 * become a customer record whose `name` is what you would put on an invoice.
 */

import type { Db } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, requireRole } from './core.ts';
import { createInvitation, UNUSABLE_PASSWORD } from './invitations.ts';
import { assertZoneUsable } from './zones.ts';
import { composeAddress, RuleViolation } from '@alka/shared';

export type AccountType = 'Corporate' | 'Individual';

export interface ApplicationInput {
  accountType: AccountType;
  /** Corporate. */
  businessName?: string | null;
  contactPerson?: string | null;
  /** Individual. */
  firstName?: string | null;
  lastName?: string | null;
  /** Both. */
  email: string;
  phone: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  parish?: string | null;
  notes?: string | null;
}

const clean = (s: string | null | undefined) => s?.trim() || null;

/** What goes on the invoice: the business, or the person. */
export function applicantName(a: {
  account_type?: string; accountType?: string;
  business_name?: string | null; businessName?: string | null;
  first_name?: string | null; firstName?: string | null;
  last_name?: string | null; lastName?: string | null;
}): string {
  const type = a.account_type ?? a.accountType;
  if (type === 'Corporate') return (a.business_name ?? a.businessName ?? '').trim();
  return [a.first_name ?? a.firstName, a.last_name ?? a.lastName]
    .map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
}

/**
 * Submit an application. PUBLIC - the applicant has no account yet, which is
 * the entire point.
 */
export async function submitApplication(
  db: Db, input: ApplicationInput,
): Promise<{ id: string; name: string }> {
  const accountType = input.accountType;
  if (accountType !== 'Corporate' && accountType !== 'Individual') {
    throw new RuleViolation('choose whether this is a business or a personal account');
  }

  const email = clean(input.email);
  const phone = clean(input.phone);
  if (!email || !email.includes('@')) throw new RuleViolation('a valid email address is needed');
  if (!phone) throw new RuleViolation('a phone number is needed');

  const businessName = clean(input.businessName);
  const contactPerson = clean(input.contactPerson);
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);

  if (accountType === 'Corporate') {
    if (!businessName) throw new RuleViolation('the business name is needed');
    if (!contactPerson) throw new RuleViolation('a contact person is needed');
  } else {
    if (!firstName) throw new RuleViolation('a first name is needed');
    if (!lastName) throw new RuleViolation('a last name is needed');
  }

  const name = applicantName({ accountType, businessName, firstName, lastName });

  // An address that is already trading, or already waiting, must not be able
  // to queue a second application. The message is the same either way - a
  // public form should not report who already has an account.
  const existingUser = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1)`, [email],
  );
  const openApplication = await db.query<{ id: string }>(
    `SELECT id FROM customer_applications
     WHERE lower(email) = lower($1) AND status = 'Pending'`, [email],
  );
  if (existingUser.length > 0 || openApplication.length > 0) {
    throw new RuleViolation(
      'there is already an account or a request for this email address. '
      + 'If you are waiting to hear from us, we have your details.',
    );
  }

  const address = {
    addressLine1: clean(input.addressLine1),
    addressLine2: clean(input.addressLine2),
    city: clean(input.city),
    parish: clean(input.parish),
  };

  const row = await db.one<{ id: string }>(
    `INSERT INTO customer_applications
       (account_type, business_name, contact_person, first_name, last_name,
        email, phone, address_line1, address_line2, city, parish,
        delivery_address, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [accountType, businessName, contactPerson, firstName, lastName,
     email, phone, address.addressLine1, address.addressLine2, address.city, address.parish,
     // The whole line as well as the parts, so nothing downstream has to know
     // the parts exist.
     composeAddress(address), clean(input.notes)],
  );

  // Deliberately NOT audited against a user: nobody is signed in, and
  // audit_log.user_id is a real foreign key to a person.
  return { id: row.id, name };
}

export async function listApplications(db: Db, actor: Actor, status?: string) {
  requireRole(actor, 'admin', 'user');
  return db.query(
    `SELECT a.*, c.name AS customer_name, u.name AS decided_by_name
     FROM customer_applications a
     LEFT JOIN customers c ON c.id = a.customer_id
     LEFT JOIN users u ON u.id = a.decided_by
     WHERE ($1::text IS NULL OR a.status = $1)
     ORDER BY a.status = 'Pending' DESC, a.created_at DESC`,
    [status ?? null],
  );
}

export interface ApprovalTerms {
  priceTierId?: string | null;
  deliveryZone?: string | null;
  paymentTerms?: string | null;
  /** Off by default: an account is nothing until somebody can sign in to it. */
  createLogin?: boolean;
}

/**
 * Approve an application: create the customer on the agreed terms, create
 * their portal login, and issue the invitation that lets them set their own
 * password. All three or none.
 *
 * The office sets the terms HERE rather than the applicant choosing them,
 * which is the whole reason this is an approval rather than a sign-up.
 */
export async function approveApplication(
  db: Db, actor: Actor, applicationId: string, terms: ApprovalTerms = {},
): Promise<{ customerId: string; userId: string | null; invitation: { link: string } | null }> {
  requireRole(actor, 'admin');

  const app = await db.one<{
    status: string; account_type: string; business_name: string | null;
    contact_person: string | null; first_name: string | null; last_name: string | null;
    email: string; phone: string; delivery_address: string | null;
    address_line1: string | null; address_line2: string | null;
    city: string | null; parish: string | null;
  }>(
    `SELECT status, account_type, business_name, contact_person, first_name, last_name,
            email, phone, delivery_address, address_line1, address_line2, city, parish
     FROM customer_applications WHERE id = $1`,
    [applicationId],
  );
  if (app.status !== 'Pending') {
    throw new RuleViolation(`this application has already been ${app.status.toLowerCase()}`);
  }

  // A zone is what puts their orders on a round, so a mistyped one is worse
  // than none at all - it would create a round nobody drives.
  const zone = clean(terms.deliveryZone);
  if (zone) await assertZoneUsable(db, zone);

  const name = applicantName(app);
  const wantsLogin = terms.createLogin !== false;

  const created = await db.tx(async (t) => {
    const customer = await t.one<{ id: string }>(
      `INSERT INTO customers
         (name, phone, email, delivery_address, address_line1, address_line2,
          city, parish, contact_person, account_type,
          price_tier_id, delivery_zone, payment_terms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [name, app.phone, app.email, app.delivery_address,
       app.address_line1, app.address_line2, app.city, app.parish,
       app.account_type === 'Corporate' ? app.contact_person : null,
       app.account_type, terms.priceTierId ?? null,
       zone, clean(terms.paymentTerms)],
    );

    let userId: string | null = null;
    if (wantsLogin) {
      // Created with a password that cannot match anything: the account
      // exists but nobody - including the office - can sign into it until
      // the invitation is accepted.
      const user = await t.one<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role)
         VALUES ($1,$2,$3,'customer') RETURNING id`,
        [app.email, name, UNUSABLE_PASSWORD],
      );
      userId = user.id;
      await t.query(`UPDATE customers SET user_id = $2 WHERE id = $1`, [customer.id, user.id]);
    }

    await t.query(
      `UPDATE customer_applications
       SET status = 'Approved', decided_at = now(), decided_by = $2, customer_id = $3
       WHERE id = $1`,
      [applicationId, actor.id, customer.id],
    );
    await audit(t, actor, 'create', 'Customer', customer.id, name,
      { fromApplication: applicationId, accountType: app.account_type });

    return { customerId: customer.id, userId };
  });

  // Outside the transaction: the invitation supersedes any earlier one and
  // audits separately, and a customer created without a login gets none.
  const invitation = created.userId
    ? await createInvitation(db, actor, created.userId)
    : null;

  return {
    customerId: created.customerId,
    userId: created.userId,
    invitation: invitation ? { link: invitation.link } : null,
  };
}

export async function declineApplication(
  db: Db, actor: Actor, applicationId: string, reason?: string,
): Promise<void> {
  requireRole(actor, 'admin');
  await db.tx(async (t) => {
    const app = await t.one<{ status: string; email: string }>(
      `SELECT status, email FROM customer_applications WHERE id = $1`, [applicationId],
    );
    if (app.status !== 'Pending') {
      throw new RuleViolation(`this application has already been ${app.status.toLowerCase()}`);
    }
    await t.query(
      `UPDATE customer_applications
       SET status = 'Declined', decided_at = now(), decided_by = $2, decline_reason = $3
       WHERE id = $1`,
      [applicationId, actor.id, clean(reason)],
    );
    await audit(t, actor, 'update', 'CustomerApplication', applicationId, app.email,
      { declined: true, reason: reason ?? null });
  });
}
