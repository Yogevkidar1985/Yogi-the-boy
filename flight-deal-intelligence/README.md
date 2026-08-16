# ✈️ Flight Deal Intelligence

**The question this engine answers is not "what flights exist?" but:**

> *"What is the cheapest flight I can get for my conditions — and is the price
> I found actually low relative to the market and to history?"*

Every price is shown with proof: **Deal Score (0–100)**, % vs the route's
historical average, historical percentile, savings vs typical price, and
booking links — never a bare number.

Built per the *Flight Deal Intelligence* master spec: price discovery +
price intelligence + historical analysis, continuous monitoring with adaptive
scheduling, natural-language search in Hebrew and English, and an MCP server
so Claude can drive the whole engine.

## What it does

- **Search** flights via pluggable providers (fast-flights → fli → mock fallback chain)
- **Track** every observed price in a local database — history is never thrown away
- **Analyze**: average / median / percentile / volatility / trend per route
- **Score** every fare 0–100 with the spec's weight model (§15) and explain *why* it's a deal
- **Detect** anomalies and error-fare candidates (with the mandatory disclaimer)
- **Monitor** saved searches continuously (default every 3h, adaptive 30m–24h by price movement)
- **Alert** on price-below / %-drop / deal-score rules via console, Telegram, webhook
- **Flexible search**: date matrices, "cheapest anywhere", weekend finder, multi-destination,
  nearby airports with positioning cost (true trip cost)
- **Natural language**: "אני רוצה לטוס ליפן בספטמבר, בערך שבועיים" → parsed → search matrix → ranked deals
- **Dashboard**: dark-mode web UI with deal cards, interactive price-history charts, monitors
- **MCP server**: 11 tools (`search_flights`, `search_cheapest_flights`, `get_price_history`,
  `get_deal_score`, `create_price_alert`, …) for Claude Desktop / Claude Code

## Quick start

```bash
cd flight-deal-intelligence
npm install
pip install fast-flights typing_extensions   # provider #1 (no API key needed)
pipx install 'flights[mcp]'                  # provider #2 (fli CLI, optional)

cp .env.example .env                         # defaults work out of the box

npm run seed        # optional: 60 days of synthetic demo history
npm run dev         # API + dashboard on http://localhost:3010
npm run worker      # continuous monitor loop (separate terminal)
```

Open **http://localhost:3010** — search, click "Track this route", and the
worker keeps checking prices and alerting on drops.

### CLI one-shot search

```bash
npm run search -- "אני רוצה לטוס מתל אביב לניו יורק, 7-14 ימים, באוקטובר, הכי זול"
```

### MCP for Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "flight-deal-intelligence": {
      "command": "npx",
      "args": ["tsx", "/path/to/flight-deal-intelligence/src/mcp/server.ts"]
    }
  }
}
```

## Architecture

```
src/
  core/       types (FlightResult §13), airports+nearby (§18), currency (§35), booking links (§47)
  providers/  adapter interface, fast-flights bridge, fli CLI, FlightRadar enrichment,
              mock (§61), registry with reliability-aware fallback (§38, §70)
  db/         SQLite schema — all §12 tables; price history retained forever (§72)
  analyzer/   statistics (§14), Deal Score (§15), anomaly/error-fare (§16/§24), dedup (§37)
  agent/      Hebrew/English NL parser (§30), search-matrix builder (§17-§23, §31-§32),
              recommendations (§67)
  alerts/     rules engine (§25) + channel adapters (§26: console/telegram/webhook)
  worker/     monitor loop with smart scheduling (§27-§28)
  api/        REST API (§50) + SSE + dashboard hosting, Zod validation (§56)
  mcp/        MCP server tools (§51)
web/          dashboard (§41-§45, §64-§66)
scripts/      seed-demo, search-cli, fast_flights_bridge.py
tests/        31 unit/integration tests incl. the §82 acceptance flow
```

Details: [docs/architecture.md](docs/architecture.md) · API: [docs/api.md](docs/api.md) ·
Deployment: [docs/deployment.md](docs/deployment.md)

## Providers

| Provider | Type | Key needed | Role |
|---|---|---|---|
| fast-flights | Google Flights (Python) | no | primary |
| fli | Google Flights (CLI) | no | secondary + cheapest-dates |
| FlightRadar24 | operational enrichment | optional | never a price source |
| SerpAPI | paid fallback | optional | slot reserved |
| mock | synthetic | — | tests/demo only (`MOCK_PROVIDER=1`) |

Provider selection weighs recent success rate, latency and rate-limit state —
a failing provider is skipped, never fatal. The engine **does not** bypass
CAPTCHAs, rate limits or anti-bot protections; a blocked provider is marked
unavailable (§39-§40).

## Environment

See [.env.example](.env.example). Nothing is required for a local start; keys
are only for optional channels (Telegram) and enrichment (FR24).

## Testing

```bash
npm run typecheck && npm test
```

31 tests cover statistics, deal scoring, error-fare detection, dedup/fuzzy
matching, NL parsing (Hebrew+English), provider fallback, alert rules, smart
scheduling, currency normalization and the full §82 acceptance flow.

## Honesty rules (§68-§69)

- Never "the cheapest price in the world" — always *"the lowest price found
  across the sources available to us at search time"*.
- Every price shows *checked X minutes ago*; stale prices are flagged.
- Unusually low fares carry: *"Price appears unusually low. Verify directly
  with the airline before purchasing."*

## Known limitations

- Live Google Flights access requires open network egress; in restricted
  sandboxes only the mock provider works (searches still run end-to-end).
- SQLite by default; the schema is PostgreSQL-portable (scaling path in
  docker-compose.yml + docs/deployment.md).
- Email/WhatsApp/Push alert channels are interface slots, not yet implemented
  (console/Telegram/webhook are).
- Auth is not enabled (single-user self-hosted default).
