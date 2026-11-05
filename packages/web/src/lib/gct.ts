/**
 * GCT on a screen's running total, worked out exactly as the server does
 * (packages/shared money.ts computeTotals), so the estimate a person sees is
 * the total the invoice will carry.
 *
 * GCT per unit (Everton, 4 Nov 2026): each unit's price with GCT is rounded
 * to the cent (J$434.78 -> J$500.00) and multiplied by the quantity, so three
 * 5-gallons are J$1,500.00, not J$1,499.99. A discount takes the same share
 * off that as it takes off the subtotal. GCT is what makes up the difference.
 */
export const GCT_RATE = 0.15;

export function unitWithGct(cents: number): number {
  return Math.round((cents * Math.round((1 + GCT_RATE) * 100)) / 100);
}

/** `items` are [quantity, price of one before GCT] pairs. */
export function gctTotal(items: ReadonlyArray<readonly [number, number]>, discountCents: number, chargeGct: boolean) {
  const subtotal = items.reduce((a, [q, p]) => a + q * p, 0);
  const net = subtotal - discountCents;
  if (!chargeGct) return { subtotal, gct: 0, grandTotal: net };
  if (subtotal <= 0) return { subtotal, gct: 0, grandTotal: net };
  const withGct = items.reduce((a, [q, p]) => a + q * unitWithGct(p), 0);
  const grandTotal = discountCents === 0 ? withGct : Math.round((withGct * net) / subtotal);
  return { subtotal, gct: grandTotal - net, grandTotal };
}
