/**
 * Provider registry with reliability-aware selection and fallback (§38, §70).
 *
 * Selection order weighs: static priority, recent success rate, latency and
 * rate-limit state. A provider failure is never fatal (§77) — the registry
 * falls through to the next provider. Results include which provider answered.
 */
import type { FlightSearchAdapter } from './adapter.js';
import type { FlightResult, ProviderHealth, SearchQuery } from '../core/types.js';
import { MockFlightProvider } from './mock.js';
import { FastFlightsAdapter } from './fastflights.js';
import { FliAdapter } from './fli.js';
import { SerpApiAdapter } from './serpapi.js';
import { AmadeusAdapter } from './amadeus.js';
import { getDatabase, type FlightDatabase } from '../db/database.js';

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

  /** Order adapters by static priority adjusted by observed reliability (§70). */
  private ordered(): FlightSearchAdapter[] {
    return [...this.adapters].sort((a, b) => {
      const ha = this.health(a.name);
      const hb = this.health(b.name);
      const scoreA = a.priority * (2 - ha.successRate) + (ha.rateLimited ? 500 : 0);
      const scoreB = b.priority * (2 - hb.successRate) + (hb.rateLimited ? 500 : 0);
      return scoreA - scoreB;
    });
  }

  /** Availability cache: probing (e.g. spawning python) costs time per query. */
  private availability = new Map<string, { at: number; ok: boolean }>();

  private async isAvailableCached(adapter: FlightSearchAdapter): Promise<boolean> {
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
    try {
      if (!(await this.isAvailableCached(adapter))) {
        return { provider: adapter.name, ok: false, error: 'unavailable', latencyMs: 0, results: [] };
      }
      const results = await withTimeout(adapter.search(query), PROVIDER_TIMEOUT_MS, adapter.name);
      const latencyMs = Date.now() - started;
      this.db.recordProviderRun(adapter.name, 'ok', latencyMs);
      return { provider: adapter.name, ok: true, latencyMs, results };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      this.db.recordProviderRun(adapter.name, 'error', latencyMs, message.slice(0, 500));
      this.db.logEvent('warn', 'provider_search_failed', { provider: adapter.name, message });
      return { provider: adapter.name, ok: false, error: message, latencyMs, results: [] };
    }
  }

  /**
   * Federated search: ALL live providers run in PARALLEL and their results are
   * merged (dedupe happens downstream, §37). Total latency = slowest single
   * provider, not the sum. Local/synthetic providers (mock) are used only when
   * every live source came back empty, so demo data never pollutes real data.
   */
  async search(query: SearchQuery): Promise<SearchOutcome> {
    const cacheKey = JSON.stringify(query);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const age = Date.now() - cached.at;
      if (age < CACHE_TTL_MS) return cached.outcome;
      if (age < STALE_TTL_MS) {
        // stale-while-revalidate: answer instantly, refresh in the background
        if (!this.refreshing.has(cacheKey)) {
          this.refreshing.add(cacheKey);
          void this.searchLive(query, cacheKey)
            .catch(() => {})
            .finally(() => this.refreshing.delete(cacheKey));
        }
        return cached.outcome;
      }
    }
    return this.searchLive(query, cacheKey);
  }

  private refreshing = new Set<string>();
  /** Request coalescing: identical concurrent searches share one live job. */
  private inflight = new Map<string, Promise<SearchOutcome>>();

  private searchLive(query: SearchQuery, cacheKey: string): Promise<SearchOutcome> {
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;
    const job = this.searchLiveInner(query, cacheKey).finally(() => this.inflight.delete(cacheKey));
    this.inflight.set(cacheKey, job);
    return job;
  }

  private async searchLiveInner(query: SearchQuery, cacheKey: string): Promise<SearchOutcome> {
    const ordered = this.ordered();
    const live = ordered.filter((a) => a.capabilities.liveNetwork);
    const local = ordered.filter((a) => !a.capabilities.liveNetwork);

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
  if (process.env.MOCK_PROVIDER === '1' || process.env.ALLOW_MOCK_FALLBACK === '1') {
    registry.register(new MockFlightProvider());
  }
  return registry;
}
