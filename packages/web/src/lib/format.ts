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

/** Colour token for an invoice status chip. */
export function statusTone(status: string): string {
  switch (status) {
    case 'Paid': return 'ok';
    case 'Partial': return 'warn';
    case 'Overdue': return 'bad';
    case 'Credit Note': return 'info';
    case 'Cancelled': return 'muted';
    default: return 'neutral';
  }
}
