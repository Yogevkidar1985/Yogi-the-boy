import { describe, it, expect } from 'vitest';
import { discoverMapping, findArrays } from '../src/providers/discover.js';
import { GenericHttpAdapter } from '../src/providers/generic.js';
import { buildQuery } from '../src/agent/agent.js';

describe('response-shape discovery', () => {
  it('finds the offers array inside a nested envelope', () => {
    const body = {
      meta: { count: 2 },
      data: {
        itineraries: [
          { fare: { total: 312.5, currency: 'EUR' }, carrier: { iata: 'LY', name: 'El Al', number: 'LY315' },
            dep: '2026-10-12T08:00:00', arr: '2026-10-12T13:00:00', stopCount: 0,
            durationMin: 300, link: 'https://book.example.test/1' },
          { fare: { total: 275, currency: 'EUR' }, carrier: { iata: 'W6', name: 'Wizz', number: 'W6202' },
            dep: '2026-10-12T15:00:00', arr: '2026-10-12T22:30:00', stopCount: 1,
            durationMin: 450, link: 'https://book.example.test/2' },
        ],
      },
    };
    const d = discoverMapping(body);
    expect(d.itemsPath).toBe('data.itineraries');
    expect(d.map.price).toBe('fare.total');
    expect(d.map.currency).toBe('fare.currency');
    expect(d.map.airline).toBe('carrier.iata');
    expect(d.map.departureTime).toBe('dep');
    expect(d.map.arrivalTime).toBe('arr');
    expect(d.map.stops).toBe('stopCount');
    expect(d.map.durationMinutes).toBe('durationMin');
    expect(d.map.bookingUrl).toBe('link');
    expect(d.warnings).toHaveLength(0);
  });

  it('handles a flat top-level array with snake_case keys', () => {
    const body = [
      { price: '199.00', currency_code: 'USD', airline_code: 'FR', flight_number: '1234',
        departure_at: '2026-09-01T06:10:00Z', arrival_at: '2026-09-01T09:40:00Z',
        number_of_changes: 0, duration: 210, deep_link: 'https://x.test/a' },
    ];
    const d = discoverMapping(body);
    expect(d.itemsPath).toBe('');
    expect(d.map.price).toBe('price');
    expect(d.map.currency).toBe('currency_code');
    expect(d.map.airline).toBe('airline_code');
    expect(d.map.flightNumber).toBe('flight_number');
    expect(d.map.stops).toBe('number_of_changes');
    expect(d.map.bookingUrl).toBe('deep_link');
  });

  it('prefers the priced array over an unrelated one', () => {
    const body = {
      airports: [{ code: 'TLV', name: 'Ben Gurion' }, { code: 'LHR', name: 'Heathrow' }],
      offers: [{ total_amount: 410, total_currency: 'ILS', marketing_carrier: 'LX' }],
    };
    const d = discoverMapping(body);
    expect(d.itemsPath).toBe('offers');
    expect(d.map.price).toBe('total_amount');
  });

  it('warns instead of guessing when no price field exists', () => {
    const d = discoverMapping({ results: [{ airline: 'LY', departure: '2026-10-12T08:00:00' }] });
    expect(d.map.price).toBeUndefined();
    expect(d.missing).toContain('price');
    expect(d.warnings.join(' ')).toMatch(/מחיר/);
  });

  it('warns when a price has no currency beside it', () => {
    const d = discoverMapping({ results: [{ price: 250, airline: 'LY' }] });
    expect(d.map.price).toBe('price');
    expect(d.warnings.join(' ')).toMatch(/מטבע/);
  });

  it('never suggests a path that is not in the response', () => {
    const body = { data: [{ fare: { total: 100, currency: 'EUR' }, carrier: { iata: 'LY' } }] };
    const d = discoverMapping(body);
    const exists = (path: string) =>
      path.split('.').reduce<unknown>((a, k) => (a == null ? undefined : (a as Record<string, unknown>)[k]),
        (body.data as unknown[])[0]) !== undefined;
    for (const p of Object.values(d.map)) expect(exists(p)).toBe(true);
  });

  it('reports every candidate array so the operator can override', () => {
    const cands = findArrays({ a: [{ x: 1 }], b: { c: [{ price: 5 }] } });
    expect(cands.map((c) => c.path).sort()).toEqual(['a', 'b.c']);
    expect(cands[0]!.path).toBe('b.c'); // the priced one ranks first
  });

  it('returns an explicit warning when the response holds no array', () => {
    const d = discoverMapping({ error: 'invalid api key' });
    expect(d.itemsPath).toBe('');
    expect(d.warnings.join(' ')).toMatch(/לא נמצא מערך/);
  });

  it('picks the deeper total when several price-like keys exist', () => {
    const d = discoverMapping({ items: [{ total: 900, pricing: { total_price: 450, currency: 'EUR' } }] });
    expect(d.map.price).toBe('pricing.total_price');
  });

  it('produces a mapping the adapter can actually search with', async () => {
    // the shape a third-party API returns, with none of our own naming
    const body = {
      meta: { currency: 'EUR' },
      airports: [{ code: 'TLV' }, { code: 'LHR' }],
      result: {
        offers: [
          { pricing: { total_price: 289.9, currency_code: 'EUR' },
            marketing_carrier: 'LY', carrier_name: 'El Al', flight_no: 'LY315',
            departure_at: '2026-10-12T08:00:00Z', arrival_at: '2026-10-12T12:30:00Z',
            number_of_changes: 0, duration_minutes: 330, deep_link: 'https://book.test/1' },
          { pricing: { total_price: 412, currency_code: 'EUR' },
            marketing_carrier: 'BA', carrier_name: 'British Airways', flight_no: 'BA164',
            departure_at: '2026-10-12T15:00:00Z', arrival_at: '2026-10-12T19:10:00Z',
            number_of_changes: 1, duration_minutes: 370, deep_link: 'https://book.test/2' },
        ],
      },
    };
    const d = discoverMapping(body);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => body })) as never;
    try {
      // feed the discovered mapping straight into the adapter, unedited
      const adapter = new GenericHttpAdapter({
        slot: 'CUSTOM1', name: 'discovered',
        urlTemplate: 'https://api.test/s?key={KEY}&from={origin}&to={destination}',
        key: 'k', headers: {}, itemsPath: d.itemsPath, map: d.map,
        timeoutMs: 5000, costTier: 'FREE',
      });
      const out = await adapter.search(buildQuery({
        origin: 'TLV', destination: 'LHR', departureDate: '2026-10-12',
      }));
      expect(out).toHaveLength(2);
      expect(out[0]!.totalPrice).toBe(289.9);
      expect(out[0]!.currency).toBe('EUR');
      expect(out[0]!.airline).toBe('LY');
      expect(out[0]!.airlineName).toBe('El Al');
      expect(out[0]!.flightNumber).toBe('LY315');
      expect(out[0]!.stops).toBe(0);
      expect(out[0]!.durationMinutes).toBe(330);
      expect(out[0]!.bookingUrl).toBe('https://book.test/1');
      expect(out[1]!.stops).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
