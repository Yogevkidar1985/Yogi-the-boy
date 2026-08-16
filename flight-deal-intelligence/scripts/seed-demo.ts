/**
 * Demo seeder: simulates 60 days of monitoring history using the mock provider
 * with a shifted clock, so charts, statistics and deal scores have data on a
 * fresh install. Clearly synthetic — remove data/flight-intel.db to reset.
 */
process.env.MOCK_PROVIDER = '1';

import { FlightDatabase } from '../src/db/database.js';
import { MockFlightProvider } from '../src/providers/mock.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { AnalysisService } from '../src/analyzer/service.js';
import { buildQuery } from '../src/agent/agent.js';

const ROUTES: [string, string][] = [
  ['TLV', 'LHR'], ['TLV', 'JFK'], ['TLV', 'ATH'], ['TLV', 'LCA'],
  ['TLV', 'CDG'], ['TLV', 'BER'], ['TLV', 'BKK'], ['TLV', 'NRT'],
];

const db = new FlightDatabase();
const analysis = new AnalysisService(db);

async function seed() {
  console.log('Seeding 60 days of synthetic monitoring history...');
  for (let daysAgo = 60; daysAgo >= 0; daysAgo -= 2) {
    const observedAt = new Date(Date.now() - daysAgo * 86400000);
    const provider = new MockFlightProvider(() => observedAt);
    const registry = new ProviderRegistry(db);
    registry.register(provider);
    for (const [origin, destination] of ROUTES) {
      const departure = new Date(observedAt.getTime() + 30 * 86400000).toISOString().slice(0, 10);
      const outcome = await registry.search(
        buildQuery({ origin, destination, departureDate: departure })
      );
      // persist with the shifted observation time
      analysis.analyze(outcome.results);
    }
    process.stdout.write('.');
  }
  console.log('\nDone. Routes seeded:', ROUTES.map(([a, b]) => `${a}-${b}`).join(', '));
  const count = db.db.prepare('SELECT COUNT(*) AS n FROM price_snapshots').get() as { n: number };
  console.log(`price_snapshots rows: ${count.n}`);
}

await seed();
