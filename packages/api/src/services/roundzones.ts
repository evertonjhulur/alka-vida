/** Naming a round, and the zones its stops are in (several rounds a day, 27 Nov 2026). */

/** SQL: the zones of a round's stops, over `d` (delivery_sheets). */
export const STOP_ZONES_SQL = `(
  SELECT COALESCE(array_agg(DISTINCT z.zone ORDER BY z.zone), ARRAY[]::text[]) FROM (
    SELECT COALESCE(ca.delivery_zone, c.delivery_zone) AS zone
    FROM delivery_stops zs JOIN customers c ON c.id = zs.customer_id
    LEFT JOIN customer_orders zo ON zo.id = zs.order_id
    LEFT JOIN customer_addresses ca ON ca.id = zo.address_id
    WHERE zs.delivery_sheet_id = d.id AND zs.order_id IS NOT NULL
  ) z WHERE z.zone IS NOT NULL)`;

/** "Portmore 2", or the zone when it has no name. */
export const labelOf = (s: { name: string | null; zone: string }) => s.name?.trim() || s.zone;
