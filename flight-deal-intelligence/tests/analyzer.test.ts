import { describe, it, expect } from 'vitest';
import { mean, median, stdDev, percentileRank, detectTrend, computeRouteStatistics, isAnomalouslyLow } from '../src/analyzer/statistics.js';
import { computeDealScore, computeValueScore } from '../src/analyzer/dealscore.js';
import { dedupe, fingerprint } from '../src/analyzer/dedup.js';
import type { FlightResult } from '../src/core/types.js';

function flight(overrides: Partial<FlightResult> = {}): FlightResult {
  return {
    id: 'f1', provider: 'test', source: 'test', origin: 'TLV', destination: 'LHR',
    departureDate: '2026-10-12', departureTime: '2026-10-12T08:00:00', arrivalTime: '2026-10-12T12:00:00',
    durationMinutes: 300, stops: 0, airline: 'LY', airlineName: 'El Al', flightNumber: 'LY315',
    cabin: 'ECONOMY', bags: 0, basePrice: 250, taxes: 40, totalPrice: 290, currency: 'EUR',
    normalizedPrice: 290, normalizedCurrency: 'EUR', exchangeRate: 1,
    exchangeRateTimestamp: new Date().toISOString(), bookingUrl: 'https://example.com',
    deepLink: 'https://example.com', segments: [], collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('statistics (§14)', () => {
  it('computes mean/median/stddev', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });

  it('percentile rank: low price = low percentile', () => {
    const history = [300, 320, 350, 400, 450, 500];
    expect(percentileRank(history, 290)).toBeLessThan(10);
    expect(percentileRank(history, 510)).toBeGreaterThan(90);
  });

  it('detects falling trend', () => {
    const series = [500, 490, 480, 470, 400, 390, 350, 340, 330];
    expect(detectTrend(series)).toBe('FALLING');
    expect(detectTrend([100, 100, 100, 100, 100, 100])).toBe('STABLE');
  });

  it('route statistics summarize history', () => {
    const stats = computeRouteStatistics('TLV-LHR', [300, 350, 400, 450], 90)!;
    expect(stats.lowest).toBe(300);
    expect(stats.highest).toBe(450);
    expect(stats.average).toBe(375);
    expect(stats.sampleCount).toBe(4);
  });

  it('flags anomalously low prices (§16)', () => {
    const typical = [500, 520, 550, 560, 580, 600, 610, 650, 630, 590];
    expect(isAnomalouslyLow(typical, 295)).toBe(true);
    expect(isAnomalouslyLow(typical, 540)).toBe(false);
  });
});

describe('deal score (§15)', () => {
  const history = [400, 420, 450, 460, 480, 500, 510, 470, 430, 445];
  const stats = computeRouteStatistics('TLV-LHR', history, 90);

  it('scores a big discount high and flags exceptional', () => {
    const cheap = flight({ normalizedPrice: 290 });
    const a = computeDealScore(cheap, { marketPrices: [290, 470, 520], stats, history });
    expect(a.dealScore).toBeGreaterThan(65);
    expect(a.vsAverage).toBeLessThan(-0.3);
    expect(a.isExceptional).toBe(true);
    expect(a.explanation.length).toBeGreaterThan(0);
  });

  it('scores an expensive fare low', () => {
    const pricey = flight({ normalizedPrice: 600, stops: 2, airline: 'FR' });
    const a = computeDealScore(pricey, { marketPrices: [290, 470, 600], stats, history });
    expect(a.dealScore).toBeLessThan(50);
    expect(a.isExceptional).toBe(false);
  });

  it('error fare candidate requires multiple deviation signals (§24)', () => {
    const suspicious = flight({ normalizedPrice: 180 });
    const a = computeDealScore(suspicious, { marketPrices: [180, 460, 500, 520], stats, history });
    expect(a.isErrorFareCandidate).toBe(true);
    expect(a.disclaimer).toMatch(/לוודא ישירות/);
  });

  it('value score prefers direct quality flights (§46)', () => {
    const direct = flight({ normalizedPrice: 320, stops: 0, durationMinutes: 300, airline: 'LH' });
    const cheapSlow = flight({ normalizedPrice: 300, stops: 2, durationMinutes: 900, airline: 'FR' });
    const ctx = { marketPrices: [300, 320], stats, history };
    expect(computeValueScore(direct, ctx)).toBeGreaterThan(computeValueScore(cheapSlow, ctx));
  });
});

describe('deduplication (§37)', () => {
  it('same flight from two providers keeps the cheaper', () => {
    const a = flight({ id: 'a', provider: 'p1', normalizedPrice: 300 });
    const b = flight({ id: 'b', provider: 'p2', normalizedPrice: 280 });
    const out = dedupe([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('b');
  });

  it('fuzzy fingerprint matches when flight number missing', () => {
    const a = flight({ id: 'a', flightNumber: '', normalizedPrice: 300 });
    const b = flight({ id: 'b', flightNumber: '', provider: 'p2', normalizedPrice: 310 });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it('different flights are kept apart', () => {
    const a = flight({ id: 'a' });
    const b = flight({ id: 'b', flightNumber: 'LY316', departureTime: '2026-10-12T15:00:00' });
    expect(dedupe([a, b])).toHaveLength(2);
  });
});
