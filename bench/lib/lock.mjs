// Writes tsc-laws.lock for a generated tslaws project without `tslaws accept`, which only a person may run: the bench
// reads the manifest and writes the lock through the same functions `accept` uses (packages/tslaws/dist/lock.js).
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchRoot } from './gen.mjs';

const distUrl = pathToFileURL(join(benchRoot, '..', 'packages', 'tslaws', 'dist') + '/').href;

function lawFiles(dir, root = dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.tslaws') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...lawFiles(full, root));
    else if (/\.laws\.[cm]?ts$/.test(entry) && !/\.proposed\.laws\./.test(entry)) found.push(relative(root, full).replaceAll('\\', '/'));
  }
  return found.sort();
}

/** Locks every law under `dir`. Returns the number of laws locked. */
export async function writeProjectLock(dir) {
  const { readManifest } = await import(distUrl + 'compile.js');
  const { writeLock } = await import(distUrl + 'lock.js');
  const laws = readManifest('builtin', lawFiles(dir), dir);
  const problems = laws.filter((law) => law.problems !== undefined && law.problems.length > 0);
  if (problems.length > 0) throw new Error(`${dir}: ${problems.length} laws cannot be run: ${problems[0].name}: ${problems[0].problems.join('; ')}`);
  writeLock(join(dir, 'tsc-laws.lock'), laws, []);
  return laws.length;
}
