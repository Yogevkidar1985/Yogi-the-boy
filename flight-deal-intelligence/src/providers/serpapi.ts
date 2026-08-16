/**
 * SerpApiAdapter (§59 optional source): Google Flights results via SerpAPI.
 * Works reliably from datacenter IPs (SerpAPI does the fetching), making it a
 * strong companion source for cloud deployments. Free tier available.
 * Enabled when SERPAPI_API_KEY is set.
 */
import type { FlightSearchAdapter, ProviderCapabilities } from './adapter.js';
import { ProviderError } from './adapter.js';
import type { FlightResult, FlightSegment, SearchQuery } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';

interface SerpLeg {
  departure_airport?: { id?: string; time?: string };
  arrival_airport?: { id?: string; time?: string };
  duration?: number;
  airline?: string;
  flight_number?: string;
  airplane?: string;
}

interface SerpItinerary {
  flights?: SerpLeg[];
  total_duration?: number;
  price?: number;
}

export class SerpApiAdapter implements FlightSearchAdapter {
  readonly name = 'serpapi';
  readonly priority = 15;
  readonly capabilities: ProviderCapabilities = {
    roundTrip: true,
    multiCity: false,
    flexibleDates: false,
    liveNetwork: true,
  };

  constructor(private apiKey: string | undefined = process.env.SERPAPI_API_KEY) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async search(query: SearchQuery): Promise<FlightResult[]> {
    if (!this.apiKey) throw new ProviderError(this.name, 'SERPAPI_API_KEY not configured', false);
    const params = new URLSearchParams({
      engine: 'google_flights',
      departure_id: query.origin,
      arrival_id: query.destination,
      outbound_date: query.departureDate,
      currency: query.currency,
      adults: String(query.passengers.adults),
      children: String(query.passengers.children),
      type: query.returnDate ? '1' : '2',
      api_key: this.apiKey,
    });
    if (query.returnDate) params.set('return_date', query.returnDate);
    if (query.stops === 'NON_STOP') params.set('stops', '1');

    const res = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new ProviderError(this.name, `HTTP ${res.status}`, res.status !== 429);
    }
    const data = (await res.json()) as {
      best_flights?: SerpItinerary[];
      other_flights?: SerpItinerary[];
      error?: string;
    };
    if (data.error) throw new ProviderError(this.name, data.error, false);

    const itineraries = [...(data.best_flights ?? []), ...(data.other_flights ?? [])];
    const links = bookingLinks(query);
    const now = new Date().toISOString();
    const results: FlightResult[] = [];

    for (const [i, it] of itineraries.entries()) {
      if (!it.price || !it.flights?.length) continue;
      const legs = it.flights;
      const first = legs[0]!;
      const last = legs[legs.length - 1]!;
      const airlineName = first.airline ?? 'Unknown';
      const flightNumber = first.flight_number?.replace(/\s+/g, '') ?? '';
      const code = flightNumber.slice(0, 2) || airlineName.slice(0, 2).toUpperCase();
      const conv = currencyService.convert(it.price, query.currency);
      const segments: FlightSegment[] = legs.map((l) => ({
        origin: l.departure_airport?.id ?? query.origin,
        destination: l.arrival_airport?.id ?? query.destination,
        departureTime: (l.departure_airport?.time ?? '').replace(' ', 'T'),
        arrivalTime: (l.arrival_airport?.time ?? '').replace(' ', 'T'),
        airline: (l.flight_number ?? '').slice(0, 2) || code,
        airlineName: l.airline,
        flightNumber: l.flight_number?.replace(/\s+/g, '') ?? '',
        aircraft: l.airplane,
        durationMinutes: l.duration ?? 0,
      }));

      results.push({
        id: `sa-${query.origin}-${query.destination}-${query.departureDate}-${i}`,
        provider: this.name,
        source: 'google-flights-serpapi',
        origin: query.origin,
        destination: query.destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate,
        departureTime: (first.departure_airport?.time ?? '').replace(' ', 'T'),
        arrivalTime: (last.arrival_airport?.time ?? '').replace(' ', 'T'),
        durationMinutes: it.total_duration ?? 0,
        stops: legs.length - 1,
        airline: code,
        airlineName,
        flightNumber,
        aircraft: first.airplane,
        cabin: query.cabin,
        bags: query.bags ?? 0,
        basePrice: it.price,
        taxes: 0,
        totalPrice: it.price,
        currency: query.currency,
        normalizedPrice: conv.value,
        normalizedCurrency: currencyService.systemCurrency,
        exchangeRate: conv.rate,
        exchangeRateTimestamp: conv.timestamp,
        bookingUrl: links.googleFlights,
        deepLink: links.googleFlights,
        segments,
        collectedAt: now,
        rawProviderData: { serpapi: true },
      });
    }
    return results;
  }
}
