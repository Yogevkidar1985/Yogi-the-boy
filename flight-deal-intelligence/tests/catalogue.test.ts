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
    for (const t of ENGINE_CATALOGUE.filter((x) => x.readiness === 'STATUS_ONLY' || x.readiness === 'CLOSED')) {
      expect(t.urlTemplate, t.id).toBeUndefined();
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
