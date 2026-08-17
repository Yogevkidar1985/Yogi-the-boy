/**
 * TravelpayoutsAdapter: cheapest observed fares from the Aviasales (Travelpayouts)
 * Flight Data API. Self-serve and free to register, which makes it the most
 * practical source to add alongside SerpAPI.
 *
 * IMPORTANT — this API serves CACHED cheapest-fare observations, not a live
 * availability search. Results carry the provider's own `expires_at` and are
 * marked as cached so the freshness layer never presents them as live prices.
 * Enabled when TRAVELPAYOUTS_TOKEN is set.
 */
import type { FlightSearchAdapter, ProviderCapabilities, ProviderCostTier } from './adapter.js';
import { ProviderError } from './adapter.js';
import type { FlightResult, SearchQuery } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';

/** One fare entry as returned under data[destination][transfers]. */
interface TpFare {
  price?: number;
  airline?: string;
  flight_number?: number | string;
  departure_at?: string;
  return_at?: string;
  expires_at?: string;
  transfers?: number;
}

export class TravelpayoutsAdapter implements FlightSearchAdapter {
  readonly name = 'travelpayouts';
  readonly priority = 18;
  readonly costTier: ProviderCostTier = 'FREE';
  readonly timeoutMs = 15000;
  readonly capabilities: ProviderCapabilities = {
    roundTrip: true,
    multiCity: false,
    flexibleDates: true,
    liveNetwork: true,
    priceVerification: false, // cached data cannot verify a live price
  };

  constructor(
    private token: string | undefined = process.env.TRAVELPAYOUTS_TOKEN,
    private marker: string | undefined = process.env.TRAVELPAYOUTS_MARKER
  ) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.token);
  }

  async search(query: SearchQuery): Promise<FlightResult[]> {
    if (!this.token) throw new ProviderError(this.name, 'TRAVELPAYOUTS_TOKEN not configured', false);

    const params = new URLSearchParams({
      origin: query.origin,
      destination: query.destination,
      depart_date: query.departureDate,
      // the API defaults to RUB, so the currency must always be explicit
      currency: query.currency.toLowerCase(),
    });
    if (query.returnDate) params.set('return_date', query.returnDate);

    const res = await fetch(`https://api.travelpayouts.com/v1/prices/cheap?${params}`, {
      headers: { 'X-Access-Token': this.token, 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(this.name, `auth failed: HTTP ${res.status}`, false);
    }
    if (res.status === 429) throw new ProviderError(this.name, 'rate limited (429)');
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}`);

    const body = (await res.json()) as { success?: boolean; data?: Record<string, Record<string, TpFare>> };
    if (body.success === false) throw new ProviderError(this.name, 'API reported failure');

    const links = bookingLinks(query);
    const now = new Date().toISOString();
    const results: FlightResult[] = [];

    // data is keyed by destination IATA, then by number of transfers ("0","1",…)
    for (const [destination, byTransfers] of Object.entries(body.data ?? {})) {
      for (const [transferKey, fare] of Object.entries(byTransfers ?? {})) {
        const price = Number(fare?.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        if (query.maxPrice && price > query.maxPrice) continue;
        const stops = Number.isFinite(Number(fare.transfers)) ? Number(fare.transfers) : Number(transferKey) || 0;
        if (query.stops === 'NON_STOP' && stops !== 0) continue;
        const airline = String(fare.airline ?? '').toUpperCase().slice(0, 3);
        if (query.airlines?.length && !query.airlines.includes(airline)) continue;
        if (query.excludeAirlines?.includes(airline)) continue;

        const departureTime = fare.departure_at ?? `${query.departureDate}T00:00:00`;
        const conv = currencyService.convert(price, query.currency);
        // the endpoint returns a fare summary, not a timed itinerary, so no
        // arrival time is invented — duration stays unknown (0)
        results.push({
          id: `tp-${query.origin}-${destination}-${query.departureDate}-${airline}-${stops}`,
          provider: this.name,
          source: 'travelpayouts-cached',
          origin: query.origin,
          destination: destination.toUpperCase(),
          departureDate: query.departureDate,
          returnDate: query.returnDate,
          departureTime,
          arrivalTime: departureTime,
          durationMinutes: 0,
          stops,
          airline,
          airlineName: airline,
          flightNumber: fare.flight_number ? `${airline}${fare.flight_number}` : '',
          cabin: query.cabin,
          bags: query.bags ?? 0,
          basePrice: price,
          taxes: 0,
          totalPrice: price,
          currency: query.currency,
          normalizedPrice: conv.value,
          normalizedCurrency: currencyService.systemCurrency,
          exchangeRate: conv.rate,
          exchangeRateTimestamp: conv.timestamp,
          bookingUrl: links.googleFlights,
          deepLink: links.kiwi,
          segments: [],
          collectedAt: now,
          rawProviderData: {
            cached: true,
            expiresAt: fare.expires_at ?? null,
            marker: this.marker ?? null,
          },
        });
      }
    }
    return results;
  }
}
