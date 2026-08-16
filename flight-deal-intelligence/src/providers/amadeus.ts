/**
 * AmadeusAdapter: real GDS inventory via the Amadeus Self-Service API
 * (free tier at developers.amadeus.com). A fully independent source from
 * Google Flights — works from any datacenter. Enabled when
 * AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET are set.
 */
import type { FlightSearchAdapter, ProviderCapabilities } from './adapter.js';
import { ProviderError } from './adapter.js';
import type { FlightResult, FlightSegment, SearchQuery } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';

function iso8601DurationToMinutes(d: string | undefined): number {
  if (!d) return 0;
  const h = d.match(/(\d+)H/);
  const m = d.match(/(\d+)M/);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

interface AmadeusSegment {
  departure: { iataCode: string; at: string };
  arrival: { iataCode: string; at: string };
  carrierCode: string;
  number: string;
  duration?: string;
  aircraft?: { code?: string };
}

interface AmadeusOffer {
  price: { grandTotal: string; currency: string };
  itineraries: { duration?: string; segments: AmadeusSegment[] }[];
}

export class AmadeusAdapter implements FlightSearchAdapter {
  readonly name = 'amadeus';
  readonly priority = 12;
  readonly capabilities: ProviderCapabilities = {
    roundTrip: true,
    multiCity: false,
    flexibleDates: false,
    liveNetwork: true,
  };

  private token: { value: string; expiresAt: number } | null = null;
  private baseUrl =
    process.env.AMADEUS_ENV === 'production'
      ? 'https://api.amadeus.com'
      : 'https://test.api.amadeus.com';

  constructor(
    private clientId: string | undefined = process.env.AMADEUS_CLIENT_ID,
    private clientSecret: string | undefined = process.env.AMADEUS_CLIENT_SECRET
  ) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.clientId && this.clientSecret);
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(`${this.baseUrl}/v1/security/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new ProviderError(this.name, `auth failed: HTTP ${res.status}`, false);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }

  async search(query: SearchQuery): Promise<FlightResult[]> {
    if (!this.clientId || !this.clientSecret) {
      throw new ProviderError(this.name, 'Amadeus credentials not configured', false);
    }
    const token = await this.getToken();
    const params = new URLSearchParams({
      originLocationCode: query.origin,
      destinationLocationCode: query.destination,
      departureDate: query.departureDate,
      adults: String(query.passengers.adults),
      currencyCode: query.currency,
      max: '20',
    });
    if (query.returnDate) params.set('returnDate', query.returnDate);
    if (query.passengers.children) params.set('children', String(query.passengers.children));
    if (query.stops === 'NON_STOP') params.set('nonStop', 'true');

    const res = await fetch(`${this.baseUrl}/v2/shopping/flight-offers?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) throw new ProviderError(this.name, 'rate limited (429)');
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}`);
    const data = (await res.json()) as { data?: AmadeusOffer[] };

    const links = bookingLinks(query);
    const now = new Date().toISOString();
    const results: FlightResult[] = [];

    for (const [i, offer] of (data.data ?? []).entries()) {
      const outbound = offer.itineraries[0];
      if (!outbound?.segments.length) continue;
      const price = Number(offer.price.grandTotal);
      if (!price || (query.maxPrice && price > query.maxPrice)) continue;
      const segs = outbound.segments;
      const first = segs[0]!;
      const last = segs[segs.length - 1]!;
      const conv = currencyService.convert(price, offer.price.currency);
      const segments: FlightSegment[] = segs.map((s) => ({
        origin: s.departure.iataCode,
        destination: s.arrival.iataCode,
        departureTime: s.departure.at,
        arrivalTime: s.arrival.at,
        airline: s.carrierCode,
        flightNumber: `${s.carrierCode}${s.number}`,
        aircraft: s.aircraft?.code,
        durationMinutes: iso8601DurationToMinutes(s.duration),
      }));

      results.push({
        id: `am-${query.origin}-${query.destination}-${query.departureDate}-${i}`,
        provider: this.name,
        source: 'amadeus-gds',
        origin: query.origin,
        destination: query.destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate,
        departureTime: first.departure.at,
        arrivalTime: last.arrival.at,
        durationMinutes: iso8601DurationToMinutes(outbound.duration),
        stops: segs.length - 1,
        airline: first.carrierCode,
        airlineName: first.carrierCode,
        flightNumber: `${first.carrierCode}${first.number}`,
        aircraft: first.aircraft?.code,
        cabin: query.cabin,
        bags: query.bags ?? 0,
        basePrice: price,
        taxes: 0,
        totalPrice: price,
        currency: offer.price.currency,
        normalizedPrice: conv.value,
        normalizedCurrency: currencyService.systemCurrency,
        exchangeRate: conv.rate,
        exchangeRateTimestamp: conv.timestamp,
        bookingUrl: links.googleFlights,
        deepLink: links.skyscanner,
        segments,
        collectedAt: now,
        rawProviderData: { amadeus: true },
      });
    }
    return results;
  }
}
