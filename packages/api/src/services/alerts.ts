/**
 * Telling staff when something needs them (Everton, 15 Oct 2026).
 *
 *   - A new online order: a push notification to the office (admins and
 *     office users).
 *   - Anything that lands in Needs a decision (discounts, credit notes, stop
 *     corrections, payment changes, same-day orders, delivery-day requests,
 *     new account requests): a push notification AND an email to every
 *     admin. Each admin can turn the email off under My account.
 *
 * Done by looking, every few seconds, for what is new since the last look -
 * not by a call at each of the dozen places those things are created. So a
 * new kind of request is announced without anyone remembering to add a line,
 * and a write that rolls back is never announced. staff_alerts_sent stops
 * anything being announced twice; `alerts_since` (set by migration 025) stops
 * the backlog from before this existed being announced at all.
 */

import type { Db } from '../db/index.ts';
import { getSetting, siteUrl } from './core.ts';
import { knockHeld, notifyUsers, usersInRoles } from './push.ts';
import { mailConfigured, sendMail } from './documents.ts';
import { renderEmail } from './emailkit.ts';

const TYPE_WORDS: Record<string, string> = {
  Discount: 'Discount', CreditNote: 'Credit note', StopCorrection: 'Stop correction',
  SameDayOrder: 'Same-day order after the cut-off', PaymentChange: 'Payment change',
  SpecialDayOrder: 'Delivery on a day that is not theirs',
};

const money = (c: number) => `$${(Number(c) / 100).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDay = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};

/** Claim an event for announcing; false if it was already announced. */
async function claim(db: Db, kind: string, refId: string): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO staff_alerts_sent (kind, ref_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING ref_id`, [kind, refId]);
  return r.length > 0;
}

async function emailAdmins(db: Db, subject: string, heading: string, lines: Array<[string, string]>, intro: string): Promise<number> {
  if (!mailConfigured()) return 0;
  const admins = (await usersInRoles(db, ['admin'])).filter((a) => a.decision_emails && a.email?.includes('@'));
  let sent = 0;
  for (const a of admins) {
    const { html, text } = renderEmail({
      preheader: subject, heading, greeting: `Good day ${a.name.split(' ')[0]},`, intro,
      facts: lines, button: { label: 'Open Needs a decision', url: `${siteUrl()}/#/decisions` },
      outro: 'You get this because you are an administrator. Turn these emails off under My account in Alka Vida.',
    });
    try { await sendMail({ to: a.email.trim(), subject, text, html }); sent++; } catch { /* best effort */ }
  }
  return sent;
}

export interface AlertRun { orders: number; decisions: number; emails: number }

/** One look for anything new. Safe to run as often as wanted. */
export async function runAlerts(db: Db): Promise<AlertRun> {
  const since = await getSetting(db, 'alerts_since', '');
  if (!since) return { orders: 0, decisions: 0, emails: 0 };
  const out: AlertRun = { orders: 0, decisions: 0, emails: 0 };

  // New online orders, to the office. One waiting for a decision is announced
  // as that decision instead, so nobody is told twice.
  const fresh = await db.query<{
    id: string; order_number: string; customer_name: string; requested_delivery_date: string | null;
    delivery_mode: string; lines: string | null; grand_total_cents: number;
  }>(
    `SELECT o.id, o.order_number, c.name AS customer_name, o.requested_delivery_date::text AS requested_delivery_date,
            o.delivery_mode, o.grand_total_cents,
            (SELECT string_agg(CASE WHEN oli.cases > 0 THEN oli.cases || ' cs ' ELSE oli.loose_bottles || ' x ' END
                               || regexp_replace(p.name, '^Alka Vida\\s+', ''), ', ' ORDER BY p.name)
               FROM order_line_items oli JOIN products p ON p.id = oli.product_id WHERE oli.order_id = o.id) AS lines
     FROM customer_orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.source = 'Portal' AND o.created_at > $1::timestamptz AND o.status <> 'Cancelled'
       AND NOT o.needs_review AND o.parent_recurring_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM staff_alerts_sent a WHERE a.kind = 'order' AND a.ref_id = o.id)
     ORDER BY o.created_at LIMIT 50`, [since],
  );
  if (fresh.length) {
    // Only those who want new-order notifications (My account / Settings › Notifications).
    const office = (await usersInRoles(db, ['admin', 'user'])).filter((u) => u.notify_orders).map((u) => u.id);
    for (const o of fresh) {
      if (!(await claim(db, 'order', o.id))) continue;
      await notifyUsers(db, office, {
        title: `New online order ${o.order_number}`,
        body: [o.customer_name, o.lines, o.delivery_mode === 'Pickup'
          ? `to collect${o.requested_delivery_date ? ` ${shortDay(o.requested_delivery_date)}` : ''}`
          : `for ${o.requested_delivery_date ? shortDay(o.requested_delivery_date) : 'their next delivery day'}`,
        money(o.grand_total_cents)].filter(Boolean).join(' · '),
        url: `/#/orders?find=${encodeURIComponent(o.order_number)}`,
        tag: `order-${o.order_number}`,
      });
      out.orders++;
    }
  }

  // Needs a decision: requests, and new account requests, to admins.
  const requests = await db.query<{
    id: string; request_type: string; entity_label: string | null; customer_name: string | null;
    amount_cents: number; reason: string | null; requested_by: string | null;
  }>(
    `SELECT r.id, r.request_type, r.entity_label, c.name AS customer_name, r.amount_cents, r.reason,
            u.name AS requested_by
     FROM approval_requests r LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN users u ON u.id = r.requested_by_id
     WHERE r.status = 'Pending' AND r.requested_date > $1::timestamptz
       AND NOT EXISTS (SELECT 1 FROM staff_alerts_sent a WHERE a.kind = 'decision' AND a.ref_id = r.id)
     ORDER BY r.requested_date LIMIT 50`, [since],
  );
  const apps = await db.query<{ id: string; who: string; account_type: string; phone: string | null }>(
    `SELECT id, COALESCE(NULLIF(business_name, ''), trim(concat_ws(' ', first_name, last_name))) AS who, account_type, phone
     FROM customer_applications
     WHERE status = 'Pending' AND created_at > $1::timestamptz
       AND NOT EXISTS (SELECT 1 FROM staff_alerts_sent a WHERE a.kind = 'application' AND a.ref_id = customer_applications.id)
     ORDER BY created_at LIMIT 50`, [since],
  );
  const webOrders = await db.query<{ id: string; reference: string; who: string; phone: string; fulfilment: string }>(
    `SELECT id, reference, COALESCE(business_name, first_name || ' ' || last_name) AS who, phone, fulfilment
     FROM website_orders
     WHERE status = 'Pending' AND created_at > $1::timestamptz
       AND NOT EXISTS (SELECT 1 FROM staff_alerts_sent a WHERE a.kind = 'website-order' AND a.ref_id = website_orders.id)
     ORDER BY created_at LIMIT 50`, [since],
  );
  // Customers who opened their own account (31 Oct 2026): nothing waits on
  // the office, but it looks at each one and adjusts prices or terms.
  const signups = await db.query<{ id: string; name: string; account_type: string; phone: string | null; zone: string | null; dup: boolean }>(
    `SELECT id, name, account_type, phone, delivery_zone AS zone, cardinality(possible_duplicates) > 0 AS dup
     FROM customers
     WHERE signed_up_at IS NOT NULL AND signup_reviewed_at IS NULL AND signed_up_at > $1::timestamptz
       AND NOT EXISTS (SELECT 1 FROM staff_alerts_sent a WHERE a.kind = 'signup' AND a.ref_id = customers.id)
     ORDER BY signed_up_at LIMIT 50`, [since],
  );
  if (requests.length || apps.length || webOrders.length || signups.length) {
    const admins = (await usersInRoles(db, ['admin'])).filter((u) => u.notify_decisions).map((u) => u.id);
    for (const r of requests) {
      if (!(await claim(db, 'decision', r.id))) continue;
      const what = TYPE_WORDS[r.request_type] ?? r.request_type;
      const title = `Needs a decision: ${what}`;
      const body = [r.entity_label, r.customer_name, Number(r.amount_cents) ? money(r.amount_cents) : null,
        r.requested_by ? `asked by ${r.requested_by}` : null].filter(Boolean).join(' · ');
      await notifyUsers(db, admins, { title, body, url: '/#/decisions', tag: `decision-${r.id}` });
      out.emails += await emailAdmins(db, `Alka Vida: ${what}${r.entity_label ? ` (${r.entity_label})` : ''} needs a decision`,
        'Something needs your decision', [
          ['What', what], ...(r.entity_label ? [['For', `${r.entity_label}${r.customer_name ? `, ${r.customer_name}` : ''}`] as [string, string]] : []),
          ...(Number(r.amount_cents) ? [['Amount', money(r.amount_cents)] as [string, string]] : []),
          ...(r.reason ? [['Why', r.reason] as [string, string]] : []),
          ...(r.requested_by ? [['Asked by', r.requested_by] as [string, string]] : []),
        ], 'This is waiting for an administrator under Needs a decision.');
      out.decisions++;
    }
    for (const a of apps) {
      if (!(await claim(db, 'application', a.id))) continue;
      await notifyUsers(db, admins, {
        title: 'Needs a decision: new account request',
        body: [a.who, a.account_type, a.phone].filter(Boolean).join(' · '),
        url: '/#/decisions?show=accounts', tag: `application-${a.id}`,
      });
      out.emails += await emailAdmins(db, `Alka Vida: new account request from ${a.who}`, 'A new account request',
        [['Who', a.who], ['Account', a.account_type], ...(a.phone ? [['Phone', a.phone] as [string, string]] : [])],
        'Someone asked to open an account. It is waiting for an administrator under Needs a decision.');
      out.decisions++;
    }
    for (const c of signups) {
      if (!(await claim(db, 'signup', c.id))) continue;
      const kind = c.account_type === 'Corporate' ? 'Business' : 'Home';
      await notifyUsers(db, admins, {
        title: `New customer: ${c.name}`,
        body: [kind, c.zone ?? 'zone not chosen', c.phone, c.dup ? 'same phone as another customer' : null].filter(Boolean).join(' · '),
        url: '/#/decisions?show=accounts', tag: `signup-${c.id}`,
      });
      out.emails += await emailAdmins(db, `Alka Vida: new customer ${c.name}`, 'A new customer signed up',
        [['Who', c.name], ['Account', kind], ['Zone', c.zone ?? 'Not sure - place them'],
         ...(c.phone ? [['Phone', c.phone] as [string, string]] : []),
         ...(c.dup ? [['Check', 'Same phone as a customer already on file'] as [string, string]] : [])],
        'They opened their own account and can order now. Look them over under Needs a decision and change their prices, zone or terms if needed.');
      out.decisions++;
    }
    for (const w of webOrders) {
      if (!(await claim(db, 'website-order', w.id))) continue;
      await notifyUsers(db, admins, {
        title: 'Needs a decision: website order',
        body: [w.reference, w.who, w.fulfilment === 'Collect' ? 'collecting' : 'delivery', w.phone].join(' · '),
        url: '/#/decisions?show=accounts', tag: `website-order-${w.id}`,
      });
      out.emails += await emailAdmins(db, `Alka Vida: website order ${w.reference} from ${w.who}`, 'A website order',
        [['Reference', w.reference], ['Who', w.who], ['Phone', w.phone], ['How', w.fulfilment === 'Collect' ? 'Collecting at White Marl' : 'Delivery']],
        'Someone ordered on the website without an account. Confirm it with them, then book it under Needs a decision.');
      out.decisions++;
    }
  }
  // Drivers: something added to their load after they confirmed it.
  const added = await db.query<{ id: string; driver: string; zone: string; day: string; by: string | null }>(
    `SELECT a.id, d.assigned_driver_id AS driver, d.zone, d.delivery_date::text AS day, a.added_by_name AS by
     FROM round_load_additions a JOIN delivery_sheets d ON d.id = a.delivery_sheet_id
     WHERE a.added_at > $1::timestamptz AND a.driver_confirmed_at IS NULL AND a.cancelled_at IS NULL
       AND d.assigned_driver_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM staff_alerts_sent x WHERE x.kind = 'load' AND x.ref_id = a.id)
     LIMIT 50`, [since],
  );
  const wantsLoad = new Set((await usersInRoles(db, ['driver'])).filter((u) => u.notify_load).map((u) => u.id));
  for (const a of added) {
    if (!(await claim(db, 'load', a.id))) continue;
    if (!wantsLoad.has(a.driver)) continue;
    await notifyUsers(db, [a.driver], {
      title: 'Something was added to your load',
      body: `${a.zone} round, ${shortDay(a.day)}${a.by ? ` · added by ${a.by}` : ''}. Confirm it on My route.`,
      url: '/#/route', tag: `load-${a.id}`,
    });
  }

  // Quiet hours just ended for someone: what was held reaches them now.
  await knockHeld(db);

  return out;
}

let kicker: (() => void) | null = null;
/** Look now (soon) rather than at the next tick: after an order or a request. */
export function kickAlerts(): void { kicker?.(); }

/** Run the look every `ms`, never two at once. */
export function startAlerts(db: Db, ms = 15_000): { kick: () => void; stop: () => void } {
  let running = false;
  const go = () => {
    if (running) return;
    running = true;
    runAlerts(db).catch((err) => console.error(`  Alerts did not run: ${(err as Error).message}`))
      .finally(() => { running = false; });
  };
  const t = setInterval(go, ms);
  t.unref();
  const kick = () => { setTimeout(go, 500).unref(); };
  kicker = kick;
  return { kick, stop: () => { clearInterval(t); kicker = null; } };
}
