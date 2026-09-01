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

export const MATERIAL_CATEGORIES = ['Bottle', 'Cap', 'Handle', 'Label', 'Water'] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];

export const RECURRENCE_PATTERNS = ['Weekly', 'Biweekly', 'Monthly'] as const;
export type RecurrencePattern = (typeof RECURRENCE_PATTERNS)[number];

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
