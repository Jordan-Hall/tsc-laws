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
  const lock = JSON.parse(readFileSync(path, 'utf8')) as { laws: LockEntries; exempt?: string[] };
  return { laws: lock.laws, exempt: lock.exempt ?? [] };
}

export function writeLock(path: string, laws: ManifestLaw[], exempt: string[] = []): void {
  const entries: LockEntries = {};
  for (const law of [...laws].sort((a, b) => lawKey(a.file, a.name).localeCompare(lawKey(b.file, b.name))))
    entries[lawKey(law.file, law.name)] = lawHash(law);
  writeFileSync(path, JSON.stringify({ version: 1, laws: entries, exempt: [...exempt].sort() }, null, 2) + '\n');
}

export interface LockViolation {
  key: string;
  reason: 'changed' | 'added' | 'removed';
}

export function compareLock(lock: LockEntries | undefined, laws: ManifestLaw[]): LockViolation[] {
  const violations: LockViolation[] = [];
  const seen = new Set<string>();
  for (const law of laws) {
    const key = lawKey(law.file, law.name);
    seen.add(key);
    const locked = lock?.[key];
    if (locked === undefined) violations.push({ key, reason: 'added' });
    else if (locked !== lawHash(law)) violations.push({ key, reason: 'changed' });
  }
  for (const key of Object.keys(lock ?? {})) if (!seen.has(key)) violations.push({ key, reason: 'removed' });
  return violations;
}
