import { describe, it, expect } from 'vitest';
import { scoreDestination, pickHuntTargets } from '../src/worker/monitor.js';

const H = 3600_000;

describe('deal hunter route priority', () => {
  it('never scanned outranks a route scanned recently with no drops', () => {
    const now = Date.now();
    const lastScanned = new Map([['TLV-BUD', now - 1 * H]]);
    const never = scoreDestination('TLV-SOF', new Map(), lastScanned, now);
    const recentlyScanned = scoreDestination('TLV-BUD', new Map(), lastScanned, now);
    expect(never).toBeGreaterThan(recentlyScanned);
  });

  it('a route with recent price drops outranks an equally-stale one without', () => {
    const now = Date.now();
    const lastScanned = new Map([['TLV-BUD', now - 6 * H], ['TLV-SOF', now - 6 * H]]);
    const dropCounts = new Map([['TLV-BUD', 3]]);
    const withDrops = scoreDestination('TLV-BUD', dropCounts, lastScanned, now);
    const withoutDrops = scoreDestination('TLV-SOF', dropCounts, lastScanned, now);
    expect(withDrops).toBeGreaterThan(withoutDrops);
  });

  it('staleness alone cannot starve a route forever: it eventually re-qualifies', () => {
    const now = Date.now();
    // scanned 10 days ago, no drops — should still rank above a route hot off a scan
    const stale = scoreDestination('TLV-WAW', new Map(), new Map([['TLV-WAW', now - 240 * H]]), now);
    const justScanned = scoreDestination('TLV-PRG', new Map(), new Map([['TLV-PRG', now - 0.1 * H]]), now);
    expect(stale).toBeGreaterThan(justScanned);
  });

  it('staleness bonus is capped so it cannot out-rank a genuinely hot route indefinitely', () => {
    const now = Date.now();
    const veryStale = scoreDestination('TLV-OTP', new Map(), new Map([['TLV-OTP', now - 100000 * H]]), now);
    const hot = scoreDestination('TLV-ATH', new Map([['TLV-ATH', 5]]), new Map([['TLV-ATH', now - 1 * H]]), now);
    expect(hot).toBeGreaterThan(veryStale);
  });

  it('picks exactly N targets, ranked by score, deterministic on ties', () => {
    const now = Date.now();
    const candidates = ['SOF', 'BUD', 'ATH', 'WAW', 'OTP'];
    const dropCounts = new Map([['TLV-ATH', 4]]);
    const lastScanned = new Map([
      ['TLV-SOF', now - 1 * H], ['TLV-BUD', now - 1 * H],
      ['TLV-WAW', now - 1 * H], ['TLV-OTP', now - 1 * H],
    ]); // ATH never scanned
    const picked = pickHuntTargets(candidates, dropCounts, lastScanned, now, 3, (d) => `TLV-${d}`);
    expect(picked).toHaveLength(3);
    expect(picked[0]).toBe('ATH'); // never scanned + drops: clear top pick
    // the remaining four are tied (all scanned 1h ago, no drops) — alphabetical tiebreak
    expect(picked.slice(1)).toEqual(['BUD', 'OTP']);
  });

  it('every candidate is a real airport code already in the curated list — nothing invented', async () => {
    const { ANYWHERE_DESTINATIONS } = await import('../src/core/airports.js');
    const picked = pickHuntTargets(ANYWHERE_DESTINATIONS, new Map(), new Map(), Date.now(), 5, (d) => `TLV-${d}`);
    for (const dest of picked) expect(ANYWHERE_DESTINATIONS).toContain(dest);
  });
});
