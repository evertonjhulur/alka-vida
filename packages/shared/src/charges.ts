/**
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
