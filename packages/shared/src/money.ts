/**
 * Money handling for Alka Vida.
 *
 * ALL monetary values in this system are integer JMD cents. Never floats.
 * A 15% GCT applied to a float subtotal produces off-by-a-cent drift that
 * accumulates across a customer ledger and eventually makes an invoice
 * impossible to close exactly. Integers make `sum(payments) === grand_total`
 * an exact comparison, which Section 3 Step 6 depends on.
 */

import { RuleViolation } from './types.ts';

export type Cents = number;

/** Jamaica General Consumption Tax. */
export const GCT_RATE = 0.15;

/** Jamaica Environmental Levy on purchases, as a fraction (0.375%). */
export const ENV_TAX_RATE = 0.00375;

/** Guard: every Cents value crossing a boundary must be a safe integer. */
export function assertCents(v: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(v)) {
    throw new Error(`${label} must be an integer number of cents, got ${v}`);
  }
  return v;
}

/** Round half-up to the nearest whole cent. Half-up matches how the office
 *  reads a printed invoice; banker's rounding would surprise them. */
export function roundCents(v: number): Cents {
  if (!Number.isFinite(v)) throw new Error(`cannot round non-finite value ${v}`);
  return Math.sign(v) * Math.round(Math.abs(v));
}

/** Parse a human-entered amount ("1,234.50") into cents. */
export function parseAmount(input: string | number): Cents {
  const n = typeof input === 'number' ? input : Number(String(input).replace(/[,\s$]/g, ''));
  if (!Number.isFinite(n)) throw new RuleViolation(`invalid amount: ${input}`);
  return roundCents(n * 100);
}

/** Format cents for display, e.g. 123450 -> "1,234.50". */
export function formatAmount(c: Cents): string {
  assertCents(c);
  const neg = c < 0;
  const abs = Math.abs(c);
  const s = `${Math.floor(abs / 100).toLocaleString('en-JM')}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/* ------------------------------------------------------------------ */
/* Document totals                                                     */
/* ------------------------------------------------------------------ */

export interface LineForTotals {
  /** Already-computed line total in cents. */
  lineTotal: Cents;
  /** How many units the line is (cases, or bottles for the 5-gallon) and the
   *  price of one before GCT. Optional: when every line says (or carries
   *  cases / looseBottles with their prices, which says the same), GCT is
   *  worked out per unit - see computeTotals. */
  units?: number;
  unitPrice?: Cents;
  cases?: number;
  looseBottles?: number;
  pricePerCaseCents?: Cents;
  pricePerBottleCents?: Cents;
}

/** The units a line is made of, if it says: [count, price of one]. */
function unitsOf(l: LineForTotals): [number, Cents] | null {
  if (l.lineTotal === 0) return [0, 0];
  if (l.units != null && l.unitPrice != null && l.units * l.unitPrice === l.lineTotal) return [l.units, l.unitPrice];
  const c = Number(l.cases ?? 0); const b = Number(l.looseBottles ?? 0);
  if (c > 0 && l.pricePerCaseCents != null && c * Number(l.pricePerCaseCents) === l.lineTotal) return [c, Number(l.pricePerCaseCents)];
  if (b > 0 && l.pricePerBottleCents != null && b * Number(l.pricePerBottleCents) === l.lineTotal) return [b, Number(l.pricePerBottleCents)];
  return null;
}

/** A unit's price with GCT, rounded to the cent: J$434.78 -> J$500.00. */
export function unitPriceWithGct(unitPrice: Cents): Cents {
  // In whole hundredths so a price ending in .5 of a cent rounds up, as
  // half-up should (10 * 1.15 is 11.499999... in floating point).
  return roundCents((unitPrice * Math.round((1 + GCT_RATE) * 100)) / 100);
}

export interface DocumentTotals {
  subtotal: Cents;
  discountAmount: Cents;
  gct: Cents;
  grandTotal: Cents;
}

/**
 * The single GCT calculation for the entire system (Section 3, Step 5).
 *
 * Used verbatim by order entry, invoice generation, invoice editing and
 * quotations. There is deliberately no second implementation anywhere:
 * the prior build drifted because order entry and invoicing each had their
 * own copy and one of them taxed the PRE-discount subtotal.
 *
 *   discountAmount = subtotal * (discountPercent / 100), or a fixed amount
 *   gct            = (subtotal - discountAmount) * GCT_RATE
 *   grandTotal     = (subtotal - discountAmount) + gct
 *
 * @param discountPercent 0-100 (a percentage, NOT a fraction).
 * @param applyGct        false for Quotations, which have no tax impact.
 */
export function computeTotals(
  lines: readonly LineForTotals[],
  discountPercent = 0,
  applyGct = true,
  discountFixedCents = 0,
): DocumentTotals {
  if (!(discountPercent >= 0 && discountPercent <= 100)) {
    throw new RuleViolation(`discountPercent must be 0-100, got ${discountPercent}`);
  }
  assertCents(discountFixedCents, 'discountFixedCents');
  if (discountFixedCents < 0) throw new RuleViolation('a discount cannot be negative');
  const subtotal = lines.reduce((acc, l) => acc + assertCents(l.lineTotal, 'lineTotal'), 0);
  // A discount is EITHER a percentage OR a fixed amount (Everton, 30 Sep 2026).
  // A fixed amount wins when both are given, and can never take the
  // document below zero.
  const discountAmount = discountFixedCents > 0
    ? Math.min(discountFixedCents, subtotal)
    : roundCents(subtotal * (discountPercent / 100));
  const net = subtotal - discountAmount;
  if (!applyGct) return { subtotal, discountAmount, gct: 0, grandTotal: net };
  // GCT per unit (Everton, 4 Nov 2026): a 5-gallon at J$434.78 is J$500.00
  // with GCT, so three must be J$1,500.00 - not J$1,499.99, which is what
  // 15% of the whole J$1,304.34 gives. When every line says what it is made
  // of, the total is each unit's price with GCT (rounded to the cent) times
  // the quantity; a discount takes the same share off that as it takes off
  // the subtotal; GCT is whatever makes up the difference. It can be a cent
  // or so off an exact 15% of the net - the price with GCT is what is kept
  // whole. Lines that do not say (a bare amount) keep the old sum.
  const units = lines.map(unitsOf);
  if (subtotal > 0 && units.every((u) => u !== null)) {
    const withGct = units.reduce((acc, u) => acc + u![0] * unitPriceWithGct(u![1]), 0);
    const grandTotal = discountAmount === 0 ? withGct : roundCents((withGct * net) / subtotal);
    return { subtotal, discountAmount, gct: grandTotal - net, grandTotal };
  }
  const gct = roundCents(net * GCT_RATE);
  return { subtotal, discountAmount, gct, grandTotal: net + gct };
}

/**
 * Line total for one order/invoice/quotation line.
 *
 * Enforces the case-vs-bottle rule (Section 2, OrderLineItem) at the point
 * where money is computed, so no caller can route around it:
 *   bottlesPerCase > 0  -> whole cases only, loose bottles forbidden
 *   bottlesPerCase == 0 -> the 5-gallon product, bottles only, cases forbidden
 */
export function computeLineTotal(args: {
  bottlesPerCase: number;
  cases: number;
  looseBottles: number;
  pricePerCase: Cents;
  pricePerBottle: Cents;
}): Cents {
  const { bottlesPerCase, cases, looseBottles, pricePerCase, pricePerBottle } = args;
  assertQuantityShape(bottlesPerCase, cases, looseBottles);
  assertCents(pricePerCase, 'pricePerCase');
  assertCents(pricePerBottle, 'pricePerBottle');
  return bottlesPerCase > 0 ? cases * pricePerCase : looseBottles * pricePerBottle;
}

/**
 * The case-vs-bottle input rule. The business does not sell loose bottles of
 * any cased product, and never sells the 5-gallon bottle by the case.
 * Shared by OrderLineItem, InvoiceLineItem and QuotationLineItem alike.
 */
export function assertQuantityShape(bottlesPerCase: number, cases: number, looseBottles: number): void {
  if (!Number.isInteger(cases) || cases < 0) throw new RuleViolation(`cases must be a non-negative integer, got ${cases}`);
  if (!Number.isInteger(looseBottles) || looseBottles < 0) {
    throw new RuleViolation(`looseBottles must be a non-negative integer, got ${looseBottles}`);
  }
  if (bottlesPerCase > 0 && looseBottles !== 0) {
    throw new RuleViolation('this is a cased product: loose bottles cannot be sold, enter whole cases only');
  }
  if (bottlesPerCase === 0 && cases !== 0) {
    throw new RuleViolation('the 5-gallon bottle is sold individually and never by the case');
  }
}

/** Total bottles represented by a line, for stock movement. */
export function totalBottles(bottlesPerCase: number, cases: number, looseBottles: number): number {
  assertQuantityShape(bottlesPerCase, cases, looseBottles);
  return bottlesPerCase > 0 ? cases * bottlesPerCase : looseBottles;
}
