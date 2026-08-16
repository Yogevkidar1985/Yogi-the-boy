# Architecture

## Flow

```
User / Claude (MCP) / REST / Dashboard
        │
        ▼
┌─ Flight Agent (§29) ─────────────────────────────┐
│ parse NL → resolve airports/groups → build       │
│ bounded search matrix → fan out (concurrency 4)  │
└──────────────┬───────────────────────────────────┘
               ▼
┌─ Provider Registry (§38/§70) ────────────────────┐
│ order = priority × recent reliability            │
│ fast-flights → fli → (mock, opt-in)              │
│ every attempt recorded to provider_runs          │
└──────────────┬───────────────────────────────────┘
               ▼
┌─ Analysis Service ───────────────────────────────┐
│ dedupe (§37 fingerprint+fuzzy)                   │
│ persist results + price_snapshots (§14)          │
│ route statistics (avg/median/percentile/trend)   │
│ Deal Score §15 weights + anomaly §16 + EF §24    │
└──────────────┬───────────────────────────────────┘
               ▼
   ranked ScoredFlight[] + recommendations (§67)
               │
     ┌─────────┴──────────┐
     ▼                    ▼
  API/Dashboard      Alert Engine (§25-§26)
                     console │ telegram │ webhook
```

## Monitoring loop (§27-§28)

`MonitorWorker.tick()` runs every saved search whose adaptive interval has
elapsed. Interval adaptation:

| Signal | New interval |
|---|---|
| exceptional-deal anomaly seen | 30 min |
| price fell ≥5% vs last run | base/3 (min 60m) |
| price stable (<2% move) | ×1.5, cap 24h / 2×base |
| otherwise | base (default 180m) |

## Data model

All §12 tables exist in SQLite (`src/db/database.ts`). Key tables:
`price_snapshots` (append-only history), `price_statistics` (cached per-route),
`deal_scores`, `provider_runs` (reliability), `saved_searches`+`alerts`+
`alert_deliveries`, `system_events` (observability).

Retention: history kept forever unless `PRICE_RETENTION_DAYS` set (§72).

## Deal Score weights (§15)

historical 20% · market 20% · route-average 15% · drop-velocity 15% ·
airline quality 10% · duration 10% · stops 5% · flexibility/value 5%.

Error-fare candidate = ≥2 independent deviation signals agree (historical,
market, robust z-score anomaly) → mandatory verification disclaimer.

## Scaling path

SQLite → PostgreSQL: schema is portable (no SQLite-specific types in tables);
swap `better-sqlite3` calls for `pg` in `database.ts`, enable the postgres
service in docker-compose. In-process worker → BullMQ on Redis: job names
already match §53 (`flight_search`, `price_monitor`, `alert_delivery`, ...).

## Integration with Flight Finder & the fli skill

Flight Finder (github.com/affromero/flight-finder) can run as a sibling
container (see docker-compose) for its web scraping + charts; this engine's
`FLIGHT_FINDER_URL` env var reserves the adapter slot. The `fli` CLI installed
via pipx is already a live provider here.
