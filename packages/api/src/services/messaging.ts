/**
 * Talking to customers (team feedback, 1 Oct 2026, points 8 and 23):
 *
 *   - order confirmations: an email when an order is placed and when it is
 *     delivered (with the invoice attached when one was raised);
 *   - News & offers, shown on the customer's portal home;
 *   - customer lists (by zone, delivery day, account type, what they owe...)
 *     and messages sent to a list by email, with a WhatsApp link per
 *     customer for the office to send the same words by hand;
 *   - the business WhatsApp number, for an "Order on WhatsApp" button.
 *
 * Every email here is best-effort: a message that cannot go is logged and
 * reported, and never undoes the order, delivery or post it was about.
 */

import type { Db, Queryable } from '../db/index.ts';
import type { Actor } from './core.ts';
import { audit, getSetting, num, requireRole, siteUrl } from './core.ts';
import { RuleViolation, computeLineTotal } from '@alka/shared';
import {
  mailConfigured, sendMail, renderInvoicePdf, formatCash as cash, fmtDate, qtyWords, invoiceEmailFigures,
} from './documents.ts';
import { customerEmail, customerWants, newsImageUrl } from './emailkit.ts';

/* ------------------------------------------------------------------ */
/* Order confirmations                                                 */
/* ------------------------------------------------------------------ */

async function logAuto(
  db: Queryable, kind: string, customerId: string, sentTo: string | null,
  key: string | null, detail: string, ok: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO auto_emails (kind, customer_id, sent_to, period_key, detail, ok)
     VALUES ($1,$2,$3,$4,$5,$6)`, [kind, customerId, sentTo, key, detail, ok],
  );
}

async function alreadySent(db: Queryable, kind: string, key: string): Promise<boolean> {
  return !!(await db.maybeOne(
    `SELECT 1 FROM auto_emails WHERE kind = $1 AND period_key = $2 AND ok`, [kind, key],
  ));
}

/** An order's lines as email items, with what each comes to. */
async function orderItems(db: Queryable, orderId: string): Promise<Array<{ name: string; qty: string; amount: string }>> {
  const rows = await db.query<{ name: string; bpc: number; cases: number; loose: number; ppc: number; ppb: number }>(
    `SELECT p.name, p.bottles_per_case AS bpc, oli.cases, oli.loose_bottles AS loose,
            oli.price_per_case_cents AS ppc, oli.price_per_bottle_cents AS ppb
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1 ORDER BY p.is_bottle_charge, p.name`, [orderId],
  );
  return rows
    .filter((r) => num(r.cases) > 0 || num(r.loose) > 0)
    .map((r) => ({
      name: r.name,
      qty: qtyWords(num(r.bpc), num(r.cases), num(r.loose)),
      amount: cash(computeLineTotal({
        bottlesPerCase: num(r.bpc), cases: num(r.cases), looseBottles: num(r.loose),
        pricePerCase: num(r.ppc), pricePerBottle: num(r.ppb),
      })),
    }));
}

/** What one stop actually handed over. */
async function stopItems(db: Queryable, stopId: string): Promise<Array<{ name: string; qty: string }>> {
  const rows = await db.query<{ name: string; bpc: number; cases: number; loose: number }>(
    `SELECT p.name, p.bottles_per_case AS bpc, sl.cases, sl.loose_bottles AS loose
     FROM delivery_stop_lines sl JOIN products p ON p.id = sl.product_id
     WHERE sl.stop_id = $1 AND sl.total_bottles > 0 ORDER BY p.is_bottle_charge, p.name`, [stopId],
  );
  return rows.map((r) => ({ name: r.name, qty: qtyWords(num(r.bpc), num(r.cases), num(r.loose)) }));
}

/** What is still to come on an order after its deliveries so far. */
export async function remainingItems(db: Queryable, orderId: string): Promise<Array<{ name: string; qty: string }>> {
  const rows = await db.query<{ name: string; bpc: number; cases: number; loose: number }>(
    `SELECT p.name, p.bottles_per_case AS bpc,
            GREATEST(oli.cases - oli.delivered_cases, 0) AS cases,
            GREATEST(oli.loose_bottles - oli.delivered_loose, 0) AS loose
     FROM order_line_items oli JOIN products p ON p.id = oli.product_id
     WHERE oli.order_id = $1 AND oli.delivered_total < oli.total_bottles
     ORDER BY p.name`, [orderId],
  );
  return rows.filter((r) => num(r.cases) > 0 || num(r.loose) > 0)
    .map((r) => ({ name: r.name, qty: qtyWords(num(r.bpc), num(r.cases), num(r.loose)) }));
}

const portalLink = (tab = 'orders') => `${siteUrl()}/#/portal/${tab}`;

/** Send one customer email and log it; never throws, never sends twice. */
async function sendLogged(
  db: Db, kind: string, key: string, customerId: string, to: string, subject: string,
  mail: { text: string; html: string; headers?: Record<string, string> },
  detail: string, attachments?: Array<{ filename: string; content: Buffer }>,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    await sendMail({ to, subject, text: mail.text, html: mail.html, headers: mail.headers, attachments });
    await logAuto(db, kind, customerId, to, key, detail, true);
    return { sent: true };
  } catch (err) {
    await logAuto(db, kind, customerId, to, key, (err as Error).message, false);
    return { sent: false, reason: (err as Error).message };
  }
}

/**
 * "Thank you for your order" (Everton, 7 Oct 2026, point 6): a tick, the
 * order number, the items, Subtotal / GCT / Total, where and when it is
 * going, the current offer, the contact address and an unsubscribe link.
 *
 * Sent for orders placed on the portal and orders the office takes, but not
 * for occurrences a standing order raises on its own a week ahead (the
 * delivery email covers those), nor counter sales.
 */
export async function sendOrderPlacedEmail(db: Db, orderId: string): Promise<{ sent: boolean; reason?: string }> {
  if (!mailConfigured()) return { sent: false, reason: 'email is not set up' };
  if ((await getSetting(db, 'order_placed_emails', 'true')) !== 'true') return { sent: false, reason: 'switched off' };
  const o = await db.maybeOne<{
    order_number: string; customer_id: string; name: string; email: string | null;
    delivery_mode: string; requested_delivery_date: string | null; grand_total_cents: number;
    gct_cents: number; subtotal_cents: number; discount_amount_cents: number; customer_po: string | null;
    parent_recurring_id: string | null; needs_review: boolean; address: string | null; gct_exempt: boolean;
    empties_expected: number | null;
  }>(
    `SELECT o.order_number, o.customer_id, c.name, c.email, o.delivery_mode,
            o.requested_delivery_date::text AS requested_delivery_date, o.grand_total_cents,
            o.gct_cents, o.subtotal_cents, o.discount_amount_cents, o.customer_po,
            o.parent_recurring_id, o.needs_review, o.gct_exempt, o.empties_expected,
            COALESCE(ca.label || ': ' || concat_ws(', ', ca.address_line1, ca.address_line2, ca.city, ca.parish),
                     c.delivery_address) AS address
     FROM customer_orders o JOIN customers c ON c.id = o.customer_id
     LEFT JOIN customer_addresses ca ON ca.id = o.address_id
     WHERE o.id = $1`, [orderId],
  );
  if (!o) return { sent: false, reason: 'no such order' };
  if (o.delivery_mode === 'Counter' || o.parent_recurring_id) return { sent: false, reason: 'not for this kind of order' };
  if (!o.email?.trim()) return { sent: false, reason: 'no email for this customer' };
  if (!(await customerWants(db, o.customer_id, 'orders'))) return { sent: false, reason: 'they have turned these off' };
  if (await alreadySent(db, 'OrderPlaced', o.order_number)) return { sent: false, reason: 'already sent' };

  const collect = o.delivery_mode === 'Pickup';
  const whenText = collect
    ? (o.requested_delivery_date ? fmtDate(o.requested_delivery_date) : 'When it suits you')
    : o.needs_review ? 'Today, to be confirmed'
      : o.requested_delivery_date ? fmtDate(o.requested_delivery_date) : 'Your next delivery day';
  const totals: Array<[string, string, boolean?]> = [['Subtotal', cash(num(o.subtotal_cents))]];
  if (num(o.discount_amount_cents) > 0) totals.push(['Discount', `-${cash(num(o.discount_amount_cents))}`]);
  totals.push([o.gct_exempt ? 'GCT (exempt)' : 'GCT', cash(num(o.gct_cents))]);
  totals.push(['Total', cash(num(o.grand_total_cents)), true]);

  const mail = await customerEmail(db, o.customer_id, 'orders', {
    preheader: `Order ${o.order_number}: ${cash(num(o.grand_total_cents))}`,
    tick: true,
    heading: 'Thank you for your order',
    subheading: `Order ${o.order_number}${o.customer_po ? ` · your PO ${o.customer_po}` : ''}`,
    greeting: `Good day ${o.name},`,
    intro: o.needs_review
      ? 'You asked for delivery today. Orders for the same day after our cut-off need a quick check, so we will confirm the day with you shortly.'
      : 'We have your order and will have it with you as below.',
    items: await orderItems(db, orderId),
    totals,
    facts: collect
      ? [['Collect from us', whenText]]
      : [['Delivery address', o.address ?? 'Your main address'], ['Delivery date', whenText]],
    button: { label: 'See my orders', url: portalLink('orders') },
    // Wording from Everton, 10 Oct 2026.
    outro: (o.empties_expected != null ? `Empties to be returned: ${o.empties_expected}\n\n` : '')
      + 'The invoice is made out from what is actually delivered.',
  });
  return sendLogged(db, 'OrderPlaced', o.order_number, o.customer_id, o.email.trim(),
    `Alka Vida order ${o.order_number} received`, mail, 'order confirmation');
}

/** "Your water was delivered", with the invoice attached when there is one. */
export async function sendDeliveredEmail(db: Db, stopId: string): Promise<{ sent: boolean; reason?: string }> {
  if (!mailConfigured()) return { sent: false, reason: 'email is not set up' };
  if ((await getSetting(db, 'order_delivered_emails', 'true')) !== 'true') return { sent: false, reason: 'switched off' };
  const s = await db.maybeOne<{
    order_id: string; order_number: string; customer_id: string; name: string; email: string | null;
    stop_outcome: string; invoice_id: string | null; day: string;
    empties: number; fulls: number; invoice_cycle: string; remainder_to: string | null;
  }>(
    `SELECT st.order_id, o.order_number, st.customer_id, c.name, c.email,
            st.stop_outcome, st.invoice_id, ds.delivery_date::text AS day,
            st.bottles_empties_picked_up AS empties, st.bottles_delivered_full AS fulls, c.invoice_cycle,
            st.remainder_to::text AS remainder_to
     FROM delivery_stops st JOIN customers c ON c.id = st.customer_id
     JOIN customer_orders o ON o.id = st.order_id
     JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
     WHERE st.id = $1`, [stopId],
  );
  if (!s || s.stop_outcome !== 'Delivered') return { sent: false, reason: 'not delivered' };
  if (!s.email?.trim()) return { sent: false, reason: 'no email for this customer' };
  if (!(await customerWants(db, s.customer_id, 'orders'))) return { sent: false, reason: 'they have turned these off' };
  const key = `${s.order_number}@${stopId}`;
  const kind = s.remainder_to ? 'OrderPartDelivered' : 'OrderDelivered';
  if (await alreadySent(db, kind, key)) return { sent: false, reason: 'already sent' };

  let attachment: { filename: string; content: Buffer } | null = null;
  let totals: Array<[string, string, boolean?]> | undefined;
  const facts: Array<[string, string]> = [['Delivered on', fmtDate(s.day)]];
  let invoiceLine = '';
  if (s.invoice_id) {
    const doc = await renderInvoicePdf(db, s.invoice_id);
    attachment = { filename: doc.filename, content: doc.pdf };
    const f = await invoiceEmailFigures(db, s.invoice_id);
    totals = f.totals;
    facts.push(['Invoice', f.invoiceNumber]);
    facts.push(['To pay', f.balanceCents > 0 ? `${cash(f.balanceCents)}${f.dueDate ? `, due ${fmtDate(f.dueDate)}` : ''}` : 'Paid, thank you']);
    invoiceLine = `Invoice ${f.invoiceNumber} is attached.`;
  } else if (s.invoice_cycle === 'Weekly' || s.invoice_cycle === 'Monthly') {
    invoiceLine = `This delivery will be on your ${s.invoice_cycle.toLowerCase()} invoice.`;
  }
  const rest = s.remainder_to ? await remainingItems(db, s.order_id) : [];
  const restText = s.remainder_to
    ? `The rest of your order (${rest.map((r) => `${r.qty} ${r.name}`).join(', ') || 'what is left'}) is coming on ${fmtDate(s.remainder_to)}. `
      + 'We have invoiced only what was delivered today; the rest is invoiced when it arrives.'
    : '';
  const mail = await customerEmail(db, s.customer_id, 'orders', {
    preheader: s.remainder_to ? `Part of order ${s.order_number} delivered; the rest on ${fmtDate(s.remainder_to)}`
      : `Order ${s.order_number} delivered`,
    tick: true,
    heading: s.remainder_to ? 'Part of your order was delivered' : 'Your order was delivered',
    subheading: `Order ${s.order_number}`,
    greeting: `Good day ${s.name},`,
    intro: [restText, invoiceLine].filter(Boolean).join('\n\n') || undefined,
    items: (await stopItems(db, stopId)).map((i) => ({ ...i })),
    totals,
    facts: s.remainder_to ? [...facts, ['Rest coming on', fmtDate(s.remainder_to)]] : facts,
    button: { label: 'See my account', url: portalLink('account') },
    outro: (num(s.fulls) > 0 || num(s.empties) > 0
      ? `5-gallon bottles: ${num(s.fulls)} full left with you, ${num(s.empties)} empties collected.\n\n` : '')
      + 'Thank you for choosing Alka Vida.',
  });
  return sendLogged(db, kind, key, s.customer_id, s.email.trim(),
    s.remainder_to ? `Alka Vida order ${s.order_number}: part delivered` : `Alka Vida order ${s.order_number} delivered`,
    mail, s.remainder_to ? 'part delivered' : 'delivery confirmation', attachment ? [attachment] : undefined);
}

/**
 * A delivery moved to another day (Everton, 7 Oct 2026, point 8): the new
 * date and the reason, to the customer. One per move.
 */
export async function sendRescheduledEmail(db: Db, stopId: string): Promise<{ sent: boolean; reason?: string }> {
  if (!mailConfigured()) return { sent: false, reason: 'email is not set up' };
  const s = await db.maybeOne<{
    order_id: string; order_number: string; customer_id: string; name: string; email: string | null;
    from_day: string; to_day: string | null; reason: string | null;
  }>(
    `SELECT st.order_id, o.order_number, st.customer_id, c.name, c.email,
            ds.delivery_date::text AS from_day, st.rescheduled_to::text AS to_day, st.reschedule_reason AS reason
     FROM delivery_stops st JOIN customers c ON c.id = st.customer_id
     JOIN customer_orders o ON o.id = st.order_id
     JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
     WHERE st.id = $1 AND st.stop_outcome = 'Rescheduled'`, [stopId],
  );
  if (!s || !s.to_day) return { sent: false, reason: 'not rescheduled' };
  if (!s.email?.trim()) return { sent: false, reason: 'no email for this customer' };
  if (!(await customerWants(db, s.customer_id, 'orders'))) return { sent: false, reason: 'they have turned these off' };
  const key = `${s.order_number}@${stopId}`;
  if (await alreadySent(db, 'OrderRescheduled', key)) return { sent: false, reason: 'already sent' };
  const mail = await customerEmail(db, s.customer_id, 'orders', {
    preheader: `Order ${s.order_number} now coming on ${fmtDate(s.to_day)}`,
    heading: 'Your delivery has a new date',
    subheading: `Order ${s.order_number}`,
    greeting: `Good day ${s.name},`,
    intro: `We have moved your delivery from ${fmtDate(s.from_day)} to ${fmtDate(s.to_day)}.`
      + (s.reason ? `\n\nReason: ${s.reason}` : ''),
    items: await orderItems(db, s.order_id),
    facts: [['Was', fmtDate(s.from_day)], ['Now', fmtDate(s.to_day)]],
    button: { label: 'See my orders', url: portalLink('orders') },
    outro: 'If the new day does not suit you, reply to this email or give us a call and we will sort it out.',
  });
  return sendLogged(db, 'OrderRescheduled', key, s.customer_id, s.email.trim(),
    `Alka Vida order ${s.order_number}: new delivery date ${fmtDate(s.to_day)}`, mail,
    `rescheduled to ${s.to_day}`);
}

/** An order cancelled, by the office or by the customer (point 4). */
export async function sendOrderCancelledEmail(
  db: Db, orderId: string, reason?: string | null,
): Promise<{ sent: boolean; reason?: string }> {
  if (!mailConfigured()) return { sent: false, reason: 'email is not set up' };
  const o = await db.maybeOne<{
    order_number: string; customer_id: string; name: string; email: string | null; status: string;
    delivery_mode: string; grand_total_cents: number;
  }>(
    `SELECT o.order_number, o.customer_id, c.name, c.email, o.status, o.delivery_mode, o.grand_total_cents
     FROM customer_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`, [orderId],
  );
  if (!o || o.status !== 'Cancelled') return { sent: false, reason: 'not cancelled' };
  if (o.delivery_mode === 'Counter') return { sent: false, reason: 'not for this kind of order' };
  if (!o.email?.trim()) return { sent: false, reason: 'no email for this customer' };
  if (!(await customerWants(db, o.customer_id, 'cancelled'))) return { sent: false, reason: 'they have turned these off' };
  if (await alreadySent(db, 'OrderCancelled', o.order_number)) return { sent: false, reason: 'already sent' };
  const mail = await customerEmail(db, o.customer_id, 'cancelled', {
    preheader: `Order ${o.order_number} has been cancelled`,
    heading: 'Your order has been cancelled',
    subheading: `Order ${o.order_number}`,
    greeting: `Good day ${o.name},`,
    intro: `Order ${o.order_number} has been cancelled and will not be delivered. Nothing is owed for it.`
      + (reason?.trim() ? `\n\nReason: ${reason.trim()}` : ''),
    items: await orderItems(db, orderId),
    button: { label: 'Place a new order', url: portalLink('order') },
    outro: 'If this is a mistake, reply to this email or give us a call.',
  });
  return sendLogged(db, 'OrderCancelled', o.order_number, o.customer_id, o.email.trim(),
    `Alka Vida order ${o.order_number} cancelled`, mail, 'order cancelled');
}

/* ------------------------------------------------------------------ */
/* News & offers                                                       */
/* ------------------------------------------------------------------ */

export interface NewsInput {
  kind?: 'News' | 'Promotion' | 'Closure' | 'Update';
  title?: string; body?: string;
  startsOn?: string | null; endsOn?: string | null;
  published?: boolean; pinned?: boolean;
  /** Pictures already uploaded (uploadNewsImage), in the order to show them. */
  imageIds?: string[] | null;
}

const KINDS = ['News', 'Promotion', 'Closure', 'Update'];

export async function listNews(db: Db, opts: { live?: boolean } = {}) {
  const posts = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT id, kind, title, body, starts_on::text AS starts_on, ends_on::text AS ends_on,
            published, pinned, created_at, updated_at,
            (published AND starts_on <= business_today()
              AND (ends_on IS NULL OR ends_on >= business_today())) AS live
     FROM news_posts
     WHERE NOT $1::boolean
        OR (published AND starts_on <= business_today()
            AND (ends_on IS NULL OR ends_on >= business_today()))
     ORDER BY pinned DESC, starts_on DESC, created_at DESC
     LIMIT 100`, [opts.live === true],
  );
  const imgs = posts.length ? await db.query<{ id: string; post_id: string }>(
    `SELECT id, post_id FROM news_images WHERE post_id = ANY($1::uuid[]) ORDER BY position, created_at`,
    [posts.map((p) => p.id)],
  ) : [];
  return posts.map((p) => ({
    ...p,
    // Relative, so the screen works on any address; emails use the full one.
    images: imgs.filter((i) => i.post_id === p.id).map((i) => ({ id: i.id, url: `/api/public/news-images/${i.id}` })),
  }));
}

/* Pictures (Everton, 7 Oct 2026, point 3) ---------------------------- */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
/** The browser shrinks a photo before it is sent; this is the backstop. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * Store one picture for a post, from a data URL (`data:image/jpeg;base64,...`).
 * It belongs to no post until the post is saved with its id in `imageIds`.
 * Kept in the database rather than on disk: Railway's disk is wiped on every
 * deploy, and the database is already backed up.
 */
export async function uploadNewsImage(db: Db, actor: Actor, dataUrl: string): Promise<{ id: string; url: string }> {
  requireRole(actor, 'admin', 'user');
  const m = /^data:([a-z/+.-]+);base64,(.+)$/i.exec(String(dataUrl ?? '').trim());
  if (!m) throw new RuleViolation('that is not a picture this can read. Use a JPEG or PNG photo.');
  const type = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  if (!IMAGE_TYPES.includes(type)) throw new RuleViolation('use a JPEG, PNG, WebP or GIF picture');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0) throw new RuleViolation('the picture is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new RuleViolation('that picture is too large (over 3 MB). Use a smaller one.');
  const row = await db.one<{ id: string }>(
    `INSERT INTO news_images (content_type, data, bytes, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [type, bytes, bytes.length, actor.id],
  );
  // Pictures uploaded but never saved with a post are tidied away after a day.
  await db.query(`DELETE FROM news_images WHERE post_id IS NULL AND created_at < now() - interval '1 day'`);
  return { id: row.id, url: `/api/public/news-images/${row.id}` };
}

/** PUBLIC: the picture itself, for the portal and for email clients. */
export async function getNewsImage(db: Db, id: string): Promise<{ type: string; data: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.maybeOne<{ content_type: string; data: Uint8Array }>(
    `SELECT content_type, data FROM news_images WHERE id = $1::uuid`, [id],
  );
  return r ? { type: r.content_type, data: Buffer.from(r.data) } : null;
}

export async function saveNews(db: Db, actor: Actor, id: string | null, input: NewsInput): Promise<{ id: string }> {
  requireRole(actor, 'admin', 'user');
  const title = input.title?.trim();
  if (!title) throw new RuleViolation('a post needs a headline');
  const kind = KINDS.includes(input.kind ?? '') ? input.kind! : 'News';
  if (input.endsOn && input.startsOn && input.endsOn < input.startsOn) {
    throw new RuleViolation('it cannot stop showing before it starts');
  }
  return db.tx(async (t) => {
    let postId = id;
    if (postId) {
      await t.query(
        `UPDATE news_posts SET kind = $2, title = $3, body = $4,
           starts_on = COALESCE($5::date, starts_on), ends_on = $6::date,
           published = $7, pinned = $8, updated_at = now()
         WHERE id = $1`,
        [postId, kind, title, input.body?.trim() ?? '', input.startsOn || null, input.endsOn || null,
         input.published !== false, !!input.pinned],
      );
    } else {
      const row = await t.one<{ id: string }>(
        `INSERT INTO news_posts (kind, title, body, starts_on, ends_on, published, pinned, created_by)
         VALUES ($1,$2,$3,COALESCE($4::date, business_today()),$5::date,$6,$7,$8) RETURNING id`,
        [kind, title, input.body?.trim() ?? '', input.startsOn || null, input.endsOn || null,
         input.published !== false, !!input.pinned, actor.id],
      );
      postId = row.id;
    }
    if (Array.isArray(input.imageIds)) await attachImages(t, postId!, input.imageIds);
    await audit(t, actor, id ? 'update' : 'create', 'NewsPost', postId, title,
      { kind, pictures: Array.isArray(input.imageIds) ? input.imageIds.length : undefined });
    return { id: postId! };
  });
}

/** The post's pictures become exactly these, in this order. */
async function attachImages(t: Queryable, postId: string, ids: readonly string[]): Promise<void> {
  const clean = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(String(x))).slice(0, 8);
  await t.query(`DELETE FROM news_images WHERE post_id = $1 AND NOT (id = ANY($2::uuid[]))`, [postId, clean]);
  for (const [i, imgId] of clean.entries()) {
    await t.query(
      `UPDATE news_images SET post_id = $2, position = $3 WHERE id = $1 AND (post_id IS NULL OR post_id = $2)`,
      [imgId, postId, i],
    );
  }
}

export async function deleteNews(db: Db, actor: Actor, id: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    await t.query(`DELETE FROM news_posts WHERE id = $1`, [id]);
    await audit(t, actor, 'delete', 'NewsPost', id, id, {});
  });
}

/* ------------------------------------------------------------------ */
/* Customer lists                                                      */
/* ------------------------------------------------------------------ */

export interface ListCriteria {
  zones?: string[];
  days?: string[];
  accountTypes?: string[];
  cycles?: string[];
  priceTierIds?: string[];
  /** Owes anything at all. */
  owes?: boolean;
  /** Has an invoice past its due date. */
  overdue?: boolean;
  /** Ordered within the last N days. */
  orderedWithinDays?: number | null;
  /** Has NOT ordered for N days (or ever). */
  quietForDays?: number | null;
  /** Can sign in to the portal. */
  onPortal?: boolean;
}

export interface ListMember {
  id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null;
  delivery_zone: string | null; account_type: string; marketing_opt_out: boolean;
  service_emails?: boolean;
  balance_cents: number;
}

/** Customers matching a rule, plus anyone added by hand, less anyone left out. */
export async function resolveList(
  db: Queryable, criteria: ListCriteria, includeIds: string[] = [], excludeIds: string[] = [],
): Promise<ListMember[]> {
  const c = criteria ?? {};
  const arr = (v: unknown) => (Array.isArray(v) && v.length ? v.map(String) : null);
  const n = (v: unknown) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.round(Number(v)) || 0));
  return db.query<ListMember>(
    `SELECT c.id, c.name, c.email, c.phone, c.whatsapp, c.delivery_zone, c.account_type,
            c.marketing_opt_out, c.service_emails, COALESCE(b.balance_cents, 0)::bigint AS balance_cents
     FROM customers c
     LEFT JOIN customer_balances b ON b.customer_id = c.id
     WHERE c.active AND NOT c.is_walk_in
       AND NOT (c.id = ANY($10::uuid[]))
       AND (c.id = ANY($9::uuid[]) OR (
             ($1::text[] IS NULL OR c.delivery_zone = ANY($1::text[]))
         AND ($2::text[] IS NULL OR c.delivery_days && $2::text[])
         AND ($3::text[] IS NULL OR c.account_type = ANY($3::text[]))
         AND ($4::text[] IS NULL OR c.invoice_cycle = ANY($4::text[]))
         AND ($5::uuid[] IS NULL OR c.price_tier_id = ANY($5::uuid[]))
         AND (NOT $6::boolean OR COALESCE(b.balance_cents, 0) > 0)
         AND (NOT $7::boolean OR EXISTS (
               SELECT 1 FROM invoice_ledger l WHERE l.customer_id = c.id AND NOT l.is_credit_note
                 AND l.status <> 'Cancelled' AND l.balance_cents > 0
                 AND l.due_date < business_today()))
         AND ($8::int IS NULL OR EXISTS (
               SELECT 1 FROM customer_orders o WHERE o.customer_id = c.id AND o.status <> 'Cancelled'
                 AND o.order_date >= business_today() - $8::int))
         AND ($11::int IS NULL OR NOT EXISTS (
               SELECT 1 FROM customer_orders o WHERE o.customer_id = c.id AND o.status <> 'Cancelled'
                 AND o.order_date >= business_today() - $11::int))
         AND (NOT $12::boolean OR c.user_id IS NOT NULL)
       ))
     ORDER BY c.name`,
    [arr(c.zones), arr(c.days), arr(c.accountTypes), arr(c.cycles), arr(c.priceTierIds),
     !!c.owes, !!c.overdue, n(c.orderedWithinDays), includeIds ?? [], excludeIds ?? [],
     n(c.quietForDays), !!c.onPortal],
  );
}

export async function listCustomerLists(db: Db) {
  const lists = await db.query<{
    id: string; name: string; criteria: ListCriteria; include_ids: string[]; exclude_ids: string[];
    updated_at: string;
  }>(`SELECT id, name, criteria, include_ids, exclude_ids, updated_at FROM customer_lists ORDER BY name`);
  const out = [];
  for (const l of lists) {
    const members = await resolveList(db, l.criteria, l.include_ids, l.exclude_ids);
    out.push({ ...l, size: members.length, withEmail: members.filter((m) => m.email?.trim()).length });
  }
  return out;
}

export async function saveCustomerList(
  db: Db, actor: Actor, id: string | null,
  input: { name?: string; criteria?: ListCriteria; includeIds?: string[]; excludeIds?: string[] },
): Promise<{ id: string }> {
  requireRole(actor, 'admin', 'user');
  const name = input.name?.trim();
  if (!name) throw new RuleViolation('give the list a name, e.g. "Kingston, Mondays"');
  return db.tx(async (t) => {
    const dup = await t.maybeOne(`SELECT 1 FROM customer_lists WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)`, [name, id]);
    if (dup) throw new RuleViolation(`there is already a list called "${name}"`);
    let listId = id;
    const vals = [name, JSON.stringify(input.criteria ?? {}), input.includeIds ?? [], input.excludeIds ?? []];
    if (listId) {
      await t.query(
        `UPDATE customer_lists SET name = $2, criteria = $3::jsonb, include_ids = $4::uuid[],
           exclude_ids = $5::uuid[], updated_at = now() WHERE id = $1`, [listId, ...vals],
      );
    } else {
      const row = await t.one<{ id: string }>(
        `INSERT INTO customer_lists (name, criteria, include_ids, exclude_ids, created_by)
         VALUES ($1,$2::jsonb,$3::uuid[],$4::uuid[],$5) RETURNING id`, [...vals, actor.id],
      );
      listId = row.id;
    }
    await audit(t, actor, id ? 'update' : 'create', 'CustomerList', listId, name, {});
    return { id: listId! };
  });
}

export async function deleteCustomerList(db: Db, actor: Actor, id: string): Promise<void> {
  requireRole(actor, 'admin', 'user');
  await db.tx(async (t) => {
    await t.query(`DELETE FROM customer_lists WHERE id = $1`, [id]);
    await audit(t, actor, 'delete', 'CustomerList', id, id, {});
  });
}

/* ------------------------------------------------------------------ */
/* WhatsApp                                                            */
/* ------------------------------------------------------------------ */

/**
 * A number as WhatsApp wants it: digits only, with the country code. A
 * Jamaican number written the usual way (876-555-1234, or just 555-1234) gets
 * the +1 876 it needs.
 */
export function whatsappDigits(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 7) return `1876${d}`;
  if (d.length === 10) return `1${d}`;
  if (d.length >= 11) return d;
  return null;
}

export function whatsappLink(raw: string | null | undefined, text?: string): string | null {
  const digits = whatsappDigits(raw);
  if (!digits) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export async function businessWhatsapp(db: Queryable): Promise<{ number: string; link: string | null }> {
  const number = (await getSetting(db, 'whatsapp_number', '')).trim();
  return { number, link: whatsappLink(number, 'Hi Alka Vida, I would like to place an order:') };
}

/* ------------------------------------------------------------------ */
/* Messages to customers                                               */
/* ------------------------------------------------------------------ */

export interface BroadcastInput {
  subject?: string;
  body?: string;
  purpose?: 'Marketing' | 'Service';
  listId?: string | null;
  criteria?: ListCriteria | null;
  customerIds?: string[] | null;
  /** Also put it on the portal's News & offers. */
  postAsNews?: { kind?: NewsInput['kind']; endsOn?: string | null } | null;
  /** Pictures for the email (and the post), uploaded first. */
  imageIds?: string[] | null;
  /** Send an existing News & offers post, pictures and all. */
  newsPostId?: string | null;
}

/**
 * Queue a message to a list (or a rule, or picked customers) and start
 * sending. Marketing respects each customer's "News and special offers"
 * tick; Service messages (closures, blackout days, a change of delivery
 * day) respect their "Service announcements" tick (7 Oct 2026).
 * Resend's free plan sends 100 emails a day, so at most the daily cap goes
 * now and the rest go on the hourly check over the next day or two.
 */
export async function createBroadcast(db: Db, actor: Actor, input: BroadcastInput) {
  requireRole(actor, 'admin', 'user');
  const subject = input.subject?.trim();
  const body = input.body?.trim();
  if (!subject) throw new RuleViolation('the message needs a subject');
  if (!body) throw new RuleViolation('the message needs some words');
  const purpose = input.purpose === 'Service' ? 'Service' : 'Marketing';

  let listName: string | null = null;
  let members: ListMember[];
  if (input.listId) {
    const l = await db.maybeOne<{ name: string; criteria: ListCriteria; include_ids: string[]; exclude_ids: string[] }>(
      `SELECT name, criteria, include_ids, exclude_ids FROM customer_lists WHERE id = $1`, [input.listId],
    );
    if (!l) throw new RuleViolation('that list no longer exists');
    listName = l.name;
    members = await resolveList(db, l.criteria, l.include_ids, l.exclude_ids);
  } else if (input.customerIds?.length) {
    members = await resolveList(db, { zones: ['__none__'] }, input.customerIds, []);
    listName = `${members.length} chosen customer${members.length === 1 ? '' : 's'}`;
  } else {
    members = await resolveList(db, input.criteria ?? {}, [], []);
    listName = 'Customers matching a filter';
  }
  if (members.length === 0) throw new RuleViolation('nobody is on that list');

  const id = await db.tx(async (t) => {
    let newsId: string | null = input.newsPostId || null;
    if (!newsId && input.postAsNews) {
      const n = await t.one<{ id: string }>(
        `INSERT INTO news_posts (kind, title, body, ends_on, created_by)
         VALUES ($1,$2,$3,$4::date,$5) RETURNING id`,
        [KINDS.includes(input.postAsNews.kind ?? '') ? input.postAsNews.kind : (purpose === 'Service' ? 'Update' : 'Promotion'),
         subject, body, input.postAsNews.endsOn || null, actor.id],
      );
      newsId = n.id;
      if (Array.isArray(input.imageIds)) await attachImages(t, newsId, input.imageIds);
    } else if (!newsId && input.imageIds?.length) {
      // Pictures for the email only: they ride on a post that is never shown.
      const n = await t.one<{ id: string }>(
        `INSERT INTO news_posts (kind, title, body, published, created_by)
         VALUES ($1,$2,$3,false,$4) RETURNING id`,
        [purpose === 'Service' ? 'Update' : 'Promotion', subject, body, actor.id],
      );
      newsId = n.id;
      await attachImages(t, newsId, input.imageIds);
    }
    const b = await t.one<{ id: string }>(
      `INSERT INTO broadcasts (subject, body, purpose, list_id, list_name, criteria, news_post_id,
                               created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id`,
      [subject, body, purpose, input.listId ?? null, listName,
       input.criteria ? JSON.stringify(input.criteria) : null, newsId, actor.id, actor.name],
    );
    for (const m of members) {
      const email = m.email?.trim() || null;
      // Each kind respects its own tick (7 Oct 2026, point 4): offers the
      // "News and special offers" one, service messages "Service announcements".
      const skip = !email ? 'no email address'
        : purpose === 'Marketing' && m.marketing_opt_out ? 'opted out of offers'
          : purpose === 'Service' && m.service_emails === false ? 'opted out of service announcements' : null;
      await t.query(
        `INSERT INTO broadcast_recipients (broadcast_id, customer_id, email, whatsapp, status, error)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [b.id, m.id, email, whatsappDigits(m.whatsapp ?? m.phone), skip ? 'Skipped' : 'Queued', skip],
      );
    }
    await audit(t, actor, 'create', 'Broadcast', b.id, subject, { purpose, listName, recipients: members.length });
    return b.id;
  });

  const sent = await sendQueuedMessages(db);
  return { id, recipients: members.length, ...sent };
}

/** Send what is queued, up to what is left of today's allowance. */
export async function sendQueuedMessages(db: Db): Promise<{ sentNow: number; stillQueued: number; problem?: string }> {
  const queued = async () => num((await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM broadcast_recipients WHERE status = 'Queued'`)).n);
  if (!mailConfigured()) return { sentNow: 0, stillQueued: await queued(), problem: 'email is not set up' };
  const cap = Math.max(0, Number(await getSetting(db, 'broadcast_daily_cap', '80')) || 0);
  const today = num((await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM broadcast_recipients
     WHERE status IN ('Sent','Failed') AND business_date(sent_at) = business_today()`)).n);
  const room = Math.max(0, cap - today);
  const batch = await db.query<{
    id: string; email: string; customer_id: string; name: string; subject: string; body: string; purpose: string;
    news_post_id: string | null;
  }>(
    `SELECT r.id, r.email, r.customer_id, c.name, b.subject, b.body, b.purpose, b.news_post_id
     FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id
     JOIN customers c ON c.id = r.customer_id
     WHERE r.status = 'Queued' ORDER BY b.created_at, c.name LIMIT $1`, [room],
  );
  let sentNow = 0;
  for (const r of batch) {
    try {
      const pics = r.news_post_id ? await db.query<{ id: string }>(
        `SELECT id FROM news_images WHERE post_id = $1 ORDER BY position, created_at`, [r.news_post_id],
      ) : [];
      const category = r.purpose === 'Marketing' ? 'offers' : 'service';
      const mail = await customerEmail(db, r.customer_id, category, {
        preheader: r.subject,
        heading: r.subject,
        greeting: `Good day ${r.name},`,
        intro: r.body,
        // The pictures as cards, the first one large.
        cards: pics.length ? pics.map((p) => ({ imageUrl: newsImageUrl(p.id) })) : undefined,
        button: { label: 'Order or see my account', url: `${siteUrl()}/#/portal/home` },
        // The message IS the offer; no second band repeating it.
        ...(r.purpose === 'Marketing' ? { offer: null } : {}),
      });
      await sendMail({ to: r.email, subject: r.subject, text: mail.text, html: mail.html, headers: mail.headers });
      await db.query(`UPDATE broadcast_recipients SET status = 'Sent', sent_at = now(), error = NULL WHERE id = $1`, [r.id]);
      sentNow += 1;
    } catch (err) {
      await db.query(`UPDATE broadcast_recipients SET status = 'Failed', sent_at = now(), error = $2 WHERE id = $1`,
        [r.id, (err as Error).message.slice(0, 300)]);
    }
  }
  return { sentNow, stillQueued: await queued() };
}

export async function listBroadcasts(db: Db) {
  return db.query(
    `SELECT b.id, b.subject, b.purpose, b.list_name, b.created_at, b.created_by_name,
            COUNT(r.*)::int AS recipients,
            COUNT(r.*) FILTER (WHERE r.status = 'Sent')::int AS sent,
            COUNT(r.*) FILTER (WHERE r.status = 'Queued')::int AS queued,
            COUNT(r.*) FILTER (WHERE r.status = 'Failed')::int AS failed,
            COUNT(r.*) FILTER (WHERE r.status = 'Skipped')::int AS skipped
     FROM broadcasts b LEFT JOIN broadcast_recipients r ON r.broadcast_id = b.id
     GROUP BY b.id ORDER BY b.created_at DESC LIMIT 50`,
  );
}

/** One message with everyone it went to, and a WhatsApp link for each. */
export async function getBroadcast(db: Db, id: string) {
  const b = await db.maybeOne<{ id: string; subject: string; body: string; purpose: string; list_name: string | null; created_at: string }>(
    `SELECT id, subject, body, purpose, list_name, created_at FROM broadcasts WHERE id = $1`, [id],
  );
  if (!b) return null;
  const rows = await db.query<{
    customer_id: string; name: string; email: string | null; whatsapp: string | null;
    status: string; error: string | null; sent_at: string | null;
  }>(
    `SELECT r.customer_id, c.name, r.email, r.whatsapp, r.status, r.error, r.sent_at
     FROM broadcast_recipients r JOIN customers c ON c.id = r.customer_id
     WHERE r.broadcast_id = $1 ORDER BY c.name`, [id],
  );
  const waText = `${b.subject}\n\n${b.body}\n\nOrder online: ${siteUrl()}`;
  return {
    ...b,
    recipients: rows.map((r) => ({ ...r, whatsappLink: r.whatsapp ? `https://wa.me/${r.whatsapp}?text=${encodeURIComponent(waText)}` : null })),
  };
}
