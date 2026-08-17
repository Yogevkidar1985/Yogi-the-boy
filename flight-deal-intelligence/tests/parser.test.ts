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

describe('flight direction is a hard constraint, never a guess', () => {
  const NOW = new Date('2026-08-17T00:00:00Z');
  const dirOf = (t: string) => {
    const r = parseTripRequest(t, NOW);
    return { o: r.origins, d: r.destinations };
  };

  it('Hebrew: מאיטליה לישראל searches Italy → Israel', () => {
    const { o, d } = dirOf('תמצא לי טיסות מאיטליה לישראל');
    expect(o).toContain('FCO');
    expect(d).toEqual(['TLV']);
    expect(o).not.toContain('TLV');
  });

  it('Hebrew: מישראל לאיטליה searches the opposite direction', () => {
    const { o, d } = dirOf('תמצא לי טיסות מישראל לאיטליה');
    expect(o).toEqual(['TLV']);
    expect(d).toContain('FCO');
    expect(d).not.toContain('TLV');
  });

  it('English: from Italy to Israel', () => {
    const { o, d } = dirOf('flights from Italy to Israel');
    expect(o).toContain('FCO');
    expect(d).toEqual(['TLV']);
  });

  it('English: from Israel to Italy', () => {
    const { o, d } = dirOf('flights from Israel to Italy');
    expect(o).toEqual(['TLV']);
    expect(d).toContain('FCO');
  });

  it('airport codes keep their direction both ways', () => {
    expect(dirOf('FCO to TLV').o).toEqual(['FCO']);
    expect(dirOf('FCO to TLV').d).toEqual(['TLV']);
    expect(dirOf('TLV to FCO').o).toEqual(['TLV']);
    expect(dirOf('TLV to FCO').d).toEqual(['FCO']);
  });

  it('country to city and city to country both resolve correctly', () => {
    const a = dirOf('מאיטליה לתל אביב');
    expect(a.o).toContain('FCO');
    expect(a.d).toEqual(['TLV']);
    const b = dirOf('מתל אביב לאיטליה');
    expect(b.o).toEqual(['TLV']);
    expect(b.d).toContain('FCO');
  });

  it('origin is never silently defaulted when the user named one', () => {
    const r = parseTripRequest('טיסות מיוון לישראל', NOW);
    expect(r.origins).toContain('ATH');
    expect(r.missing ?? []).not.toContain('origin');
  });

  it('destination and origin never overlap', () => {
    const r = parseTripRequest('מאיטליה לישראל', NOW);
    for (const code of r.destinations) expect(r.origins).not.toContain(code);
  });

  it('flags ambiguous phrasing that names places without a direction', () => {
    const r = parseTripRequest('איטליה ישראל טיסות', NOW);
    expect(r.ambiguousDirection).toBe(true);
  });
});

describe('constraint extraction', () => {
  const NOW = new Date('2026-08-17T00:00:00Z');
  it('direct-only intent', () => {
    expect(parseTripRequest('טיסה ישירה ללונדון', NOW).maxStops).toBe(0);
    expect(parseTripRequest('nonstop to London', NOW).maxStops).toBe(0);
  });
  it('explicit Hebrew date range', () => {
    const r = parseTripRequest('טיסות מאיטליה לישראל 29 באוגוסט עד 30 באוגוסט', NOW);
    expect(r.departureWindow.from).toBe('2026-08-29');
    expect(r.departureWindow.to).toBe('2026-08-30');
  });
  it('numeric dates', () => {
    const r = parseTripRequest('טיסה ב-29/08', NOW);
    expect(r.departureWindow.from).toBe('2026-08-29');
  });
  it('tomorrow', () => {
    expect(parseTripRequest('טיסה מחר ללונדון', NOW).departureWindow.from).toBe('2026-08-18');
  });
  it('airline preference vs exclusion', () => {
    expect(parseTripRequest('רק אל על ללונדון', NOW).airlines).toEqual(['LY']);
    expect(parseTripRequest('ללונדון בלי ריינאייר', NOW).excludeAirlines).toContain('FR');
  });
  it('baggage and per-person budget', () => {
    const r = parseTripRequest('ליוון עד 1500 שקל לאדם כולל מזוודה', NOW);
    expect(r.checkedBags).toBe(1);
    expect(r.budgetPerPerson).toBe(true);
    expect(r.maxPrice).toBe(1500);
  });
});
