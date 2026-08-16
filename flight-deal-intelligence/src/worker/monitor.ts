/**
 * Monitoring worker (§27-§28): every saved search with monitor=on is re-run on
 * its interval; smart scheduling adapts the interval to price movement:
 *   stable → slow down (up to 24h), dropping → speed up (down to 30m on anomaly).
 *
 * Runs as a plain Node loop (no Redis required); with REDIS_URL set the same
 * jobs can be moved onto a queue without touching the logic (§53).
 */
import { getDatabase } from '../db/database.js';
import { buildDefaultRegistry } from '../providers/registry.js';
import { AnalysisService } from '../analyzer/service.js';
import { AlertEngine, evaluateRules } from '../alerts/engine.js';
import { routeKey, type SavedSearch } from '../core/types.js';
import { currencyService } from '../core/currency.js';

const MIN_INTERVAL_MIN = 30;
const MAX_INTERVAL_MIN = 24 * 60;

export function nextInterval(
  baseMinutes: number,
  currentMinutes: number,
  priceChangeRatio: number | null,
  anomaly: boolean
): number {
  if (anomaly) return MIN_INTERVAL_MIN; // §28: major anomaly → every 30m
  if (priceChangeRatio === null) return baseMinutes;
  if (priceChangeRatio <= -0.05) {
    // price falling → tighten to at least half the base, min 60m
    return Math.max(60, Math.min(currentMinutes, Math.round(baseMinutes / 3)));
  }
  if (Math.abs(priceChangeRatio) < 0.02) {
    // stable → relax up to 2x base, capped at 24h
    return Math.min(MAX_INTERVAL_MIN, Math.round(Math.min(currentMinutes * 1.5, baseMinutes * 2)));
  }
  return baseMinutes;
}

export class MonitorWorker {
  private db = getDatabase();
  private registry = buildDefaultRegistry(this.db);
  private analysis = new AnalysisService(this.db);
  private alerts = new AlertEngine();
  private timer: NodeJS.Timeout | null = null;

  /** Run every saved search whose interval has elapsed. */
  async tick(): Promise<{ ran: number; alertsSent: number }> {
    await currencyService.refresh();
    let ran = 0;
    let alertsSent = 0;
    for (const search of this.db.listSavedSearches()) {
      if (!search.monitor) continue;
      const interval = search.adaptiveIntervalMinutes ?? search.intervalMinutes;
      const due =
        !search.lastRunAt ||
        Date.now() - Date.parse(search.lastRunAt + 'Z') >= interval * 60000;
      if (!due) continue;
      try {
        alertsSent += await this.runSearch(search);
        ran++;
      } catch (err) {
        this.db.logEvent('error', 'monitor_run_failed', {
          searchId: search.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.db.applyRetention();
    return { ran, alertsSent };
  }

  private async runSearch(search: SavedSearch): Promise<number> {
    const started = Date.now();
    const outcome = await this.registry.search(search.query);
    const scored = this.analysis.analyze(outcome.results);
    const lowest = scored.length ? Math.min(...scored.map((s) => s.normalizedPrice)) : null;

    this.db.db
      .prepare(
        `INSERT INTO search_runs (saved_search_id, provider, status, result_count, lowest_price, latency_ms)
         VALUES (?,?,?,?,?,?)`
      )
      .run(
        search.id, outcome.provider, scored.length ? 'ok' : 'empty',
        scored.length, lowest, Date.now() - started
      );

    // price movement vs previous run → smart scheduling (§28)
    const changeRatio =
      lowest !== null && search.lastLowestPrice
        ? (lowest - search.lastLowestPrice) / search.lastLowestPrice
        : null;
    const anomaly = scored.some((s) => s.analysis.isExceptional);
    const newInterval = nextInterval(
      search.intervalMinutes,
      search.adaptiveIntervalMinutes ?? search.intervalMinutes,
      changeRatio,
      anomaly
    );
    this.db.updateSavedSearchRun(search.id, lowest, newInterval);

    // alerts (§25)
    const rules = this.db.listAlerts(search.id);
    const triggered = evaluateRules(rules, scored, search.lastLowestPrice);
    await this.alerts.dispatch(triggered);
    return triggered.length;
  }

  start(pollSeconds = 60): void {
    console.log(`[worker] monitoring loop started (poll every ${pollSeconds}s)`);
    const loop = async () => {
      const { ran, alertsSent } = await this.tick();
      if (ran > 0) console.log(`[worker] ran ${ran} searches, sent ${alertsSent} alerts`);
    };
    void loop();
    this.timer = setInterval(() => void loop(), pollSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

// entrypoint: `npm run worker`
if (import.meta.url === `file://${process.argv[1]}`) {
  new MonitorWorker().start(Number(process.env.WORKER_POLL_SECONDS ?? 60));
}
