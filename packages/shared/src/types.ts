/**
 * Domain enumerations and shared shapes.
 *
 * Declared as const objects + union types rather than TS `enum`, because the
 * project runs on Node type-stripping which only supports erasable syntax.
 */

export const ROLES = ['admin', 'user', 'driver', 'customer'] as const;
export type Role = (typeof ROLES)[number];

export const ORDER_STATUSES = ['Pending', 'Partially Delivered', 'Delivered', 'Cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Counter is a walk-in sale: invoiced and paid on the spot. Pickup is a real
 * order the customer collects later, invoiced when they actually take it.
 */
export const DELIVERY_MODES = ['Delivery', 'Pickup', 'Counter'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const STOP_OUTCOMES = [
  'Pending', 'Delivered', 'Customer Not Home', 'Refused', 'Rescheduled', 'Other',
  // The driver took a payment and delivered nothing (7 Oct 2026, point 10).
  'Payment Only',
] as const;
export type StopOutcome = (typeof STOP_OUTCOMES)[number];

export const PAYMENT_METHODS = ['Cash', 'Card', 'Bank Transfer', 'Cheque', 'Other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['Provisional', 'Confirmed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Derived by the invoice_ledger view - never stored on the invoice row. */
export const INVOICE_STATUSES = [
  'Open', 'Sent', 'Paid', 'Partial', 'Overdue', 'Credit Note', 'Cancelled',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const APPROVAL_STATUSES = ['Pending', 'Approved', 'Rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * The categories a fresh install starts with - NOT the permitted set.
 *
 * Categories and their sizes are data the office manages (migration 010,
 * `material_categories`). Nothing in the business logic branches on category,
 * so a new one cannot affect costing, production or purchasing; the service
 * validates against that table, which is the only place a list the office
 * edits can be checked.
 */
export const MATERIAL_CATEGORIES = ['Bottle', 'Cap', 'Handle', 'Label', 'Water'] as const;
export type MaterialCategory = string;

export const RECURRENCE_PATTERNS = ['Weekly', 'Biweekly', 'Monthly'] as const;
export type RecurrencePattern = (typeof RECURRENCE_PATTERNS)[number];

export const INVOICE_CYCLES = ['PerDelivery', 'Weekly', 'Monthly'] as const;

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A permission error the API surfaces as 403. */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** A business-rule violation the API surfaces as 400. */
export class RuleViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleViolation';
  }
}

/**
 * Jamaica's fourteen parishes. A fixed list because it IS fixed - the last
 * change was in 1867 - and because a delivery address that groups by parish
 * is only useful if everybody spells them the same way.
 */
export const PARISHES = [
  'Kingston', 'St Andrew', 'St Thomas', 'Portland', 'St Mary', 'St Ann',
  'Trelawny', 'St James', 'Hanover', 'Westmoreland', 'St Elizabeth',
  'Manchester', 'Clarendon', 'St Catherine',
] as const;
export type Parish = (typeof PARISHES)[number];

/**
 * What the office may agree with a customer. Free text on the column, so an
 * older value keeps working, but these are what the screen offers.
 */
export const PAYMENT_TERMS = [
  'Cash on delivery', 'Net 15', 'Net 30', 'Net 60', 'Net 90',
] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

/** The parts of a delivery address, as the forms collect them. */
export interface AddressParts {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  parish?: string | null;
}

/**
 * The whole address on one line.
 *
 * Everything downstream - the delivery stop the driver reads, the invoice PDF
 * - takes a single string, and did so long before the parts existed. Composing
 * it in one place is what stops the parts and the whole from disagreeing.
 * Returns null when there is nothing to compose, so an address left blank
 * stays blank rather than becoming a string of commas.
 */
export function composeAddress(a: AddressParts): string | null {
  const line = [a.addressLine1, a.addressLine2, a.city, a.parish]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ');
  return line || null;
}
