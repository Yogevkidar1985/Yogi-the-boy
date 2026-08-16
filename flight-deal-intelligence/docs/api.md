# API Reference (§50)

Base URL: `http://localhost:3010`

## Flights

| Method | Path | Description |
|---|---|---|
| GET | `/api/flights/search?origin=TLV&destination=LHR&departureDate=2026-10-12[&returnDate=...&cabin=...&stops=...&maxPrice=...&adults=...]` | search + score |
| POST | `/api/flights/search` | same, JSON body |
| GET | `/api/flights/:id` | stored result by id |

Response flights include `analysis` (dealScore, breakdown, percentile,
vsAverage, explanation, disclaimer), `valueScore`, `freshnessMinutes`,
`bookingUrl`, `deepLink`.

## AI search

| POST | `/api/ai/search` | body `{"prompt":"אני רוצה לטוס ליוון בספטמבר..."}` → full agent report (best, top-10, byDestination, dateMatrix, recommendations) |
| POST | `/api/ai/parse` | parse only — returns the structured trip request |

## Routes & history

| GET | `/api/routes/TLV-LHR/history?days=90` | daily low/avg series + statistics |
| GET | `/api/routes/TLV-LHR/cheapest-dates?days=90` | cheapest observed price per day |

## Saved searches & monitoring

| POST | `/api/searches` | `{name, query:{...}, monitor:true, intervalMinutes:180}` |
| GET | `/api/searches` | list with adaptive interval + last run/low |
| DELETE | `/api/searches/:id` | remove search + its alerts |
| POST | `/api/searches/:id/run` | run now |

## Alerts

| POST | `/api/alerts` | `{savedSearchId, kind: PRICE_BELOW\|DROP_PERCENT\|DEAL_SCORE_ABOVE, threshold, channels:["console","telegram","webhook"]}` |
| GET | `/api/alerts` | list |

## Other

| GET | `/api/deals?limit=20` | best recent deals (dashboard feed) |
| GET | `/api/airports?q=tel` | airport lookup |
| GET | `/api/airports/TLV/nearby` | alternates + positioning cost |
| GET | `/api/airlines` | airline list |
| GET | `/api/providers` | provider health (§38) |
| GET | `/api/links?origin=..&destination=..&departureDate=..` | booking deep links |
| GET | `/api/health` | health endpoint |
| GET | `/api/events` | SSE stream (live updates) |

## MCP tools (§51)

`search_flights`, `search_cheapest_flights` (NL), `search_flexible_dates`,
`search_cheapest_destination`, `get_price_history`, `get_deal_score`,
`create_price_alert`, `list_price_alerts`, `get_route_statistics`,
`compare_airports`, `compare_dates`.
