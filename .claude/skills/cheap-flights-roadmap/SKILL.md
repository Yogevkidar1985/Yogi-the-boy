---
name: cheap-flights-roadmap
description: >
  Roadmap and curated resource map for finding cheap flights, based on the
  awesome-flights list. Use whenever the user wants to find cheap flights,
  compare flight prices, hunt error fares, pick low-cost airlines, plan
  stopovers, claim delay compensation, or asks "where should I search for
  flights". Also triggers on Hebrew requests like: טיסות זולות, מחירי טיסות,
  דילים לטיסות, לואו קוסט, איפה לחפש טיסות. Combines with the fli skill
  (Google Flights CLI/MCP) and the Flight Finder price tracker.
license: CC0-1.0
---

# Cheap Flights Roadmap

Use this skill as the master playbook when helping the user find cheap flights.
It maps every stage of the hunt to the right tool or resource, and ties into
the user's installed engines.

## The user's own engines (check these first)

Before recommending external sites, remember the user has two engines set up:

1. **fli** (`pipx install 'flights[mcp]'`) — Google Flights CLI + MCP server.
   - Specific date search: `fli flights TLV JFK 2026-10-25`
   - Cheapest-date scan: `fli dates TLV JFK --from 2026-10-01 --to 2026-10-31`
   - Full usage guidance lives in the `fli` skill.
2. **Flight Finder** (github.com/affromero/flight-finder) — self-hosted
   continuous price tracker with charts, web UI at `localhost:3003`.
   Use it for tracking price evolution over time and alerting on drops.

Both need direct access to Google Flights, so in restricted networks fall back
to the web resources below.

## Strategy: how to hunt a cheap flight

Work through these stages in order; each stage maps to a section in
`resources.md`:

1. **Broad scan** — find the general price level for the route.
   Use fli / Google Flights, [Kiwi](https://kiwi.com) (aggressive virtual
   interlining), and [ITA Matrix](http://matrix.itasoftware.com/) for
   power-search syntax.
2. **Flexible dates** — cheapest day matters more than cheapest airline.
   Use `fli dates`, or Azair for low-cost combinations across a whole month.
3. **Low-cost carriers** — check `lowcost.md` for the low-cost airline list
   (Ryanair, Wizzair, EasyJet, Pegasus, Aegean...). Many do not appear in all
   aggregators, so check them directly. [Azair](http://www.azair.eu/) combines
   almost all of them, including self-transfer combos.
4. **Error fares and deals** — subscribe/check aggregators from the
   "Error fares" section: [Skiplagged](https://skiplagged.com) (hidden-city),
   [Secret Flying](http://www.secretflying.com/), [The Flight Deal](https://www.theflightdeal.com).
   Error fares die fast — book first, plan later, and don't attach frequent
   flyer numbers to hidden-city tickets.
5. **Alternative airports** — use [FlightConnections](https://www.flightconnections.com/)
   and [Flightsfrom](https://www.flightsfrom.com) to see all routes from
   nearby airports. From Israel, also consider Larnaca (LCA), Athens (ATH),
   and Istanbul (IST/SAW) as cheap launch pads reachable by low-cost hops.
6. **Stopovers as a feature** — long layovers can be free vacations
   (e.g. Turkish Airlines offers a free hotel/Istanbul tour for 8h+
   stopovers). [Airwander](https://airwander.com/) searches long-stopover
   itineraries on purpose.
7. **Alliances and families** — `alliances.md` maps airline alliances
   (oneworld, Star Alliance, SkyTeam) and parent/sister companies
   (Lufthansa group, IAG, Singapore/Scoot). Useful for award tickets,
   codeshares, and knowing which "different" airlines share inventory.

## After booking / if things go wrong

- **Delays and cancellations**: EU Regulation 261/2004 grants up to €600
  compensation for delays 3h+ on EU-connected flights. Services like
  [AirHelp](https://airhelp.com) or [Compensair](https://www.compensair.com/en/)
  file claims for a cut of the payout.
- **Seat choice**: [SeatGuru](https://www.seatguru.com/) before check-in.
- **Sleeping in airports**: [sleepinginairports.net](https://www.sleepinginairports.net/)
  for long layovers on a budget.

## Reference files

- `resources.md` — the full curated list (search engines, communities,
  charters, empty legs, plane watching, charts, and more).
- `lowcost.md` — low-cost airline list with destination maps.
- `alliances.md` — airline alliances and parent/sistership companies.

Read them when the user's request touches a category not summarized above
(charter flights, empty legs, private pilot ride-shares, plane spotting,
group travel, aviation data APIs).

## How to answer well

- Lead with the user's own engines (fli, Flight Finder) when they are usable;
  fall back to the curated web resources when they are not.
- For "find me a cheap flight to X" — run the strategy stages in order and
  present concrete options with prices, not just links.
- For Hebrew requests, answer in Hebrew but keep airport codes, airline
  names, and site names in English.
- Some links in the curated list are old (the list predates 2021); if a site
  is dead, say so and use the nearest alternative from the same section.
