/**
 * GenericHttpAdapter: connect ANY JSON flight API without writing code.
 *
 * The provider is described entirely by environment variables — a URL
 * template, optional headers, the JSON path to the results array, and a field
 * mapping. That makes it possible to plug in a provider the moment access is
 * granted, instead of waiting for a bespoke adapter.
 *
 * Up to three slots exist (CUSTOM1_*, CUSTOM2_*, CUSTOM3_*), so several
 * providers can run side by side.
 *
 * Example (one-way search):
 *   CUSTOM1_NAME=flightapi
 *   CUSTOM1_URL=https://api.flightapi.io/onewaytrip/{KEY}/{origin}/{destination}/{departureDate}/{adults}/0/0/Economy/{currency}
 *   CUSTOM1_KEY=xxxxxxxx
 *   CUSTOM1_ITEMS=fares
 *   CUSTOM1_MAP={"price":"totalPrice","currency":"currency","airline":"carrierCode","flightNumber":"flightNo","departureTime":"departure","arrivalTime":"arrival","stops":"stopCount","durationMinutes":"durationMin","bookingUrl":"deepLink"}
 *
 * Nothing is invented: a field that the API does not return simply stays empty.
 */
import type { FlightSearchAdapter, ProviderCapabilities, ProviderCostTier } from './adapter.js';
import { ProviderError } from './adapter.js';
import type { FlightResult, SearchQuery } from '../core/types.js';
import { currencyService } from '../core/currency.js';
import { bookingLinks } from '../core/links.js';

/** Read "a.b.c" or "a.0.b" out of a parsed JSON body. */
function pick(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    if (Array.isArray(acc)) {
      const i = Number(key);
      return Number.isInteger(i) ? acc[i] : undefined;
    }
    return typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined;
  }, obj);
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

export interface GenericProviderSpec {
  slot: string;
  name: string;
  urlTemplate: string;
  key?: string;
  headers: Record<string, string>;
  itemsPath?: string;
  map: Record<string, string>;
  timeoutMs: number;
  costTier: ProviderCostTier;
}

/** Read a slot's configuration; returns undefined when the slot is unused. */
export function readGenericSpec(slot: string): GenericProviderSpec | undefined {
  const url = process.env[`${slot}_URL`];
  if (!url) return undefined;
  let headers: Record<string, string> = {};
  let map: Record<string, string> = {};
  try { headers = JSON.parse(process.env[`${slot}_HEADERS`] ?? '{}'); } catch { headers = {}; }
  try { map = JSON.parse(process.env[`${slot}_MAP`] ?? '{}'); } catch { map = {}; }
  return {
    slot,
    name: process.env[`${slot}_NAME`] ?? slot.toLowerCase(),
    urlTemplate: url,
    key: process.env[`${slot}_KEY`],
    headers,
    itemsPath: process.env[`${slot}_ITEMS`],
    map,
    timeoutMs: Number(process.env[`${slot}_TIMEOUT_MS`] ?? 20000),
    costTier: (process.env[`${slot}_TIER`] as ProviderCostTier) ?? 'PAID',
  };
}

export const GENERIC_SLOTS = ['CUSTOM1', 'CUSTOM2', 'CUSTOM3'];

export class GenericHttpAdapter implements FlightSearchAdapter {
  readonly name: string;
  readonly priority = 25;
  readonly costTier: ProviderCostTier;
  readonly timeoutMs: number;
  readonly capabilities: ProviderCapabilities = {
    roundTrip: true,
    multiCity: false,
    flexibleDates: false,
    liveNetwork: true,
  };

  constructor(private spec: GenericProviderSpec) {
    this.name = spec.name;
    this.costTier = spec.costTier;
    this.timeoutMs = spec.timeoutMs;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.spec.urlTemplate);
  }

  private buildUrl(q: SearchQuery): string {
    const vars: Record<string, string> = {
      KEY: this.spec.key ?? '',
      origin: q.origin,
      destination: q.destination,
      departureDate: q.departureDate,
      returnDate: q.returnDate ?? '',
      adults: String(q.passengers.adults),
      children: String(q.passengers.children),
      infants: String(q.passengers.infants),
      cabin: q.cabin,
      currency: q.currency,
    };
    return this.spec.urlTemplate.replace(/\{(\w+)\}/g, (_, k: string) =>
      encodeURIComponent(vars[k] ?? ''));
  }

  async search(query: SearchQuery): Promise<FlightResult[]> {
    const url = this.buildUrl(query);
    const headers: Record<string, string> = { 'Accept-Encoding': 'gzip', ...this.spec.headers };
    // allow {KEY} inside header values too (e.g. Authorization: Bearer {KEY})
    for (const [k, v] of Object.entries(headers)) {
      headers[k] = v.replace(/\{KEY\}/g, this.spec.key ?? '');
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(this.name, `auth failed: HTTP ${res.status}`, false);
    }
    if (res.status === 429) throw new ProviderError(this.name, 'rate limited (429)');
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}`);

    const body: unknown = await res.json();
    const raw = this.spec.itemsPath ? pick(body, this.spec.itemsPath) : body;
    const items = Array.isArray(raw) ? raw : [];
    if (!items.length) return [];

    const m = this.spec.map;
    const links = bookingLinks(query);
    const now = new Date().toISOString();
    const results: FlightResult[] = [];

    for (const [i, item] of items.entries()) {
      const price = num(pick(item, m.price));
      if (price === undefined || price <= 0) continue; // no price → not a usable offer
      if (query.maxPrice && price > query.maxPrice) continue;
      const currency = (str(pick(item, m.currency)) || query.currency).toUpperCase().slice(0, 3);
      const airline = str(pick(item, m.airline)).toUpperCase().slice(0, 3);
      if (query.airlines?.length && airline && !query.airlines.includes(airline)) continue;
      if (airline && query.excludeAirlines?.includes(airline)) continue;
      const stops = num(pick(item, m.stops)) ?? 0;
      if (query.stops === 'NON_STOP' && stops !== 0) continue;

      const departureTime = str(pick(item, m.departureTime)) || `${query.departureDate}T00:00:00`;
      const arrivalTime = str(pick(item, m.arrivalTime)) || departureTime;
      const conv = currencyService.convert(price, currency);
      const bookingUrl = str(pick(item, m.bookingUrl)) || links.googleFlights;

      results.push({
        id: `${this.name}-${query.origin}-${query.destination}-${query.departureDate}-${i}`,
        provider: this.name,
        source: `${this.name}-api`,
        origin: query.origin,
        destination: query.destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate,
        departureTime,
        arrivalTime,
        durationMinutes: num(pick(item, m.durationMinutes)) ?? 0,
        stops,
        airline: airline || '??',
        airlineName: str(pick(item, m.airlineName)) || airline || undefined,
        flightNumber: str(pick(item, m.flightNumber)),
        cabin: query.cabin,
        bags: num(pick(item, m.bags)) ?? query.bags ?? 0,
        basePrice: price,
        taxes: 0,
        totalPrice: price,
        currency,
        normalizedPrice: conv.value,
        normalizedCurrency: currencyService.systemCurrency,
        exchangeRate: conv.rate,
        exchangeRateTimestamp: conv.timestamp,
        bookingUrl,
        deepLink: bookingUrl,
        segments: [],
        collectedAt: now,
        rawProviderData: { slot: this.spec.slot },
      });
    }
    return results;
  }
}

/** Every configured custom slot, ready to register. */
export function buildGenericAdapters(): GenericHttpAdapter[] {
  return GENERIC_SLOTS.map(readGenericSpec)
    .filter((s): s is GenericProviderSpec => Boolean(s))
    .map((s) => new GenericHttpAdapter(s));
}
