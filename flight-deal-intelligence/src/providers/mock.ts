/**
 * MockFlightProvider (§61): deterministic synthetic results so the whole system
 * runs and is testable without scraping. NEVER enabled in production searches
 * unless MOCK_PROVIDER=1 (§77: no fake API responses in production).
 *
 * Prices are deterministic per (route, date) with realistic spread, weekday
 * effects and airline variation, so historical analytics behave sensibly.
 */
import { createHash } from 'node:crypto';
import type { FlightSearchAdapter, ProviderCapabilities } from './adapter.js';
import type { FlightResult, SearchQuery, CabinClass } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';
import { airportName } from '../core/airports.js';

const AIRLINES = [
  { code: 'LY', name: 'El Al', quality: 0.8, factor: 1.15 },
  { code: 'W6', name: 'Wizz Air', quality: 0.5, factor: 0.72 },
  { code: 'FR', name: 'Ryanair', quality: 0.45, factor: 0.68 },
  { code: 'TK', name: 'Turkish Airlines', quality: 0.75, factor: 0.92 },
  { code: 'LH', name: 'Lufthansa', quality: 0.85, factor: 1.2 },
  { code: 'A3', name: 'Aegean', quality: 0.7, factor: 0.88 },
  { code: 'U8', name: 'Cyprus Airways', quality: 0.6, factor: 0.8 },
  { code: 'BA', name: 'British Airways', quality: 0.8, factor: 1.1 },
];

/** Deterministic pseudo-random in [0,1) from a seed string. */
function seeded(seed: string): number {
  const h = createHash('sha256').update(seed).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

/** Base long-haul-ness of a route from its code pair (deterministic). */
function routeBasePrice(origin: string, destination: string): number {
  const r = seeded(`route:${origin}:${destination}`);
  // 60-180 EUR short haul ... up to ~700 EUR long haul
  return 60 + r * 640;
}

const CABIN_FACTOR: Record<CabinClass, number> = {
  ECONOMY: 1,
  PREMIUM_ECONOMY: 1.8,
  BUSINESS: 3.2,
  FIRST: 5.5,
};

export class MockFlightProvider implements FlightSearchAdapter {
  readonly name = 'mock';
  readonly priority = 1000; // last resort by default
  readonly costTier = 'FREE' as const;
  readonly capabilities: ProviderCapabilities = {
    roundTrip: true,
    multiCity: true,
    flexibleDates: true,
    liveNetwork: false,
  };

  /** Optional time-shift so tests/seeds can generate "historical" observations. */
  constructor(private nowFn: () => Date = () => new Date()) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async search(query: SearchQuery): Promise<FlightResult[]> {
    const now = this.nowFn();
    const results: FlightResult[] = [];
    const base = routeBasePrice(query.origin, query.destination) * CABIN_FACTOR[query.cabin];
    const date = new Date(query.departureDate + 'T00:00:00Z');
    const weekday = date.getUTCDay();
    // weekends pricier, tuesday/wednesday cheaper
    const weekdayFactor = [1.06, 0.99, 0.93, 0.94, 1.0, 1.1, 1.08][weekday] ?? 1;
    // seasonal daily drift: slow sine over the year + small noise per day
    const dayOfYear = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
    const seasonFactor = 1 + 0.18 * Math.sin((dayOfYear / 365) * Math.PI * 2);
    // market movement: price also varies by observation day (for history charts)
    const obsDay = now.toISOString().slice(0, 10);
    const marketFactor = 0.9 + 0.2 * seeded(`market:${query.origin}:${query.destination}:${obsDay}`);

    for (const [i, airline] of AIRLINES.entries()) {
      const rnd = seeded(`f:${query.origin}:${query.destination}:${query.departureDate}:${airline.code}`);
      // not every airline flies every route
      if (rnd < 0.25) continue;
      const stops = rnd > 0.75 ? 0 : rnd > 0.4 ? 1 : 2;
      const stopsFactor = stops === 0 ? 1.18 : stops === 1 ? 0.95 : 0.82;
      if (query.stops === 'NON_STOP' && stops !== 0) continue;
      if (query.stops === 'ONE_STOP' && stops > 1) continue;
      if (query.airlines?.length && !query.airlines.includes(airline.code)) continue;
      if (query.excludeAirlines?.includes(airline.code)) continue;

      const price =
        base * airline.factor * weekdayFactor * seasonFactor * marketFactor * stopsFactor *
        (query.returnDate ? 1.75 : 1) *
        (query.passengers.adults + 0.75 * query.passengers.children + 0.1 * query.passengers.infants);
      const totalPrice = Math.round(price * 100) / 100;
      if (query.maxPrice && totalPrice > query.maxPrice) continue;

      const durBase = 90 + Math.round(routeBasePrice(query.origin, query.destination) * 0.9);
      const durationMinutes = durBase + stops * (75 + Math.round(rnd * 90));
      const depHour = 6 + Math.round(rnd * 16);
      if (query.departureTimeWindow) {
        const [lo, hi] = query.departureTimeWindow;
        if (depHour < lo || depHour > hi) continue;
      }
      const departureTime = `${query.departureDate}T${String(depHour).padStart(2, '0')}:${rnd > 0.5 ? '30' : '00'}:00`;
      const arrival = new Date(Date.parse(departureTime + 'Z') + durationMinutes * 60000);
      const links = bookingLinks(query);
      const conv = currencyService.convert(totalPrice, 'EUR');

      results.push({
        id: `mock-${query.origin}-${query.destination}-${query.departureDate}-${airline.code}-${i}`,
        provider: this.name,
        source: 'synthetic',
        origin: query.origin,
        destination: query.destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate,
        departureTime,
        arrivalTime: arrival.toISOString().slice(0, 19),
        durationMinutes,
        stops,
        airline: airline.code,
        airlineName: airline.name,
        flightNumber: `${airline.code}${100 + Math.round(rnd * 899)}`,
        aircraft: rnd > 0.5 ? 'Boeing 737' : 'Airbus A320',
        cabin: query.cabin,
        bags: query.bags ?? 0,
        basePrice: Math.round(totalPrice * 0.82 * 100) / 100,
        taxes: Math.round(totalPrice * 0.18 * 100) / 100,
        totalPrice,
        currency: 'EUR',
        normalizedPrice: conv.value,
        normalizedCurrency: currencyService.systemCurrency,
        exchangeRate: conv.rate,
        exchangeRateTimestamp: conv.timestamp,
        bookingUrl: links.googleFlights,
        deepLink: links.kiwi,
        segments: [
          {
            origin: query.origin,
            destination: query.destination,
            departureTime,
            arrivalTime: arrival.toISOString().slice(0, 19),
            airline: airline.code,
            airlineName: airline.name,
            flightNumber: `${airline.code}${100 + Math.round(rnd * 899)}`,
            durationMinutes,
          },
        ],
        collectedAt: now.toISOString(),
        rawProviderData: { mock: true, airportNames: [airportName(query.origin), airportName(query.destination)] },
      });
    }
    return results.sort((a, b) => a.totalPrice - b.totalPrice);
  }
}
