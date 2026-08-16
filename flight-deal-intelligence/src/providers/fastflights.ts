/**
 * FastFlightsAdapter (§4): wraps the fast-flights Python package (Google Flights
 * data, no API key — §59) behind the uniform FlightSearchAdapter interface via a
 * JSON stdin/stdout bridge subprocess.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlightSearchAdapter, ProviderCapabilities } from './adapter.js';
import { ProviderError, withRetry } from './adapter.js';
import type { CabinClass, FlightResult, SearchQuery } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'fast_flights_bridge.py');

const SEAT: Record<CabinClass, string> = {
  ECONOMY: 'economy',
  PREMIUM_ECONOMY: 'premium-economy',
  BUSINESS: 'business',
  FIRST: 'first',
};

interface BridgeFlight {
  name: string | null;
  departure: string | null;
  arrival: string | null;
  duration: string | null;
  stops: number | null;
  price: string | number | null;
  is_best: boolean | null;
}

function parsePrice(raw: string | number | null): { amount: number; currency: string } | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return { amount: raw, currency: 'EUR' };
  const symbols: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP', '₪': 'ILS' };
  const m = raw.replace(/[,\s]/g, '').match(/([€$£₪]?)(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { amount: Number(m[2]), currency: symbols[m[1] ?? ''] ?? 'EUR' };
}

function parseDurationMinutes(raw: string | null): number {
  if (!raw) return 0;
  const h = raw.match(/(\d+)\s*h/i);
  const m = raw.match(/(\d+)\s*m/i);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

export class FastFlightsAdapter implements FlightSearchAdapter {
  readonly name = 'fast-flights';
  readonly priority = 10; // preferred primary (§70)
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

  private runBridge(input: object, timeoutMs: number): Promise<{ ok: boolean; flights?: BridgeFlight[]; error?: string }> {
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
          25000
        ),
      { attempts: 2, timeoutMs: 28000, baseDelayMs: 500 }
    );
    if (!res.ok || !res.flights) {
      throw new ProviderError(this.name, res.error ?? 'unknown bridge error');
    }
    const links = bookingLinks(query);
    const now = new Date().toISOString();
    const results: FlightResult[] = [];
    for (const [i, f] of res.flights.entries()) {
      const price = parsePrice(f.price);
      if (!price) continue;
      const conv = currencyService.convert(price.amount, price.currency);
      const durationMinutes = parseDurationMinutes(f.duration);
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
        durationMinutes,
        stops: f.stops ?? 0,
        airline: (f.name ?? 'XX').slice(0, 20),
        airlineName: f.name ?? undefined,
        flightNumber: '',
        cabin: query.cabin,
        bags: query.bags ?? 0,
        basePrice: price.amount,
        taxes: 0,
        totalPrice: price.amount,
        currency: price.currency,
        normalizedPrice: conv.value,
        normalizedCurrency: currencyService.systemCurrency,
        exchangeRate: conv.rate,
        exchangeRateTimestamp: conv.timestamp,
        bookingUrl: links.googleFlights,
        deepLink: links.googleFlights,
        segments: [],
        collectedAt: now,
        rawProviderData: f,
      });
    }
    return results;
  }
}
