import { describe, it, expect, beforeAll } from 'vitest';
import { FlightDatabase } from '../src/db/database.js';
import { MockFlightProvider } from '../src/providers/mock.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { AnalysisService } from '../src/analyzer/service.js';
import { FlightAgent, buildQuery } from '../src/agent/agent.js';
import { evaluateRules } from '../src/alerts/engine.js';
import { nextInterval } from '../src/worker/monitor.js';
import { parseTripRequest } from '../src/agent/parser.js';
import { currencyService } from '../src/core/currency.js';
import type { FlightSearchAdapter } from '../src/providers/adapter.js';
import { ProviderError } from '../src/providers/adapter.js';

class FailingProvider implements FlightSearchAdapter {
  readonly name = 'failing';
  readonly priority = 1;
  readonly capabilities = { roundTrip: true, multiCity: false, flexibleDates: false, liveNetwork: true };
  async isAvailable() { return true; }
  async search(): Promise<never> {
    throw new ProviderError(this.name, 'simulated outage');
  }
}

describe('provider fallback chain (§70, §77)', () => {
  it('falls through failing provider to mock, recording both attempts', async () => {
    const db = new FlightDatabase(':memory:');
    const registry = new ProviderRegistry(db);
    registry.register(new FailingProvider());
    registry.register(new MockFlightProvider());
    const outcome = await registry.search(buildQuery({ origin: 'TLV', destination: 'LHR', departureDate: '2026-10-12' }));
    expect(outcome.provider).toBe('mock');
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.attempted.some((a) => a.provider === 'failing' && !a.ok)).toBe(true);
    // provider health recorded (§38)
    const health = registry.health('failing');
    expect(health.errorCount).toBeGreaterThan(0);
  });
});

describe('end-to-end acceptance flow (§82)', () => {
  let db: FlightDatabase;
  let agent: FlightAgent;

  beforeAll(() => {
    db = new FlightDatabase(':memory:');
    const registry = new ProviderRegistry(db);
    registry.register(new MockFlightProvider());
    agent = new FlightAgent(registry, new AnalysisService(db), db);
  });

  it('runs the full §82 flow: parse → matrix → search → score → rank', async () => {
    const report = await agent.run('אני רוצה לטוס מתל אביב לניו יורק, 7-14 ימים, בכל תאריך במהלך אוקטובר. תמצא לי את המחיר הכי נמוך שאתה יכול.');
    expect(report.request.origins).toContain('TLV');
    expect(report.totalQueries).toBeGreaterThan(3);
    expect(report.totalResults).toBeGreaterThan(0);
    expect(report.best).not.toBeNull();
    expect(report.best!.analysis.dealScore).toBeGreaterThanOrEqual(0);
    expect(report.best!.bookingUrl).toMatch(/^https:\/\/www\.google\.com\/travel\/flights/);
    expect(report.top.length).toBeGreaterThan(0);
    expect(report.top.length).toBeLessThanOrEqual(10);
    expect(report.dateMatrix!.some((c) => c.isLowest)).toBe(true);
    expect(report.disclaimer).toMatch(/available to us/);
    // history accumulated (§14)
    const route = `${report.best!.origin}-${report.best!.destination}`;
    expect(db.priceHistory(route).length).toBeGreaterThan(0);
  }, 30000);

  it('anywhere mode ranks multiple destinations (§31)', async () => {
    const report = await agent.run('לא אכפת לי לאן רק שיהיה זול, בספטמבר');
    expect(report.byDestination.length).toBeGreaterThan(3);
    const prices = report.byDestination.map((d) => d.best.normalizedPrice);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices); // sorted ascending
  }, 30000);
});

describe('alerts (§25)', () => {
  const mkFlight = (price: number, score: number) => ({
    normalizedPrice: price, normalizedCurrency: 'EUR',
    analysis: { dealScore: score, explanation: [], scoreBreakdown: {}, percentile: null, vsAverage: null, vsLowest: null, isExceptional: false, isErrorFareCandidate: false },
  }) as never;

  it('PRICE_BELOW triggers only under threshold', () => {
    const rule = { id: 1, savedSearchId: 1, kind: 'PRICE_BELOW' as const, threshold: 250, channels: ['console'], active: true, createdAt: '' };
    expect(evaluateRules([rule], [mkFlight(240, 50)], null)).toHaveLength(1);
    expect(evaluateRules([rule], [mkFlight(260, 50)], null)).toHaveLength(0);
  });

  it('DROP_PERCENT compares with previous low', () => {
    const rule = { id: 1, savedSearchId: 1, kind: 'DROP_PERCENT' as const, threshold: 20, channels: ['console'], active: true, createdAt: '' };
    expect(evaluateRules([rule], [mkFlight(160, 50)], 200)).toHaveLength(1); // -20%
    expect(evaluateRules([rule], [mkFlight(190, 50)], 200)).toHaveLength(0); // -5%
  });

  it('DEAL_SCORE_ABOVE triggers on high scores', () => {
    const rule = { id: 1, savedSearchId: 1, kind: 'DEAL_SCORE_ABOVE' as const, threshold: 90, channels: ['console'], active: true, createdAt: '' };
    expect(evaluateRules([rule], [mkFlight(300, 94)], null)).toHaveLength(1);
    expect(evaluateRules([rule], [mkFlight(300, 85)], null)).toHaveLength(0);
  });
});

describe('smart scheduling (§28)', () => {
  it('anomaly → 30 minutes', () => {
    expect(nextInterval(180, 180, null, true)).toBe(30);
  });
  it('falling price → tighter interval', () => {
    expect(nextInterval(180, 180, -0.1, false)).toBeLessThan(180);
  });
  it('stable price → relaxed interval, capped at 24h', () => {
    const next = nextInterval(180, 180, 0.0, false);
    expect(next).toBeGreaterThan(180);
    expect(nextInterval(1440, 1440, 0.01, false)).toBeLessThanOrEqual(1440);
  });
});

describe('currency normalization (§35)', () => {
  it('converts and keeps rate metadata', () => {
    const { value, rate } = currencyService.convert(100, 'USD', 'EUR');
    expect(rate).toBeGreaterThan(0.5);
    expect(rate).toBeLessThan(1.2);
    expect(value).toBeCloseTo(100 * rate, 1);
  });
  it('same-currency conversion is identity', () => {
    expect(currencyService.convert(100, 'EUR', 'EUR')).toMatchObject({ value: 100, rate: 1 });
  });
});

describe('malformed provider responses (§60)', () => {
  it('mock provider respects filters without crashing', async () => {
    const mock = new MockFlightProvider();
    const results = await mock.search(buildQuery({
      origin: 'TLV', destination: 'LHR', departureDate: '2026-10-12',
      stops: 'NON_STOP', maxPrice: 100000,
    }));
    expect(results.every((r) => r.stops === 0)).toBe(true);
  });
});
