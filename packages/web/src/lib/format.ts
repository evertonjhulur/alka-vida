/**
 * Display helpers.
 *
 * The UI receives integer cents from the API and formats at the edge. It
 * never does arithmetic on a formatted string, and never converts money to a
 * float for display maths.
 */

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toLocaleString('en-JM');
  const part = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}$${whole}.${part}`;
}

/** Parse a typed amount into integer cents. */
export function toCents(input: string): number {
  const n = Number(input.replace(/[,$\s]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** The business runs on Jamaica time. Never the browser's, never UTC. */
export const BUSINESS_TIMEZONE = 'America/Jamaica';

/**
 * Today, in Jamaica. For anything that fills in or compares against a date.
 *
 * en-CA formats as YYYY-MM-DD, which is what `<input type="date">` wants and
 * what the server means by a business date.
 */
export function todayInJamaica(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TIMEZONE });
}

/**
 * A date, as the business would say it.
 *
 * Two different things arrive here and they must be treated differently:
 *
 *   * A DATE column - an invoice date, a delivery date - comes over as
 *     `2026-09-04T00:00:00.000Z`. There is no instant in that, only a day, so
 *     it is taken as written. Converting it to a timezone would move it back
 *     a day, which is the bug migrations 004 and 008 were written to fix.
 *
 *   * A TIMESTAMP - created_at, reconciled_date - is a real instant. Slicing
 *     its UTC form showed the wrong day for anything after 7pm Jamaica: an
 *     order placed at 19:27 on the 4th read as the 5th. It is converted to
 *     Jamaica time instead.
 *
 * The two are told apart by the time being exactly UTC midnight. A real
 * instant landing exactly there is indistinguishable from a plain date and
 * will read as the UTC day - that is one second in 86,400, and the
 * alternative, every date column wrong by a day, is far worse.
 */
export function date(value: string | null | undefined): string {
  if (!value) return '—';
  const s = String(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(s)) return s.slice(0, 10);

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString('en-CA', { timeZone: BUSINESS_TIMEZONE });
}

/**
 * The clock time of an instant, in Jamaica - "3:16 pm".
 *
 * Slicing the ISO string gave the UTC time: a round started at 10:16 pm in
 * Kingston read as "03:16".
 */
export function time(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-JM', {
    timeZone: BUSINESS_TIMEZONE, hour: 'numeric', minute: '2-digit',
  });
}

/** Colour token for an invoice status chip. */
export function statusTone(status: string): string {
  switch (status) {
    case 'Paid': return 'ok';
    case 'Partial': return 'warn';
    case 'Part delivered': return 'warn';
    case 'Out for delivery': return 'info';
    case 'Overdue': return 'bad';
    case 'Credit Note': return 'info';
    case 'Cancelled': return 'muted';
    default: return 'neutral';
  }
}

/** A business date as people say it: "Tue 29 Sep". Taken as written, no timezone shift. */
export function day(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = date(value);
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${wd} ${d.getUTCDate()} ${mo}`;
}

/** "today", "yesterday", "tomorrow", or the day itself, against the business day. */
export function relDay(value: string | null | undefined, today: string = todayInJamaica()): string {
  if (!value) return '—';
  const a = Date.parse(`${date(value)}T12:00:00Z`);
  const b = Date.parse(`${date(today)}T12:00:00Z`);
  const diff = Math.round((a - b) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === -1) return 'yesterday';
  if (diff === 1) return 'tomorrow';
  return day(value);
}

/**
 * A date for reading, not for sums: "Tue 29 Sep" this year, "29 Sep 2025"
 * for any other year. Every screen uses this for display; `date()` stays for
 * comparisons, date boxes and exports, which need 2026-09-29.
 */
export function when(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = date(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  if (iso.slice(0, 4) === todayInJamaica().slice(0, 4)) return day(iso);
  const d = new Date(`${iso}T12:00:00Z`);
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()} ${mo} ${d.getUTCFullYear()}`;
}
