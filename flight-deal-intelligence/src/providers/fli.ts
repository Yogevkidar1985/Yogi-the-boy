/**
 * FliAdapter: wraps the `fli` CLI (Google Flights via the flights/pipx package)
 * using its `--format json` output. Serves as fallback/secondary provider and
 * powers cheapest-date scans via `fli dates`.
 */
import { execFile } from 'node:child_process';
import type { FlightSearchAdapter, ProviderCapabilities } from './adapter.js';
import { ProviderError, withRetry } from './adapter.js';
import type { CabinClass, FlightResult, SearchQuery } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';

const CABIN_ARG: Record<CabinClass, string> = {
  ECONOMY: 'ECONOMY',
  PREMIUM_ECONOMY: 'PREMIUM_ECONOMY',
  BUSINESS: 'BUSINESS',
  FIRST: 'FIRST',
};

export class FliAdapter implements FlightSearchAdapter {
  readonly name = 'fli';
  readonly priority = 20;
  readonly capabilities: ProviderCapabilities = {
    roundTrip: true,
    multiCity: false,
    flexibleDates: true,
    liveNetwork: true,
  };

  constructor(private bin: string = process.env.FLI_BIN ?? 'fli') {}

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.bin, ['--help'], { timeout: 15000 }, (err) => resolve(!err));
    });
  }

  private run(args: string[], timeoutMs = 60000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new ProviderError(this.name, stderr?.slice(0, 300) || err.message));
        resolve(stdout);
      });
    });
  }

  async search(query: SearchQuery): Promise<FlightResult[]> {
    const args = ['flights', query.origin, query.destination, query.departureDate, '--format', 'json'];
    if (query.returnDate) args.push('--return', query.returnDate);
    args.push('--class', CABIN_ARG[query.cabin]);
    if (query.stops !== 'ANY') args.push('--stops', query.stops);
    if (query.airlines?.length) args.push('--airlines', query.airlines.join(','));

    // single attempt with a tight budget: the whole request (all providers)
    // must finish inside typical proxy limits (~100s on Render/Railway)
    const stdout = await withRetry(this.name, () => this.run(args, 35000), { attempts: 1, timeoutMs: 38000 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new ProviderError(this.name, 'non-JSON output from fli CLI', false);
    }
    const flights = Array.isArray(parsed) ? parsed : (parsed as { flights?: unknown[] }).flights ?? [];
    const links = bookingLinks(query);
    const now = new Date().toISOString();

    return (flights as Record<string, unknown>[]).map((f, i) => {
      const price = Number(f.price ?? f.total_price ?? 0);
      const currency = String(f.currency ?? 'USD');
      const conv = currencyService.convert(price, currency);
      const legs = (f.legs ?? f.slices ?? []) as Record<string, unknown>[];
      const first = legs[0] ?? {};
      return {
        id: `fli-${query.origin}-${query.destination}-${query.departureDate}-${i}`,
        provider: this.name,
        source: 'google-flights',
        origin: query.origin,
        destination: query.destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate,
        departureTime: String(first.departure_datetime ?? f.departure ?? ''),
        arrivalTime: String(first.arrival_datetime ?? f.arrival ?? ''),
        durationMinutes: Number(f.duration ?? first.duration ?? 0),
        stops: Number(f.stops ?? 0),
        airline: String(first.airline ?? f.airline ?? 'XX'),
        airlineName: String(first.airline_name ?? f.airline ?? ''),
        flightNumber: String(first.flight_number ?? ''),
        cabin: query.cabin,
        bags: query.bags ?? 0,
        basePrice: price,
        taxes: 0,
        totalPrice: price,
        currency,
        normalizedPrice: conv.value,
        normalizedCurrency: currencyService.systemCurrency,
        exchangeRate: conv.rate,
        exchangeRateTimestamp: conv.timestamp,
        bookingUrl: links.googleFlights,
        deepLink: links.googleFlights,
        segments: [],
        collectedAt: now,
        rawProviderData: f,
      } satisfies FlightResult;
    });
  }

  /** Cheapest-date scan using `fli dates` (§20). Returns date→price map. */
  async cheapestDates(
    origin: string,
    destination: string,
    from: string,
    to: string
  ): Promise<{ date: string; price: number }[]> {
    const stdout = await this.run(
      ['dates', origin, destination, '--from', from, '--to', to, '--format', 'json'],
      90000
    );
    try {
      const parsed = JSON.parse(stdout) as unknown;
      const arr = Array.isArray(parsed) ? parsed : (parsed as { dates?: unknown[] }).dates ?? [];
      return (arr as Record<string, unknown>[]).map((d) => ({
        date: String(d.date ?? d.departure_date ?? ''),
        price: Number(d.price ?? 0),
      }));
    } catch {
      throw new ProviderError(this.name, 'non-JSON output from fli dates', false);
    }
  }
}
