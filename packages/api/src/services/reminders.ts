/**
 * Tomorrow's round: remind customers to order (Everton, 7 Oct 2026).
 *
 * The evening before a round, the office opens one list: every customer
 * whose delivery day it is - their own delivery days, or, when they have
 * none, the days their zone's round runs - and who has NOT already got an
 * order for that day (a standing order's occurrence counts as an order).
 * Each has a message typed for them ("Would you like your usual 3 cases of
 * 500ml?") and a WhatsApp button that opens a chat with them, message
 * filled in; the office presses send in WhatsApp and the row ticks itself
 * off. Customers without WhatsApp can be sent the same words by email.
 *
 * WhatsApp is one tap per customer by design: sending on its own needs
 * Meta's paid, pre-approved template messages, which Everton chose not to
 * use (1 Oct 2026). Email is sent by the system, respects the customer's
 * "Service announcements" tick, and carries an unsubscribe link.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, businessToday, getSetting, num, requireRole, siteUrl } from './core.ts';
import { RuleViolation, addDays } from '@alka/shared';
import { whatsappDigits, whatsappLink } from './messaging.ts';
import { mailConfigured, sendMail } from './documents.ts';
import { customerEmail, customerWants } from './emailkit.ts';

/** Longest reminder template (point 8): one WhatsApp message, readable on a phone. */
export const MAX_TEMPLATE = 500;

export const DEFAULT_TEMPLATE =
  'Good day {name}, our truck is in {zone} {when}. {ask} Reply here or order online: {link}';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function weekdayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function dayWords(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${weekdayOf(iso)} ${d} ${MONTH[m - 1]}`;
}

/**
 * A delivery day typed or picked by the office (tester's findings, 10 Oct
 * 2026, point 1): an impossible or unreadable date is refused with a clear
 * message (400), never a 500 and never a silent switch to another day; a day
 * already gone is refused too. Blank means tomorrow.
 */
export function reminderDay(raw: unknown, opts: { allowPast?: boolean } = {}): string {
  const today = businessToday();
  const s = String(raw ?? '').trim();
  if (!s) return addDays(today, 1);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const ok = m && (() => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  })();
  if (!ok) throw new RuleViolation(`"${s.slice(0, 20)}" is not a date we can use. Pick the day from the calendar.`);
  if (!opts.allowPast && s < today) throw new RuleViolation('that day has gone. Reminders are for today or a later day.');
  return s;
}

export interface ReminderRow {
  customerId: string;
  name: string;
  contactPerson: string | null;
  zone: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  /** "3 cases of 500ml, 2 x 5 Gallon" from their last order, or null. */
  usual: string | null;
  lastOrderOn: string | null;
  balanceCents: number;
  message: string;
  whatsappLink: string | null;
  /** Wants service emails and has an address. */
  canEmail: boolean;
  /** When canEmail is false, why: "No email address" / "Turned off service emails". */
  emailBlocked: string | null;
  /** Already reminded for this day, and how. */
  remindedBy: string[];
  remindedAt: string | null;
}

/**
 * "3 cases of 500ml, 2 x 5 Gallon": their last DELIVERED order, bottles
 * bought left out. Delivered only (tester's findings, point 3): an order
 * still to come is not their "last order", and its date is in the future.
 */
async function usualOrder(t: Queryable, customerId: string): Promise<{ text: string | null; on: string | null }> {
  const last = await t.maybeOne<{ id: string; on_day: string }>(
    `SELECT id, fulfilled_on::text AS on_day
     FROM customer_orders
     WHERE customer_id = $1 AND status IN ('Delivered','Partially Delivered') AND delivery_mode <> 'Counter'
       AND fulfilled_on IS NOT NULL AND fulfilled_on <= business_today()
     ORDER BY fulfilled_on DESC, created_at DESC LIMIT 1`, [customerId],
  );
  if (!last) return { text: null, on: null };
  const lines = await t.query<{ name: string; bpc: number; cases: number; loose: number }>(
    `SELECT p.name, p.bottles_per_case AS bpc, oli.cases, oli.loose_bottles AS loose
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1 AND NOT p.is_bottle_charge ORDER BY p.name`, [last.id],
  );
  const parts = lines
    .filter((l) => num(l.cases) > 0 || num(l.loose) > 0)
    .map((l) => {
      const name = l.name.replace(/^Alka Vida\s+/i, '');
      if (num(l.bpc) > 0) return `${num(l.cases)} case${num(l.cases) === 1 ? '' : 's'} of ${name}`;
      return `${num(l.loose)} x ${name}`;
    });
  return { text: parts.length ? parts.join(', ') : null, on: last.on_day };
}

export function fillTemplate(template: string, v: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k] : m)).replace(/\s{2,}/g, ' ').trim();
}

/**
 * Who to remind for a delivery day (default: tomorrow), with their message.
 */
export async function remindersFor(db: Db, opts: { date?: string | null } = {}) {
  const today = businessToday();
  const date = reminderDay(opts.date);
  const wd = weekdayOf(date);
  // The page heading (point 2): Today / Tomorrow / Tue 13 Oct.
  const heading = date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : dayWords(date);
  const template = (await getSetting(db, 'reminder_template', DEFAULT_TEMPLATE)).trim() || DEFAULT_TEMPLATE;
  const when = date === addDays(today, 1) ? `tomorrow, ${dayWords(date)}`
    : date === today ? `today, ${dayWords(date)}` : `on ${dayWords(date)}`;

  const customers = await db.query<{
    id: string; name: string; contact_person: string | null; delivery_zone: string | null;
    phone: string | null; whatsapp: string | null; email: string | null; service_emails: boolean;
    balance_cents: number;
  }>(
    `SELECT c.id, c.name, c.contact_person, c.delivery_zone, c.phone, c.whatsapp, c.email,
            c.service_emails, COALESCE(b.balance_cents, 0)::bigint AS balance_cents
     FROM customers c
     LEFT JOIN delivery_zones z ON z.name = c.delivery_zone
     LEFT JOIN customer_balances b ON b.customer_id = c.id
     WHERE c.active AND NOT c.is_walk_in
       -- Their own delivery days, or (none set) the days their zone's round runs.
       AND (CASE WHEN cardinality(c.delivery_days) > 0 THEN $2 = ANY(c.delivery_days)
                 ELSE $2 = ANY(COALESCE(z.run_days, '{}')) END)
       -- Not already ordered for that day.
       AND NOT EXISTS (
         SELECT 1 FROM customer_orders o
         WHERE o.customer_id = c.id AND o.status <> 'Cancelled'
           AND o.delivery_mode <> 'Counter' AND o.requested_delivery_date = $1::date)
     ORDER BY c.delivery_zone NULLS LAST, c.route_sequence, c.name`,
    [date, wd],
  );

  const sent = await db.query<{ customer_id: string; channel: string; sent_at: string }>(
    `SELECT customer_id, channel, sent_at FROM order_reminders WHERE for_date = $1::date AND ok
     ORDER BY sent_at`, [date],
  );

  const rows: ReminderRow[] = [];
  for (const c of customers) {
    const usual = await usualOrder(db, c.id);
    const message = fillTemplate(template, {
      name: c.contact_person?.trim() || c.name,
      business: c.name,
      zone: c.delivery_zone ?? 'your area',
      when,
      day: dayWords(date),
      ask: usual.text ? `Would you like your usual ${usual.text}?` : 'Would you like us to bring you some water?',
      usual: usual.text ?? 'order',
      link: `${siteUrl()}/#/portal/order`,
    });
    const mine = sent.filter((s) => s.customer_id === c.id);
    const wa = c.whatsapp?.trim() || c.phone;
    rows.push({
      customerId: c.id,
      name: c.name,
      contactPerson: c.contact_person,
      zone: c.delivery_zone,
      phone: c.phone,
      whatsapp: whatsappDigits(wa),
      email: c.email?.trim() || null,
      usual: usual.text,
      lastOrderOn: usual.on,
      balanceCents: num(c.balance_cents),
      message,
      whatsappLink: whatsappLink(wa, message),
      canEmail: !!c.email?.trim() && c.service_emails !== false,
      emailBlocked: !c.email?.trim() ? 'No email address' : c.service_emails === false ? 'Turned off service emails' : null,
      remindedBy: [...new Set(mine.map((s) => s.channel))],
      remindedAt: mine.at(-1)?.sent_at ?? null,
    });
  }
  return { date, today, weekday: wd, when, heading, template, maxTemplate: MAX_TEMPLATE, mailConfigured: mailConfigured(), rows };
}

/** The office pressed "Send on WhatsApp" for this customer: tick them off. */
export async function markReminded(
  db: Db, actor: Actor, customerId: string, date: string, channel: 'WhatsApp' | 'Email' = 'WhatsApp',
): Promise<void> {
  requireRole(actor, 'admin', 'user');
  if (!String(date ?? '').trim()) throw new RuleViolation('which delivery day was this about?');
  const day = reminderDay(date);
  // A double tap sends one tick, not two.
  const recent = await db.maybeOne(
    `SELECT 1 FROM order_reminders WHERE customer_id = $1 AND for_date = $2::date AND channel = $3
       AND sent_at > now() - interval '30 seconds'`, [customerId, day, channel],
  );
  if (recent) return;
  await db.query(
    `INSERT INTO order_reminders (customer_id, for_date, channel, sent_by, sent_by_name)
     VALUES ($1,$2::date,$3,$4,$5)`, [customerId, day, channel, actor.id, actor.name],
  );
}

/** Undo a tick (pressed by mistake, or the message was never sent). */
export async function unmarkReminded(db: Db, actor: Actor, customerId: string, date: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.query(
    `DELETE FROM order_reminders WHERE customer_id = $1 AND for_date = $2::date AND channel = 'WhatsApp'`,
    [customerId, reminderDay(date, { allowPast: true })],
  );
}

/**
 * Email the reminder to the chosen customers (those who want service
 * announcements and have an address). Each email is logged, sent or not.
 */
export async function emailReminders(
  db: Db, actor: Actor, date: string, customerIds: readonly string[],
): Promise<{ sent: number; skipped: number; failed: Array<{ name: string; reason: string }> }> {
  requireRole(actor, 'admin', 'user');
  if (!mailConfigured()) throw new RuleViolation('email is not set up, so reminders can only go by WhatsApp');
  if (!String(date ?? '').trim()) throw new RuleViolation('which delivery day are these reminders for?');
  const list = await remindersFor(db, { date });
  const out = { sent: 0, skipped: 0, failed: [] as Array<{ name: string; reason: string }> };
  for (const r of list.rows.filter((x) => customerIds.includes(x.customerId))) {
    if (!r.email || !(await customerWants(db, r.customerId, 'service'))) { out.skipped += 1; continue; }
    try {
      const mail = await customerEmail(db, r.customerId, 'service', {
        preheader: `Our truck is in ${r.zone ?? 'your area'} ${list.when}`,
        heading: `Delivering in ${r.zone ?? 'your area'} ${list.when}`,
        intro: r.message.replace(/\s*Reply here or order online:.*$/i, ''),
        button: { label: 'Order now', url: `${siteUrl()}/#/portal/order` },
        outro: 'Or simply reply to this email with what you would like.',
      });
      await sendMail({
        to: r.email, subject: `Alka Vida: delivering in ${r.zone ?? 'your area'} ${list.when}`,
        text: mail.text, html: mail.html, headers: mail.headers,
      });
      await db.query(
        `INSERT INTO order_reminders (customer_id, for_date, channel, sent_by, sent_by_name)
         VALUES ($1,$2::date,'Email',$3,$4)`, [r.customerId, list.date, actor.id, actor.name],
      );
      out.sent += 1;
    } catch (err) {
      await db.query(
        `INSERT INTO order_reminders (customer_id, for_date, channel, sent_by, sent_by_name, ok, detail)
         VALUES ($1,$2::date,'Email',$3,$4,false,$5)`,
        [r.customerId, list.date, actor.id, actor.name, (err as Error).message.slice(0, 300)],
      );
      out.failed.push({ name: r.name, reason: (err as Error).message });
    }
  }
  await audit(db, actor, 'update', 'OrderReminders', null, list.date, { emailed: out.sent, skipped: out.skipped });
  return out;
}

export async function setReminderTemplate(db: Db, actor: Actor, template: string): Promise<string> {
  requireRole(actor, 'admin', 'user');
  const t = String(template ?? '').trim() || DEFAULT_TEMPLATE;
  if (t.length > MAX_TEMPLATE) throw new RuleViolation(`keep the message to ${MAX_TEMPLATE} characters or fewer`);
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ('reminder_template', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [t],
  );
  return t;
}
