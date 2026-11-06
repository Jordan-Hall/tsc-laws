// `tslaws list`: the laws files of the project with the level each runs at and where it stands, so an editor or an agent
// can ask the tool instead of matching file names. It reads files and the lock; it compiles and runs nothing.
import { join } from 'node:path';
import { discoverLaws, discoverProposals } from './lawFiles.ts';
import { readConfig } from './coverage.ts';
import { classifyLawFile, type LawKind } from './lawKinds.ts';
import { readLock } from './lock.ts';

export interface ListedFile {
  /** Project-relative path with forward slashes. */
  file: string;
  /** The level it runs at: from its name by default, from what it imports with `levels: "imports"`. */
  kind: LawKind;
  /**
   * `accepted`: the lock has laws of this file. `unaccepted`: in the tree, but the lock has none of it, so `check`
   * fails it until a person runs `tslaws accept`. `proposed`: a proposal (in `.tslaws/proposals`, or an
   * in-tree `*.proposed.laws.ts`); no lock, no coverage.
   */
  status: 'accepted' | 'unaccepted' | 'proposed';
  /** Set when the file cannot run at one level (it reaches both APIs). */
  error?: string;
  /** Where a proposal lives: `proposals` (the directory) or `name` (an in-tree `*.proposed.laws.ts` name). */
  proposal?: 'proposals' | 'name';
  notices: string[];
}

/** Every laws file and proposal of the project, sorted by path, accepted and unaccepted before proposed. */
export function listLawFiles(cwd: string): ListedFile[] {
  const mode = readConfig(cwd).levels ?? 'names';
  const lock = readLock(join(cwd, 'tsc-laws.lock'));
  const locked = new Set(Object.keys(lock?.laws ?? {}).map((key) => key.slice(0, key.indexOf('::'))));
  const entry = (file: string, status: ListedFile['status'], proposal?: ListedFile['proposal']): ListedFile => {
    const verdict = classifyLawFile(cwd, file, mode);
    return {
      file,
      kind: verdict.kind,
      status,
      ...(verdict.error === undefined ? {} : { error: verdict.error }),
      ...(proposal === undefined ? {} : { proposal }),
      notices: verdict.notices,
    };
  };
  return [
    ...discoverLaws(cwd).map((file) => entry(file, locked.has(file) ? 'accepted' : 'unaccepted')),
    ...discoverLaws(cwd, true).map((file) => entry(file, 'proposed', 'name')),
    ...discoverProposals(cwd).map((file) => entry(file, 'proposed', 'proposals')),
  ];
}

/** One line per file: `kind status path`. */
export function renderList(files: ListedFile[]): string {
  if (files.length === 0) return 'no laws files found\n';
  const width = Math.max(...files.map((f) => f.kind.length));
  return `${files.map((f) => `${f.kind.padEnd(width)}  ${f.status.padEnd(10)}  ${f.file}${f.error === undefined ? '' : `  (${f.error})`}`).join('\n')}\n`;
}
