// The tamper lock: a hash per law declaration. Laws are the human's side of the contract, so any change,
// addition or removal fails the check until a person runs `tslaws accept`.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { CertificateRecord } from './certificates.ts';
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
  /**
   * Only in a lock accepted after `tslaws check --certify`: for each law a checker accepted a proof of, the hashes of the
   * proof and of the checker's verdict. A record counts only while its `law` is the law's hash in `laws`.
   */
  certificates?: Record<string, CertificateRecord>;
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
    certificates?: Record<string, CertificateRecord>;
  };
  return {
    laws: lock.laws,
    exempt: lock.exempt ?? [],
    ...(lock.levels === undefined ? {} : { levels: lock.levels }),
    ...(lock.certificates === undefined ? {} : { certificates: lock.certificates }),
  };
}

/** The records that still describe their law: the law is in the lock with the hash the record was made for. */
export function currentCertificates(
  laws: LockEntries,
  records: Record<string, CertificateRecord> | undefined,
): Record<string, CertificateRecord> {
  const kept: Record<string, CertificateRecord> = {};
  for (const key of Object.keys(records ?? {}).sort())
    if (laws[key] !== undefined && records![key]!.law === laws[key]) kept[key] = records![key]!;
  return kept;
}

/** Whether the lock records a certificate for the law as the lock holds it. */
export function isCertified(lock: Lock | undefined, key: string): boolean {
  return lock?.laws[key] !== undefined && lock.certificates?.[key]?.law === lock.laws[key];
}

/** The `certificates` part of a lock body: nothing when no record is current, so an uncertified lock keeps its format. */
function certificatesBody(
  laws: LockEntries,
  records: Record<string, CertificateRecord> | undefined,
): { certificates?: Record<string, CertificateRecord> } {
  const current = currentCertificates(laws, records);
  return Object.keys(current).length === 0 ? {} : { certificates: current };
}

export function writeLock(
  path: string,
  laws: ManifestLaw[],
  exempt: string[] = [],
  levels?: Record<string, string>,
  certificates?: Record<string, CertificateRecord>,
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
    ...certificatesBody(entries, certificates),
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

/**
 * One difference between the lock and the project: a law added, changed, removed or moved to another level, or a
 * coverage exemption added or removed. `fingerprint` names the exact content a person accepts, so an approval given for
 * one version of a law never accepts a later edit of it.
 */
export interface LockChange {
  key: string;
  kind: 'law' | 'exempt';
  reason: 'added' | 'changed' | 'removed' | 'level';
  fingerprint: string;
}

const fingerprintOf = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

/**
 * Every change a person would record by accepting the project as it is now. `levels` is the level of each laws file
 * now, or undefined when the lock does not record levels.
 */
export function lockChanges(
  lock: Lock | undefined,
  laws: ManifestLaw[],
  exempt: string[],
  levels?: Record<string, string>,
): LockChange[] {
  const byKey = new Map(laws.map((law) => [lawKey(law.file, law.name), law]));
  const compared = compareLock(
    lock?.laws,
    laws,
    levels === undefined ? undefined : { locked: lock?.levels, now: levels },
  );
  const changes: LockChange[] = compared.map((violation) => {
    const law = byKey.get(violation.key);
    const hash = law === undefined ? 'removed' : lawHash(law);
    const level = law === undefined ? '' : (levels?.[law.file.replaceAll('\\', '/')] ?? '');
    return {
      key: violation.key,
      kind: 'law',
      reason: violation.reason,
      fingerprint: fingerprintOf('law', violation.key, hash, level),
    };
  });
  const locked = new Set(lock?.exempt ?? []);
  const now = new Set(exempt);
  for (const key of [...now].filter((k) => !locked.has(k)).sort())
    changes.push({ key, kind: 'exempt', reason: 'added', fingerprint: fingerprintOf('exempt', key, 'added') });
  for (const key of [...locked].filter((k) => !now.has(k)).sort())
    changes.push({ key, kind: 'exempt', reason: 'removed', fingerprint: fingerprintOf('exempt', key, 'removed') });
  return changes;
}

/**
 * The lock after accepting only the changes whose fingerprints are in `accepted`; every other entry keeps what the lock
 * had. Levels are recorded per laws file, so a file's level is taken from now once every law change in it is accepted.
 */
export function acceptChanges(
  lock: Lock | undefined,
  laws: ManifestLaw[],
  exempt: string[],
  levels: Record<string, string> | undefined,
  accepted: ReadonlySet<string>,
): Lock {
  const changes = lockChanges(lock, laws, exempt, levels);
  const taken = changes.filter((c) => accepted.has(c.fingerprint));
  const byKey = new Map(laws.map((law) => [lawKey(law.file, law.name), law]));
  const entries: LockEntries = { ...lock?.laws };
  const exemptions = new Set(lock?.exempt ?? []);
  for (const change of taken) {
    if (change.kind === 'exempt') {
      if (change.reason === 'added') exemptions.add(change.key);
      else exemptions.delete(change.key);
      continue;
    }
    const law = byKey.get(change.key);
    if (law === undefined) delete entries[change.key];
    else entries[change.key] = lawHash(law);
  }
  let recorded: Record<string, string> | undefined;
  if (levels !== undefined) {
    recorded = { ...lock?.levels };
    const fileOf = (key: string): string => key.slice(0, key.lastIndexOf('::'));
    const open = new Set(
      changes.filter((c) => c.kind === 'law' && !accepted.has(c.fingerprint)).map((c) => fileOf(c.key)),
    );
    for (const [file, level] of Object.entries(levels)) if (!open.has(file)) recorded[file] = level;
    for (const file of Object.keys(recorded))
      if (!(file in levels) && !Object.keys(entries).some((key) => fileOf(key) === file)) delete recorded[file];
  }
  return {
    laws: entries,
    exempt: [...exemptions],
    ...(recorded === undefined ? {} : { levels: recorded }),
    ...certificatesBody(entries, lock?.certificates),
  };
}

/** Writes a lock value in the same canonical form as `writeLock`. */
export function writeLockValue(path: string, lock: Lock): void {
  const laws: LockEntries = {};
  for (const key of Object.keys(lock.laws).sort((a, b) => a.localeCompare(b))) laws[key] = lock.laws[key]!;
  const body = {
    version: 1,
    laws,
    exempt: [...lock.exempt].sort(),
    ...(lock.levels === undefined
      ? {}
      : {
          levels: Object.fromEntries(
            Object.keys(lock.levels)
              .sort()
              .map((f) => [f, lock.levels![f]!]),
          ),
        }),
    ...certificatesBody(laws, lock.certificates),
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
}
