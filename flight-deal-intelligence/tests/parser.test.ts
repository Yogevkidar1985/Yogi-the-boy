import { describe, it, expect } from 'vitest';
import { parseTripRequest } from '../src/agent/parser.js';

const NOW = new Date('2026-08-16T00:00:00Z');

describe('natural language parser (§17, §30)', () => {
  it('parses the spec §17 example: TLV to Japan in September, ~2 weeks', () => {
    const r = parseTripRequest('אני רוצה לטוס מתל אביב ליפן בספטמבר, בערך לשבועיים', NOW);
    expect(r.origins).toContain('TLV');
    expect(r.destinations).toEqual(expect.arrayContaining(['NRT', 'HND', 'KIX']));
    expect(r.departureWindow.from).toBe('2026-09-01');
    expect(r.departureWindow.to).toBe('2026-09-30');
    expect(r.tripLengthDays!.min).toBeGreaterThanOrEqual(12);
    expect(r.flexibility).toBe('HIGH');
    expect(r.mode).toBe('FLEXIBLE');
  });

  it('parses the §82 acceptance request: NYC, 7-14 days, October', () => {
    const r = parseTripRequest('אני רוצה לטוס מתל אביב לניו יורק, 7-14 ימים, בכל תאריך במהלך אוקטובר', NOW);
    expect(r.origins).toContain('TLV');
    expect(r.destinations).toEqual(expect.arrayContaining(['JFK', 'EWR']));
    expect(r.departureWindow.from).toBe('2026-10-01');
    expect(r.tripLengthDays).toEqual({ min: 7, max: 14 });
  });

  it('parses budget: "אני רוצה אירופה עד 150 יורו"', () => {
    const r = parseTripRequest('אני רוצה אירופה עד 150 יורו', NOW);
    expect(r.maxPrice).toBe(150);
    expect(r.currency).toBe('EUR');
    expect(r.destinations.length).toBeGreaterThan(5);
  });

  it('anywhere mode (§31)', () => {
    const r = parseTripRequest('לא אכפת לי לאן, רק שיהיה זול', NOW);
    expect(r.mode).toBe('ANYWHERE');
  });

  it('weekend mode (§32)', () => {
    const r = parseTripRequest('weekend deal from TLV', NOW);
    expect(r.mode).toBe('WEEKEND');
  });

  it('family passengers (§34)', () => {
    const r = parseTripRequest('מצא לי טיסה זולה למשפחה ליוון באוגוסט', NOW);
    expect(r.passengers.adults).toBe(2);
    expect(r.passengers.children).toBe(2);
    expect(r.destinations).toContain('ATH');
    // August already started → window begins tomorrow, ends at month end
    expect(r.departureWindow.from).toBe('2026-08-17');
    expect(r.departureWindow.to).toBe('2026-08-31');
  });

  it('english: explicit IATA codes', () => {
    const r = parseTripRequest('TLV to JFK in October under $500', NOW);
    expect(r.origins[0]).toBe('TLV');
    expect(r.destinations).toContain('JFK');
    expect(r.maxPrice).toBe(500);
    expect(r.currency).toBe('USD');
  });
});
