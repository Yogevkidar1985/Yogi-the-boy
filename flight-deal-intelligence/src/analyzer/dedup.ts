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

/**
 * Keep the cheapest offer for each fingerprint, but remember EVERY provider
 * observation of the itinerary in `sources` — that cross-provider agreement is
 * the raw material for market consensus and price confidence.
 */
export function dedupe(flights: FlightResult[]): FlightResult[] {
  const byKey = new Map<string, FlightResult>();
  for (const f of flights) {
    const key = fingerprint(f);
    const source = {
      provider: f.provider,
      price: f.normalizedPrice,
      currency: f.normalizedCurrency,
      collectedAt: f.collectedAt,
      bookingUrl: f.bookingUrl,
    };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...f, sources: [source] });
    } else {
      const sources = [...(existing.sources ?? []), source];
      // best booking source = cheapest observation
      byKey.set(key, f.normalizedPrice < existing.normalizedPrice ? { ...f, sources } : { ...existing, sources });
    }
  }
  return [...byKey.values()];
}
