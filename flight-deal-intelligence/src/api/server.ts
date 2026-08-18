/**
 * REST API (§50) + dashboard hosting (§41-§45) + SSE live updates (§11).
 * Input validation with Zod (§56); request IDs + structured logging (§48).
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getDatabase } from '../db/database.js';
import { buildDefaultRegistry } from '../providers/registry.js';
import { AnalysisService } from '../analyzer/service.js';
import { FlightAgent, buildQuery } from '../agent/agent.js';
import { parseTripRequest } from '../agent/parser.js';
import { loadAirports, nearbyAirports, airportName, isValidAirport } from '../core/airports.js';
import { searchCities, resolveAirport, cityForCode } from '../core/cities.js';
import { routeKey } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';
import { bus, liveState } from '../core/bus.js';
import { providerInfo } from '../providers/config.js';
import { ProviderStore } from '../providers/store.js';
import { discoverMapping } from '../providers/discover.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = getDatabase();

// One-time cleanup: purge legacy records stored before the provider field
// mapping was fixed (airline codes like 'XX' or sliced names) so stale broken
// rows never surface in the deals feed.
db.db.exec(`
  DELETE FROM deal_scores WHERE flight_result_id IN
    (SELECT id FROM flight_results WHERE airline = 'XX' OR length(airline) > 3);
  DELETE FROM flight_results WHERE airline = 'XX' OR length(airline) > 3;
`);
const registry = buildDefaultRegistry(db);
const analysis = new AnalysisService(db);
const agent = new FlightAgent(registry, analysis, db);

export const app = express();
app.use(express.json({ limit: '256kb' }));

// request id + logging (§48)
app.use((req, res, next) => {
  const id = randomUUID().slice(0, 8);
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  const started = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({ id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }));
  });
  next();
});

app.use(express.static(join(ROOT, 'web')));

/**
 * API rate limiting (§23): a simple per-IP sliding window on the expensive
 * endpoints (live search, verification, agent scans) so a runaway client
 * cannot burn provider quota. Cheap reads stay unlimited.
 */
const RL_WINDOW_MS = Number(process.env.API_RATE_WINDOW_SECONDS ?? 60) * 1000;
const RL_MAX = Number(process.env.API_RATE_MAX_SEARCHES ?? 40);
const rlHits = new Map<string, number[]>();

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const hits = (rlHits.get(key) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) {
    res.setHeader('Retry-After', Math.ceil(RL_WINDOW_MS / 1000));
    res.status(429).json({ error: 'too many searches — please wait a moment' });
    return;
  }
  hits.push(now);
  rlHits.set(key, hits);
  if (rlHits.size > 5000) rlHits.clear(); // bounded memory
  next();
}

app.use(['/api/flights/search', '/api/flights/verify', '/api/ai/search'], rateLimit);

const searchSchema = z.object({
  origin: z.string().length(3),
  destination: z.string().length(3),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  adults: z.coerce.number().int().min(1).max(9).default(1),
  children: z.coerce.number().int().min(0).max(8).default(0),
  infants: z.coerce.number().int().min(0).max(4).default(0),
  cabin: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']).default('ECONOMY'),
  stops: z.enum(['ANY', 'NON_STOP', 'ONE_STOP', 'TWO_PLUS_STOPS']).default('ANY'),
  maxPrice: z.coerce.number().positive().optional(),
  airlines: z.string().optional(),
  currency: z.string().length(3).default(currencyService.systemCurrency),
});

/**
 * Date sanity (§17): a return before departure, or a departure in the past,
 * can never produce a bookable result — reject it before burning provider
 * quota, with a message the UI can show as-is.
 */
function validateDates(p: { departureDate: string; returnDate?: string }): string | null {
  const today = new Date().toISOString().slice(0, 10);
  if (p.departureDate < today) return 'תאריך היציאה כבר עבר';
  if (p.returnDate && p.returnDate < p.departureDate) return 'תאריך החזרה מוקדם מתאריך היציאה';
  if (!Number.isFinite(Date.parse(p.departureDate))) return 'תאריך יציאה לא תקין';
  return null;
}

function toQuery(p: z.infer<typeof searchSchema>) {
  return buildQuery({
    origin: p.origin.toUpperCase(),
    destination: p.destination.toUpperCase(),
    departureDate: p.departureDate,
    returnDate: p.returnDate,
    passengers: { adults: p.adults, children: p.children, infants: p.infants },
    cabin: p.cabin,
    stops: p.stops,
    maxPrice: p.maxPrice,
    airlines: p.airlines?.split(',').map((a) => a.trim().toUpperCase()),
    currency: p.currency.toUpperCase(),
  });
}

// ---- flights (§50) --------------------------------------------------------

app.get('/api/flights/search', async (req, res) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const dateError = validateDates(parsed.data);
  if (dateError) return res.status(400).json({ error: dateError });
  const started = Date.now();
  try {
    const outcome = await registry.search(toQuery(parsed.data));
    const scored = analysis.analyze(outcome.results);
    db.recordSearchSession({
      kind: 'structured',
      query: `${parsed.data.origin}-${parsed.data.destination} ${parsed.data.departureDate}`,
      totalResults: scored.length,
      bestPrice: scored.length ? Math.min(...scored.map((s) => s.normalizedPrice)) : null,
      providers: outcome.attempted.filter((a) => a.ok).map((a) => a.provider),
      elapsedMs: Date.now() - started,
    });
    res.json({
      provider: outcome.provider,
      attempted: outcome.attempted,
      count: scored.length,
      flights: scored,
      disclaimer: 'Lowest price found across the sources available to us at search time.',
    });
  } catch (err) {
    db.logEvent('error', 'search_failed', { error: String(err) }, res.locals.requestId);
    res.status(502).json({ error: 'all providers failed', detail: String(err) });
  }
});

/**
 * Price verification (meta-search §33-§35): re-run the query FRESH (no cache),
 * find the same itinerary, and report whether the shown price still holds.
 * Used for top deals and before redirecting to booking.
 */
app.post('/api/flights/verify', async (req, res) => {
  const schema = z.object({
    origin: z.string().length(3),
    destination: z.string().length(3),
    departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    airline: z.string().max(3).optional(),
    flightNumber: z.string().max(12).optional(),
    expectedPrice: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  const started = Date.now();
  try {
    const outcome = await registry.search(
      buildQuery({
        origin: d.origin.toUpperCase(),
        destination: d.destination.toUpperCase(),
        departureDate: d.departureDate,
        returnDate: d.returnDate,
      }),
      { fresh: true }
    );
    const scored = analysis.analyze(outcome.results);
    // exact itinerary first; otherwise the route's current best price
    const match =
      scored.find(
        (f) =>
          (!d.airline || f.airline === d.airline) &&
          (!d.flightNumber || f.flightNumber === d.flightNumber)
      ) ?? [...scored].sort((a, b) => a.normalizedPrice - b.normalizedPrice)[0];
    db.recordSearchSession({
      kind: 'verify',
      query: `${d.origin}-${d.destination} ${d.departureDate}`,
      totalResults: scored.length,
      bestPrice: match?.normalizedPrice ?? null,
      providers: outcome.attempted.filter((a) => a.ok).map((a) => a.provider),
      elapsedMs: Date.now() - started,
    });
    if (!match) {
      return res.json({
        verified: false,
        available: false,
        expectedPrice: d.expectedPrice,
        currentPrice: null,
        priceChanged: null,
        message: 'itinerary not found in a fresh search',
      });
    }
    const delta = match.normalizedPrice - d.expectedPrice;
    res.json({
      verified: true,
      available: true,
      exactMatch: Boolean(
        (!d.airline || match.airline === d.airline) &&
        (!d.flightNumber || match.flightNumber === d.flightNumber)
      ),
      expectedPrice: d.expectedPrice,
      currentPrice: match.normalizedPrice,
      currency: match.normalizedCurrency,
      priceChanged: Math.abs(delta) > Math.max(2, d.expectedPrice * 0.01),
      delta: Math.round(delta * 100) / 100,
      priceConfidence: match.priceConfidence,
      sources: match.sources,
      flight: match,
    });
  } catch (err) {
    res.status(502).json({ error: 'verification failed', detail: String(err) });
  }
});

/** Meta-search KPI feed: sessions, volumes, latency (spec §75-§76, §101-§105). */
app.get('/api/metrics/search', (req, res) => {
  res.json(db.searchMetrics(Math.min(24 * 14, Number(req.query.hours ?? 24))));
});

app.post('/api/flights/search', async (req, res) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const outcome = await registry.search(toQuery(parsed.data));
  const scored = analysis.analyze(outcome.results);
  res.json({ provider: outcome.provider, count: scored.length, flights: scored });
});

/**
 * Calendar API (date grid): real lowest price per departure date for a month.
 * Days without fresh observations return status "unknown" — no fake prices.
 */
app.get('/api/flights/calendar', (req, res) => {
  const schema = z.object({
    origin: z.string().length(3),
    destination: z.string().length(3),
    month: z.string().regex(/^\d{4}-\d{2}$/),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const route = routeKey(parsed.data.origin, parsed.data.destination);
  const rows = db.lowsByDepartureDate(route, parsed.data.month);
  const prices = rows.map((r) => r.low).sort((a, b) => a - b);
  const min = prices[0];
  const p25 = prices[Math.floor(prices.length * 0.25)];
  const p75 = prices[Math.floor(prices.length * 0.75)];
  const days = rows.map((r) => ({
    date: r.day,
    lowestPrice: r.low,
    currency: currencyService.systemCurrency,
    status:
      prices.length < 3 ? 'average'
      : r.low === min ? 'cheapest'
      : r.low <= p25! ? 'good'
      : r.low >= p75! ? 'expensive'
      : 'average',
    lastUpdated: r.seen,
  }));
  res.json({ route, month: parsed.data.month, days });
});

/** Cheapest observed price per MONTH (and its exact day) for a route. */
app.get('/api/flights/month-lows', (req, res) => {
  const schema = z.object({ origin: z.string().length(3), destination: z.string().length(3) });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const route = routeKey(parsed.data.origin, parsed.data.destination);
  const rows = db.db
    .prepare(
      `SELECT departure_date AS day, MIN(price) AS low
       FROM price_snapshots
       WHERE route = ? AND collected_at >= datetime('now', '-7 days') AND departure_date >= date('now')
       GROUP BY departure_date`
    )
    .all(route) as { day: string; low: number }[];
  const byMonth = new Map<string, { month: string; low: number; cheapestDay: string }>();
  for (const r of rows) {
    const m = r.day.slice(0, 7);
    const cur = byMonth.get(m);
    if (!cur || r.low < cur.low) byMonth.set(m, { month: m, low: r.low, cheapestDay: r.day });
  }
  res.json({
    route,
    currency: currencyService.systemCurrency,
    months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(0, 8),
  });
});

/** Lows by DEPARTURE date over a horizon — feeds the departure-price graph. */
app.get('/api/flights/departure-prices', (req, res) => {
  const schema = z.object({
    origin: z.string().length(3),
    destination: z.string().length(3),
    days: z.coerce.number().int().min(7).max(180).default(60),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const route = routeKey(parsed.data.origin, parsed.data.destination);
  const rows = db.db
    .prepare(
      `SELECT departure_date AS day, MIN(price) AS low
       FROM price_snapshots
       WHERE route = ? AND collected_at >= datetime('now', '-7 days')
         AND departure_date >= date('now') AND departure_date <= date('now', ?)
       GROUP BY departure_date ORDER BY day`
    )
    .all(route, `+${parsed.data.days} days`) as { day: string; low: number }[];
  res.json({ route, currency: currencyService.systemCurrency, days: rows });
});

app.get('/api/flights/:id', (req, res) => {
  const row = db.db.prepare(`SELECT * FROM flight_results WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// ---- AI search (§30, §66) — runs as a background job with live progress ----
// A wide scan can take minutes, far beyond hosting proxies' ~100s request
// limit, so the search runs server-side and the UI polls for progress.

interface AiJob {
  id: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  total: number;
  bestSoFar: unknown | null;
  report?: unknown;
  error?: string;
  createdAt: number;
}
const aiJobs = new Map<string, AiJob>();

app.post('/api/ai/search', (req, res) => {
  const schema = z.object({ prompt: z.string().min(3).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  // prune jobs older than an hour
  for (const [id, job] of aiJobs) {
    if (Date.now() - job.createdAt > 3600_000) aiJobs.delete(id);
  }
  const id = randomUUID().slice(0, 8);
  const job: AiJob = { id, status: 'running', progress: 0, total: 0, bestSoFar: null, createdAt: Date.now() };
  aiJobs.set(id, job);
  void (async () => {
    try {
      const report = await agent.run(parsed.data.prompt, (done, total, bestSoFar) => {
        job.progress = done;
        job.total = total;
        job.bestSoFar = bestSoFar;
      });
      job.report = report;
      job.status = 'done';
      broadcast('deals', { jobId: id });
    } catch (err) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
    }
  })();
  res.status(202).json({ jobId: id });
});

app.get('/api/ai/jobs/:id', (req, res) => {
  const job = aiJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

app.post('/api/ai/parse', (req, res) => {
  const schema = z.object({ prompt: z.string().min(3).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(parseTripRequest(parsed.data.prompt));
});

// ---- routes / history (§43-§44) ------------------------------------------

app.get('/api/routes/:route/history', (req, res) => {
  const windowDays = Math.min(365, Number(req.query.days ?? 90));
  const route = req.params.route.toUpperCase();
  const series = db.priceSeries(route, windowDays);
  const stats = analysis.routeStatistics(route, windowDays);
  res.json({ route, windowDays, series, stats });
});

app.get('/api/routes/:route/cheapest-dates', (req, res) => {
  const route = req.params.route.toUpperCase();
  const [origin, destination] = route.split('-');
  if (!origin || !destination) return res.status(400).json({ error: 'route format: TLV-JFK' });
  res.json({ route, dates: agent.cheapestDates(origin, destination, Number(req.query.days ?? 90)) });
});

// ---- saved searches / monitors (§25, §27, §50) ---------------------------

const savedSearchSchema = z.object({
  name: z.string().min(1).max(120),
  query: searchSchema,
  monitor: z.boolean().default(true),
  intervalMinutes: z.number().int().min(30).max(1440).default(180),
});

app.post('/api/searches', (req, res) => {
  const parsed = savedSearchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = db.createSavedSearch(
    parsed.data.name,
    toQuery(parsed.data.query),
    parsed.data.monitor,
    parsed.data.intervalMinutes
  );
  res.status(201).json({ id });
});

app.get('/api/searches', (_req, res) => {
  res.json(db.listSavedSearches());
});

app.delete('/api/searches/:id', (req, res) => {
  db.deleteSavedSearch(Number(req.params.id));
  res.status(204).end();
});

app.patch('/api/searches/:id', (req, res) => {
  const schema = z.object({
    monitor: z.boolean().optional(),
    intervalMinutes: z.number().int().min(30).max(1440).optional(),
    name: z.string().min(1).max(120).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!db.getSavedSearch(Number(req.params.id))) return res.status(404).json({ error: 'not found' });
  db.updateSavedSearch(Number(req.params.id), parsed.data);
  res.json({ ok: true });
});

app.post('/api/searches/:id/run', async (req, res) => {
  const search = db.getSavedSearch(Number(req.params.id));
  if (!search) return res.status(404).json({ error: 'not found' });
  const outcome = await registry.search(search.query);
  const scored = analysis.analyze(outcome.results);
  const lowest = scored.length ? Math.min(...scored.map((s) => s.normalizedPrice)) : null;
  db.updateSavedSearchRun(search.id, lowest, search.adaptiveIntervalMinutes ?? search.intervalMinutes);
  res.json({ provider: outcome.provider, count: scored.length, lowest, flights: scored.slice(0, 10) });
});

// ---- alerts (§25) ---------------------------------------------------------

const alertFiltersSchema = z.object({
  maxStops: z.number().int().min(0).max(3).optional(),
  airlines: z.array(z.string().min(2).max(3)).max(20).optional(),
  depHours: z.tuple([z.number().int().min(0).max(24), z.number().int().min(0).max(24)]).optional(),
  cabin: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']).optional(),
});

const hourPair = z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)]);

app.post('/api/alerts', (req, res) => {
  const schema = z.object({
    savedSearchId: z.number().int(),
    kind: z.enum(['PRICE_BELOW', 'DROP_PERCENT', 'DEAL_SCORE_ABOVE']),
    threshold: z.number().positive(),
    channels: z.array(z.string()).default(['console']),
    label: z.string().max(160).optional(),
    filters: alertFiltersSchema.optional(),
    cooldownMinutes: z.number().int().min(0).max(10080).optional(),
    quietHours: hourPair.nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  if (!db.getSavedSearch(d.savedSearchId)) {
    return res.status(404).json({ error: 'saved search not found' });
  }
  const id = db.createAlert(d.savedSearchId, d.kind, d.threshold, d.channels, {
    label: d.label,
    filters: d.filters,
    cooldownMinutes: d.cooldownMinutes,
    quietHours: d.quietHours ?? undefined,
  });
  res.status(201).json({ id });
});

app.get('/api/alerts', (_req, res) => res.json(db.listAlerts()));

app.patch('/api/alerts/:id', (req, res) => {
  const schema = z.object({
    threshold: z.number().positive().optional(),
    active: z.boolean().optional(),
    channels: z.array(z.string()).optional(),
    label: z.string().max(160).optional(),
    filters: alertFiltersSchema.nullable().optional(),
    cooldownMinutes: z.number().int().min(0).max(10080).optional(),
    quietHours: hourPair.nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  if (!db.listAlerts().some((a) => a.id === id)) return res.status(404).json({ error: 'not found' });
  db.updateAlert(id, parsed.data);
  res.json({ ok: true });
});

app.delete('/api/alerts/:id', (req, res) => {
  db.deleteAlert(Number(req.params.id));
  res.status(204).end();
});

// ---- watched flights: save a flight, get pinged when it hits your price ----

const watchSchema = z.object({
  flight: z.object({
    origin: z.string().length(3),
    destination: z.string().length(3),
    departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    airline: z.string().max(3).optional(),
    airlineName: z.string().max(120).optional(),
    flightNumber: z.string().max(12).optional(),
    stops: z.number().int().min(0).max(5).optional(),
    departureTime: z.string().optional(),
    arrivalTime: z.string().optional(),
    durationMinutes: z.number().optional(),
    normalizedPrice: z.number().positive(),
    normalizedCurrency: z.string().length(3),
    bookingUrl: z.string().optional(),
    cabin: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']).optional(),
  }),
  targetPrice: z.number().positive(),
  channels: z.array(z.string()).default(['telegram', 'console']),
  /** restrict the alert to the hearted flight's airline (default) or any airline */
  sameAirlineOnly: z.boolean().default(true),
  intervalMinutes: z.number().int().min(30).max(1440).default(180),
});

app.post('/api/watches', (req, res) => {
  const parsed = watchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { flight: f, targetPrice, channels, sameAirlineOnly, intervalMinutes } = parsed.data;
  const route = routeKey(f.origin, f.destination);

  // 1) a monitored saved search that re-checks exactly this trip
  const searchId = db.createSavedSearch(
    `מעקב ${route} ${f.departureDate}`,
    buildQuery({
      origin: f.origin.toUpperCase(),
      destination: f.destination.toUpperCase(),
      departureDate: f.departureDate,
      returnDate: f.returnDate ?? undefined,
      cabin: f.cabin ?? 'ECONOMY',
    }),
    true,
    intervalMinutes
  );

  // 2) a PRICE_BELOW rule scoped to the flight's shape
  const filters: Record<string, unknown> = {};
  if (sameAirlineOnly && f.airline) filters.airlines = [f.airline];
  if (f.stops !== undefined) filters.maxStops = f.stops;
  const label = `${f.origin}→${f.destination} מתחת ל-${Math.round(targetPrice)} ${f.normalizedCurrency}`;
  const alertId = db.createAlert(searchId, 'PRICE_BELOW', targetPrice, channels, {
    label,
    filters: Object.keys(filters).length ? (filters as never) : undefined,
    cooldownMinutes: 720,
  });

  // 3) the favorite itself, for the "טיסות שאהבתי" board
  const id = db.createWatchedFlight({
    savedSearchId: searchId,
    route,
    origin: f.origin.toUpperCase(),
    destination: f.destination.toUpperCase(),
    departureDate: f.departureDate,
    returnDate: f.returnDate ?? null,
    airline: f.airline ?? null,
    airlineName: f.airlineName ?? null,
    flightNumber: f.flightNumber ?? null,
    stops: f.stops ?? null,
    priceAtSave: f.normalizedPrice,
    currency: f.normalizedCurrency,
    targetPrice,
    flight: f,
  });
  res.status(201).json({ id, savedSearchId: searchId, alertId });
});

app.get('/api/watches', (_req, res) => res.json(db.listWatchedFlights()));

app.patch('/api/watches/:id', (req, res) => {
  const schema = z.object({
    targetPrice: z.number().positive().optional(),
    active: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  const watch = db.getWatchedFlight(id);
  if (!watch) return res.status(404).json({ error: 'not found' });
  db.updateWatchedFlight(id, parsed.data);
  // keep the linked PRICE_BELOW rule in sync with the new target / paused state
  if (watch.savedSearchId) {
    for (const rule of db.listAlerts(watch.savedSearchId)) {
      if (rule.kind !== 'PRICE_BELOW') continue;
      db.updateAlert(rule.id, {
        ...(parsed.data.targetPrice !== undefined ? { threshold: parsed.data.targetPrice } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      });
    }
    if (parsed.data.active !== undefined) {
      db.updateSavedSearch(watch.savedSearchId, { monitor: parsed.data.active });
    }
  }
  res.json({ ok: true });
});

app.delete('/api/watches/:id', (req, res) => {
  db.deleteWatchedFlight(Number(req.params.id));
  res.status(204).end();
});

/** Delivery log — proves alerts actually reached their channels (§48). */
app.get('/api/alerts/deliveries', (_req, res) => {
  const rows = db.db
    .prepare(
      `SELECT ad.channel, ad.status, ad.message, ad.delivered_at, a.kind, a.threshold
       FROM alert_deliveries ad LEFT JOIN alerts a ON a.id = ad.alert_id
       ORDER BY ad.delivered_at DESC LIMIT 20`
    )
    .all();
  res.json(rows);
});

/** Send a test message through the Telegram channel so users can verify setup. */
app.post('/api/alerts/test', async (_req, res) => {
  const { TelegramChannel } = await import('../alerts/channels.js');
  const tg = new TelegramChannel();
  if (!tg.enabled()) {
    return res.status(400).json({
      ok: false,
      error: 'Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID',
    });
  }
  try {
    await tg.send({
      title: 'Flight Deal Intelligence — בדיקת חיבור',
      body: 'ההתראות מחוברות. כשמחיר במעקב יירד, ההודעה תגיע לכאן.',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- deals dashboard feed (§41) ------------------------------------------

/** Real engine status for the live header — never a fake clock (§12, §37). */
app.get('/api/live-status', (_req, res) => {
  res.json({
    workerEnabled: process.env.RUN_WORKER === '1',
    active: liveState.lastTickAt !== null,
    lastTickAt: liveState.lastTickAt,
    nextTickAt: liveState.nextTickAt,
    lastRefreshAt: liveState.lastRefreshAt,
    refreshMinutes: Number(process.env.DEAL_REFRESH_MINUTES ?? 10),
    stats: db.liveStats(),
  });
});

app.get('/api/deals', (req, res) => {
  const limit = Math.min(50, Number(req.query.limit ?? 20));
  // one card per route+departure date: the best-scoring most recent offer (§41)
  const rows = db.db
    .prepare(
      `SELECT * FROM (
         SELECT ds.route, ds.score, ds.is_exceptional, ds.computed_at,
                fr.id, fr.origin, fr.destination, fr.departure_date, fr.return_date,
                fr.airline, fr.airline_name, fr.stops, fr.normalized_price, fr.normalized_currency,
                fr.booking_url, fr.deep_link, fr.collected_at, fr.duration_minutes,
                ROW_NUMBER() OVER (
                  PARTITION BY ds.route, fr.departure_date
                  ORDER BY ds.computed_at DESC, ds.score DESC
                ) AS rn
         FROM deal_scores ds JOIN flight_results fr ON fr.id = ds.flight_result_id
         WHERE ds.computed_at >= datetime('now', '-2 days')
       ) WHERE rn = 1
       ORDER BY score DESC LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
  const stats = new Map<string, ReturnType<typeof analysis.routeStatistics>>();
  const deals = rows.map((r) => {
    const route = r.route as string;
    if (!stats.has(route)) stats.set(route, analysis.routeStatistics(route));
    const s = stats.get(route)!;
    const price = r.normalized_price as number;
    const freshness = Math.round((Date.now() - Date.parse(String(r.collected_at))) / 60000);
    // when this route+date was first observed — the only honest basis for a
    // "new deal" badge (a price re-checked today is not a new deal)
    const seen = db.db
      .prepare(
        `SELECT MIN(collected_at) AS first_seen FROM price_snapshots
         WHERE route = ? AND departure_date = ?`
      )
      .get(route, String(r.departure_date)) as { first_seen: string | null };
    const firstSeenMinutes = (() => {
      if (!seen.first_seen) return null;
      // timestamps arrive either as ISO with Z or as SQLite "YYYY-MM-DD HH:MM:SS"
      const t = Date.parse(
        /[TZ]/.test(seen.first_seen) ? seen.first_seen : seen.first_seen.replace(' ', 'T') + 'Z'
      );
      return Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : null;
    })();
    // real previous price for THIS route+date — a savings claim needs evidence (§6)
    const prev = db.previousLowForDate(route, String(r.departure_date), 30);
    const dropPct = prev && prev > price ? Math.round(((prev - price) / prev) * 100) : 0;
    const foundMinutes = Math.round((Date.now() - Date.parse(String(r.computed_at).replace(' ', 'T') + 'Z')) / 60000);
    return {
      ...r,
      typical_price: s?.average ?? null,
      savings: s ? Math.round((s.average - price) * 100) / 100 : null,
      freshness_minutes: freshness,
      prev_price: prev,
      drop_pct: dropPct,
      first_seen_minutes: firstSeenMinutes,
      // genuinely new = first observed within the last 24h, not merely re-scored
      is_new: firstSeenMinutes !== null && firstSeenMinutes <= 1440,
      // honesty status: a stale observation is a "last seen price", not a live one
      price_status: freshness <= 15 ? 'VERIFIED_RECENT' : freshness <= 90 ? 'RECENT' : 'STALE',
    };
  });
  const sort = String(req.query.sort ?? 'score');
  const price = (d: (typeof deals)[number]) => Number((d as Record<string, unknown>).normalized_price);
  if (sort === 'price') deals.sort((a, b) => price(a) - price(b));
  else if (sort === 'drop') deals.sort((a, b) => b.drop_pct - a.drop_pct);
  else if (sort === 'new') deals.sort((a, b) => a.freshness_minutes - b.freshness_minutes);
  res.json(deals);
});

// ---- reference data -------------------------------------------------------

app.get('/api/airports', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json([]);
  // 1) city search (Hebrew/English) — the Google-Flights-like path
  const cityHits = searchCities(q, 8).map((s) => ({
    code: s.code,
    city: s.city,
    country: s.country,
    name: airportName(s.code) ?? s.code,
  }));
  // 2) airport-name / code search from the full airports DB
  const ql = q.toLowerCase();
  const seen = new Set(cityHits.map((c) => c.code));
  const nameHits: { code: string; city: string | null; country?: string; name: string }[] = [];
  for (const [code, name] of loadAirports().entries()) {
    if (nameHits.length + cityHits.length >= 10) break;
    if (seen.has(code)) continue;
    if (code.toLowerCase() === ql || name.toLowerCase().includes(ql)) {
      nameHits.push({ code, city: cityForCode(code)?.city ?? null, name });
      seen.add(code);
    }
  }
  res.json([...cityHits, ...nameHits]);
});

/** Resolve free text (Hebrew/English city, airport name, or code) → airport. */
app.get('/api/airports/resolve', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  const hit = resolveAirport(q);
  if (hit) {
    return res.json({ code: hit.code, city: hit.city, name: airportName(hit.code) ?? hit.code });
  }
  // fall back to airport-name substring from the full DB
  const ql = q.toLowerCase();
  for (const [code, name] of loadAirports().entries()) {
    if (name.toLowerCase().includes(ql)) {
      return res.json({ code, city: cityForCode(code)?.city ?? null, name });
    }
  }
  res.status(404).json({ error: `no airport found for "${q}"` });
});

app.get('/api/airports/:code/nearby', (req, res) => {
  res.json(nearbyAirports(req.params.code));
});

app.get('/api/airlines', (_req, res) => {
  const rows = db.db.prepare(`SELECT code, name FROM airlines LIMIT 100`).all();
  res.json(rows);
});

app.get('/api/providers', (_req, res) => {
  res.json(
    registry.list().map((a) => {
      const info = providerInfo[a.name];
      // report only whether each credential is present — never its value
      const credentials = (info?.envVars ?? []).map((v) => ({ name: v, configured: Boolean(process.env[v]) }));
      return {
        name: a.name,
        label: info?.label ?? a.name,
        priority: a.priority,
        status: registry.status(a.name),
        costTier: a.costTier ?? 'FREE',
        capabilities: a.capabilities,
        rateLimit: registry.rateStats(a.name),
        access: info?.access ?? 'SELF_SERVE',
        signupUrl: info?.signupUrl,
        note: info?.note,
        credentials,
        credentialsReady: credentials.length === 0 || credentials.every((c) => c.configured),
        ...registry.health(a.name),
      };
    })
  );
});

/**
 * Test Connection (§51): a real minimal search against ONE provider. A
 * provider is never "connected" because a key exists — only a live call
 * proves it. Returns latency and result count or the actual failure.
 */
app.post('/api/providers/:name/test', async (req, res) => {
  const adapter = registry.list().find((a) => a.name === req.params.name);
  if (!adapter) return res.status(404).json({ error: 'unknown provider' });
  const dep = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const started = Date.now();
  try {
    if (!(await adapter.isAvailable())) {
      return res.json({ ok: false, status: 'NOT_CONFIGURED', error: 'credentials not configured' });
    }
    const results = await adapter.search(buildQuery({ origin: 'TLV', destination: 'ATH', departureDate: dep }));
    res.json({ ok: true, status: 'AUTHENTICATED', latencyMs: Date.now() - started, results: results.length });
  } catch (err) {
    res.json({
      ok: false,
      status: /auth|401|403/i.test(String(err)) ? 'AUTH_ERROR' : 'FAILED',
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
  }
});

// ---- admin: manage search engines without redeploying ---------------------

const store = new ProviderStore(db);

/** Every admin route requires ADMIN_TOKEN; without it the API stays closed. */
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'ADMIN_TOKEN is not configured on the server' });
    return;
  }
  const given = String(req.headers['x-admin-token'] ?? '');
  if (given !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

/** Rebuild the live registry so admin edits take effect immediately. */
function refreshCustomProviders(previousNames: string[]): void {
  registry.reloadDynamic(store.adapters(), previousNames);
}

const providerBody = z.object({
  name: z.string().min(2).max(31),
  urlTemplate: z.string().url().startsWith('https://'),
  apiKey: z.string().max(500).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  itemsPath: z.string().max(200).optional(),
  map: z.record(z.string(), z.string()).optional(),
  tier: z.enum(['FREE', 'LOW_COST', 'PAID', 'PREMIUM']).optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  requestsPerMinute: z.number().int().min(1).max(6000).optional(),
  concurrency: z.number().int().min(1).max(50).optional(),
  note: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
});

app.get('/api/admin/providers', requireAdmin, (_req, res) => {
  res.json(store.list().map((p) => ({ ...p, apiKey: undefined, keyMask: p.hasKey ? '••••••••' : '' })));
});

app.post('/api/admin/providers', requireAdmin, (req, res) => {
  const parsed = providerBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const names = store.list().map((p) => p.name);
    const id = store.create(parsed.data);
    refreshCustomProviders(names);
    res.status(201).json({ id });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/admin/providers/:id', requireAdmin, (req, res) => {
  const parsed = providerBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  if (!store.get(id)) return res.status(404).json({ error: 'not found' });
  try {
    const names = store.list().map((p) => p.name);
    store.update(id, parsed.data);
    refreshCustomProviders(names);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Probe an engine before it is saved: make ONE real request and read the
 * response back, so the field mapping comes from what the API actually
 * returns instead of from guesswork. The key never leaves the server.
 */
const probeBody = z.object({
  urlTemplate: z.string().url(),
  apiKey: z.string().max(500).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  origin: z.string().length(3).optional(),
  destination: z.string().length(3).optional(),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Refuse to point the prober at the machine it runs on or a private network. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

app.post('/api/admin/providers/probe', requireAdmin, async (req, res) => {
  const parsed = probeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;
  const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const vars: Record<string, string> = {
    KEY: p.apiKey ?? '',
    origin: p.origin ?? process.env.DEFAULT_ORIGIN ?? 'TLV',
    destination: p.destination ?? 'LHR',
    departureDate: p.departureDate ?? day,
    returnDate: '',
    adults: '1', children: '0', infants: '0',
    cabin: 'ECONOMY', cabinTitle: 'Economy', cabinLower: 'economy',
    currency: currencyService.systemCurrency,
  };
  const url = p.urlTemplate.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(vars[k] ?? ''));
  let target: URL;
  try { target = new URL(url); } catch { return res.status(400).json({ error: 'כתובת לא תקינה' }); }
  // self-hosted setups may legitimately run an engine on the same network, over
  // plain http; both have to be opted into explicitly, never assumed
  const localAllowed = process.env.ALLOW_PRIVATE_PROBE === '1';
  if (isPrivateHost(target.hostname) && !localAllowed) {
    return res.status(400).json({ error: 'לא ניתן לבדוק כתובות ברשת פנימית' });
  }
  if (target.protocol !== 'https:' && !localAllowed) {
    return res.status(400).json({ error: 'נדרשת כתובת https — מפתח API לא נשלח בחיבור לא מוצפן' });
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  for (const [k, v] of Object.entries(p.headers ?? {})) headers[k] = v.replace(/\{KEY\}/g, p.apiKey ?? '');

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const text = await r.text();
    const latencyMs = Date.now() - started;
    let body: unknown;
    try { body = JSON.parse(text); } catch {
      return res.json({
        ok: false, httpStatus: r.status, latencyMs,
        error: r.ok ? 'התשובה אינה JSON' : `השרת החזיר ${r.status}`,
        bodyPreview: text.slice(0, 400),
      });
    }
    if (!r.ok) {
      return res.json({
        ok: false, httpStatus: r.status, latencyMs,
        error: `השרת החזיר ${r.status} — בדקו את המפתח ואת הפרמטרים`,
        bodyPreview: JSON.stringify(body).slice(0, 400),
      });
    }
    const d = discoverMapping(body);
    res.json({ ok: true, httpStatus: r.status, latencyMs, ...d });
  } catch (err) {
    res.json({
      ok: false, latencyMs: Date.now() - started,
      error: ctrl.signal.aborted ? 'הבקשה חרגה מזמן ההמתנה' : (err instanceof Error ? err.message : String(err)),
    });
  } finally {
    clearTimeout(timer);
  }
});

app.delete('/api/admin/providers/:id', requireAdmin, (req, res) => {
  const names = store.list().map((p) => p.name);
  store.remove(Number(req.params.id));
  refreshCustomProviders(names);
  res.status(204).end();
});

/** Is the admin console usable on this deployment? (no secrets revealed) */
app.get('/api/admin/status', (_req, res) => {
  res.json({
    adminTokenConfigured: Boolean(process.env.ADMIN_TOKEN),
    secretConfigured: Boolean(process.env.ADMIN_SECRET && process.env.ADMIN_SECRET.length >= 8),
    storedProviders: (() => { try { return store.list().length; } catch { return 0; } })(),
  });
});

app.get('/api/links', (req, res) => {
  const schema = z.object({
    origin: z.string().length(3),
    destination: z.string().length(3),
    departureDate: z.string(),
    returnDate: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(bookingLinks(parsed.data));
});

/**
 * Display-currency support: rates relative to the system currency, with the
 * fetch timestamp and source so every conversion is traceable. Original prices
 * are never mutated — the client converts for display only.
 */
app.get('/api/currency/rates', (_req, res) => {
  const base = currencyService.systemCurrency;
  const targets = ['ILS', 'USD', 'EUR', 'GBP', 'CHF', 'AED', 'JPY'];
  const rates: Record<string, number> = {};
  for (const t of targets) {
    try {
      rates[t] = currencyService.convert(1, base, t).value;
    } catch { /* unknown currency in the table → omit */ }
  }
  res.json({ base, rates, fetchedAt: currencyService.lastUpdated, source: currencyService.source });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    currency: { system: currencyService.systemCurrency, ratesUpdated: currencyService.lastUpdated, source: currencyService.source },
    providers: registry.list().map((a) => a.name),
    telegram: { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) },
    workerInProcess: process.env.RUN_WORKER === '1',
  });
});

// ---- SSE live updates (§11) ----------------------------------------------

const sseClients = new Set<express.Response>();
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

export function broadcast(event: string, data: unknown): void {
  for (const client of sseClients) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// worker → UI live updates (same-process deployments, RUN_WORKER=1)
bus.on('deals', () => broadcast('deals', { at: new Date().toISOString() }));

// entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3010);
  void currencyService.refresh();
  app.listen(port, () => {
    console.log(`Flight Deal Intelligence API + dashboard: http://localhost:${port}`);
  });
  // Single-service deployments (Render/Railway free tiers): RUN_WORKER=1 runs
  // the 24/7 monitoring agent inside the web process instead of a second service.
  if (process.env.RUN_WORKER === '1') {
    const { MonitorWorker } = await import('../worker/monitor.js');
    new MonitorWorker().start(Number(process.env.WORKER_POLL_SECONDS ?? 60));
  }
}
