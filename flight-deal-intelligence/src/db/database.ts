/**
 * Database layer (§12). SQLite via better-sqlite3 for local/dev; the schema is
 * portable to PostgreSQL for production (see infra/postgres/schema.sql note in docs).
 *
 * Price history is never deleted automatically (§72) unless a retention policy
 * is configured via PRICE_RETENTION_DAYS.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FlightResult, SavedSearch, SearchQuery, AlertRule, AlertFilters, WatchedFlight } from '../core/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  query_json TEXT NOT NULL,
  monitor INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 180,
  adaptive_interval_minutes INTEGER,
  last_run_at TEXT,
  last_lowest_price REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS search_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_search_id INTEGER REFERENCES saved_searches(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  lowest_price REAL,
  latency_ms INTEGER,
  error TEXT,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flight_results (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  departure_date TEXT NOT NULL,
  return_date TEXT,
  departure_time TEXT,
  arrival_time TEXT,
  duration_minutes INTEGER,
  stops INTEGER NOT NULL DEFAULT 0,
  airline TEXT,
  airline_name TEXT,
  flight_number TEXT,
  aircraft TEXT,
  cabin TEXT NOT NULL DEFAULT 'ECONOMY',
  bags INTEGER NOT NULL DEFAULT 0,
  base_price REAL,
  taxes REAL,
  total_price REAL NOT NULL,
  currency TEXT NOT NULL,
  normalized_price REAL NOT NULL,
  normalized_currency TEXT NOT NULL,
  exchange_rate REAL NOT NULL DEFAULT 1,
  exchange_rate_timestamp TEXT,
  booking_url TEXT,
  deep_link TEXT,
  segments_json TEXT,
  raw_provider_data TEXT,
  collected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_route ON flight_results(origin, destination, departure_date);
CREATE INDEX IF NOT EXISTS idx_results_fingerprint ON flight_results(fingerprint);

CREATE TABLE IF NOT EXISTS flight_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_result_id TEXT REFERENCES flight_results(id),
  seq INTEGER NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  departure_time TEXT,
  arrival_time TEXT,
  airline TEXT,
  flight_number TEXT,
  aircraft TEXT,
  duration_minutes INTEGER
);

CREATE TABLE IF NOT EXISTS airports (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS airlines (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  departure_date TEXT NOT NULL,
  return_date TEXT,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  provider TEXT NOT NULL,
  airline TEXT,
  stops INTEGER,
  collected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_route ON price_snapshots(route, collected_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_route_date ON price_snapshots(route, departure_date);

CREATE TABLE IF NOT EXISTS price_statistics (
  route TEXT PRIMARY KEY,
  sample_count INTEGER NOT NULL,
  lowest REAL, highest REAL, average REAL, median REAL,
  std_dev REAL, volatility REAL, trend TEXT,
  window_days INTEGER NOT NULL DEFAULT 90,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deal_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_result_id TEXT REFERENCES flight_results(id),
  route TEXT NOT NULL,
  score REAL NOT NULL,
  breakdown_json TEXT,
  is_exceptional INTEGER NOT NULL DEFAULT 0,
  is_error_fare_candidate INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deal_scores_route ON deal_scores(route, computed_at);
CREATE INDEX IF NOT EXISTS idx_deal_scores_computed ON deal_scores(computed_at);
CREATE INDEX IF NOT EXISTS idx_results_collected ON flight_results(collected_at);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_search_id INTEGER REFERENCES saved_searches(id),
  kind TEXT NOT NULL,
  threshold REAL NOT NULL,
  channels_json TEXT NOT NULL DEFAULT '["console"]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watched_flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_search_id INTEGER REFERENCES saved_searches(id),
  route TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  departure_date TEXT NOT NULL,
  return_date TEXT,
  airline TEXT,
  airline_name TEXT,
  flight_number TEXT,
  stops INTEGER,
  price_at_save REAL NOT NULL,
  currency TEXT NOT NULL,
  target_price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_price REAL,
  last_checked_at TEXT,
  triggered_at TEXT,
  flight_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS providers (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS provider_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  error TEXT,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_provider_runs ON provider_runs(provider, ran_at);

CREATE TABLE IF NOT EXISTS route_statistics (
  route TEXT PRIMARY KEY,
  best_month TEXT,
  best_day TEXT,
  current_percentile REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS destination_groups (
  name TEXT PRIMARY KEY,
  airports_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_preferences (
  user_id INTEGER PRIMARY KEY,
  preferences_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_route_stats (
  provider TEXT NOT NULL,
  route TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  ok_runs INTEGER NOT NULL DEFAULT 0,
  results_sum INTEGER NOT NULL DEFAULT 0,
  lowest_price REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, route)
);

CREATE TABLE IF NOT EXISTS deal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  route TEXT NOT NULL,
  departure_date TEXT,
  prev_price REAL,
  new_price REAL,
  drop_pct REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deal_events_created ON deal_events(created_at);

CREATE TABLE IF NOT EXISTS search_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  query TEXT,
  total_queries INTEGER NOT NULL DEFAULT 1,
  total_results INTEGER NOT NULL DEFAULT 0,
  best_price REAL,
  providers TEXT,
  elapsed_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class FlightDatabase {
  readonly db: Database.Database;

  constructor(path: string = process.env.DATABASE_PATH ?? 'data/flight-intel.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for databases created before newer columns existed. */
  private migrate(): void {
    const alertCols = new Set(
      (this.db.prepare(`PRAGMA table_info(alerts)`).all() as { name: string }[]).map((c) => c.name)
    );
    const add = (col: string, ddl: string) => {
      if (!alertCols.has(col)) this.db.exec(`ALTER TABLE alerts ADD COLUMN ${ddl}`);
    };
    add('label', `label TEXT`);
    add('filters_json', `filters_json TEXT`);
    add('cooldown_minutes', `cooldown_minutes INTEGER NOT NULL DEFAULT 360`);
    add('quiet_from', `quiet_from INTEGER`);
    add('quiet_to', `quiet_to INTEGER`);
    add('last_triggered_at', `last_triggered_at TEXT`);

    const watchCols = new Set(
      (this.db.prepare(`PRAGMA table_info(watched_flights)`).all() as { name: string }[]).map((c) => c.name)
    );
    const addWatch = (col: string, ddl: string) => {
      if (!watchCols.has(col)) this.db.exec(`ALTER TABLE watched_flights ADD COLUMN ${ddl}`);
    };
    addWatch('similar_json', `similar_json TEXT`);
    addWatch('similar_alerted_at', `similar_alerted_at TEXT`);
  }

  // ---- flight results -----------------------------------------------------

  insertFlightResult(r: FlightResult, fingerprint: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO flight_results
         (id, fingerprint, provider, source, origin, destination, departure_date, return_date,
          departure_time, arrival_time, duration_minutes, stops, airline, airline_name,
          flight_number, aircraft, cabin, bags, base_price, taxes, total_price, currency,
          normalized_price, normalized_currency, exchange_rate, exchange_rate_timestamp,
          booking_url, deep_link, segments_json, raw_provider_data, collected_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        r.id, fingerprint, r.provider, r.source, r.origin, r.destination, r.departureDate,
        r.returnDate ?? null, r.departureTime, r.arrivalTime, r.durationMinutes, r.stops,
        r.airline, r.airlineName ?? null, r.flightNumber, r.aircraft ?? null, r.cabin, r.bags,
        r.basePrice, r.taxes, r.totalPrice, r.currency, r.normalizedPrice, r.normalizedCurrency,
        r.exchangeRate, r.exchangeRateTimestamp, r.bookingUrl, r.deepLink,
        JSON.stringify(r.segments), r.rawProviderData ? JSON.stringify(r.rawProviderData) : null,
        r.collectedAt
      );
  }

  // ---- price history (§14, §72) ------------------------------------------

  insertPriceSnapshot(s: {
    route: string; origin: string; destination: string; departureDate: string;
    returnDate?: string; price: number; currency: string; provider: string;
    airline?: string; stops?: number; collectedAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO price_snapshots (route, origin, destination, departure_date, return_date, price, currency, provider, airline, stops, collected_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        s.route, s.origin, s.destination, s.departureDate, s.returnDate ?? null, s.price,
        s.currency, s.provider, s.airline ?? null, s.stops ?? null,
        s.collectedAt ?? new Date().toISOString()
      );
  }

  priceHistory(route: string, windowDays = 90): { price: number; collectedAt: string; departureDate: string }[] {
    return this.db
      .prepare(
        `SELECT price, collected_at as collectedAt, departure_date as departureDate
         FROM price_snapshots
         WHERE route = ? AND collected_at >= datetime('now', ?)
         ORDER BY collected_at ASC`
      )
      .all(route, `-${windowDays} days`) as { price: number; collectedAt: string; departureDate: string }[];
  }

  /** Daily lowest price series for charting (§43). */
  priceSeries(route: string, windowDays = 90): { day: string; low: number; avg: number }[] {
    return this.db
      .prepare(
        `SELECT substr(collected_at, 1, 10) AS day, MIN(price) AS low, ROUND(AVG(price),2) AS avg
         FROM price_snapshots
         WHERE route = ? AND collected_at >= datetime('now', ?)
         GROUP BY day ORDER BY day ASC`
      )
      .all(route, `-${windowDays} days`) as { day: string; low: number; avg: number }[];
  }

  // ---- saved searches / monitors (§25-§28) --------------------------------

  createSavedSearch(name: string, query: SearchQuery, monitor: boolean, intervalMinutes: number): number {
    const info = this.db
      .prepare(
        `INSERT INTO saved_searches (name, query_json, monitor, interval_minutes) VALUES (?,?,?,?)`
      )
      .run(name, JSON.stringify(query), monitor ? 1 : 0, intervalMinutes);
    return Number(info.lastInsertRowid);
  }

  listSavedSearches(): SavedSearch[] {
    const rows = this.db.prepare(`SELECT * FROM saved_searches ORDER BY id`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      name: r.name as string,
      query: JSON.parse(r.query_json as string) as SearchQuery,
      monitor: !!r.monitor,
      intervalMinutes: r.interval_minutes as number,
      adaptiveIntervalMinutes: (r.adaptive_interval_minutes as number) ?? undefined,
      lastRunAt: (r.last_run_at as string) ?? null,
      lastLowestPrice: (r.last_lowest_price as number) ?? null,
      createdAt: r.created_at as string,
    }));
  }

  getSavedSearch(id: number): SavedSearch | undefined {
    return this.listSavedSearches().find((s) => s.id === id);
  }

  deleteSavedSearch(id: number): void {
    this.db.prepare(`DELETE FROM alerts WHERE saved_search_id = ?`).run(id);
    this.db.prepare(`UPDATE watched_flights SET saved_search_id = NULL WHERE saved_search_id = ?`).run(id);
    this.db.prepare(`DELETE FROM saved_searches WHERE id = ?`).run(id);
  }

  updateSavedSearch(id: number, patch: { monitor?: boolean; intervalMinutes?: number; name?: string }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.monitor !== undefined) { sets.push('monitor = ?'); vals.push(patch.monitor ? 1 : 0); }
    if (patch.intervalMinutes !== undefined) {
      sets.push('interval_minutes = ?', 'adaptive_interval_minutes = ?');
      vals.push(patch.intervalMinutes, patch.intervalMinutes);
    }
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (!sets.length) return;
    this.db.prepare(`UPDATE saved_searches SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  updateSavedSearchRun(id: number, lowestPrice: number | null, adaptiveIntervalMinutes: number): void {
    this.db
      .prepare(
        `UPDATE saved_searches SET last_run_at = datetime('now'), last_lowest_price = ?, adaptive_interval_minutes = ? WHERE id = ?`
      )
      .run(lowestPrice, adaptiveIntervalMinutes, id);
  }

  // ---- alerts (§25-§26) ---------------------------------------------------

  createAlert(
    savedSearchId: number,
    kind: string,
    threshold: number,
    channels: string[],
    opts: {
      label?: string;
      filters?: AlertFilters;
      cooldownMinutes?: number;
      quietHours?: [number, number] | null;
    } = {}
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO alerts (saved_search_id, kind, threshold, channels_json, label, filters_json, cooldown_minutes, quiet_from, quiet_to)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        savedSearchId, kind, threshold, JSON.stringify(channels),
        opts.label ?? null,
        opts.filters ? JSON.stringify(opts.filters) : null,
        opts.cooldownMinutes ?? 360,
        opts.quietHours?.[0] ?? null,
        opts.quietHours?.[1] ?? null
      );
    return Number(info.lastInsertRowid);
  }

  private rowToAlert(r: Record<string, unknown>): AlertRule {
    return {
      id: r.id as number,
      savedSearchId: r.saved_search_id as number,
      kind: r.kind as AlertRule['kind'],
      threshold: r.threshold as number,
      channels: JSON.parse(r.channels_json as string) as string[],
      active: !!r.active,
      createdAt: r.created_at as string,
      label: (r.label as string) ?? undefined,
      filters: r.filters_json ? (JSON.parse(r.filters_json as string) as AlertFilters) : undefined,
      cooldownMinutes: (r.cooldown_minutes as number) ?? undefined,
      quietHours:
        r.quiet_from != null && r.quiet_to != null
          ? [r.quiet_from as number, r.quiet_to as number]
          : undefined,
      lastTriggeredAt: (r.last_triggered_at as string) ?? null,
    };
  }

  listAlerts(savedSearchId?: number): AlertRule[] {
    const rows = (
      savedSearchId
        ? this.db.prepare(`SELECT * FROM alerts WHERE saved_search_id = ?`).all(savedSearchId)
        : this.db.prepare(`SELECT * FROM alerts`).all()
    ) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAlert(r));
  }

  updateAlert(
    id: number,
    patch: {
      threshold?: number;
      active?: boolean;
      channels?: string[];
      label?: string;
      filters?: AlertFilters | null;
      cooldownMinutes?: number;
      quietHours?: [number, number] | null;
    }
  ): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.threshold !== undefined) { sets.push('threshold = ?'); vals.push(patch.threshold); }
    if (patch.active !== undefined) { sets.push('active = ?'); vals.push(patch.active ? 1 : 0); }
    if (patch.channels !== undefined) { sets.push('channels_json = ?'); vals.push(JSON.stringify(patch.channels)); }
    if (patch.label !== undefined) { sets.push('label = ?'); vals.push(patch.label); }
    if (patch.filters !== undefined) {
      sets.push('filters_json = ?');
      vals.push(patch.filters ? JSON.stringify(patch.filters) : null);
    }
    if (patch.cooldownMinutes !== undefined) { sets.push('cooldown_minutes = ?'); vals.push(patch.cooldownMinutes); }
    if (patch.quietHours !== undefined) {
      sets.push('quiet_from = ?', 'quiet_to = ?');
      vals.push(patch.quietHours?.[0] ?? null, patch.quietHours?.[1] ?? null);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  deleteAlert(id: number): void {
    this.db.prepare(`DELETE FROM alerts WHERE id = ?`).run(id);
  }

  markAlertTriggered(id: number): void {
    this.db.prepare(`UPDATE alerts SET last_triggered_at = datetime('now') WHERE id = ?`).run(id);
  }

  // ---- watched flights (favorites with a target price) --------------------

  createWatchedFlight(w: {
    savedSearchId: number | null;
    route: string;
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string | null;
    airline?: string | null;
    airlineName?: string | null;
    flightNumber?: string | null;
    stops?: number | null;
    priceAtSave: number;
    currency: string;
    targetPrice: number;
    flight?: unknown;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO watched_flights
         (saved_search_id, route, origin, destination, departure_date, return_date,
          airline, airline_name, flight_number, stops, price_at_save, currency,
          target_price, flight_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        w.savedSearchId, w.route, w.origin, w.destination, w.departureDate, w.returnDate ?? null,
        w.airline ?? null, w.airlineName ?? null, w.flightNumber ?? null, w.stops ?? null,
        w.priceAtSave, w.currency, w.targetPrice,
        w.flight ? JSON.stringify(w.flight) : null
      );
    return Number(info.lastInsertRowid);
  }

  private rowToWatch(r: Record<string, unknown>): WatchedFlight {
    return {
      id: r.id as number,
      savedSearchId: (r.saved_search_id as number) ?? null,
      route: r.route as string,
      origin: r.origin as string,
      destination: r.destination as string,
      departureDate: r.departure_date as string,
      returnDate: (r.return_date as string) ?? null,
      airline: (r.airline as string) ?? null,
      airlineName: (r.airline_name as string) ?? null,
      flightNumber: (r.flight_number as string) ?? null,
      stops: (r.stops as number) ?? null,
      priceAtSave: r.price_at_save as number,
      currency: r.currency as string,
      targetPrice: r.target_price as number,
      active: !!r.active,
      lastPrice: (r.last_price as number) ?? null,
      lastCheckedAt: (r.last_checked_at as string) ?? null,
      triggeredAt: (r.triggered_at as string) ?? null,
      createdAt: r.created_at as string,
      flight: r.flight_json ? JSON.parse(r.flight_json as string) : undefined,
      similar: r.similar_json ? JSON.parse(r.similar_json as string) : undefined,
      similarAlertedAt: (r.similar_alerted_at as string) ?? null,
    };
  }

  listWatchedFlights(): WatchedFlight[] {
    const rows = this.db
      .prepare(`SELECT * FROM watched_flights ORDER BY id DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToWatch(r));
  }

  getWatchedFlight(id: number): WatchedFlight | undefined {
    const row = this.db.prepare(`SELECT * FROM watched_flights WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToWatch(row) : undefined;
  }

  updateWatchedFlight(
    id: number,
    patch: {
      targetPrice?: number; active?: boolean; lastPrice?: number | null; triggered?: boolean;
      similar?: unknown[]; similarAlerted?: boolean;
    }
  ): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.targetPrice !== undefined) { sets.push('target_price = ?'); vals.push(patch.targetPrice); }
    if (patch.active !== undefined) { sets.push('active = ?'); vals.push(patch.active ? 1 : 0); }
    if (patch.lastPrice !== undefined) {
      sets.push('last_price = ?', `last_checked_at = datetime('now')`);
      vals.push(patch.lastPrice);
    }
    if (patch.triggered) sets.push(`triggered_at = datetime('now')`);
    if (patch.similar !== undefined) { sets.push('similar_json = ?'); vals.push(JSON.stringify(patch.similar)); }
    if (patch.similarAlerted) sets.push(`similar_alerted_at = datetime('now')`);
    if (!sets.length) return;
    this.db.prepare(`UPDATE watched_flights SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  deleteWatchedFlight(id: number): void {
    const row = this.getWatchedFlight(id);
    this.db.prepare(`DELETE FROM watched_flights WHERE id = ?`).run(id);
    // remove the monitor that existed only to serve this watch
    if (row?.savedSearchId) {
      const others = this.db
        .prepare(`SELECT COUNT(*) AS n FROM watched_flights WHERE saved_search_id = ?`)
        .get(row.savedSearchId) as { n: number };
      if (others.n === 0) this.deleteSavedSearch(row.savedSearchId);
    }
  }

  /** Watches whose monitor is the given saved search (used by the worker). */
  watchesForSearch(savedSearchId: number): WatchedFlight[] {
    const rows = this.db
      .prepare(`SELECT * FROM watched_flights WHERE saved_search_id = ? AND active = 1`)
      .all(savedSearchId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToWatch(r));
  }

  recordAlertDelivery(alertId: number, channel: string, status: string, message: string): void {
    this.db
      .prepare(`INSERT INTO alert_deliveries (alert_id, channel, status, message) VALUES (?,?,?,?)`)
      .run(alertId, channel, status, message);
  }

  // ---- provider reliability (§38) -----------------------------------------

  recordProviderRun(provider: string, status: 'ok' | 'error', latencyMs: number, error?: string): void {
    this.db
      .prepare(`INSERT INTO provider_runs (provider, status, latency_ms, error) VALUES (?,?,?,?)`)
      .run(provider, status, latencyMs, error ?? null);
  }

  providerStats(provider: string, windowHours = 24): {
    successCount: number; errorCount: number; avgLatencyMs: number;
    lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null;
  } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS successCount,
           SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errorCount,
           AVG(CASE WHEN status='ok' THEN latency_ms END) AS avgLatencyMs,
           MAX(CASE WHEN status='ok' THEN ran_at END) AS lastSuccessAt,
           MAX(CASE WHEN status='error' THEN ran_at END) AS lastErrorAt
         FROM provider_runs WHERE provider = ? AND ran_at >= datetime('now', ?)`
      )
      .get(provider, `-${windowHours} hours`) as Record<string, unknown>;
    const lastError = this.db
      .prepare(`SELECT error FROM provider_runs WHERE provider=? AND status='error' ORDER BY ran_at DESC LIMIT 1`)
      .get(provider) as { error: string } | undefined;
    return {
      successCount: Number(row.successCount ?? 0),
      errorCount: Number(row.errorCount ?? 0),
      avgLatencyMs: Number(row.avgLatencyMs ?? 0),
      lastSuccessAt: (row.lastSuccessAt as string) ?? null,
      lastErrorAt: (row.lastErrorAt as string) ?? null,
      lastError: lastError?.error ?? null,
    };
  }

  // ---- route-provider learning (V4 §19-§20) -------------------------------

  recordProviderRouteRun(
    provider: string,
    route: string,
    ok: boolean,
    resultCount: number,
    lowestPrice: number | null
  ): void {
    this.db
      .prepare(
        `INSERT INTO provider_route_stats (provider, route, runs, ok_runs, results_sum, lowest_price, updated_at)
         VALUES (?,?,1,?,?,?,datetime('now'))
         ON CONFLICT(provider, route) DO UPDATE SET
           runs = runs + 1,
           ok_runs = ok_runs + excluded.ok_runs,
           results_sum = results_sum + excluded.results_sum,
           lowest_price = CASE
             WHEN excluded.lowest_price IS NULL THEN lowest_price
             WHEN lowest_price IS NULL THEN excluded.lowest_price
             ELSE MIN(lowest_price, excluded.lowest_price) END,
           updated_at = datetime('now')`
      )
      .run(provider, route, ok ? 1 : 0, resultCount, lowestPrice);
  }

  providerRouteStats(route: string): { provider: string; runs: number; okRuns: number; resultsSum: number; lowestPrice: number | null }[] {
    const rows = this.db
      .prepare(`SELECT provider, runs, ok_runs, results_sum, lowest_price FROM provider_route_stats WHERE route = ?`)
      .all(route) as Record<string, unknown>[];
    return rows.map((r) => ({
      provider: r.provider as string,
      runs: r.runs as number,
      okRuns: r.ok_runs as number,
      resultsSum: r.results_sum as number,
      lowestPrice: (r.lowest_price as number) ?? null,
    }));
  }

  // ---- live deal events (price drops, new deals) --------------------------

  recordDealEvent(e: {
    kind: 'PRICE_DROP' | 'NEW_DEAL' | 'PRICE_EXPIRED';
    route: string;
    departureDate?: string;
    prevPrice?: number | null;
    newPrice?: number | null;
    dropPct?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO deal_events (kind, route, departure_date, prev_price, new_price, drop_pct)
         VALUES (?,?,?,?,?,?)`
      )
      .run(e.kind, e.route, e.departureDate ?? null, e.prevPrice ?? null, e.newPrice ?? null, e.dropPct ?? null);
  }

  /** Previous observed low for a route+date BEFORE the current observation window. */
  previousLowForDate(route: string, departureDate: string, beforeMinutes = 30): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(price) AS low FROM price_snapshots
         WHERE route = ? AND departure_date = ?
           AND collected_at < datetime('now', ?)
           AND collected_at >= datetime('now', '-7 days')`
      )
      .get(route, departureDate, `-${beforeMinutes} minutes`) as { low: number | null };
    return row.low ?? null;
  }

  liveStats(): { drops24h: number; newDeals1h: number; checked24h: number } {
    const drops = this.db
      .prepare(`SELECT COUNT(*) AS n FROM deal_events WHERE kind='PRICE_DROP' AND created_at >= datetime('now','-1 day')`)
      .get() as { n: number };
    const fresh = this.db
      .prepare(`SELECT COUNT(DISTINCT route) AS n FROM deal_scores WHERE computed_at >= datetime('now','-1 hour')`)
      .get() as { n: number };
    const checked = this.db
      .prepare(`SELECT COALESCE(SUM(total_results),0) AS n FROM search_sessions WHERE created_at >= datetime('now','-1 day')`)
      .get() as { n: number };
    return { drops24h: drops.n, newDeals1h: fresh.n, checked24h: checked.n };
  }

  // ---- meta-search KPIs ---------------------------------------------------

  recordSearchSession(s: {
    kind: 'structured' | 'agent' | 'verify' | 'monitor';
    query?: string;
    totalQueries?: number;
    totalResults: number;
    bestPrice?: number | null;
    providers?: string[];
    elapsedMs?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO search_sessions (kind, query, total_queries, total_results, best_price, providers, elapsed_ms)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        s.kind, s.query ?? null, s.totalQueries ?? 1, s.totalResults,
        s.bestPrice ?? null, s.providers ? JSON.stringify(s.providers) : null, s.elapsedMs ?? null
      );
  }

  searchMetrics(windowHours = 24): Record<string, unknown> {
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS sessions, SUM(total_queries) AS queries, SUM(total_results) AS results,
                AVG(elapsed_ms) AS avgElapsedMs, MIN(best_price) AS bestPrice
         FROM search_sessions WHERE created_at >= datetime('now', ?)`
      )
      .get(`-${windowHours} hours`) as Record<string, unknown>;
    const recent = this.db
      .prepare(`SELECT * FROM search_sessions ORDER BY id DESC LIMIT 20`)
      .all();
    return { windowHours, ...agg, recent };
  }

  /**
   * Deal probability 0-100 per route from accumulated history: how often does
   * this route show prices well below its average, plus trend/volatility hints.
   * Used to focus Freestyle/Everything search budget on high-yield routes.
   */
  dealProbability(route: string): number {
    const stats = this.db
      .prepare(`SELECT average, volatility, trend, sample_count FROM price_statistics WHERE route = ?`)
      .get(route) as { average: number; volatility: number; trend: string; sample_count: number } | undefined;
    if (!stats || !stats.average || stats.sample_count < 5) return 50; // unknown → neutral (explore)
    const dealRow = this.db
      .prepare(
        `SELECT AVG(CASE WHEN price < ? THEN 1.0 ELSE 0 END) AS dealShare
         FROM price_snapshots WHERE route = ? AND collected_at >= datetime('now', '-90 days')`
      )
      .get(stats.average * 0.85, route) as { dealShare: number | null };
    let score = 40 + (dealRow.dealShare ?? 0) * 45; // routes that often dip below 85% of average
    if (stats.trend === 'FALLING') score += 10;
    if (stats.trend === 'RISING') score -= 5;
    score += Math.min(10, stats.volatility * 40); // volatile routes produce more windows
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // ---- observability (§48) ------------------------------------------------

  logEvent(level: 'info' | 'warn' | 'error', event: string, detail?: unknown, requestId?: string): void {
    this.db
      .prepare(`INSERT INTO system_events (level, event, detail, request_id) VALUES (?,?,?,?)`)
      .run(level, event, detail === undefined ? null : JSON.stringify(detail), requestId ?? null);
  }

  /** Retention policy (§72): only applies when PRICE_RETENTION_DAYS is set. */
  applyRetention(): number {
    const days = Number(process.env.PRICE_RETENTION_DAYS ?? 0);
    if (!days) return 0;
    const info = this.db
      .prepare(`DELETE FROM price_snapshots WHERE collected_at < datetime('now', ?)`)
      .run(`-${days} days`);
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}

let singleton: FlightDatabase | null = null;
export function getDatabase(): FlightDatabase {
  if (!singleton) singleton = new FlightDatabase();
  return singleton;
}
