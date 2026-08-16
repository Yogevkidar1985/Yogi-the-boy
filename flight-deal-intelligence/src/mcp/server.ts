/**
 * MCP server (§51-§52): exposes the engine to Claude and other MCP clients
 * over STDIO. Tools mirror the REST API so an agent can search, analyze and
 * create alerts conversationally.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDatabase } from '../db/database.js';
import { buildDefaultRegistry } from '../providers/registry.js';
import { AnalysisService } from '../analyzer/service.js';
import { FlightAgent, buildQuery } from '../agent/agent.js';
import { routeKey } from '../core/types.js';
import { nearbyAirports } from '../core/airports.js';

const db = getDatabase();
const registry = buildDefaultRegistry(db);
const analysis = new AnalysisService(db);
const agent = new FlightAgent(registry, analysis, db);

const server = new McpServer({ name: 'flight-deal-intelligence', version: '0.1.0' });

function jsonContent(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

server.tool(
  'search_flights',
  'Search flights for a specific origin, destination and date. Returns scored results with deal analysis and booking links.',
  {
    origin: z.string().length(3),
    destination: z.string().length(3),
    departureDate: z.string().describe('YYYY-MM-DD'),
    returnDate: z.string().optional(),
    cabin: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']).default('ECONOMY'),
    maxPrice: z.number().optional(),
  },
  async (args) => {
    const outcome = await registry.search(
      buildQuery({
        origin: args.origin.toUpperCase(),
        destination: args.destination.toUpperCase(),
        departureDate: args.departureDate,
        returnDate: args.returnDate,
        cabin: args.cabin,
        maxPrice: args.maxPrice,
      })
    );
    const scored = analysis.analyze(outcome.results);
    return jsonContent({ provider: outcome.provider, count: scored.length, flights: scored.slice(0, 10) });
  }
);

server.tool(
  'search_cheapest_flights',
  'Natural-language flexible search (Hebrew or English). Parses the request, fans out a bounded search matrix and returns the best deals with explanations.',
  { prompt: z.string().min(3).max(500) },
  async (args) => jsonContent(await agent.run(args.prompt))
);

server.tool(
  'search_flexible_dates',
  'Scan a date window for the cheapest departure dates on a route.',
  {
    origin: z.string().length(3),
    destination: z.string().length(3),
    from: z.string().describe('YYYY-MM-DD window start'),
    to: z.string().describe('YYYY-MM-DD window end'),
    tripLengthDays: z.number().int().optional(),
  },
  async (args) => {
    const report = await agent.runParsed({
      origins: [args.origin.toUpperCase()],
      destinations: [args.destination.toUpperCase()],
      departureWindow: { from: args.from, to: args.to },
      tripLengthDays: args.tripLengthDays ? { min: args.tripLengthDays, max: args.tripLengthDays } : undefined,
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'ECONOMY',
      flexibility: 'HIGH',
      mode: 'FLEXIBLE',
      raw: `flexible ${args.origin}->${args.destination}`,
    });
    return jsonContent({ dateMatrix: report.dateMatrix, best: report.best, top: report.top.slice(0, 5) });
  }
);

server.tool(
  'search_cheapest_destination',
  'Cheapest-anywhere mode: given an origin and date window, rank the cheapest destinations.',
  {
    origin: z.string().length(3),
    from: z.string(),
    to: z.string(),
    maxPrice: z.number().optional(),
  },
  async (args) => {
    const report = await agent.runParsed({
      origins: [args.origin.toUpperCase()],
      destinations: [],
      destinationLabel: 'anywhere',
      departureWindow: { from: args.from, to: args.to },
      maxPrice: args.maxPrice,
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'ECONOMY',
      flexibility: 'HIGH',
      mode: 'ANYWHERE',
      raw: `anywhere from ${args.origin}`,
    });
    return jsonContent({ destinations: report.byDestination, disclaimer: report.disclaimer });
  }
);

server.tool(
  'get_price_history',
  'Price history series + statistics for a route (e.g. TLV-JFK).',
  { route: z.string().regex(/^[A-Za-z]{3}-[A-Za-z]{3}$/), days: z.number().int().max(365).default(90) },
  async (args) => {
    const route = args.route.toUpperCase();
    return jsonContent({
      series: db.priceSeries(route, args.days),
      stats: analysis.routeStatistics(route, args.days),
    });
  }
);

server.tool(
  'get_deal_score',
  'Analyze whether a given price is a good deal for a route based on stored history.',
  { route: z.string().regex(/^[A-Za-z]{3}-[A-Za-z]{3}$/), price: z.number().positive() },
  async (args) => {
    const route = args.route.toUpperCase();
    const stats = analysis.routeStatistics(route);
    if (!stats) return jsonContent({ error: 'no history for this route yet — run a search first' });
    const history = db.priceHistory(route).map((h) => h.price);
    const below = history.filter((p) => p < args.price).length;
    const percentile = history.length ? Math.round((below / history.length) * 100) : null;
    return jsonContent({
      route,
      price: args.price,
      stats,
      percentile,
      vsAverage: stats.average ? Math.round(((args.price - stats.average) / stats.average) * 100) + '%' : null,
      verdict:
        stats.average && args.price < stats.average * 0.7
          ? 'exceptional deal vs history'
          : stats.average && args.price < stats.average * 0.9
            ? 'good price vs history'
            : 'around or above typical price',
    });
  }
);

server.tool(
  'create_price_alert',
  'Create a monitored saved search with an alert rule (PRICE_BELOW / DROP_PERCENT / DEAL_SCORE_ABOVE).',
  {
    origin: z.string().length(3),
    destination: z.string().length(3),
    departureDate: z.string(),
    returnDate: z.string().optional(),
    kind: z.enum(['PRICE_BELOW', 'DROP_PERCENT', 'DEAL_SCORE_ABOVE']),
    threshold: z.number().positive(),
    intervalMinutes: z.number().int().min(30).default(180),
  },
  async (args) => {
    const query = buildQuery({
      origin: args.origin.toUpperCase(),
      destination: args.destination.toUpperCase(),
      departureDate: args.departureDate,
      returnDate: args.returnDate,
    });
    const searchId = db.createSavedSearch(
      `${args.origin}-${args.destination} ${args.departureDate}`,
      query, true, args.intervalMinutes
    );
    const alertId = db.createAlert(searchId, args.kind, args.threshold, ['console', 'telegram', 'webhook']);
    return jsonContent({ savedSearchId: searchId, alertId, monitorIntervalMinutes: args.intervalMinutes });
  }
);

server.tool('list_price_alerts', 'List all alert rules and their saved searches.', {}, async () =>
  jsonContent({ alerts: db.listAlerts(), searches: db.listSavedSearches() })
);

server.tool(
  'get_route_statistics',
  'Route intelligence (§44): average/median/lowest/highest/volatility/trend.',
  { route: z.string().regex(/^[A-Za-z]{3}-[A-Za-z]{3}$/) },
  async (args) => jsonContent(analysis.routeStatistics(args.route.toUpperCase()))
);

server.tool(
  'compare_airports',
  'Compare nearby/alternative airports for an origin including estimated positioning costs.',
  { airport: z.string().length(3) },
  async (args) => jsonContent(nearbyAirports(args.airport.toUpperCase()))
);

server.tool(
  'compare_dates',
  'Cheapest observed price per day for a route from stored history.',
  { origin: z.string().length(3), destination: z.string().length(3), days: z.number().int().default(90) },
  async (args) =>
    jsonContent(agent.cheapestDates(args.origin.toUpperCase(), args.destination.toUpperCase(), args.days))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('flight-deal-intelligence MCP server running on stdio');
