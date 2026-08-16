/**
 * Deal Score 0-100 (§15) with the spec's exact weights, plus anomaly / error
 * fare detection (§16, §24), value score (§46) and human explanations (§71).
 * Never claims "cheapest in the world" — only relative to observed data (§68).
 */
import type { DealAnalysis, FlightResult, RouteStatistics, ScoredFlight } from '../core/types.js';
import { isAnomalouslyLow, percentileRank } from './statistics.js';

/** Airline quality heuristic 0-1 (full-service vs ultra-low-cost). */
const AIRLINE_QUALITY: Record<string, number> = {
  LY: 0.8, LH: 0.85, BA: 0.8, AF: 0.8, KL: 0.8, TK: 0.75, LX: 0.85, OS: 0.8,
  A3: 0.7, U8: 0.6, W6: 0.45, FR: 0.4, U2: 0.5, PC: 0.5, 'W9': 0.45, EK: 0.9,
  QR: 0.9, SQ: 0.95, DL: 0.75, UA: 0.7, AA: 0.7,
};

export interface MarketContext {
  /** all normalized prices observed in the current result set (same query) */
  marketPrices: number[];
  stats: RouteStatistics | null;
  history: number[];
  /** price observed for this route ~24h ago, for drop-velocity */
  previousLow?: number;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function computeDealScore(flight: FlightResult, ctx: MarketContext): DealAnalysis {
  const price = flight.normalizedPrice;
  const { stats, history, marketPrices, previousLow } = ctx;
  const breakdown: Record<string, number> = {};

  // 20% historical price: how far below historical average
  let historical = 0.5;
  if (stats && stats.average > 0) {
    historical = clamp01((stats.average - price) / (stats.average * 0.5) / 2 + 0.5);
  }
  breakdown.historicalPrice = Math.round(historical * 20 * 10) / 10;

  // 20% current market: position among competing offers right now
  let market = 0.5;
  if (marketPrices.length > 1) {
    const best = Math.min(...marketPrices);
    const worst = Math.max(...marketPrices);
    market = worst > best ? clamp01(1 - (price - best) / (worst - best)) : 0.5;
  }
  breakdown.marketPrice = Math.round(market * 20 * 10) / 10;

  // 15% route average: price vs median of history
  let routeAvg = 0.5;
  if (stats && stats.median > 0) {
    routeAvg = clamp01((stats.median - price) / stats.median + 0.5);
  }
  breakdown.routeAverage = Math.round(routeAvg * 15 * 10) / 10;

  // 15% price-drop velocity
  let velocity = 0.5;
  if (previousLow && previousLow > 0) {
    velocity = clamp01((previousLow - price) / (previousLow * 0.3) / 2 + 0.5);
  }
  breakdown.dropVelocity = Math.round(velocity * 15 * 10) / 10;

  // 10% airline quality
  const quality = AIRLINE_QUALITY[flight.airline] ?? 0.6;
  breakdown.airlineQuality = Math.round(quality * 10 * 10) / 10;

  // 10% duration: shorter is better relative to the market
  let duration = 0.5;
  const durations = marketPrices.length > 1 ? undefined : undefined;
  void durations;
  if (flight.durationMinutes > 0 && ctx.marketPrices.length > 0) {
    duration = clamp01(1 - flight.durationMinutes / (18 * 60));
  }
  breakdown.duration = Math.round(duration * 10 * 10) / 10;

  // 5% stops
  const stopsScore = flight.stops === 0 ? 1 : flight.stops === 1 ? 0.55 : 0.2;
  breakdown.stops = Math.round(stopsScore * 5 * 10) / 10;

  // 5% flexibility/value: bags included etc.
  const flexScore = flight.bags > 0 ? 1 : 0.5;
  breakdown.flexibilityValue = Math.round(flexScore * 5 * 10) / 10;

  const dealScore = Math.round(
    Object.values(breakdown).reduce((a, b) => a + b, 0)
  );

  const vsAverage = stats && stats.average > 0 ? Math.round(((price - stats.average) / stats.average) * 100) / 100 : null;
  const vsLowest = stats && stats.lowest > 0 ? Math.round(((price - stats.lowest) / stats.lowest) * 100) / 100 : null;
  const percentile = history.length ? percentileRank(history, price) : null;

  const anomaly = isAnomalouslyLow(history, price);
  // Error fare candidate (§24): several deviation signals must agree
  const deviations = [
    stats && stats.average > 0 && price < stats.average * 0.55,
    marketPrices.length > 2 && price < Math.min(...marketPrices.filter((p) => p !== price)) * 0.6,
    anomaly,
  ].filter(Boolean).length;
  const isErrorFareCandidate = deviations >= 2;

  const explanation: string[] = [];
  if (vsAverage !== null && vsAverage < -0.05) {
    explanation.push(`${Math.round(Math.abs(vsAverage) * 100)}% מתחת לממוצע המסלול ב-${stats?.windowDays ?? 90} הימים האחרונים`);
  }
  if (percentile !== null && percentile <= 10) {
    explanation.push(`זול מ-${100 - percentile}% מהמחירים שנצפו במסלול הזה`);
  }
  if (vsLowest !== null && vsLowest <= 0.05) {
    explanation.push(vsLowest <= 0 ? 'המחיר הנמוך ביותר שנצפה במסלול הזה' : `רק ${Math.round(vsLowest * 100)}% מעל השפל ההיסטורי`);
  }
  if (flight.stops === 0) explanation.push('טיסה ישירה');
  if (flight.bags > 0) explanation.push('כבודה כלולה');
  if (previousLow && price < previousLow * 0.85) {
    explanation.push(`המחיר ירד ${Math.round((1 - price / previousLow) * 100)}% מאז הבדיקה הקודמת`);
  }

  return {
    dealScore,
    scoreBreakdown: breakdown,
    percentile,
    vsAverage,
    vsLowest,
    isExceptional: anomaly || (vsAverage !== null && vsAverage < -0.3),
    isErrorFareCandidate,
    explanation,
    disclaimer: isErrorFareCandidate
      ? 'המחיר נמוך באופן חריג — מומלץ לוודא ישירות מול חברת התעופה לפני רכישה.'
      : undefined,
  };
}

/** Value Score (§46): rank not only by price. Lower = better rank position. */
export function computeValueScore(flight: FlightResult, ctx: MarketContext): number {
  const best = ctx.marketPrices.length ? Math.min(...ctx.marketPrices) : flight.normalizedPrice;
  const priceRatio = best > 0 ? flight.normalizedPrice / best : 1;
  const durationPenalty = flight.durationMinutes / (10 * 60);
  const stopsPenalty = flight.stops * 0.15;
  const quality = AIRLINE_QUALITY[flight.airline] ?? 0.6;
  const score = 100 - (priceRatio - 1) * 60 - durationPenalty * 10 - stopsPenalty * 100 * 0.1 + quality * 10;
  return Math.round(Math.max(0, Math.min(110, score)) * 10) / 10;
}

export function scoreFlight(flight: FlightResult, ctx: MarketContext): ScoredFlight {
  const analysis = computeDealScore(flight, ctx);
  return {
    ...flight,
    analysis,
    valueScore: computeValueScore(flight, ctx),
    freshnessMinutes: Math.round((Date.now() - Date.parse(flight.collectedAt)) / 60000),
  };
}
