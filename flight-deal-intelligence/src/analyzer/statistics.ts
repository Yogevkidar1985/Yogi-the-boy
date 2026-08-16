/**
 * Price statistics (§14): lowest/highest/average/median/percentile/volatility/
 * trend/anomaly over a route's stored history.
 */
import type { RouteStatistics } from '../core/types.js';

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Percentile rank of `value` within history: 0 = cheapest ever, 100 = priciest. */
export function percentileRank(history: number[], value: number): number {
  if (!history.length) return 50;
  const below = history.filter((x) => x < value).length;
  const equal = history.filter((x) => x === value).length;
  return Math.round(((below + equal / 2) / history.length) * 100);
}

/**
 * Trend over the observation series: compares the mean of the last third with
 * the mean of the first third. >5% move = RISING/FALLING, else STABLE.
 */
export function detectTrend(series: number[]): 'RISING' | 'FALLING' | 'STABLE' {
  if (series.length < 6) return 'STABLE';
  const third = Math.floor(series.length / 3);
  const early = mean(series.slice(0, third));
  const late = mean(series.slice(-third));
  if (early === 0) return 'STABLE';
  const change = (late - early) / early;
  if (change > 0.05) return 'RISING';
  if (change < -0.05) return 'FALLING';
  return 'STABLE';
}

export function computeRouteStatistics(
  route: string,
  prices: number[],
  windowDays: number
): RouteStatistics | null {
  if (!prices.length) return null;
  const avg = mean(prices);
  const sd = stdDev(prices);
  return {
    route,
    sampleCount: prices.length,
    lowest: Math.min(...prices),
    highest: Math.max(...prices),
    average: Math.round(avg * 100) / 100,
    median: median(prices),
    stdDev: Math.round(sd * 100) / 100,
    volatility: avg > 0 ? Math.round((sd / avg) * 1000) / 1000 : 0,
    trend: detectTrend(prices),
    windowDays,
  };
}

/**
 * Anomaly detection (§16, §24): a price is anomalous when it sits far below
 * the normal range. Uses robust z-score against median to resist outliers.
 */
export function isAnomalouslyLow(history: number[], value: number): boolean {
  if (history.length < 8) return false;
  const med = median(history);
  const sd = stdDev(history);
  if (sd === 0) return false;
  return (med - value) / sd > 2;
}
