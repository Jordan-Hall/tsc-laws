// Updates scripts/ci/durations.json from run-tests.mjs reports, such as the test-report-* artifacts of a CI run on
// main. Each unit gets the median of its first-attempt times across the reports; units missing from the reports
// keep their current value.
//
// Usage: node scripts/ci/update-durations.mjs <report.json ...>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './units.mjs';

const path = join(root, 'scripts/ci/durations.json');
const file = JSON.parse(readFileSync(path, 'utf8'));
const times = new Map();
for (const report of process.argv.slice(2))
  for (const unit of JSON.parse(readFileSync(report, 'utf8')).units)
    times.set(unit.id, [...(times.get(unit.id) ?? []), unit.seconds]);
for (const [id, list] of times) {
  const sorted = list.sort((a, b) => a - b);
  file.seconds[id] = Math.round(sorted[Math.floor(sorted.length / 2)]);
}
file.seconds = Object.fromEntries(Object.entries(file.seconds).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
console.log(`updated ${times.size} units`);
