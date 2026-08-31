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

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  return String(value).slice(0, 10);
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
