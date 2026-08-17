/**
 * DuffelFlightProvider: airline offers (NDC/GDS/LCC content) via the official
 * Duffel API (duffel.com). Enabled only when DUFFEL_API_TOKEN is set — the
 * provider stays DISABLED without credentials and the engine works without it.
 *
 * Uses only the documented offer-request flow; no assumptions beyond it.
 */
import type { FlightSearchAdapter, ProviderCapabilities, ProviderCostTier } from './adapter.js';
import { ProviderError } from './adapter.js';
import type { FlightResult, FlightSegment, SearchQuery } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';

function isoDurationToMinutes(d: string | undefined): number {
  if (!d) return 0;
  const days = d.match(/(\d+)D/);
  const h = d.match(/(\d+)H/);
  const m = d.match(/(\d+)M/);
  return (days ? Number(days[1]) * 1440 : 0) + (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

interface DuffelSegment {
  origin: { iata_code: string };
  destination: { iata_code: string };
  departing_at: string;
  arriving_at: string;
  marketing_carrier: { iata_code: string; name?: string };
  operating_carrier?: { iata_code?: string; name?: string };
  marketing_carrier_flight_number?: string;
  aircraft?: { name?: string } | null;
  duration?: string;
}

interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  slices: { duration?: string; segments: DuffelSegment[] }[];
  expires_at?: string;
}

const CABIN_MAP: Record<string, string> = {
  ECONOMY: 'economy',
  PREMIUM_ECONOMY: 'premium_economy',
  BUSINESS: 'business',
  FIRST: 'first',
};

export class DuffelAdapter implements FlightSearchAdapter {
  readonly name = 'duffel';
  readonly priority = 14;
  readonly costTier: ProviderCostTier = 'PAID';
  readonly timeoutMs = 25000;
  readonly capabilities: ProviderCapabilities = {
    roundTrip: true,
    multiCity: false,
    flexibleDates: false,
    liveNetwork: true,
    priceVerification: true,
  };

  constructor(private token: string | undefined = process.env.DUFFEL_API_TOKEN) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.token);
  }

  async search(query: SearchQuery): Promise<FlightResult[]> {
    if (!this.token) throw new ProviderError(this.name, 'DUFFEL_API_TOKEN not configured', false);

    const slices: { origin: string; destination: string; departure_date: string }[] = [
      { origin: query.origin, destination: query.destination, departure_date: query.departureDate },
    ];
    if (query.returnDate) {
      slices.push({ origin: query.destination, destination: query.origin, departure_date: query.returnDate });
    }
    const passengers = [
      ...Array.from({ length: query.passengers.adults }, () => ({ type: 'adult' })),
      ...Array.from({ length: query.passengers.children }, () => ({ age: 10 })),
    ];

    const res = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Duffel-Version': 'v2',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
      },
      body: JSON.stringify({
        data: {
          slices,
          passengers,
          cabin_class: CABIN_MAP[query.cabin] ?? 'economy',
          max_connections: query.stops === 'NON_STOP' ? 0 : undefined,
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(this.name, `auth failed: HTTP ${res.status}`, false);
    }
    if (res.status === 429) throw new ProviderError(this.name, 'rate limited (429)');
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { offers?: DuffelOffer[] } };
    const offers = body.data?.offers ?? [];

    const links = bookingLinks(query);
    const now = new Date().toISOString();
    const results: FlightResult[] = [];

    for (const offer of offers.slice(0, 20)) {
      const outbound = offer.slices[0];
      if (!outbound?.segments.length) continue;
      const price = Number(offer.total_amount);
      if (!price || (query.maxPrice && price > query.maxPrice)) continue;
      const segs = outbound.segments;
      const first = segs[0]!;
      const last = segs[segs.length - 1]!;
      const conv = currencyService.convert(price, offer.total_currency);
      const segments: FlightSegment[] = segs.map((s) => ({
        origin: s.origin.iata_code,
        destination: s.destination.iata_code,
        departureTime: s.departing_at,
        arrivalTime: s.arriving_at,
        airline: s.operating_carrier?.iata_code ?? s.marketing_carrier.iata_code,
        airlineName: s.operating_carrier?.name ?? s.marketing_carrier.name,
        flightNumber: `${s.marketing_carrier.iata_code}${s.marketing_carrier_flight_number ?? ''}`,
        aircraft: s.aircraft?.name,
        durationMinutes: isoDurationToMinutes(s.duration),
      }));

      results.push({
        id: `df-${offer.id}`,
        provider: this.name,
        source: 'duffel-api',
        origin: query.origin,
        destination: query.destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate,
        departureTime: first.departing_at,
        arrivalTime: last.arriving_at,
        durationMinutes: isoDurationToMinutes(outbound.duration),
        stops: segs.length - 1,
        airline: first.marketing_carrier.iata_code,
        airlineName: first.marketing_carrier.name ?? first.marketing_carrier.iata_code,
        flightNumber: `${first.marketing_carrier.iata_code}${first.marketing_carrier_flight_number ?? ''}`,
        aircraft: first.aircraft?.name,
        cabin: query.cabin,
        bags: query.bags ?? 0,
        basePrice: price,
        taxes: 0,
        totalPrice: price,
        currency: offer.total_currency,
        normalizedPrice: conv.value,
        normalizedCurrency: currencyService.systemCurrency,
        exchangeRate: conv.rate,
        exchangeRateTimestamp: conv.timestamp,
        bookingUrl: links.googleFlights,
        deepLink: links.skyscanner,
        segments,
        collectedAt: now,
        rawProviderData: { duffelOfferId: offer.id, expiresAt: offer.expires_at },
      });
    }
    return results;
  }
}
