/**
 * CLI entry: `npm run search -- "אני רוצה לטוס ליוון בספטמבר הכי זול"`
 * Runs the full agent flow and prints a readable report (§82).
 */
import { FlightAgent } from '../src/agent/agent.js';

const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
  console.error('usage: npm run search -- "<trip description in Hebrew or English>"');
  process.exit(1);
}

const agent = new FlightAgent();
const report = await agent.run(prompt);

console.log(`\n=== Flight Deal Intelligence ===`);
console.log(`Parsed: ${report.request.origins.join('/')} → ${report.request.destinationLabel ?? report.request.destinations.join(',')} | window ${report.request.departureWindow.from}..${report.request.departureWindow.to} | mode ${report.request.mode}`);
console.log(`Ran ${report.totalQueries} queries via [${report.providersUsed.join(', ')}], ${report.totalResults} fares, ${(report.elapsedMs / 1000).toFixed(1)}s\n`);

if (!report.best) {
  console.log('No results — all providers unavailable.');
  process.exit(2);
}

const b = report.best;
console.log(`CHEAPEST: ${b.normalizedPrice} ${b.normalizedCurrency} — ${b.origin} → ${b.destination} on ${b.departureDate}${b.returnDate ? ` (return ${b.returnDate})` : ''}`);
console.log(`  ${b.airlineName ?? b.airline}, ${b.stops === 0 ? 'direct' : `${b.stops} stop(s)`}, Deal Score ${b.analysis.dealScore}/100`);
for (const e of b.analysis.explanation) console.log(`  • ${e}`);
if (b.analysis.disclaimer) console.log(`  ⚠ ${b.analysis.disclaimer}`);
console.log(`  Book: ${b.bookingUrl}`);

if (report.bestValue && report.bestValue.id !== b.id) {
  const v = report.bestValue;
  console.log(`\nBEST VALUE: ${v.normalizedPrice} ${v.normalizedCurrency} — ${v.airlineName ?? v.airline}, ${v.stops === 0 ? 'direct' : `${v.stops} stop(s)`}, value ${v.valueScore}`);
}

console.log('\nTOP 10 BY PRICE:');
for (const f of report.top) {
  console.log(`  ${String(f.normalizedPrice).padStart(7)} ${f.normalizedCurrency}  ${f.origin}→${f.destination}  ${f.departureDate}  ${(f.airlineName ?? f.airline).padEnd(18)} score ${f.analysis.dealScore}`);
}

if (report.byDestination.length > 1) {
  console.log('\nCHEAPEST BY DESTINATION:');
  for (const d of report.byDestination.slice(0, 10)) {
    console.log(`  ${d.destination} ${(d.destinationName ?? '').padEnd(35)} ${d.best.normalizedPrice} ${d.best.normalizedCurrency}`);
  }
}

for (const r of report.recommendations) console.log(`\n💡 ${r}`);
console.log(`\n${report.disclaimer}`);
