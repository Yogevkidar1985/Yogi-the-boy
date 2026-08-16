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
import { getDatabase, type FlightDatabase } from '../db/database.js';

export interface SearchOutcome {
  results: FlightResult[];
  provider: string;
  attempted: { provider: string; ok: boolean; error?: string; latencyMs: number }[];
}

const CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_MINUTES ?? 10) * 60_000;

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

  /**
   * Search with fallback chain. Tries providers in reliability order until one
   * returns results; records every attempt for provider health tracking.
   */
  async search(query: SearchQuery): Promise<SearchOutcome> {
    const cacheKey = JSON.stringify(query);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.outcome;
    }
    const attempted: SearchOutcome['attempted'] = [];
    for (const adapter of this.ordered()) {
      const started = Date.now();
      try {
        if (!(await adapter.isAvailable())) {
          attempted.push({ provider: adapter.name, ok: false, error: 'unavailable', latencyMs: 0 });
          continue;
        }
        const results = await adapter.search(query);
        const latencyMs = Date.now() - started;
        this.db.recordProviderRun(adapter.name, 'ok', latencyMs);
        attempted.push({ provider: adapter.name, ok: true, latencyMs });
        if (results.length > 0) {
          const outcome = { results, provider: adapter.name, attempted };
          if (this.cache.size > 500) this.cache.clear();
          this.cache.set(cacheKey, { at: Date.now(), outcome });
          return outcome;
        }
      } catch (err) {
        const latencyMs = Date.now() - started;
        const message = err instanceof Error ? err.message : String(err);
        this.db.recordProviderRun(adapter.name, 'error', latencyMs, message.slice(0, 500));
        this.db.logEvent('warn', 'provider_search_failed', { provider: adapter.name, message });
        attempted.push({ provider: adapter.name, ok: false, error: message, latencyMs });
      }
    }
    return { results: [], provider: 'none', attempted };
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
  if (process.env.MOCK_PROVIDER === '1' || process.env.ALLOW_MOCK_FALLBACK === '1') {
    registry.register(new MockFlightProvider());
  }
  return registry;
}
