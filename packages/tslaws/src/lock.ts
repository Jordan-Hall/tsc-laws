// The tamper lock: a hash per law declaration. Laws are the human's side of the contract, so any change,
// addition or removal fails the check until a person runs `tslaws accept`.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ManifestLaw } from './types.ts';

export type LockEntries = Record<string, string>;

export interface Lock {
  laws: LockEntries;
  /** `file::name` of the functions a person exempted from coverage. */
  exempt: string[];
  /**
   * Only in a lock accepted with `levels: "imports"`: the level each laws file resolved to. A lock accepted by name
   * (the default) has no such section and keeps the format it always had.
   */
  levels?: Record<string, string>;
}

export function lawKey(file: string, name: string): string {
  return `${file.replaceAll('\\', '/')}::${name}`;
}

export function lawHash(law: ManifestLaw): string {
  const normalized = `${law.proved ? 'proved ' : ''}${law.text.replace(/\s+/g, ' ')}`;
  return createHash('sha256').update(normalized).digest('hex');
}

export function readLock(path: string): Lock | undefined {
  if (!existsSync(path)) return undefined;
  const lock = JSON.parse(readFileSync(path, 'utf8')) as {
    laws: LockEntries;
    exempt?: string[];
    levels?: Record<string, string>;
  };
  return { laws: lock.laws, exempt: lock.exempt ?? [], ...(lock.levels === undefined ? {} : { levels: lock.levels }) };
}

export function writeLock(
  path: string,
  laws: ManifestLaw[],
  exempt: string[] = [],
  levels?: Record<string, string>,
): void {
  const entries: LockEntries = {};
  for (const law of [...laws].sort((a, b) => lawKey(a.file, a.name).localeCompare(lawKey(b.file, b.name))))
    entries[lawKey(law.file, law.name)] = lawHash(law);
  const recorded: Record<string, string> = {};
  for (const file of Object.keys(levels ?? {}).sort()) recorded[file.replaceAll('\\', '/')] = levels![file]!;
  const body = {
    version: 1,
    laws: entries,
    exempt: [...exempt].sort(),
    ...(levels === undefined ? {} : { levels: recorded }),
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
}

export interface LockViolation {
  key: string;
  reason: 'changed' | 'added' | 'removed' | 'level';
}

/**
 * `levels` is the level each laws file resolves to now, or undefined when levels come from names and the lock has no
 * levels section (then nothing about levels is compared). A law whose file's level is not the locked one, or is not
 * locked at all, is a violation until a person accepts again.
 */
export function compareLock(
  lock: LockEntries | undefined,
  laws: ManifestLaw[],
  levels?: { locked: Record<string, string> | undefined; now: Record<string, string> },
): LockViolation[] {
  const violations: LockViolation[] = [];
  const seen = new Set<string>();
  for (const law of laws) {
    const key = lawKey(law.file, law.name);
    seen.add(key);
    const locked = lock?.[key];
    if (locked === undefined) violations.push({ key, reason: 'added' });
    else if (locked !== lawHash(law)) violations.push({ key, reason: 'changed' });
    else if (levels !== undefined) {
      const file = law.file.replaceAll('\\', '/');
      if (levels.locked?.[file] !== levels.now[file]) violations.push({ key, reason: 'level' });
    }
  }
  for (const key of Object.keys(lock ?? {})) if (!seen.has(key)) violations.push({ key, reason: 'removed' });
  return violations;
}
