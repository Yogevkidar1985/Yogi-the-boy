/**
 * Analysis service: persists results + snapshots, computes route statistics
 * and scores every flight against history and the live market (§2, §14-§16).
 */
import type { FlightResult, RouteStatistics, ScoredFlight } from '../core/types.js';
import { routeKey } from '../core/types.js';
import { getDatabase, type FlightDatabase } from '../db/database.js';
import { computeRouteStatistics } from './statistics.js';
import { dedupe, fingerprint } from './dedup.js';
import { scoreFlight, type MarketContext } from './dealscore.js';

export class AnalysisService {
  constructor(private db: FlightDatabase = getDatabase()) {}

  /** Store results + price snapshots so every search enriches history (§14). */
  persistResults(results: FlightResult[]): void {
    for (const r of results) {
      this.db.insertFlightResult(r, fingerprint(r));
      this.db.insertPriceSnapshot({
        route: routeKey(r.origin, r.destination),
        origin: r.origin,
        destination: r.destination,
        departureDate: r.departureDate,
        returnDate: r.returnDate,
        price: r.normalizedPrice,
        currency: r.normalizedCurrency,
        provider: r.provider,
        airline: r.airline,
        stops: r.stops,
        collectedAt: r.collectedAt,
      });
    }
  }

  routeStatistics(route: string, windowDays = 90): RouteStatistics | null {
    const history = this.db.priceHistory(route, windowDays).map((h) => h.price);
    const stats = computeRouteStatistics(route, history, windowDays);
    if (stats) {
      this.db.db
        .prepare(
          `INSERT OR REPLACE INTO price_statistics
           (route, sample_count, lowest, highest, average, median, std_dev, volatility, trend, window_days, computed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`
        )
        .run(
          route, stats.sampleCount, stats.lowest, stats.highest, stats.average,
          stats.median, stats.stdDev, stats.volatility, stats.trend, windowDays
        );
    }
    return stats;
  }

  /** Previous lowest observed price for a route ~1 day ago (drop velocity input). */
  previousLow(route: string): number | undefined {
    const row = this.db.db
      .prepare(
        `SELECT MIN(price) AS low FROM price_snapshots
         WHERE route = ? AND collected_at < datetime('now', '-12 hours')
           AND collected_at >= datetime('now', '-3 days')`
      )
      .get(route) as { low: number | null };
    return row.low ?? undefined;
  }

  /**
   * Full pipeline for a result set of one query: dedupe → persist → score.
   * Returns flights sorted by deal score (best deals first).
   */
  analyze(results: FlightResult[], windowDays = 90): ScoredFlight[] {
    const unique = dedupe(results);
    this.persistResults(unique);
    if (!unique.length) return [];

    const route = routeKey(unique[0]!.origin, unique[0]!.destination);
    const history = this.db.priceHistory(route, windowDays).map((h) => h.price);
    const stats = this.routeStatistics(route, windowDays);
    const ctx: MarketContext = {
      marketPrices: unique.map((f) => f.normalizedPrice),
      stats,
      history,
      previousLow: this.previousLow(route),
    };
    const scored = unique.map((f) => scoreFlight(f, ctx));
    for (const s of scored) {
      this.db.db
        .prepare(
          `INSERT INTO deal_scores (flight_result_id, route, score, breakdown_json, is_exceptional, is_error_fare_candidate)
           VALUES (?,?,?,?,?,?)`
        )
        .run(
          s.id, route, s.analysis.dealScore, JSON.stringify(s.analysis.scoreBreakdown),
          s.analysis.isExceptional ? 1 : 0, s.analysis.isErrorFareCandidate ? 1 : 0
        );
    }
    return scored.sort((a, b) => b.analysis.dealScore - a.analysis.dealScore);
  }
}
