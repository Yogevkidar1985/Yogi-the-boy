/**
 * Core domain types for Flight Deal Intelligence.
 * FlightResult follows spec §13; search/query types support §17-§23, §30-§34.
 */

export type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
export type StopsFilter = 'ANY' | 'NON_STOP' | 'ONE_STOP' | 'TWO_PLUS_STOPS';
export type SortBy = 'CHEAPEST' | 'DURATION' | 'DEPARTURE_TIME' | 'ARRIVAL_TIME' | 'VALUE';

export interface Passengers {
  adults: number;
  children: number;
  infants: number;
}

export const DEFAULT_PASSENGERS: Passengers = { adults: 1, children: 0, infants: 0 };

/** A single flight leg request: origin → destination on a date. */
export interface SegmentQuery {
  origin: string; // IATA code
  destination: string; // IATA code
  date: string; // YYYY-MM-DD
}

/** Full search query. Round trip = returnDate set; open jaw / multi-city = segments. */
export interface SearchQuery {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  /** Open-jaw / multi-city legs (§22-§23). When set, overrides origin/destination/dates. */
  segments?: SegmentQuery[];
  passengers: Passengers;
  cabin: CabinClass;
  stops: StopsFilter;
  maxPrice?: number;
  airlines?: string[];
  excludeAirlines?: string[];
  currency: string;
  /** departure time window "6-20" (hours) */
  departureTimeWindow?: [number, number];
  bags?: number;
}

export interface FlightSegment {
  origin: string;
  destination: string;
  departureTime: string; // ISO
  arrivalTime: string; // ISO
  airline: string;
  airlineName?: string;
  flightNumber: string;
  aircraft?: string;
  durationMinutes: number;
}

/** Normalized flight result — spec §13. */
export interface FlightResult {
  id: string;
  provider: string;
  source: string;
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  departureTime: string;
  arrivalTime: string;
  durationMinutes: number;
  stops: number;
  airline: string;
  airlineName?: string;
  flightNumber: string;
  aircraft?: string;
  cabin: CabinClass;
  bags: number;
  basePrice: number;
  taxes: number;
  totalPrice: number;
  currency: string;
  /** Price normalized to the system currency (§35). */
  normalizedPrice: number;
  normalizedCurrency: string;
  exchangeRate: number;
  exchangeRateTimestamp: string;
  bookingUrl: string;
  deepLink: string;
  segments: FlightSegment[];
  collectedAt: string; // ISO
  rawProviderData?: unknown;
}

/** Statistics for a route's price history — §14, §44. */
export interface RouteStatistics {
  route: string; // "TLV-JFK"
  sampleCount: number;
  lowest: number;
  highest: number;
  average: number;
  median: number;
  stdDev: number;
  /** current price percentile 0-100 (lower = cheaper than history) */
  volatility: number; // stdDev / average
  trend: 'RISING' | 'FALLING' | 'STABLE';
  windowDays: number;
}

export interface DealAnalysis {
  dealScore: number; // 0-100 (§15)
  scoreBreakdown: Record<string, number>;
  percentile: number | null; // where current price sits in history
  vsAverage: number | null; // e.g. -0.31 = 31% below average
  vsLowest: number | null;
  isExceptional: boolean; // §16
  isErrorFareCandidate: boolean; // §24
  explanation: string[]; // §71 "Why this is a good deal"
  disclaimer?: string;
}

export interface ScoredFlight extends FlightResult {
  analysis: DealAnalysis;
  valueScore: number; // §46
  freshnessMinutes: number; // §69
}

/** Parsed natural-language request — §17, §30. */
export interface ParsedTripRequest {
  origins: string[];
  destinations: string[]; // IATA codes, may be several (multi-destination §21)
  destinationLabel?: string; // "Japan", "Europe", "anywhere"
  departureWindow: { from: string; to: string };
  tripLengthDays?: { min: number; max: number };
  maxPrice?: number;
  currency?: string;
  passengers: Passengers;
  cabin: CabinClass;
  flexibility: 'NONE' | 'LOW' | 'HIGH';
  mode: 'SPECIFIC' | 'FLEXIBLE' | 'ANYWHERE' | 'WEEKEND';
  raw: string;
}

export interface ProviderHealth {
  provider: string;
  successCount: number;
  errorCount: number;
  successRate: number;
  avgLatencyMs: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  rateLimited: boolean;
  available: boolean;
  confidence: number; // 0-1, used for provider selection §38/§70
}

export interface AlertRule {
  id: number;
  savedSearchId: number;
  kind: 'PRICE_BELOW' | 'DROP_PERCENT' | 'DEAL_SCORE_ABOVE';
  threshold: number;
  channels: string[]; // channel adapter names
  active: boolean;
  createdAt: string;
}

export interface SavedSearch {
  id: number;
  name: string;
  query: SearchQuery;
  monitor: boolean;
  intervalMinutes: number; // §27
  adaptiveIntervalMinutes?: number; // §28 smart scheduling
  lastRunAt: string | null;
  lastLowestPrice: number | null;
  createdAt: string;
}

export function routeKey(origin: string, destination: string): string {
  return `${origin.toUpperCase()}-${destination.toUpperCase()}`;
}
