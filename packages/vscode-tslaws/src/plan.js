'use strict';

// Chooses which laws files to run for a change to one file. Pure.

const SOURCE = /\.(ts|tsx|mts|cts)$/;

/** A project TypeScript source that a law could cover or be: not a declaration file, not generated output. */
function isRunnable(rel) {
  if (!SOURCE.test(rel) || /\.d\.(ts|mts|cts)$/.test(rel)) return false;
  return !rel.split('/').some((part) => part === 'node_modules' || part === '.tslaws' || part === '.git');
}

const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/**
 * @param {{file: string, lawFiles: string[], coverage: Map<string, Set<string>> | null}} o
 *   `file` is the changed file relative to the workspace; `lawFiles` every `*.laws.ts` known; `coverage` which law files
 *   reached each source file in the last report
 * @returns {{files: string[] | null, reason: 'law' | 'covered' | 'nearby' | 'all' | 'none'}} files null means all laws
 */
function planRun({ file, lawFiles, coverage }) {
  if (!isRunnable(file)) return { files: [], reason: 'none' };
  // Proposed laws run only when asked for with `--proposed`; they are not part of the check.
  if (file.endsWith('.proposed.laws.ts')) return { files: [], reason: 'none' };
  const accepted = lawFiles.filter((f) => !f.endsWith('.proposed.laws.ts'));
  if (file.endsWith('.laws.ts')) return { files: [file], reason: 'law' };
  if (accepted.length === 0) return { files: [], reason: 'none' };
  const covering = coverage?.get(file);
  if (covering !== undefined && covering.size > 0) return { files: [...covering].sort(), reason: 'covered' };
  // The law file beside it (`cart.ts` and `cart.laws.ts`), else the laws files of the nearest folder that has any.
  const sibling = file.replace(SOURCE, '.laws.ts');
  if (accepted.includes(sibling)) return { files: [sibling], reason: 'nearby' };
  for (let dir = dirOf(file); ; dir = dirOf(dir)) {
    const here = accepted.filter((f) => dirOf(f) === dir);
    if (here.length > 0) return { files: here.sort(), reason: 'nearby' };
    if (dir === '') break;
  }
  return { files: null, reason: 'all' };
}

module.exports = { planRun, isRunnable };
