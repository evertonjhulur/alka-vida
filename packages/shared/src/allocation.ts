/**
 * Route settlement: turning cash a driver collected into real Payments.
 *
 * This is the ONLY mechanism in the system that converts delivery activity
 * into Payment records (Section 3, Step 4).
 *
 * The prior build had TWO mechanisms running in parallel - allocation-based
 * creation, plus a generic "auto-split any overpayment" rule that ran
 * afterwards and independently re-detected the same excess. The two together
 * produced duplicate phantom credit. That generic rule is deliberately absent
 * here and must never be added: the planner below emits the complete, final
 * list of payments in one pass, and no later stage is permitted to inspect a
 * payment total and split it again.
 */

import type { Cents } from './money.ts';
import { assertCents } from './money.ts';

export interface AllocationInput {
  invoiceId: string;
  amountCents: Cents;
}

export interface PlannedPayment {
  /** null means unattached. Not a distinct category - just a blank field. */
  invoiceId: string | null;
  amountCents: Cents;
}

/**
 * The narrow allocation constraint (Section 2, DeliveryStop).
 *
 * The driver's suggested split may never exceed the cash they said they
 * collected. This validates ONLY the allocation inputs. It is deliberately a
 * separate exported function from anything to do with completing a stop,
 * because a prior build wired this check into stop completion and made a
 * payment mismatch block the delivery itself. Marking a stop delivered must
 * always succeed; only settlement consults this.
 */
export function validateAllocation(
  paymentAmountCents: Cents,
  allocations: readonly AllocationInput[],
): { ok: true } | { ok: false; error: string } {
  assertCents(paymentAmountCents, 'paymentAmount');
  for (const a of allocations) {
    if (!Number.isSafeInteger(a.amountCents) || a.amountCents < 0) {
      return { ok: false, error: 'each allocated amount must be a non-negative whole number of cents' };
    }
  }
  const total = allocations.reduce((s, a) => s + a.amountCents, 0);
  if (total > paymentAmountCents) {
    return {
      ok: false,
      error: `allocated ${total} cents exceeds the ${paymentAmountCents} cents collected`,
    };
  }
  const seen = new Set<string>();
  for (const a of allocations) {
    if (seen.has(a.invoiceId)) {
      return { ok: false, error: `invoice ${a.invoiceId} appears twice in the allocation` };
    }
    seen.add(a.invoiceId);
  }
  return { ok: true };
}

/**
 * Produce the complete set of Payments to create for one settled stop.
 *
 * Every entry - attached or unattached - is emitted by this single function
 * and then written by one uniform loop at the call site. There is no
 * "if there is a remainder" branch downstream; the remainder is simply the
 * last element of the same list.
 *
 * Allocations are capped cumulatively so the total created can never exceed
 * the cash actually collected, even if a caller passes an over-allocation.
 */
export function planPayments(
  paymentAmountCents: Cents,
  allocations: readonly AllocationInput[],
): PlannedPayment[] {
  assertCents(paymentAmountCents, 'paymentAmount');
  if (paymentAmountCents <= 0) return [];

  const planned: PlannedPayment[] = [];
  let remaining = paymentAmountCents;

  for (const a of allocations) {
    if (remaining <= 0) break;
    const amount = Math.min(Math.max(a.amountCents, 0), remaining);
    if (amount <= 0) continue;
    planned.push({ invoiceId: a.invoiceId, amountCents: amount });
    remaining -= amount;
  }

  // Whatever the driver did not allocate is simply the final entry of the
  // same list, with a blank invoice_id. This is not "overpayment handling";
  // it is the same uniform step, and nothing downstream re-splits it.
  if (remaining > 0) {
    planned.push({ invoiceId: null, amountCents: remaining });
  }

  return planned;
}
