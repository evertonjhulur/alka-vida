/**  Copy of packages/shared/src/charges.ts (the web build does not import @alka/shared).
 *
 * Charges and services (25 Nov 2026): a product that is a charge rather than
 * water - BML's coolant packaging, a delivery fee - is counted in its own
 * unit (case, delivery, each...), not in bottles.
 */

/** "case" -> "cases", "delivery" -> "deliveries", "box" -> "boxes". */
export function pluralUnit(unit: string): string {
  const u = unit.trim();
  if (/[^aeiou]y$/i.test(u)) return `${u.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(u)) return `${u}es`;
  return `${u}s`;
}

/** The unit a charge is priced per; blank or "each" means a plain count. */
export function chargeUnitOf(unit: string | null | undefined): string | null {
  const u = (unit ?? '').trim();
  return u && u.toLowerCase() !== 'each' ? u : null;
}

/** "12 cases", "1 delivery", or just "3" for a charge counted each. */
export function unitCount(n: number, unit: string | null | undefined): string {
  const u = chargeUnitOf(unit);
  if (!u) return String(n);
  return `${n} ${Math.abs(n) === 1 ? u : pluralUnit(u)}`;
}

/** "per case", "each". */
export function perUnit(unit: string | null | undefined): string {
  const u = chargeUnitOf(unit);
  return u ? `per ${u}` : 'each';
}

/** Anything with a product's shape, as the screens get it from the API. */
export interface Unitish {
  bottles_per_case?: number | string | null;
  is_charge?: boolean | null;
  charge_unit?: string | null;
}

/**
 * The word after a quantity: "cases"/"bottles", or a charge's own unit
 * ("cases", "deliveries"); blank for a charge counted each. `short` gives
 * "cs"/"btl" for water.
 */
export function unitWord(p: Unitish | null | undefined, n: number, short = false): string {
  if (p?.is_charge) {
    const u = chargeUnitOf(p.charge_unit);
    return u ? (Math.abs(n) === 1 ? u : pluralUnit(u)) : '';
  }
  const cased = Number(p?.bottles_per_case ?? 0) > 0;
  if (short) return cased ? 'cs' : 'btl';
  return cased ? (Math.abs(n) === 1 ? 'case' : 'cases') : (Math.abs(n) === 1 ? 'bottle' : 'bottles');
}
