/**
 * FastFlightsAdapter (§4): wraps the fast-flights Python package v3 (Google
 * Flights data, no API key — §59) behind the uniform FlightSearchAdapter
 * interface via a JSON stdin/stdout bridge subprocess.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlightSearchAdapter, ProviderCapabilities } from './adapter.js';
import { ProviderError, withRetry } from './adapter.js';
import type { CabinClass, FlightResult, FlightSegment, SearchQuery } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE = join(ROOT, 'scripts', 'fast_flights_bridge.py');

const SEAT: Record<CabinClass, string> = {
  ECONOMY: 'economy',
  PREMIUM_ECONOMY: 'premium-economy',
  BUSINESS: 'business',
  FIRST: 'first',
};

/** Reverse lookup: airline display name → IATA code (from assets/airlines.csv). */
let nameToCode: Map<string, string> | null = null;
function airlineCode(name: string): string {
  if (!nameToCode) {
    nameToCode = new Map();
    try {
      const csv = readFileSync(join(ROOT, 'assets', 'airlines.csv'), 'utf-8');
      for (const line of csv.split('\n').slice(1)) {
        const idx = line.indexOf(',');
        if (idx > 0) nameToCode.set(line.slice(idx + 1).trim().toLowerCase(), line.slice(0, idx).trim());
      }
    } catch {
      /* lookup stays empty — fall through to name slice */
    }
  }
  return nameToCode.get(name.trim().toLowerCase()) ?? name.slice(0, 2).toUpperCase();
}

interface BridgeLeg {
  from: string | null;
  to: string | null;
  departure: string;
  arrival: string;
  durationMinutes: number;
  plane: string | null;
}

interface BridgeFlight {
  price: number | null;
  type: string | null;
  airlines: string[];
  stops: number;
  departure: string | null;
  arrival: string | null;
  durationMinutes: number;
  legs: BridgeLeg[];
}

interface BridgeResponse {
  ok: boolean;
  currency?: string;
  flights?: BridgeFlight[];
  error?: string;
}

export class FastFlightsAdapter implements FlightSearchAdapter {
  readonly name = 'fast-flights';
  readonly priority = 10; // preferred primary (§70)
  readonly costTier = 'FREE' as const;
  readonly timeoutMs = 40000;
  readonly capabilities: ProviderCapabilities = {
    roundTrip: true,
    multiCity: false,
    flexibleDates: false,
    liveNetwork: true,
  };

  constructor(private pythonBin: string = process.env.PYTHON_BIN ?? 'python3') {}

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.pythonBin, ['-c', 'import fast_flights'], { timeout: 10000 }, (err) =>
        resolve(!err)
      );
    });
  }

  private runBridge(input: object, timeoutMs: number): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.pythonBin,
        [BRIDGE],
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) return reject(new ProviderError(this.name, err.message));
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            reject(new ProviderError(this.name, `unparseable bridge output: ${stdout.slice(0, 200)}`));
          }
        }
      );
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    });
  }

  async search(query: SearchQuery): Promise<FlightResult[]> {
    const maxStops =
      query.stops === 'NON_STOP' ? 0 : query.stops === 'ONE_STOP' ? 1 : undefined;
    const res = await withRetry(
      this.name,
      () =>
        this.runBridge(
          {
            origin: query.origin,
            destination: query.destination,
            date: query.departureDate,
            returnDate: query.returnDate,
            seat: SEAT[query.cabin],
            adults: query.passengers.adults,
            children: query.passengers.children,
            infants: query.passengers.infants,
            maxStops,
            currency: query.currency,
          },
          20000
        ),
      // single attempt keeps wide scans fast — the registry falls back to the
      // next provider on failure anyway (§70)
      { attempts: 1, timeoutMs: 22000 }
    );
    if (!res.ok || !res.flights) {
      throw new ProviderError(this.name, res.error ?? 'unknown bridge error');
    }
    const priceCurrency = (res.currency ?? query.currency ?? 'EUR').toUpperCase();
    const links = bookingLinks(query);
    const now = new Date().toISOString();
    const results: FlightResult[] = [];

    for (const [i, f] of res.flights.entries()) {
      if (f.price == null || f.price <= 0) continue;
      if (query.maxPrice && f.price > query.maxPrice) continue;
      const airlineName = f.airlines[0] ?? 'Unknown';
      const code = airlineCode(airlineName);
      const conv = currencyService.convert(f.price, priceCurrency);
      const segments: FlightSegment[] = f.legs.map((l) => ({
        origin: l.from ?? query.origin,
        destination: l.to ?? query.destination,
        departureTime: l.departure,
        arrivalTime: l.arrival,
        airline: code,
        airlineName,
        flightNumber: '',
        aircraft: l.plane ?? undefined,
        durationMinutes: l.durationMinutes,
      }));

      results.push({
        id: `ff-${query.origin}-${query.destination}-${query.departureDate}-${i}`,
        provider: this.name,
        source: 'google-flights',
        origin: query.origin,
        destination: query.destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate,
        departureTime: f.departure ?? '',
        arrivalTime: f.arrival ?? '',
        durationMinutes: f.durationMinutes,
        stops: f.stops,
        airline: code,
        airlineName,
        flightNumber: '',
        aircraft: f.legs[0]?.plane ?? undefined,
        cabin: query.cabin,
        bags: query.bags ?? 0,
        basePrice: f.price,
        taxes: 0,
        totalPrice: f.price,
        currency: priceCurrency,
        normalizedPrice: conv.value,
        normalizedCurrency: currencyService.systemCurrency,
        exchangeRate: conv.rate,
        exchangeRateTimestamp: conv.timestamp,
        bookingUrl: links.googleFlights,
        deepLink: links.googleFlights,
        segments,
        collectedAt: now,
        rawProviderData: { type: f.type, airlines: f.airlines },
      });
    }
    return results;
  }
}
