/**
 * Flight Agent (§29): parse → resolve airports → generate search matrix →
 * select providers → search → normalize → dedupe → analyze → score → recommend.
 *
 * Implements flexible search (§17), date matrix (§19), cheapest-date (§20),
 * multi-destination (§21), cheapest-anywhere (§31), weekend finder (§32) and
 * smart recommendations (§67). Search fan-out is bounded to protect providers
 * (§39 concurrency limits).
 */
import type {
  ParsedTripRequest, ScoredFlight, SearchQuery, StopsFilter, CabinClass,
} from '../core/types.js';
import { DEFAULT_PASSENGERS, routeKey } from '../core/types.js';
import { ANYWHERE_DESTINATIONS, nearbyAirports, airportName } from '../core/airports.js';
import { parseTripRequest } from './parser.js';
import { ProviderRegistry, buildDefaultRegistry } from '../providers/registry.js';
import { AnalysisService } from '../analyzer/service.js';
import { getDatabase, type FlightDatabase } from '../db/database.js';
import { currencyService } from '../core/currency.js';

export interface DateMatrixCell {
  departureDate: string;
  returnDate?: string;
  price: number | null;
  isLowest: boolean;
}

export type AgentProgressFn = (done: number, total: number, bestSoFar: ScoredFlight | null) => void;

export interface AgentSearchReport {
  request: ParsedTripRequest;
  totalQueries: number;
  totalResults: number;
  best: ScoredFlight | null;
  bestValue: ScoredFlight | null;
  top: ScoredFlight[];
  byDestination: { destination: string; destinationName?: string; best: ScoredFlight }[];
  dateMatrix?: DateMatrixCell[];
  recommendations: string[];
  providersUsed: string[];
  disclaimer: string;
  elapsedMs: number;
}

const MAX_QUERIES_PER_REQUEST = Number(process.env.MAX_QUERIES_PER_REQUEST ?? 24);
const CONCURRENCY = Number(process.env.SEARCH_CONCURRENCY ?? 6);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]!);
      }
    })
  );
  return results;
}

function* dateRange(from: string, to: string, stepDays = 1): Generator<string> {
  let t = Date.parse(from + 'T00:00:00Z');
  const end = Date.parse(to + 'T00:00:00Z');
  while (t <= end) {
    yield new Date(t).toISOString().slice(0, 10);
    t += stepDays * 86400000;
  }
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

export class FlightAgent {
  constructor(
    private registry: ProviderRegistry = buildDefaultRegistry(),
    private analysis: AnalysisService = new AnalysisService(),
    private db: FlightDatabase = getDatabase()
  ) {}

  /** Build the (bounded) list of concrete queries for a parsed request (§29 step 4). */
  buildSearchMatrix(req: ParsedTripRequest): SearchQuery[] {
    const queries: SearchQuery[] = [];
    const destinations = req.mode === 'ANYWHERE'
      ? ANYWHERE_DESTINATIONS
      : req.destinations.length
        ? req.destinations
        : ANYWHERE_DESTINATIONS.slice(0, 10);

    const { from, to } = req.departureWindow;
    // Sample departure dates across the window; density depends on how many
    // destination combinations we must cover (bounded fan-out, §28/§39).
    const windowDays = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000));
    const budgetPerDest = Math.max(1, Math.floor(MAX_QUERIES_PER_REQUEST / Math.max(1, destinations.length)));
    const step = Math.max(1, Math.ceil(windowDays / budgetPerDest));

    for (const origin of req.origins.slice(0, 2)) {
      for (const dest of destinations) {
        for (const dep of dateRange(from, to, step)) {
          let returnDate: string | undefined;
          if (req.tripLengthDays) {
            const len = Math.round((req.tripLengthDays.min + req.tripLengthDays.max) / 2);
            returnDate = addDays(dep, len);
          }
          queries.push({
            origin,
            destination: dest,
            departureDate: dep,
            returnDate,
            passengers: req.passengers ?? DEFAULT_PASSENGERS,
            cabin: req.cabin,
            stops: 'ANY',
            maxPrice: req.maxPrice,
            currency: req.currency ?? currencyService.systemCurrency,
          });
          if (queries.length >= MAX_QUERIES_PER_REQUEST) return queries;
        }
      }
    }
    return queries;
  }

  /** Weekend finder (§32): Thu/Fri departures with Sun/Mon returns in the window. */
  buildWeekendQueries(req: ParsedTripRequest): SearchQuery[] {
    const queries: SearchQuery[] = [];
    const dests = req.destinations.length ? req.destinations : ANYWHERE_DESTINATIONS.slice(0, 8);
    for (const dep of dateRange(req.departureWindow.from, req.departureWindow.to)) {
      const day = new Date(dep + 'T00:00:00Z').getUTCDay();
      if (day !== 4 && day !== 5) continue; // Thursday / Friday
      for (const dest of dests) {
        for (const retOffset of day === 4 ? [3, 4] : [2, 3]) {
          queries.push({
            origin: req.origins[0]!,
            destination: dest,
            departureDate: dep,
            returnDate: addDays(dep, retOffset),
            passengers: req.passengers,
            cabin: req.cabin,
            stops: 'ANY',
            maxPrice: req.maxPrice,
            currency: req.currency ?? currencyService.systemCurrency,
          });
          if (queries.length >= MAX_QUERIES_PER_REQUEST) return queries;
        }
      }
    }
    return queries;
  }

  /** Run one concrete query through providers + analysis. */
  async searchOne(query: SearchQuery): Promise<ScoredFlight[]> {
    const outcome = await this.registry.search(query);
    return this.analysis.analyze(outcome.results);
  }

  /** Full agent flow from natural language (§30, §82). */
  async run(text: string, onProgress?: AgentProgressFn): Promise<AgentSearchReport> {
    const started = Date.now();
    const request = parseTripRequest(text);
    return this.runParsed(request, started, onProgress);
  }

  async runParsed(
    request: ParsedTripRequest,
    started = Date.now(),
    onProgress?: AgentProgressFn
  ): Promise<AgentSearchReport> {
    const queries =
      request.mode === 'WEEKEND' ? this.buildWeekendQueries(request) : this.buildSearchMatrix(request);
    onProgress?.(0, queries.length, null); // report total immediately

    const providersUsed = new Set<string>();
    const allScored: ScoredFlight[] = [];
    const cellResults: DateMatrixCell[] = [];
    let done = 0;

    await mapLimit(queries, CONCURRENCY, async (q) => {
      const outcome = await this.registry.search(q);
      outcome.attempted.filter((a) => a.ok).forEach((a) => providersUsed.add(a.provider));
      const scored = this.analysis.analyze(outcome.results);
      allScored.push(...scored);
      const low = scored.length ? Math.min(...scored.map((s) => s.normalizedPrice)) : null;
      cellResults.push({
        departureDate: q.departureDate,
        returnDate: q.returnDate,
        price: low,
        isLowest: false,
      });
      done++;
      if (onProgress) {
        const bestSoFar = [...allScored].sort((a, b) => a.normalizedPrice - b.normalizedPrice)[0] ?? null;
        onProgress(done, queries.length, bestSoFar);
      }
    });

    // mark the lowest matrix cell (§19)
    const priced = cellResults.filter((c) => c.price !== null);
    if (priced.length) {
      const min = Math.min(...priced.map((c) => c.price!));
      for (const c of cellResults) c.isLowest = c.price === min;
    }

    const sortedByPrice = [...allScored].sort((a, b) => a.normalizedPrice - b.normalizedPrice);
    const sortedByValue = [...allScored].sort((a, b) => b.valueScore - a.valueScore);
    const best = sortedByPrice[0] ?? null;
    const bestValue = sortedByValue[0] ?? null;

    // best per destination (§21, §31)
    const byDest = new Map<string, ScoredFlight>();
    for (const f of sortedByPrice) {
      if (!byDest.has(f.destination)) byDest.set(f.destination, f);
    }

    const recommendations = this.buildRecommendations(best, allScored);

    return {
      request,
      totalQueries: queries.length,
      totalResults: allScored.length,
      best,
      bestValue,
      top: sortedByPrice.slice(0, 10),
      byDestination: [...byDest.entries()]
        .map(([destination, flight]) => ({
          destination,
          destinationName: airportName(destination),
          best: flight,
        }))
        .sort((a, b) => a.best.normalizedPrice - b.best.normalizedPrice)
        .slice(0, 20),
      dateMatrix: cellResults.sort((a, b) => a.departureDate.localeCompare(b.departureDate)),
      recommendations,
      providersUsed: [...providersUsed],
      // §68: never claim world-cheapest
      disclaimer: 'Lowest price found across the sources available to us at search time — not a guarantee of the lowest price that exists.',
      elapsedMs: Date.now() - started,
    };
  }

  /** Smart recommendations (§67): cheaper day nearby, cheaper nearby airport. */
  private buildRecommendations(best: ScoredFlight | null, all: ScoredFlight[]): string[] {
    const recs: string[] = [];
    if (!best) return recs;

    // cheaper on another day (same route)
    const sameRoute = all.filter(
      (f) => f.origin === best.origin && f.destination === best.destination && f.departureDate !== best.departureDate
    );
    const cheaperDay = sameRoute.find((f) => f.normalizedPrice < best.normalizedPrice * 0.97);
    if (cheaperDay) {
      recs.push(
        `Found ${Math.round(best.normalizedPrice - cheaperDay.normalizedPrice)} ${cheaperDay.normalizedCurrency} cheaper if you depart on ${cheaperDay.departureDate} instead of ${best.departureDate}.`
      );
    }

    // cheaper from a nearby origin, accounting for positioning cost (§18, §36)
    for (const alt of nearbyAirports(best.origin)) {
      const altFlights = all.filter((f) => f.origin === alt.code && f.destination === best.destination);
      const altBest = altFlights.sort((a, b) => a.normalizedPrice - b.normalizedPrice)[0];
      if (altBest) {
        const trueCost = altBest.normalizedPrice + alt.positioningCostEur;
        if (trueCost < best.normalizedPrice * 0.92) {
          recs.push(
            `Flying from ${alt.code} instead of ${best.origin} saves ~${Math.round(best.normalizedPrice - altBest.normalizedPrice)} ${altBest.normalizedCurrency}, with an estimated ${alt.positioningCostEur} EUR / ${alt.positioningHours}h positioning cost (true cost ${Math.round(trueCost)}).`
          );
        }
      }
    }

    if (best.analysis.isErrorFareCandidate) {
      recs.push('Error-fare candidate: the price appears unusually low. Verify directly with the airline before purchasing.');
    }
    return recs;
  }

  /** Cheapest-date engine (§20): daily lows for a route from stored history. */
  cheapestDates(origin: string, destination: string, windowDays = 90): { day: string; low: number }[] {
    return this.db
      .priceSeries(routeKey(origin, destination), windowDays)
      .map((r) => ({ day: r.day, low: r.low }));
  }
}

export function buildQuery(partial: Partial<SearchQuery> & { origin: string; destination: string; departureDate: string }): SearchQuery {
  return {
    passengers: DEFAULT_PASSENGERS,
    cabin: 'ECONOMY' as CabinClass,
    stops: 'ANY' as StopsFilter,
    currency: currencyService.systemCurrency,
    ...partial,
  };
}
