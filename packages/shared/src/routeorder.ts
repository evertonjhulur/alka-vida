/**
 * Putting a round's stops in a sensible order with nothing but the map pins
 * (Everton, 23 Oct 2026).
 *
 * This is the "straight line" sort: it works anywhere, needs no internet and
 * no outside service, and is what the app falls back to when the road-map
 * sort (openrouteservice) is not set up or not reachable. It knows nothing
 * about roads, hills or one-way streets, so its distances are as the crow
 * flies - good enough to stop a truck zig-zagging across town, not a promise
 * of the shortest drive.
 *
 * Method: nearest neighbour from the plant, then 2-opt (undo any two legs
 * that cross) until nothing improves. Exact for a handful of stops and very
 * close to best for the 20-40 on a round, in well under a millisecond.
 * Lives in shared so the driver's phone can run the same sort offline later.
 */

export interface LatLng { lat: number; lng: number }

/** Kilometres between two points on the earth, as the crow flies. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length of plant -> each point in turn -> plant, in km. */
export function tourKm(depot: LatLng, points: readonly LatLng[]): number {
  if (points.length === 0) return 0;
  let km = haversineKm(depot, points[0]);
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  return km + haversineKm(points[points.length - 1], depot);
}

/**
 * The order to visit `points` in, starting and finishing at `depot`, as
 * indexes into `points`. Stable: equal choices keep the original order.
 */
export function orderStops(depot: LatLng, points: readonly LatLng[]): number[] {
  const n = points.length;
  if (n <= 1) return points.map((_, i) => i);

  // Node 0 is the plant; node i+1 is points[i].
  const nodes = [depot, ...points];
  const d = (i: number, j: number) => haversineKm(nodes[i], nodes[j]);

  // Nearest neighbour.
  const left = new Set<number>(points.map((_, i) => i + 1));
  const tour: number[] = [0];
  let at = 0;
  while (left.size) {
    let best = -1;
    let bestD = Infinity;
    for (const j of left) {
      const dj = d(at, j);
      if (dj < bestD - 1e-9) { best = j; bestD = dj; }
    }
    tour.push(best);
    left.delete(best);
    at = best;
  }
  tour.push(0);

  // 2-opt: reverse any stretch that shortens the closed tour.
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 1; i < tour.length - 2; i++) {
      for (let k = i + 1; k < tour.length - 1; k++) {
        const delta = d(tour[i - 1], tour[k]) + d(tour[i], tour[k + 1])
          - d(tour[i - 1], tour[i]) - d(tour[k], tour[k + 1]);
        if (delta < -1e-9) {
          const mid = tour.slice(i, k + 1).reverse();
          tour.splice(i, mid.length, ...mid);
          improved = true;
        }
      }
    }
  }
  return tour.slice(1, -1).map((node) => node - 1);
}

/** Inside Jamaica (with a margin): a pin outside is a typo or a phone in another country. */
export function inJamaica(p: LatLng): boolean {
  return p.lat >= 17.6 && p.lat <= 18.6 && p.lng >= -78.5 && p.lng <= -76.1;
}

/**
 * Coordinates from what a person pastes: "18.0123, -76.9456", or a Google
 * Maps link with @lat,lng / q=lat,lng / !3dlat!4dlng in it. Short
 * maps.app.goo.gl links have no coordinates in them; the server follows those.
 */
export function parseLatLng(text: string): LatLng | null {
  const s = decodeURIComponent(String(text ?? '')).trim();
  const tries = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|query|ll|destination|daddr)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/,
  ];
  for (const re of tries) {
    const m = s.match(re);
    if (m) {
      const p = { lat: Number(m[1]), lng: Number(m[2]) };
      if (Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180) return p;
    }
  }
  return null;
}
