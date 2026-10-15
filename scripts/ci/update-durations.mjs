// Updates scripts/ci/durations.json from run-tests.mjs reports, such as the test-report-* artifacts of a CI run on
// main. Each unit gets the median of its first-attempt times across the reports. The parts of a split test file
// (`file#i/n`) take every nth case, so they cost the same in expectation: each part gets the median over all parts'
// times, which smooths out the runner-to-runner variation of a single run. Units missing from the reports keep their
// current value.
//
// Usage: node scripts/ci/update-durations.mjs <report.json ...>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './units.mjs';

const path = join(root, 'scripts/ci/durations.json');
const file = JSON.parse(readFileSync(path, 'utf8'));
const times = new Map();
const ids = new Set();
for (const report of process.argv.slice(2))
  for (const unit of JSON.parse(readFileSync(report, 'utf8')).units) {
    const key = unit.id.replace(/#.*$/, '#');
    times.set(key, [...(times.get(key) ?? []), unit.seconds]);
    ids.add(unit.id);
  }
for (const id of ids) {
  const sorted = times.get(id.replace(/#.*$/, '#')).sort((a, b) => a - b);
  file.seconds[id] = Math.round(sorted[Math.floor(sorted.length / 2)]);
}
file.seconds = Object.fromEntries(Object.entries(file.seconds).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
console.log(`updated ${ids.size} units`);
