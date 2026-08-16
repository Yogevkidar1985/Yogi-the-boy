/**
 * Deduplication (§37): the same flight can arrive from several providers.
 * Fingerprint on airline+flightNumber+departure+date; fuzzy fallback matches
 * near-identical times/durations when flight numbers are missing.
 */
import type { FlightResult } from '../core/types.js';

export function fingerprint(f: FlightResult): string {
  if (f.flightNumber) {
    return [f.airline, f.flightNumber, f.departureDate, f.departureTime.slice(0, 16)].join('|');
  }
  // fuzzy key: route + date + rounded departure hour + duration bucket + stops
  const hour = f.departureTime.match(/T(\d{2})/)?.[1] ?? 'xx';
  const durBucket = Math.round(f.durationMinutes / 30);
  return ['~', f.origin, f.destination, f.departureDate, hour, durBucket, f.stops].join('|');
}

/** Keep the cheapest offer for each fingerprint. */
export function dedupe(flights: FlightResult[]): FlightResult[] {
  const byKey = new Map<string, FlightResult>();
  for (const f of flights) {
    const key = fingerprint(f);
    const existing = byKey.get(key);
    if (!existing || f.normalizedPrice < existing.normalizedPrice) {
      byKey.set(key, f);
    }
  }
  return [...byKey.values()];
}
