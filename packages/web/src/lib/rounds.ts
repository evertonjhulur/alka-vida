/** Naming a round (several rounds a day, 27 Nov 2026). */

/** "Portmore 2", or the zone when the round has no name. */
export function roundTitle(s: { name?: string | null; zone: string }): string {
  return s.name?.trim() || s.zone;
}

/** The zones of its stops other than its own: a round can carry several once stops are moved onto it. */
export function otherZones(s: { zone: string; stop_zones?: string[] | null }): string[] {
  return (s.stop_zones ?? []).filter((z) => z !== s.zone);
}
