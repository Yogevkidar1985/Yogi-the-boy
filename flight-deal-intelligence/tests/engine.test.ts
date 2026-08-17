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

describe('smart alerts: filters, cooldown, quiet hours', () => {
  const mkFlight = (price: number, opts: { stops?: number; airline?: string; depHour?: number } = {}) => ({
    normalizedPrice: price, normalizedCurrency: 'EUR',
    stops: opts.stops ?? 0, airline: opts.airline ?? 'LY', cabin: 'ECONOMY',
    departureTime: `2026-10-12T${String(opts.depHour ?? 9).padStart(2, '0')}:00`,
    analysis: { dealScore: 50, explanation: [], scoreBreakdown: {}, percentile: null, vsAverage: null, vsLowest: null, isExceptional: false, isErrorFareCandidate: false },
  }) as never;
  const base = { id: 1, savedSearchId: 1, kind: 'PRICE_BELOW' as const, threshold: 250, channels: ['console'], active: true, createdAt: '' };

  it('maxStops filter blocks connecting flights from triggering', () => {
    const rule = { ...base, filters: { maxStops: 0 } };
    expect(evaluateRules([rule], [mkFlight(200, { stops: 1 })], null)).toHaveLength(0);
    expect(evaluateRules([rule], [mkFlight(200, { stops: 0 })], null)).toHaveLength(1);
  });

  it('airline filter only fires for the watched airline', () => {
    const rule = { ...base, filters: { airlines: ['W6'] } };
    expect(evaluateRules([rule], [mkFlight(200, { airline: 'LY' })], null)).toHaveLength(0);
    expect(evaluateRules([rule], [mkFlight(200, { airline: 'W6' })], null)).toHaveLength(1);
  });

  it('departure-hour window filters flights outside it', () => {
    const rule = { ...base, filters: { depHours: [5, 12] as [number, number] } };
    expect(evaluateRules([rule], [mkFlight(200, { depHour: 20 })], null)).toHaveLength(0);
    expect(evaluateRules([rule], [mkFlight(200, { depHour: 8 })], null)).toHaveLength(1);
  });

  it('cooldown silences a rule that fired recently', () => {
    const now = new Date('2026-10-12T10:00:00Z');
    const recent = { ...base, cooldownMinutes: 360, lastTriggeredAt: '2026-10-12T08:00:00Z' };
    const old = { ...base, cooldownMinutes: 360, lastTriggeredAt: '2026-10-11T10:00:00Z' };
    expect(evaluateRules([recent], [mkFlight(200)], null, now)).toHaveLength(0);
    expect(evaluateRules([old], [mkFlight(200)], null, now)).toHaveLength(1);
  });

  it('quiet hours hold alerts back, including windows wrapping midnight', () => {
    const rule = { ...base, quietHours: [21, 5] as [number, number] };
    expect(evaluateRules([rule], [mkFlight(200)], null, new Date('2026-10-12T23:00:00Z'))).toHaveLength(0);
    expect(evaluateRules([rule], [mkFlight(200)], null, new Date('2026-10-12T03:00:00Z'))).toHaveLength(0);
    expect(evaluateRules([rule], [mkFlight(200)], null, new Date('2026-10-12T12:00:00Z'))).toHaveLength(1);
  });
});

describe('watched flights (favorites with a target price)', () => {
  it('round-trips a watch and syncs price + trigger state', () => {
    const db = new FlightDatabase(':memory:');
    const searchId = db.createSavedSearch('TLV-ATH', buildQuery({ origin: 'TLV', destination: 'ATH', departureDate: '2026-10-05' }), true, 180);
    const id = db.createWatchedFlight({
      savedSearchId: searchId, route: 'TLV-ATH', origin: 'TLV', destination: 'ATH',
      departureDate: '2026-10-05', airline: 'A3', priceAtSave: 220, currency: 'EUR', targetPrice: 180,
    });
    let w = db.getWatchedFlight(id)!;
    expect(w.targetPrice).toBe(180);
    expect(w.active).toBe(true);
    expect(w.triggeredAt).toBeNull();

    db.updateWatchedFlight(id, { lastPrice: 175, triggered: true });
    w = db.getWatchedFlight(id)!;
    expect(w.lastPrice).toBe(175);
    expect(w.triggeredAt).not.toBeNull();

    expect(db.watchesForSearch(searchId)).toHaveLength(1);
    db.deleteWatchedFlight(id);
    expect(db.listWatchedFlights()).toHaveLength(0);
    // the monitor existed only for this watch → cleaned up with it
    expect(db.getSavedSearch(searchId)).toBeUndefined();
  });
});

describe('provider circuit breaker + route learning (V4)', () => {
  it('opens the circuit after repeated failures and skips the provider', async () => {
    const db = new FlightDatabase(':memory:');
    const registry = new ProviderRegistry(db);
    registry.register(new FailingProvider());
    registry.register(new MockFlightProvider());
    const q = buildQuery({ origin: 'TLV', destination: 'ATH', departureDate: '2026-11-01' });
    // 3 distinct fresh searches → 3 failures → circuit opens
    for (let i = 1; i <= 3; i++) {
      await registry.search(buildQuery({ origin: 'TLV', destination: 'ATH', departureDate: `2026-11-0${i}` }), { fresh: true });
    }
    expect(registry.status('failing')).toBe('CIRCUIT_OPEN');
    const outcome = await registry.search(q, { fresh: true });
    const failingAttempt = outcome.attempted.find((a) => a.provider === 'failing');
    expect(failingAttempt?.error).toMatch(/circuit open/);
    expect(outcome.results.length).toBeGreaterThan(0); // mock still answers
  });

  it('learns per-route provider performance', async () => {
    const db = new FlightDatabase(':memory:');
    const registry = new ProviderRegistry(db);
    registry.register(new MockFlightProvider());
    await registry.search(buildQuery({ origin: 'TLV', destination: 'LHR', departureDate: '2026-11-05' }), { fresh: true });
    const stats = db.providerRouteStats('TLV-LHR');
    expect(stats).toHaveLength(1);
    expect(stats[0]!.okRuns).toBe(1);
    expect(stats[0]!.resultsSum).toBeGreaterThan(0);
    expect(stats[0]!.lowestPrice).toBeGreaterThan(0);
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
