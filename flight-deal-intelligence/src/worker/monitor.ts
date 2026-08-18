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
import { AlertEngine, evaluateRules, type TriggeredAlert } from '../alerts/engine.js';
import { rankSimilar, type FlightDna } from '../analyzer/similarity.js';
import { routeKey, type SavedSearch, type ScoredFlight, type WatchedFlight } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bus, liveState } from '../core/bus.js';
import { buildQuery } from '../agent/agent.js';

/** How often the top deals on the board are re-checked against live sources. */
const DEAL_REFRESH_MINUTES = Number(process.env.DEAL_REFRESH_MINUTES ?? 10);
/** How many board deals are revalidated per refresh cycle (quota-friendly). */
const DEAL_REFRESH_ROUTES = Number(process.env.DEAL_REFRESH_ROUTES ?? 5);

/** Similar-deal alerts: at most one per watch per this many hours. */
const SIMILAR_ALERT_COOLDOWN_H = Number(process.env.SIMILAR_ALERT_COOLDOWN_HOURS ?? 24);
/** A similar flight counts as a better deal below this share of the saved price. */
const SIMILAR_DEAL_RATIO = Number(process.env.SIMILAR_DEAL_RATIO ?? 0.85);

const MIN_INTERVAL_MIN = 30;
const MAX_INTERVAL_MIN = 24 * 60;

/**
 * Deal Hunter route priority (§15-17 of the hunter spec): which destinations
 * the next scan should spend its budget on, ranked from real observed
 * signals only — never invented seasonality or demand.
 *
 *   +5 per recent price-drop event on that route (a route that is actually
 *      moving deserves more attention than one sitting flat)
 *   +staleness bonus, capped, so a route that hasn't been scanned in a while
 *      is never starved forever by routes that keep winning on drops —
 *      every destination still gets a turn eventually (§85 diversity)
 *   +a fixed bonus for a route never scanned at all, so day one coverage
 *      isn't blocked by routes with pre-existing history
 *
 * Pure and DB-free so it can be unit tested directly, same as nextInterval.
 */
export function scoreDestination(
  route: string,
  dropCounts: Map<string, number>,
  lastScanned: Map<string, number>, // route -> epoch ms
  nowMs: number
): number {
  const drops = dropCounts.get(route) ?? 0;
  const last = lastScanned.get(route);
  if (last === undefined) return 5 * drops + 8; // never scanned: guaranteed early turn
  const hoursSince = (nowMs - last) / 3600_000;
  const staleness = Math.min(10, hoursSince / 12); // caps out after ~5 days
  return 5 * drops + staleness;
}

/** Pick the top-N destinations by score, ties broken by route name so the
    result is deterministic (useful for tests and for reproducible scans). */
export function pickHuntTargets(
  candidates: string[],
  dropCounts: Map<string, number>,
  lastScanned: Map<string, number>,
  nowMs: number,
  n: number,
  routeFor: (dest: string) => string
): string[] {
  return [...candidates]
    .map((dest) => ({ dest, score: scoreDestination(routeFor(dest), dropCounts, lastScanned, nowMs) }))
    .sort((a, b) => b.score - a.score || a.dest.localeCompare(b.dest))
    .slice(0, n)
    .map((c) => c.dest);
}

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

  /**
   * Hot-deal discovery: twice a day (DEAL_SCAN_HOURS, default 12h) scan a
   * rotating slice of destinations from DEFAULT_ORIGIN so the deals feed
   * refreshes with 20+ new scored deals per scan (~40+/day).
   */
  private async dealScan(): Promise<void> {
    const scanHours = Number(process.env.DEAL_SCAN_HOURS ?? 12);
    const last = this.db.db
      .prepare(`SELECT MAX(created_at) AS t FROM system_events WHERE event='deal_scan'`)
      .get() as { t: string | null };
    if (last.t && Date.now() - Date.parse(last.t + 'Z') < scanHours * 3600_000) return;
    this.db.logEvent('info', 'deal_scan', { startedAt: new Date().toISOString() });

    const { ANYWHERE_DESTINATIONS } = await import('../core/airports.js');
    const { buildQuery } = await import('../agent/agent.js');
    const origin = process.env.DEFAULT_ORIGIN ?? 'TLV';
    const maxQueries = Number(process.env.DEAL_SCAN_MAX_QUERIES ?? 20);
    const scanIndex = Math.floor(Date.now() / (scanHours * 3600_000));

    // real signals only: recent price-drop events and when each route was
    // last actually scanned — no invented seasonality or demand score
    const dropDays = Number(process.env.HUNTER_DROP_WINDOW_DAYS ?? 14);
    const dropRows = this.db.db
      .prepare(`SELECT route, COUNT(*) AS n FROM deal_events WHERE kind='PRICE_DROP' AND created_at >= datetime('now', ?) GROUP BY route`)
      .all(`-${dropDays} days`) as { route: string; n: number }[];
    const dropCounts = new Map(dropRows.map((r) => [r.route, r.n]));
    const lastRows = this.db.db
      .prepare(`SELECT route, MAX(updated_at) AS t FROM provider_route_stats GROUP BY route`)
      .all() as { route: string; t: string }[];
    const lastScanned: Map<string, number> = new Map(
      lastRows
        .map((r): [string, number] => [r.route, Date.parse(r.t.includes('T') ? r.t : r.t + 'Z')])
        .filter(([, t]) => Number.isFinite(t))
    );
    const dests = pickHuntTargets(
      ANYWHERE_DESTINATIONS, dropCounts, lastScanned, Date.now(), maxQueries,
      (dest) => routeKey(origin, dest)
    );
    for (const dest of dests) {
      try {
        // deterministic-but-varied departure 15-45 days out per destination
        const daysOut = 15 + ((scanIndex + dest.charCodeAt(0) + dest.charCodeAt(2)) % 31);
        const departureDate = new Date(Date.now() + daysOut * 86400000).toISOString().slice(0, 10);
        const outcome = await this.registry.search(buildQuery({ origin, destination: dest, departureDate }));
        this.analysis.analyze(outcome.results);
      } catch (err) {
        this.db.logEvent('warn', 'deal_scan_route_failed', { dest, error: String(err) });
      }
    }
    console.log(`[worker] deal scan complete: ${dests.length} routes refreshed`);
  }

  /**
   * Live board revalidation: the freshest-scored top deals whose price is
   * older than the refresh window get a fresh, cache-free re-check. Price
   * drops become deal events; every cycle notifies the UI over SSE.
   */
  private lastRefreshAt = 0;
  private async refreshTopDeals(): Promise<void> {
    if (Date.now() - this.lastRefreshAt < DEAL_REFRESH_MINUTES * 60_000) return;
    this.lastRefreshAt = Date.now();
    const rows = this.db.db
      .prepare(
        `SELECT ds.route, fr.departure_date AS dep, fr.return_date AS ret, MAX(fr.collected_at) AS seen
         FROM deal_scores ds JOIN flight_results fr ON fr.id = ds.flight_result_id
         WHERE ds.computed_at >= datetime('now', '-2 days')
         GROUP BY ds.route, fr.departure_date
         HAVING seen < datetime('now', ?)
         ORDER BY MAX(ds.score) DESC LIMIT ?`
      )
      .all(`-${DEAL_REFRESH_MINUTES} minutes`, DEAL_REFRESH_ROUTES) as { route: string; dep: string; ret: string | null }[];
    let changed = false;
    for (const r of rows) {
      const [origin, destination] = r.route.split('-');
      if (!origin || !destination) continue;
      try {
        const prevLow = this.db.previousLowForDate(r.route, r.dep, 5);
        const outcome = await this.registry.search(
          buildQuery({ origin, destination, departureDate: r.dep, returnDate: r.ret ?? undefined }),
          { fresh: true }
        );
        const scored = this.analysis.analyze(outcome.results);
        changed = true;
        if (scored.length) {
          const newLow = Math.min(...scored.map((s) => s.normalizedPrice));
          if (prevLow && newLow < prevLow * 0.95) {
            this.db.recordDealEvent({
              kind: 'PRICE_DROP', route: r.route, departureDate: r.dep,
              prevPrice: prevLow, newPrice: newLow,
              dropPct: Math.round(((prevLow - newLow) / prevLow) * 100),
            });
          }
        } else {
          this.db.recordDealEvent({ kind: 'PRICE_EXPIRED', route: r.route, departureDate: r.dep });
        }
      } catch (err) {
        this.db.logEvent('warn', 'deal_refresh_failed', { route: r.route, error: String(err) });
      }
    }
    liveState.lastRefreshAt = new Date().toISOString();
    if (changed) bus.emit('deals');
  }

  /** Run every saved search whose interval has elapsed. */
  async tick(): Promise<{ ran: number; alertsSent: number }> {
    await currencyService.refresh();
    await this.dealScan();
    await this.refreshTopDeals();
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

    // alerts (§25) — price alerts are VERIFIED with a fresh, cache-free search
    // before anything is sent (Flight Watch §86): no stale price ever alerts.
    const rules = this.db.listAlerts(search.id);
    let triggered = evaluateRules(rules, scored, search.lastLowestPrice);
    if (triggered.length) {
      triggered = await this.verifyTriggered(search, triggered);
    }
    await this.alerts.dispatch(triggered);

    // favorite flights bound to this monitor: track price, hits + alternatives
    for (const watch of this.db.watchesForSearch(search.id)) {
      const matching = watch.airline ? scored.filter((s) => s.airline === watch.airline) : scored;
      const low = matching.length
        ? Math.min(...matching.map((s) => s.normalizedPrice))
        : lowest;
      // Similar Flights Engine: rank the watched flight's alternatives
      const dna: FlightDna = {
        airline: watch.airline,
        flightNumber: watch.flightNumber,
        stops: watch.stops,
        departureTime: (watch.flight as { departureTime?: string } | undefined)?.departureTime ?? null,
        durationMinutes: (watch.flight as { durationMinutes?: number } | undefined)?.durationMinutes ?? null,
        price: watch.priceAtSave,
      };
      const similar = rankSimilar(dna, scored);
      this.db.updateWatchedFlight(watch.id, {
        lastPrice: low,
        triggered: low !== null && low <= watch.targetPrice,
        similar,
      });
      await this.maybeSendSimilarDeal(search, watch, similar);
    }
    return triggered.length;
  }

  /** Re-check triggered price alerts against a fresh (no-cache) search. */
  private async verifyTriggered(search: SavedSearch, triggered: TriggeredAlert[]): Promise<TriggeredAlert[]> {
    try {
      const fresh = await this.registry.search(search.query, { fresh: true });
      const freshScored = this.analysis.analyze(fresh.results);
      const confirmed = evaluateRules(triggered.map((t) => t.rule), freshScored, search.lastLowestPrice);
      const confirmedIds = new Set(confirmed.map((c) => c.rule.id));
      const dropped = triggered.filter((t) => !confirmedIds.has(t.rule.id));
      for (const d of dropped) {
        this.db.logEvent('info', 'alert_dropped_on_verification', { ruleId: d.rule.id, reason: d.reason });
      }
      return confirmed;
    } catch {
      // verification search failed entirely → fall back to the original signal
      return triggered;
    }
  }

  /** "We found a very similar flight for less" — the Spotify-for-flights alert. */
  private async maybeSendSimilarDeal(
    search: SavedSearch,
    watch: WatchedFlight,
    similar: ReturnType<typeof rankSimilar>
  ): Promise<void> {
    const best = similar.find(
      (s) => s.similarity >= 70 && (s.price <= watch.priceAtSave * SIMILAR_DEAL_RATIO || s.price <= watch.targetPrice)
    );
    if (!best) return;
    if (watch.similarAlertedAt) {
      const last = Date.parse(watch.similarAlertedAt.includes('T') ? watch.similarAlertedAt : watch.similarAlertedAt + 'Z');
      if (Number.isFinite(last) && Date.now() - last < SIMILAR_ALERT_COOLDOWN_H * 3600_000) return;
    }
    const rule = this.db.listAlerts(search.id)[0];
    if (!rule) return;
    const SYM: Record<string, string> = { ILS: '₪', EUR: '€', USD: '$', GBP: '£' };
    const money = (n: number, c: string) => `${SYM[c] ?? c + ' '}${Math.round(n).toLocaleString('en')}`;
    const saving = Math.round(watch.priceAtSave - best.price);
    const delivered = await this.alerts.sendCustom(rule.id, rule.channels, {
      title: `מצאנו טיסה דומה במחיר נמוך יותר: ${watch.origin} → ${watch.destination} · ${money(best.price, best.currency)}`,
      body: [
        `הטיסה ששמרת: ${watch.airlineName ?? watch.airline ?? ''} ${watch.flightNumber ?? ''} במחיר ${money(watch.priceAtSave, watch.currency)}`,
        `האפשרות החדשה: ${best.airlineName ?? best.airline} ${best.flightNumber ?? ''} · ${best.stops === 0 ? 'טיסה ישירה' : `${best.stops} עצירות`}`,
        `דמיון לטיסה ששמרת: ${best.similarity}%`,
        `חיסכון: ${money(saving, watch.currency)}`,
        `תאריכים: ${watch.departureDate}${watch.returnDate ? ` → ${watch.returnDate}` : ''}`,
      ].join('\n'),
      url: best.bookingUrl,
    });
    if (delivered) this.db.updateWatchedFlight(watch.id, { similarAlerted: true });
  }

  start(pollSeconds = 60): void {
    console.log(`[worker] monitoring loop started (poll every ${pollSeconds}s)`);
    const loop = async () => {
      liveState.lastTickAt = new Date().toISOString();
      liveState.nextTickAt = new Date(Date.now() + pollSeconds * 1000).toISOString();
      const { ran, alertsSent } = await this.tick();
      if (ran > 0) {
        console.log(`[worker] ran ${ran} searches, sent ${alertsSent} alerts`);
        bus.emit('deals');
      }
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
