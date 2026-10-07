import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node tools/export-graph.mjs input.json graph.json');
const reference = JSON.parse(
  execFileSync(resolve('dist/tsgo-oracle'), [resolve(input)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }),
);
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify(reference.graph) + '\n');
console.log(output);
