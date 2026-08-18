import { describe, it, expect } from 'vitest';
import { ENGINE_CATALOGUE, catalogueForDisplay } from '../src/providers/catalogue.js';

describe('engine catalogue', () => {
  it('has unique ids that are safe as provider names', () => {
    const ids = ENGINE_CATALOGUE.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{2,31}$/);
  });

  it('always points at an https signup page', () => {
    for (const t of ENGINE_CATALOGUE) {
      expect(t.signupUrl.startsWith('https://'), t.id).toBe(true);
      if (t.docsUrl) expect(t.docsUrl.startsWith('https://'), t.id).toBe(true);
    }
  });

  it('gives every READY engine a usable request template', () => {
    for (const t of ENGINE_CATALOGUE.filter((x) => x.readiness === 'READY')) {
      expect(t.urlTemplate, t.id).toBeTruthy();
      expect(t.urlTemplate!.startsWith('https://'), t.id).toBe(true);
      // a search engine has to be addressed by route and date
      expect(t.urlTemplate, t.id).toContain('{origin}');
      expect(t.urlTemplate, t.id).toContain('{destination}');
      expect(t.urlTemplate, t.id).toContain('{departureDate}');
    }
  });

  it('never offers a request template for an engine that cannot search', () => {
    const cannot = ENGINE_CATALOGUE.filter(
      (x) => x.readiness === 'STATUS_ONLY' || x.readiness === 'CLOSED' || x.readiness === 'NEEDS_OAUTH');
    for (const t of cannot) expect(t.urlTemplate, t.id).toBeUndefined();
  });

  it('gives every entry a category', () => {
    const known = new Set(['PRICE_API', 'META', 'GDS', 'NDC', 'AIRLINE', 'AWARD', 'MARKETPLACE', 'STATUS']);
    for (const t of ENGINE_CATALOGUE) expect(known.has(t.category), t.id).toBe(true);
  });

  it('covers every part of the market, not one corner of it', () => {
    const byCat = new Map<string, number>();
    for (const t of ENGINE_CATALOGUE) byCat.set(t.category, (byCat.get(t.category) ?? 0) + 1);
    for (const c of ['PRICE_API', 'META', 'GDS', 'NDC', 'AIRLINE', 'AWARD', 'MARKETPLACE', 'STATUS']) {
      expect(byCat.get(c) ?? 0, c).toBeGreaterThan(0);
    }
    expect(ENGINE_CATALOGUE.length).toBeGreaterThanOrEqual(40);
  });

  it('marks an engine closed rather than hinting at a way around its protection', () => {
    for (const t of ENGINE_CATALOGUE) {
      expect(t.note, t.id).not.toMatch(/\bscraping\b|עוקף|bypass|circumvent/i);
    }
  });

  it('only uses placeholders the adapter actually substitutes', () => {
    const known = new Set(['KEY', 'origin', 'destination', 'departureDate', 'returnDate',
      'adults', 'children', 'infants', 'cabin', 'cabinTitle', 'cabinLower', 'currency']);
    for (const t of ENGINE_CATALOGUE) {
      const text = [t.urlTemplate ?? '', JSON.stringify(t.headers ?? {})].join(' ');
      for (const m of text.matchAll(/\{(\w+)\}/g)) {
        expect(known.has(m[1]!), `${t.id} uses {${m[1]}}`).toBe(true);
      }
    }
  });

  it('keeps a key out of the URL when the vendor expects a header', () => {
    for (const t of ENGINE_CATALOGUE) {
      const headerCarriesKey = JSON.stringify(t.headers ?? {}).includes('{KEY}');
      if (headerCarriesKey) expect(t.urlTemplate ?? '', t.id).not.toContain('{KEY}');
    }
  });

  it('explains every entry and sorts the runnable ones first', () => {
    for (const t of ENGINE_CATALOGUE) expect(t.note.length, t.id).toBeGreaterThan(20);
    const order = catalogueForDisplay().map((t) => t.readiness);
    expect(order[0]).toBe('BUILT_IN');
    expect(order[order.length - 1]).toBe('STATUS_ONLY');
  });

  it('offers a real spread of price sources, not just built-ins', () => {
    const usable = ENGINE_CATALOGUE.filter(
      (t) => t.readiness === 'READY' || t.readiness === 'NEEDS_URL' || t.readiness === 'NEEDS_LOOKUP');
    expect(usable.length).toBeGreaterThanOrEqual(10);
  });
});
