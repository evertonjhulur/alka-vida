/**
 * The order statuses the office filters by (Everton, 15 Oct 2026):
 *
 *   Pending            new: taken, not prepared yet
 *   Ready              the round's truck load has been logged, or someone
 *                      marked it ready (a collection waiting to be picked up)
 *   Out for Delivery   on a round the driver has started
 *   Partially Delivered
 *   Delivered          delivered, collected or sold at the counter
 *   Cancelled
 *
 * "Waiting (not delivered yet)" is gone: it was Ready and Out for Delivery
 * together, which the multi-select status filter now gives by ticking both.
 */

export type OrderStage = 'pending' | 'ready' | 'out' | 'part' | 'delivered' | 'cancelled';

export const ORDER_STAGES: ReadonlyArray<readonly [OrderStage, string]> = [
  ['pending', 'Pending'],
  ['ready', 'Ready'],
  ['out', 'Out for Delivery'],
  ['part', 'Partially Delivered'],
  ['delivered', 'Delivered'],
  ['cancelled', 'Cancelled'],
];

/** What the office sees first: everything not finished. */
export const OPEN_STAGES: OrderStage[] = ['pending', 'ready', 'out', 'part'];

export function orderStage(o: {
  status: string; sheet_started?: boolean | null; sheet_status?: string | null;
  ready_at?: string | null; load_logged_at?: string | null;
}): OrderStage {
  if (o.status === 'Cancelled') return 'cancelled';
  if (o.status === 'Delivered') return 'delivered';
  if (o.status === 'Partially Delivered') return 'part';
  const started = !!o.sheet_started && (o.sheet_status === undefined || o.sheet_status === null || o.sheet_status === 'Open');
  if (started) return 'out';
  const onOpenRound = o.sheet_status === undefined || o.sheet_status === null || o.sheet_status === 'Open';
  return o.ready_at || (o.load_logged_at && onOpenRound) ? 'ready' : 'pending';
}

export const STAGE_WORDS: Record<OrderStage, string> = Object.fromEntries(ORDER_STAGES) as Record<OrderStage, string>;
