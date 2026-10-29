/**
 * The email as the office wrote it on the send screen (Everton, 28 Oct 2026).
 *
 * "Email..." on any document opens a screen in a new tab, the way QuickBooks
 * and Zoho do it: To, Cc and Bcc, the subject and message already written
 * (and changeable), the document attached, and room for other files. This
 * module is the small shared part every sender uses:
 *
 * - the addresses, checked and tidied;
 * - "Send me a copy", which adds the sender's own login address as Bcc;
 * - the files staff attach, checked against the 10 MB limit.
 *
 * It deliberately imports nothing from the senders, so documents.ts,
 * paperwork.ts and messaging.ts can all use it without a circle.
 */

import { RuleViolation } from '@alka/shared';
import type { Queryable } from '../db/index.ts';

/** What the send screen sends back. */
export interface Compose {
  to: string[] | string;
  cc?: string[] | string | null;
  bcc?: string[] | string | null;
  /** Adds the sender's own login address as Bcc. */
  sendMeCopy?: boolean;
  subject: string;
  message: string;
  /** Files the sender added, base64. */
  extra?: Array<{ filename: string; contentType?: string | null; data: string }>;
}

export interface MailFile { filename: string; content: Buffer; contentType?: string }

/** Everything a sender needs from a Compose, checked. */
export interface Outgoing {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  message: string;
  extra: MailFile[];
}

/** Total size of the files one email may carry, the document included. */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const MAX_EXTRA_FILES = 10;

/** Kinds of file a mail server (or a customer's) would refuse or that could do harm. */
const BLOCKED = /\.(exe|bat|cmd|com|scr|msi|vbs|vbe|js|jse|ws|wsf|ps1|jar|lnk|reg|cpl|hta|pif|dll)$/i;

export function looksLikeEmail(s: string): boolean {
  return /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(s);
}

/** "a@b.com; c@d.com, e@f.com" or a list -> clean, distinct addresses. */
export function splitAddresses(v: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(v) ? v.join(',') : String(v ?? '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const a = part.trim().replace(/^<|>$/g, '');
    if (!a) continue;
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function checkAll(list: string[], box: string): void {
  const bad = list.find((a) => !looksLikeEmail(a));
  if (bad) throw new RuleViolation(`"${bad}" in ${box} is not an email address`);
}

/** The signed-in person's own address, for "Send me a copy". */
export async function senderAddress(db: Queryable, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const u = await db.maybeOne<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  const e = u?.email?.trim() ?? '';
  return looksLikeEmail(e) ? e : null;
}

/**
 * Checks what came from the send screen and turns it into what goes out.
 * `documentBytes` is the size of the document itself, which counts toward
 * the 10 MB too.
 */
export async function outgoing(
  db: Queryable, userId: string | null | undefined, c: Compose, documentBytes = 0,
): Promise<Outgoing> {
  const to = splitAddresses(c.to);
  if (to.length === 0) throw new RuleViolation('put at least one address in To');
  checkAll(to, 'To');
  const taken = new Set(to.map((a) => a.toLowerCase()));
  const cc = splitAddresses(c.cc).filter((a) => !taken.has(a.toLowerCase()));
  checkAll(cc, 'Cc');
  cc.forEach((a) => taken.add(a.toLowerCase()));
  const bcc = splitAddresses(c.bcc).filter((a) => !taken.has(a.toLowerCase()));
  checkAll(bcc, 'Bcc');
  if (c.sendMeCopy) {
    const me = await senderAddress(db, userId);
    if (!me) throw new RuleViolation('your login has no email address, so a copy cannot be sent to you. Untick "Send me a copy" or add the address under My account.');
    if (!taken.has(me.toLowerCase()) && !bcc.some((a) => a.toLowerCase() === me.toLowerCase())) bcc.push(me);
  }
  if (to.length + cc.length + bcc.length > 20) throw new RuleViolation('an email can go to at most 20 addresses in all');

  const subject = String(c.subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!subject) throw new RuleViolation('the email needs a subject');
  if (subject.length > 250) throw new RuleViolation('the subject is too long (250 characters at most)');
  const message = String(c.message ?? '').replace(/\r\n/g, '\n').trim();
  if (!message) throw new RuleViolation('the email needs a message');
  if (message.length > 10000) throw new RuleViolation('the message is too long (10,000 characters at most)');

  const extra: MailFile[] = [];
  const files = Array.isArray(c.extra) ? c.extra : [];
  if (files.length > MAX_EXTRA_FILES) throw new RuleViolation(`attach at most ${MAX_EXTRA_FILES} other files`);
  let total = documentBytes;
  for (const f of files) {
    const name = String(f?.filename ?? '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 150);
    if (!name) throw new RuleViolation('an attached file has no name');
    if (BLOCKED.test(name)) throw new RuleViolation(`${name} is a kind of file email does not allow (programs and scripts)`);
    const data = String(f?.data ?? '');
    if (!/^[A-Za-z0-9+/=\s]*$/.test(data)) throw new RuleViolation(`${name} could not be read; attach it again`);
    const content = Buffer.from(data, 'base64');
    if (content.length === 0) throw new RuleViolation(`${name} is empty`);
    total += content.length;
    extra.push({ filename: name, content, ...(f.contentType ? { contentType: String(f.contentType).slice(0, 100) } : {}) });
  }
  if (total > MAX_ATTACH_BYTES) {
    throw new RuleViolation(`the attachments come to ${(total / 1048576).toFixed(1)} MB; the limit is 10 MB per email`);
  }
  return { to, cc, bcc, subject, message, extra };
}

/** The copy addresses saved on a customer's account (checked as they were saved). */
export async function savedCopies(db: Queryable, customerId: string | null | undefined): Promise<string[]> {
  if (!customerId) return [];
  const c = await db.maybeOne<{ cc_emails: string | null }>(`SELECT cc_emails FROM customers WHERE id = $1`, [customerId]);
  return splitAddresses(c?.cc_emails).filter(looksLikeEmail);
}

/** What the audit log keeps about who an email went to. */
export function auditAddresses(o: { to: string[]; cc: string[]; bcc: string[]; extra?: MailFile[]; subject?: string }): Record<string, unknown> {
  return {
    emailedTo: o.to.join(', '),
    ...(o.cc.length ? { cc: o.cc.join(', ') } : {}),
    ...(o.bcc.length ? { bcc: o.bcc.join(', ') } : {}),
    ...(o.extra?.length ? { otherFiles: o.extra.map((f) => f.filename) } : {}),
    ...(o.subject ? { subject: o.subject } : {}),
  };
}
