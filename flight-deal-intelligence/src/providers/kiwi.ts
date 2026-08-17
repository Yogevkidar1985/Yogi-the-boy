/**
 * KiwiFlightProvider: unconventional combinations and virtual interlining via
 * the official Kiwi.com Tequila API. Enabled only when KIWI_API_KEY is set.
 *
 * IMPORTANT (V4 §31): itineraries built from separate tickets are flagged
 * selfTransfer=true and must never be presented as protected connections —
 * the UI shows an explicit risk badge for them.
 */
import type { FlightSearchAdapter, ProviderCapabilities, ProviderCostTier } from './adapter.js';
import { ProviderError } from './adapter.js';
import type { FlightResult, FlightSegment, SearchQuery } from '../core/types.js';
import { currencyService } from '../core/currency.js';

interface KiwiRouteSeg {
  flyFrom: string;
  flyTo: string;
  local_departure: string;
  local_arrival: string;
  airline: string;
  flight_no: number;
  operating_carrier?: string;
  bags_recheck_required?: boolean;
  virtual_interlining?: boolean;
}

interface KiwiItinerary {
  id: string;
  price: number;
  flyFrom: string;
  flyTo: string;
  local_departure: string;
  local_arrival: string;
  duration: { total: number };
  airlines: string[];
  route: KiwiRouteSeg[];
  deep_link: string;
  virtual_interlining?: boolean;
  has_airport_change?: boolean;
}

function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export class KiwiAdapter implements FlightSearchAdapter {
  readonly name = 'kiwi';
  readonly priority = 16;
  readonly costTier: ProviderCostTier = 'LOW_COST';
  readonly timeoutMs = 20000;
  readonly capabilities: ProviderCapabilities = {
    roundTrip: true,
    multiCity: false,
    flexibleDates: true,
    liveNetwork: true,
    selfTransfer: true,
  };

  constructor(private apiKey: string | undefined = process.env.KIWI_API_KEY) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async search(query: SearchQuery): Promise<FlightResult[]> {
    if (!this.apiKey) throw new ProviderError(this.name, 'KIWI_API_KEY not configured', false);

    const params = new URLSearchParams({
      fly_from: query.origin,
      fly_to: query.destination,
      date_from: ddmmyyyy(query.departureDate),
      date_to: ddmmyyyy(query.departureDate),
      adults: String(query.passengers.adults),
      curr: query.currency,
      limit: '20',
      sort: 'price',
    });
    if (query.passengers.children) params.set('children', String(query.passengers.children));
    if (query.returnDate) {
      params.set('return_from', ddmmyyyy(query.returnDate));
      params.set('return_to', ddmmyyyy(query.returnDate));
    }
    if (query.stops === 'NON_STOP') params.set('max_stopovers', '0');
    if (query.maxPrice) params.set('price_to', String(Math.round(query.maxPrice)));

    const res = await fetch(`https://api.tequila.kiwi.com/v2/search?${params}`, {
      headers: { apikey: this.apiKey, 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(this.name, `auth failed: HTTP ${res.status}`, false);
    }
    if (res.status === 429) throw new ProviderError(this.name, 'rate limited (429)');
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}`);
    const body = (await res.json()) as { data?: KiwiItinerary[] };

    const now = new Date().toISOString();
    const results: FlightResult[] = [];

    for (const it of body.data ?? []) {
      // outbound legs only (return legs have return=1 in the raw API; the
      // outbound is every segment until we land at the destination)
      const outIdx = it.route.findIndex((r) => r.flyTo === it.flyTo);
      const outbound = outIdx >= 0 ? it.route.slice(0, outIdx + 1) : it.route;
      if (!outbound.length) continue;
      const first = outbound[0]!;
      const last = outbound[outbound.length - 1]!;
      const selfTransfer = Boolean(
        it.virtual_interlining ||
        it.has_airport_change ||
        outbound.some((r) => r.virtual_interlining || r.bags_recheck_required)
      );
      const conv = currencyService.convert(it.price, query.currency);
      const segments: FlightSegment[] = outbound.map((r) => ({
        origin: r.flyFrom,
        destination: r.flyTo,
        departureTime: r.local_departure,
        arrivalTime: r.local_arrival,
        airline: r.operating_carrier || r.airline,
        flightNumber: `${r.airline}${r.flight_no}`,
        durationMinutes: Math.round(
          (Date.parse(r.local_arrival) - Date.parse(r.local_departure)) / 60000
        ),
      }));

      results.push({
        id: `kw-${it.id}`,
        provider: this.name,
        source: 'kiwi-tequila',
        origin: query.origin,
        destination: query.destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate,
        departureTime: first.local_departure,
        arrivalTime: last.local_arrival,
        durationMinutes: Math.round(it.duration.total / 60),
        stops: outbound.length - 1,
        airline: first.airline,
        airlineName: first.airline,
        flightNumber: `${first.airline}${first.flight_no}`,
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
        bookingUrl: it.deep_link,
        deepLink: it.deep_link,
        segments,
        collectedAt: now,
        selfTransfer,
        rawProviderData: { kiwiId: it.id, virtualInterlining: selfTransfer },
      });
    }
    return results;
  }
}
