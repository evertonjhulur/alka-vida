/**
 * How every email looks, and who may be sent which kind (7 Oct 2026, points
 * 4, 5 and 6).
 *
 * One layout for everything that leaves the building - order confirmations,
 * invoices, statements, receipts, reminders, messages - so they read as one
 * company: the logo on white, a band in the logo's blue, the heading in its
 * indigo (blue #0E76BC / indigo #2D3590, never the old teal), a footer band
 * carrying the current offer, the contact address, and, on anything that is
 * not essential, an unsubscribe link that works without signing in.
 *
 * Every email is sent as HTML with a plain-text twin, so a mail program that
 * shows only text still gets every figure.
 *
 * WHICH EMAILS A CUSTOMER GETS. Each non-essential kind has a tick on My
 * Profile > Emails from us, and a column on the customer:
 *
 *   orders      order_emails       placed, delivered, rescheduled, part delivered
 *   cancelled   cancel_emails      an order cancelled
 *   statements  auto_statements    the automatic monthly statement
 *   reminders   auto_reminders     automatic overdue reminders (office tick)
 *   offers      NOT marketing_opt_out   news and special offers
 *   service     service_emails     service announcements (closures, holidays)
 *
 * Essential emails - an invoice, receipt, quote or statement the office sends
 * by hand, a password link, the account-approved email - have no tick and no
 * unsubscribe link: they are the business itself, not a mailing.
 */

import type { Queryable } from '../db/index.ts';
import { audit, contactEmail, siteUrl } from './core.ts';
export { contactEmail };
import { logoPath } from './documents.ts';

export const COLORS = {
  blue: '#0E76BC',
  indigo: '#2D3590',
  ink: '#1d2433',
  muted: '#5b6475',
  line: '#dfe5ee',
  page: '#f2f5f9',
  tint: '#eef6fc',
  ok: '#1a7f37',
};

export const EMAIL_CATEGORIES = ['orders', 'cancelled', 'statements', 'reminders', 'offers', 'service'] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<EmailCategory, string> = {
  orders: 'order confirmations and delivery updates',
  cancelled: 'order cancelled emails',
  statements: 'the monthly statement',
  reminders: 'payment reminders',
  offers: 'news and special offers',
  service: 'service announcements',
};

/** The customer column behind each tick; offers is stored the other way round. */
const COLUMN: Record<EmailCategory, string> = {
  orders: 'order_emails',
  cancelled: 'cancel_emails',
  statements: 'auto_statements',
  reminders: 'auto_reminders',
  offers: 'marketing_opt_out',
  service: 'service_emails',
};

export function isCategory(v: unknown): v is EmailCategory {
  return typeof v === 'string' && (EMAIL_CATEGORIES as readonly string[]).includes(v);
}

/** Does this customer want this kind of email? */
export async function customerWants(t: Queryable, customerId: string, category: EmailCategory): Promise<boolean> {
  const row = await t.maybeOne<{ v: boolean }>(
    `SELECT ${COLUMN[category]} AS v FROM customers WHERE id = $1`, [customerId],
  );
  if (!row) return false;
  return category === 'offers' ? !row.v : !!row.v;
}

/** Switch one kind off (or on again) for the customer holding this token. */
export async function setByToken(
  t: Queryable, token: string, category: EmailCategory | 'all', wanted: boolean,
): Promise<{ name: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  const c = await t.maybeOne<{ id: string; name: string }>(
    `SELECT id, name FROM customers WHERE email_token = $1::uuid`, [token],
  );
  if (!c) return null;
  const cats = category === 'all' ? EMAIL_CATEGORIES : [category];
  for (const k of cats) {
    const value = k === 'offers' ? !wanted : wanted;
    await t.query(`UPDATE customers SET ${COLUMN[k]} = $2, updated_at = now() WHERE id = $1`, [c.id, value]);
  }
  await audit(t, null, 'update', 'Customer', c.id, c.name,
    { emails: category, wanted, byUnsubscribeLink: true });
  return { name: c.name };
}

export function unsubscribeUrl(token: string, category: EmailCategory): string {
  return `${siteUrl()}/unsubscribe?t=${encodeURIComponent(token)}&c=${category}`;
}


export interface Offer {
  title: string;
  body: string;
  imageUrl: string | null;
  endsOn: string | null;
}

export function newsImageUrl(id: string): string {
  return `${siteUrl()}/api/public/news-images/${id}`;
}

/**
 * The offer for the footer band: the newest live Promotion (pinned first).
 * None live, no band.
 */
export async function currentOffer(t: Queryable): Promise<Offer | null> {
  const p = await t.maybeOne<{ id: string; title: string; body: string; ends_on: string | null }>(
    `SELECT id, title, body, ends_on::text AS ends_on FROM news_posts
     WHERE kind = 'Promotion' AND published AND starts_on <= business_today()
       AND (ends_on IS NULL OR ends_on >= business_today())
     ORDER BY pinned DESC, starts_on DESC, created_at DESC LIMIT 1`,
  ).catch(() => null);
  if (!p) return null;
  const img = await t.maybeOne<{ id: string }>(
    `SELECT id FROM news_images WHERE post_id = $1 ORDER BY position, created_at LIMIT 1`, [p.id],
  ).catch(() => null);
  return { title: p.title, body: p.body, imageUrl: img ? newsImageUrl(img.id) : null, endsOn: p.ends_on };
}

/* ------------------------------------------------------------------ */
/* The layout                                                          */
/* ------------------------------------------------------------------ */

export const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Plain text to HTML paragraphs, keeping the writer's line breaks. */
export const paras = (s: string): string => s.split(/\n{2,}/)
  .map((p) => `<p style="margin:0 0 14px;line-height:1.55">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

export interface EmailItem { name: string; qty: string; amount?: string }
export interface EmailCard { title?: string; body?: string; imageUrl?: string | null; tag?: string; until?: string | null }

export interface EmailParts {
  /** The grey line a mail program shows beside the subject. */
  preheader?: string;
  /** A tick in a circle above the heading ("Thank you for your order"). */
  tick?: boolean;
  heading: string;
  /** Under the heading, e.g. "Order SO-00042". */
  subheading?: string;
  greeting?: string;
  /** Plain text; blank lines start a new paragraph. */
  intro?: string;
  items?: EmailItem[];
  /** [label, value, emphasise]. */
  totals?: Array<[string, string, boolean?]>;
  /** Small labelled boxes: delivery address, date, invoice number... */
  facts?: Array<[string, string]>;
  /** Picture cards (News & offers). */
  cards?: EmailCard[];
  button?: { label: string; url: string };
  /** Plain text after everything else. */
  outro?: string;
  offer?: Offer | null;
  contact?: string;
  unsubscribe?: { url: string; what: string } | null;
}

function wordmark(): string {
  return `<span style="font:800 26px/1 Arial,Helvetica,sans-serif;letter-spacing:2px">`
    + `<span style="color:${COLORS.blue}">ALKA</span> <span style="color:${COLORS.indigo}">VIDA</span></span>`;
}

function logoBlock(): string {
  if (logoPath()) {
    return `<img src="${esc(`${siteUrl()}/api/logo`)}" alt="Alka Vida" height="64" `
      + `style="display:block;height:64px;width:auto;border:0;outline:none">`;
  }
  return wordmark();
}

function cardHtml(c: EmailCard): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" `
    + `style="border:1px solid ${COLORS.line};border-radius:10px;overflow:hidden;margin:0 0 14px;background:#fff">`
    + (c.imageUrl ? `<tr><td><img src="${esc(c.imageUrl)}" alt="" width="536" `
      + `style="display:block;width:100%;max-width:536px;height:auto;border:0"></td></tr>` : '')
    + (c.title || c.body || c.tag || c.until ? `<tr><td style="padding:14px 16px">`
    + (c.tag ? `<div style="font:700 11px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;color:${COLORS.blue};margin-bottom:4px">${esc(c.tag)}</div>` : '')
    + (c.title ? `<div style="font:700 17px Arial,sans-serif;color:${COLORS.indigo};margin-bottom:6px">${esc(c.title)}</div>` : '')
    + (c.body ? `<div style="font:14px/1.5 Arial,sans-serif;color:${COLORS.ink}">${esc(c.body).replace(/\n/g, '<br>')}</div>` : '')
    + (c.until ? `<div style="font:12px Arial,sans-serif;color:${COLORS.muted};margin-top:6px">Until ${esc(c.until)}</div>` : '')
    + `</td></tr>` : '') + `</table>`;
}

const fmtDay = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/** The email as HTML and as plain text, from the same parts. */
export function renderEmail(p: EmailParts): { html: string; text: string } {
  const F = 'font-family:Arial,Helvetica,sans-serif';
  const rows: string[] = [];

  if (p.tick) {
    rows.push(`<tr><td align="center" style="padding:28px 32px 0">`
      + `<div style="width:60px;height:60px;line-height:60px;border-radius:30px;background:${COLORS.blue};`
      + `color:#fff;font:700 34px/60px Arial,sans-serif;text-align:center">&#10003;</div></td></tr>`);
  }
  rows.push(`<tr><td align="${p.tick ? 'center' : 'left'}" style="padding:${p.tick ? '14px' : '28px'} 32px 0;${F}">`
    + `<h1 style="margin:0;font-size:24px;line-height:1.25;color:${COLORS.indigo}">${esc(p.heading)}</h1>`
    + (p.subheading ? `<div style="margin-top:6px;font-size:15px;color:${COLORS.muted}">${esc(p.subheading)}</div>` : '')
    + `</td></tr>`);

  const body: string[] = [];
  if (p.greeting) body.push(`<p style="margin:0 0 14px">${esc(p.greeting)}</p>`);
  if (p.intro) body.push(paras(p.intro));

  if (p.items?.length) {
    body.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;border-collapse:collapse">`
      + `<tr><td style="padding:8px 0;border-bottom:2px solid ${COLORS.indigo};font:700 12px Arial,sans-serif;color:${COLORS.muted};text-transform:uppercase;letter-spacing:.5px">Item</td>`
      + `<td align="right" style="padding:8px 0;border-bottom:2px solid ${COLORS.indigo};font:700 12px Arial,sans-serif;color:${COLORS.muted};text-transform:uppercase;letter-spacing:.5px">Qty</td>`
      + `<td align="right" style="padding:8px 0 8px 12px;border-bottom:2px solid ${COLORS.indigo};font:700 12px Arial,sans-serif;color:${COLORS.muted};text-transform:uppercase;letter-spacing:.5px">${p.items.some((i) => i.amount) ? 'Amount' : ''}</td></tr>`
      + p.items.map((i) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${COLORS.line}">${esc(i.name)}</td>`
        + `<td align="right" style="padding:10px 0;border-bottom:1px solid ${COLORS.line};white-space:nowrap">${esc(i.qty)}</td>`
        + `<td align="right" style="padding:10px 0 10px 12px;border-bottom:1px solid ${COLORS.line};white-space:nowrap">${esc(i.amount ?? '')}</td></tr>`).join('')
      + `</table>`);
  }
  if (p.totals?.length) {
    body.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px">`
      + p.totals.map(([label, value, strong]) => `<tr>`
        + `<td align="right" style="padding:${strong ? '10px' : '4px'} 0 4px;${strong ? `font-weight:700;font-size:17px;color:${COLORS.indigo};border-top:1px solid ${COLORS.line}` : `color:${COLORS.muted}`}">${esc(label)}</td>`
        + `<td align="right" width="130" style="padding:${strong ? '10px' : '4px'} 0 4px 12px;white-space:nowrap;${strong ? `font-weight:700;font-size:17px;color:${COLORS.indigo};border-top:1px solid ${COLORS.line}` : ''}">${esc(value)}</td></tr>`).join('')
      + `</table>`);
  }
  if (p.facts?.length) {
    body.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr>`
      + p.facts.map(([label, value], i) => `<td valign="top" width="${Math.floor(100 / p.facts!.length)}%" `
        + `style="padding:12px 14px;background:${COLORS.tint};border-radius:8px;${i > 0 ? 'border-left:6px solid #fff;' : ''}">`
        + `<div style="font:700 11px Arial,sans-serif;letter-spacing:.6px;text-transform:uppercase;color:${COLORS.blue};margin-bottom:4px">${esc(label)}</div>`
        + `<div style="font:14px/1.45 Arial,sans-serif;color:${COLORS.ink}">${esc(value).replace(/\n/g, '<br>')}</div></td>`).join('')
      + `</tr></table>`);
  }
  if (p.cards?.length) body.push(p.cards.map(cardHtml).join(''));
  if (p.button) {
    body.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr>`
      + `<td style="background:${COLORS.blue};border-radius:8px"><a href="${esc(p.button.url)}" `
      + `style="display:inline-block;padding:13px 26px;font:700 15px Arial,sans-serif;color:#fff;text-decoration:none">${esc(p.button.label)}</a></td>`
      + `</tr></table>`);
  }
  if (p.outro) body.push(paras(p.outro));
  rows.push(`<tr><td style="padding:22px 32px 10px;${F};font-size:15px;color:${COLORS.ink}">${body.join('')}</td></tr>`);

  if (p.offer) {
    rows.push(`<tr><td style="background:${COLORS.indigo};padding:0">`
      + (p.offer.imageUrl ? `<img src="${esc(p.offer.imageUrl)}" alt="" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0">` : '')
      + `<div style="padding:18px 32px;${F};color:#fff">`
      + `<div style="font:700 11px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;color:#9fd3f5;margin-bottom:4px">Current offer</div>`
      + `<div style="font:700 18px Arial,sans-serif;margin-bottom:4px">${esc(p.offer.title)}</div>`
      + (p.offer.body ? `<div style="font:14px/1.5 Arial,sans-serif;color:#e4e7f7">${esc(p.offer.body).replace(/\n/g, '<br>')}</div>` : '')
      + (p.offer.endsOn ? `<div style="font:12px Arial,sans-serif;color:#b9bfe8;margin-top:6px">Until ${esc(fmtDay(p.offer.endsOn))}</div>` : '')
      + `</div></td></tr>`);
  }

  const contact = p.contact ?? 'orders@alkavidaja.com';
  rows.push(`<tr><td style="padding:18px 32px 24px;${F};font-size:13px;line-height:1.55;color:${COLORS.muted};border-top:4px solid ${COLORS.blue}">`
    + `Contact <a href="mailto:${esc(contact)}" style="color:${COLORS.blue};font-weight:700">${esc(contact)}</a> for any orders or queries.<br>`
    + `Alka Vida &middot; 1506 Investments Limited &middot; Kingston, Jamaica`
    + (p.unsubscribe ? `<br><a href="${esc(p.unsubscribe.url)}" style="color:${COLORS.muted}">Unsubscribe</a> from ${esc(p.unsubscribe.what)}.` : '')
    + `</td></tr>`);

  const html = `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.heading)}</title></head>`
    + `<body style="margin:0;padding:0;background:${COLORS.page}">`
    + (p.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(p.preheader)}</div>` : '')
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page}"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid ${COLORS.line}">`
    + `<tr><td style="padding:22px 32px 18px">${logoBlock()}</td></tr>`
    + `<tr><td style="height:6px;line-height:6px;font-size:0;background:${COLORS.blue}">&nbsp;</td></tr>`
    + rows.join('')
    + `</table></td></tr></table></body></html>`;

  // The plain-text twin: same words, same figures.
  const t: string[] = [];
  t.push(p.heading.toUpperCase());
  if (p.subheading) t.push(p.subheading);
  t.push('');
  if (p.greeting) t.push(p.greeting, '');
  if (p.intro) t.push(p.intro, '');
  if (p.items?.length) {
    for (const i of p.items) t.push(`  ${i.qty}  ${i.name}${i.amount ? `  ${i.amount}` : ''}`);
    t.push('');
  }
  if (p.totals?.length) {
    for (const [l, v] of p.totals) t.push(`${l}: ${v}`);
    t.push('');
  }
  if (p.facts?.length) {
    for (const [l, v] of p.facts) t.push(`${l}: ${v.replace(/\n/g, ', ')}`);
    t.push('');
  }
  for (const c of p.cards ?? []) if (c.title) t.push(`${c.tag ? `[${c.tag}] ` : ''}${c.title}`, ...(c.body ? [c.body] : []), '');
  if (p.button) t.push(`${p.button.label}: ${p.button.url}`, '');
  if (p.outro) t.push(p.outro, '');
  if (p.offer) t.push(`CURRENT OFFER: ${p.offer.title}`, ...(p.offer.body ? [p.offer.body] : []), '');
  t.push(`Contact ${contact} for any orders or queries.`);
  t.push('Alka Vida · 1506 Investments Limited');
  if (p.unsubscribe) t.push('', `Unsubscribe from ${p.unsubscribe.what}: ${p.unsubscribe.url}`);
  return { html, text: t.join('\n') };
}

/**
 * The full treatment for one customer: the offer band, the contact line, and
 * for a non-essential category the unsubscribe link (and the List-Unsubscribe
 * header, so a mail program can offer its own one-click button).
 */
export async function customerEmail(
  t: Queryable,
  customerId: string | null,
  category: EmailCategory | null,
  parts: EmailParts,
): Promise<{ html: string; text: string; headers?: Record<string, string> }> {
  const contact = await contactEmail(t);
  const offer = parts.offer === undefined ? await currentOffer(t) : parts.offer;
  let unsubscribe: EmailParts['unsubscribe'] = null;
  let headers: Record<string, string> | undefined;
  if (customerId && category) {
    const c = await t.maybeOne<{ email_token: string }>(
      `SELECT email_token::text AS email_token FROM customers WHERE id = $1`, [customerId],
    );
    if (c) {
      const url = unsubscribeUrl(c.email_token, category);
      unsubscribe = { url, what: CATEGORY_LABEL[category] };
      headers = { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
    }
  }
  return { ...renderEmail({ ...parts, offer, contact, unsubscribe }), headers };
}

/** A small page for the unsubscribe link (no sign-in, no app). */
export function unsubscribePage(opts: {
  title: string; message: string; form?: { token: string; category: string; label: string } | null;
  undo?: { token: string; category: string } | null;
}): string {
  const form = opts.form
    ? `<form method="post" action="/unsubscribe"><input type="hidden" name="t" value="${esc(opts.form.token)}">`
      + `<input type="hidden" name="c" value="${esc(opts.form.category)}">`
      + `<button type="submit" style="background:${COLORS.blue};color:#fff;border:0;border-radius:8px;padding:13px 22px;font:700 16px Arial,sans-serif;cursor:pointer">${esc(opts.form.label)}</button></form>`
      + `<form method="post" action="/unsubscribe" style="margin-top:14px"><input type="hidden" name="t" value="${esc(opts.form.token)}">`
      + `<input type="hidden" name="c" value="all"><button type="submit" style="background:none;border:0;color:${COLORS.muted};text-decoration:underline;font:14px Arial,sans-serif;cursor:pointer;padding:0">Stop every email that is not an invoice, receipt or statement we send you</button></form>`
    : '';
  const undo = opts.undo
    ? `<form method="post" action="/unsubscribe" style="margin-top:16px"><input type="hidden" name="t" value="${esc(opts.undo.token)}">`
      + `<input type="hidden" name="c" value="${esc(opts.undo.category)}"><input type="hidden" name="on" value="1">`
      + `<button type="submit" style="background:none;border:1px solid ${COLORS.line};border-radius:8px;padding:10px 16px;font:14px Arial,sans-serif;cursor:pointer">Changed your mind? Send them again</button></form>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(opts.title)} - Alka Vida</title></head>`
    + `<body style="margin:0;background:${COLORS.page};font-family:Arial,Helvetica,sans-serif;color:${COLORS.ink}">`
    + `<div style="max-width:520px;margin:40px auto;padding:0 16px"><div style="background:#fff;border:1px solid ${COLORS.line};border-radius:12px;overflow:hidden">`
    + `<div style="padding:22px 28px">${logoBlock()}</div><div style="height:6px;background:${COLORS.blue}"></div>`
    + `<div style="padding:24px 28px 28px"><h1 style="margin:0 0 10px;font-size:22px;color:${COLORS.indigo}">${esc(opts.title)}</h1>`
    + `<p style="line-height:1.55;margin:0 0 18px">${esc(opts.message)}</p>${form}${undo}`
    + `<p style="font-size:13px;color:${COLORS.muted};margin:22px 0 0">You can choose exactly which emails you get under My Profile when you sign in.</p>`
    + `</div></div></div></body></html>`;
}
