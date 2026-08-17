/**
 * Deduplication (§37): the same flight can arrive from several providers.
 * Fingerprint on airline+flightNumber+departure+date; fuzzy fallback matches
 * near-identical times/durations when flight numbers are missing.
 */
import type { FlightResult } from '../core/types.js';

/**
 * An itinerary key identifies the JOURNEY (same aircraft, same times).
 * The fare product on top of it — cabin and baggage — is a different thing:
 * economy hand-luggage-only and business with two bags are NOT the same offer
 * and must never be merged, or the cheaper row would misrepresent what you get.
 */
export function itineraryKey(f: FlightResult): string {
  if (f.flightNumber) {
    return [f.airline, f.flightNumber, f.departureDate, f.departureTime.slice(0, 16)].join('|');
  }
  // fuzzy key: route + date + rounded departure hour + duration bucket + stops
  const hour = f.departureTime.match(/T(\d{2})/)?.[1] ?? 'xx';
  const durBucket = Math.round(f.durationMinutes / 30);
  return ['~', f.origin, f.destination, f.departureDate, hour, durBucket, f.stops].join('|');
}

/** Full offer fingerprint: itinerary + the fare product sold on it. */
export function fingerprint(f: FlightResult): string {
  return [itineraryKey(f), f.cabin ?? 'ECONOMY', `bags${f.bags ?? 0}`].join('|');
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
