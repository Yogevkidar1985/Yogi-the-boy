/**
 * Provider registry with reliability-aware selection and fallback (§38, §70).
 *
 * Selection order weighs: static priority, recent success rate, latency and
 * rate-limit state. A provider failure is never fatal (§77) — the registry
 * falls through to the next provider. Results include which provider answered.
 */
import type { FlightSearchAdapter, ProviderStatus } from './adapter.js';
import type { FlightResult, ProviderHealth, SearchQuery } from '../core/types.js';
import { MockFlightProvider } from './mock.js';
import { FastFlightsAdapter } from './fastflights.js';
import { FliAdapter } from './fli.js';
import { SerpApiAdapter } from './serpapi.js';
import { AmadeusAdapter } from './amadeus.js';
import { DuffelAdapter } from './duffel.js';
import { KiwiAdapter } from './kiwi.js';
import { getDatabase, type FlightDatabase } from '../db/database.js';
import { routeKey } from '../core/types.js';
import { configFor, ProviderRateLimiter } from './config.js';

export interface SearchOutcome {
  results: FlightResult[];
  provider: string;
  attempted: { provider: string; ok: boolean; error?: string; latencyMs: number }[];
}

const CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_MINUTES ?? 10) * 60_000;
/** Serve a stale cache hit (and refresh in the background) up to this age. */
const STALE_TTL_MS = Number(process.env.SEARCH_STALE_MINUTES ?? 45) * 60_000;
/** Hard cap per provider so one hung source never stalls the whole search. */
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_SECONDS ?? 45) * 1000;
/** Circuit breaker: consecutive failures before a provider is skipped. */
const BREAKER_THRESHOLD = Number(process.env.BREAKER_THRESHOLD ?? 3);
/** How long an open circuit stays closed to traffic before one trial call. */
const BREAKER_COOLDOWN_MS = Number(process.env.BREAKER_COOLDOWN_MINUTES ?? 5) * 60_000;
/** Daily cap on paid-provider requests so a wide scan can't burn quota. */
const PAID_DAILY_BUDGET = Number(process.env.PAID_REQUESTS_PER_DAY ?? 400);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export class ProviderRegistry {
  private adapters: FlightSearchAdapter[] = [];
  /** Identical-search cache (§55): avoids hammering providers on repeats. */
  private cache = new Map<string, { at: number; outcome: SearchOutcome }>();

  constructor(private db: FlightDatabase = getDatabase()) {}

  register(adapter: FlightSearchAdapter): void {
    this.adapters.push(adapter);
    this.db.db
      .prepare(`INSERT OR IGNORE INTO providers (name, kind, priority) VALUES (?,?,?)`)
      .run(adapter.name, adapter.capabilities.liveNetwork ? 'live' : 'local', adapter.priority);
  }

  list(): FlightSearchAdapter[] {
    return [...this.adapters];
  }

  health(name: string): ProviderHealth {
    const s = this.db.providerStats(name);
    const total = s.successCount + s.errorCount;
    const successRate = total === 0 ? 1 : s.successCount / total;
    return {
      provider: name,
      successCount: s.successCount,
      errorCount: s.errorCount,
      successRate,
      avgLatencyMs: s.avgLatencyMs,
      lastSuccessAt: s.lastSuccessAt,
      lastErrorAt: s.lastErrorAt,
      lastError: s.lastError,
      rateLimited: /rate.?limit|429/i.test(s.lastError ?? ''),
      available: successRate > 0.1 || total === 0,
      confidence: successRate * (total > 0 ? Math.min(1, total / 5) : 0.5),
    };
  }

  /**
   * Order adapters by static priority adjusted by observed reliability (§70)
   * and, when a route is given, by learned per-route usefulness (V4 §20):
   * providers that historically deliver results on this exact route run first.
   */
  private ordered(route?: string): FlightSearchAdapter[] {
    const routeBoost = new Map<string, number>();
    if (route) {
      for (const s of this.db.providerRouteStats(route)) {
        if (s.runs >= 2) {
          const hitRate = s.okRuns / s.runs;
          const yieldRate = s.resultsSum / Math.max(1, s.okRuns);
          routeBoost.set(s.provider, hitRate * Math.min(5, yieldRate));
        }
      }
    }
    return [...this.adapters].sort((a, b) => {
      const ha = this.health(a.name);
      const hb = this.health(b.name);
      const scoreA = a.priority * (2 - ha.successRate) + (ha.rateLimited ? 500 : 0) - (routeBoost.get(a.name) ?? 0) * 3;
      const scoreB = b.priority * (2 - hb.successRate) + (hb.rateLimited ? 500 : 0) - (routeBoost.get(b.name) ?? 0) * 3;
      return scoreA - scoreB;
    });
  }

  /** Availability cache: probing (e.g. spawning python) costs time per query. */
  private availability = new Map<string, { at: number; ok: boolean }>();

  /** Circuit breaker state per provider (V4 §79). */
  private breaker = new Map<string, { fails: number; openedAt: number | null }>();

  /** Per-provider rate limiter + concurrency gate (§23). */
  private limiters = new Map<string, ProviderRateLimiter>();
  private limiter(name: string): ProviderRateLimiter {
    let l = this.limiters.get(name);
    if (!l) {
      l = new ProviderRateLimiter(configFor(name));
      this.limiters.set(name, l);
    }
    return l;
  }

  /** Rate-limit state for the provider dashboard. */
  rateStats(name: string): ReturnType<ProviderRateLimiter['stats']> {
    return this.limiter(name).stats();
  }

  private breakerState(name: string): 'closed' | 'open' | 'half-open' {
    const b = this.breaker.get(name);
    if (!b || b.openedAt === null) return 'closed';
    return Date.now() - b.openedAt >= BREAKER_COOLDOWN_MS ? 'half-open' : 'open';
  }

  private recordOutcome(name: string, ok: boolean): void {
    const b = this.breaker.get(name) ?? { fails: 0, openedAt: null };
    if (ok) {
      b.fails = 0;
      b.openedAt = null; // half-open trial succeeded → close the circuit
    } else {
      b.fails += 1;
      if (b.fails >= BREAKER_THRESHOLD) b.openedAt = Date.now();
    }
    this.breaker.set(name, b);
  }

  /** Today's paid-provider request count vs the daily budget (V4 §82). */
  private paidBudgetLeft(): number {
    const paid = this.adapters
      .filter((a) => a.costTier === 'PAID' || a.costTier === 'PREMIUM')
      .map((a) => a.name);
    if (!paid.length) return PAID_DAILY_BUDGET;
    const row = this.db.db
      .prepare(
        `SELECT COUNT(*) AS n FROM provider_runs
         WHERE provider IN (${paid.map(() => '?').join(',')}) AND ran_at >= date('now')`
      )
      .get(...paid) as { n: number };
    return Math.max(0, PAID_DAILY_BUDGET - row.n);
  }

  /** Operational status for dashboards — computed, never hard-coded (V4 §8). */
  status(name: string): ProviderStatus {
    const adapter = this.adapters.find((a) => a.name === name);
    if (!adapter) return 'UNKNOWN';
    if (!configFor(name).enabled) return 'DISABLED';
    const avail = this.availability.get(name);
    if (avail && !avail.ok) return 'DISABLED';
    const state = this.breakerState(name);
    if (state === 'open') return 'CIRCUIT_OPEN';
    const h = this.health(name);
    if (h.rateLimited) return 'RATE_LIMITED';
    if (/auth|401|403/i.test(h.lastError ?? '') && h.successCount === 0) return 'AUTH_ERROR';
    if (h.successCount + h.errorCount === 0) return avail?.ok ? 'ACTIVE' : 'UNKNOWN';
    if (h.successRate < 0.5) return 'DEGRADED';
    return 'ACTIVE';
  }

  private async isAvailableCached(adapter: FlightSearchAdapter): Promise<boolean> {
    // feature flag wins over everything: a disabled provider is never called
    if (!configFor(adapter.name).enabled) return false;
    const cached = this.availability.get(adapter.name);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.ok;
    const ok = await adapter.isAvailable();
    this.availability.set(adapter.name, { at: Date.now(), ok });
    return ok;
  }

  private async tryOne(
    adapter: FlightSearchAdapter,
    query: SearchQuery
  ): Promise<{ provider: string; ok: boolean; error?: string; latencyMs: number; results: FlightResult[] }> {
    const started = Date.now();
    // circuit breaker: open circuits are skipped instantly; after the cooldown
    // one half-open trial call is allowed through to test recovery (V4 §79)
    if (this.breakerState(adapter.name) === 'open') {
      return { provider: adapter.name, ok: false, error: 'circuit open (cooling down)', latencyMs: 0, results: [] };
    }
    try {
      if (!(await this.isAvailableCached(adapter))) {
        return { provider: adapter.name, ok: false, error: 'unavailable', latencyMs: 0, results: [] };
      }
      const cfg = configFor(adapter.name);
      const timeoutMs = cfg.timeoutMs ?? adapter.timeoutMs ?? PROVIDER_TIMEOUT_MS;
      // rate limiter: never exceed the provider's agreed request budget
      const results = await this.limiter(adapter.name).run(() =>
        withTimeout(adapter.search(query), timeoutMs, adapter.name)
      );
      const latencyMs = Date.now() - started;
      this.db.recordProviderRun(adapter.name, 'ok', latencyMs);
      this.recordOutcome(adapter.name, true);
      this.db.recordProviderRouteRun(
        adapter.name,
        routeKey(query.origin, query.destination),
        true,
        results.length,
        results.length ? Math.min(...results.map((r) => r.normalizedPrice)) : null
      );
      return { provider: adapter.name, ok: true, latencyMs, results };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      this.db.recordProviderRun(adapter.name, 'error', latencyMs, message.slice(0, 500));
      this.db.logEvent('warn', 'provider_search_failed', { provider: adapter.name, message });
      this.recordOutcome(adapter.name, false);
      this.db.recordProviderRouteRun(adapter.name, routeKey(query.origin, query.destination), false, 0, null);
      return { provider: adapter.name, ok: false, error: message, latencyMs, results: [] };
    }
  }

  /**
   * Federated search: ALL live providers run in PARALLEL and their results are
   * merged (dedupe happens downstream, §37). Total latency = slowest single
   * provider, not the sum. Local/synthetic providers (mock) are used only when
   * every live source came back empty, so demo data never pollutes real data.
   */
  async search(query: SearchQuery, opts: { fresh?: boolean } = {}): Promise<SearchOutcome> {
    const cacheKey = JSON.stringify(query);
    // verification: never serve cache, and always allow paid sources
    if (opts.fresh) return this.searchLive(query, cacheKey, true);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const age = Date.now() - cached.at;
      if (age < CACHE_TTL_MS) return cached.outcome;
      if (age < STALE_TTL_MS) {
        // stale-while-revalidate: answer instantly, refresh in the background
        if (!this.refreshing.has(cacheKey)) {
          this.refreshing.add(cacheKey);
          void this.searchLive(query, cacheKey, false)
            .catch(() => {})
            .finally(() => this.refreshing.delete(cacheKey));
        }
        return cached.outcome;
      }
    }
    return this.searchLive(query, cacheKey, false);
  }

  private refreshing = new Set<string>();
  /** Request coalescing: identical concurrent searches share one live job. */
  private inflight = new Map<string, Promise<SearchOutcome>>();

  private searchLive(query: SearchQuery, cacheKey: string, alwaysPaid: boolean): Promise<SearchOutcome> {
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;
    const job = this.searchLiveInner(query, cacheKey, alwaysPaid).finally(() => this.inflight.delete(cacheKey));
    this.inflight.set(cacheKey, job);
    return job;
  }

  private async searchLiveInner(query: SearchQuery, cacheKey: string, alwaysPaid: boolean): Promise<SearchOutcome> {
    const ordered = this.ordered(routeKey(query.origin, query.destination));
    // cost-aware search (V4 §82-§83): when the daily paid budget is spent,
    // discovery continues on free sources; verification still may use paid.
    const paidAllowed = alwaysPaid || this.paidBudgetLeft() > 0;
    const usable = ordered.filter(
      (a) => paidAllowed || (a.costTier !== 'PAID' && a.costTier !== 'PREMIUM')
    );
    const live = usable.filter((a) => a.capabilities.liveNetwork);
    const local = usable.filter((a) => !a.capabilities.liveNetwork);

    const liveOutcomes = await Promise.all(live.map((a) => this.tryOne(a, query)));
    const attempted: SearchOutcome['attempted'] = liveOutcomes.map(({ results, ...rest }) => rest);
    let results: FlightResult[] = liveOutcomes.flatMap((o) => o.results);

    if (results.length === 0) {
      for (const adapter of local) {
        const outcome = await this.tryOne(adapter, query);
        const { results: r, ...rest } = outcome;
        attempted.push(rest);
        if (r.length) {
          results = r;
          break;
        }
      }
    }

    const successful = attempted.filter((a, i) =>
      a.ok && (i < liveOutcomes.length ? liveOutcomes[i]!.results.length > 0 : results.length > 0)
    );
    const outcome: SearchOutcome = {
      results,
      provider: successful.length ? successful.map((a) => a.provider).join('+') : 'none',
      attempted,
    };
    if (results.length > 0) {
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(cacheKey, { at: Date.now(), outcome });
    }
    return outcome;
  }
}

/**
 * Build the default registry (§70 priority: fast-flights → fli → mock).
 * Mock joins only when MOCK_PROVIDER=1 or no live provider is reachable
 * AND ALLOW_MOCK_FALLBACK=1 — never silently in production (§61, §77).
 */
export function buildDefaultRegistry(db?: FlightDatabase): ProviderRegistry {
  const registry = new ProviderRegistry(db);
  registry.register(new FastFlightsAdapter());
  registry.register(new FliAdapter());
  registry.register(new SerpApiAdapter()); // active when SERPAPI_API_KEY is set
  registry.register(new AmadeusAdapter()); // active when AMADEUS_CLIENT_ID/SECRET are set
  registry.register(new DuffelAdapter()); // active when DUFFEL_API_TOKEN is set
  registry.register(new KiwiAdapter()); // active when KIWI_API_KEY is set
  if (process.env.MOCK_PROVIDER === '1' || process.env.ALLOW_MOCK_FALLBACK === '1') {
    registry.register(new MockFlightProvider());
  }
  return registry;
}
