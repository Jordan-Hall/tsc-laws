// On-disk proof & certificate verdict cache keyed by exact SMT-LIB query hash and solver/tool fingerprints.
// Unchanged laws skip Z3, cvc5 and Carcara on incremental/watch/CI runs; any change to the law, its called code,
// solver config, or tool binary invalidates the entry.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Certificate, CertifyMode } from './certificates.ts';
import { hashOf } from './certificates.ts';
import { z3Fingerprint } from './nativeZ3.ts';
import { toolCommand, type SolverName } from './solvers.ts';
import type { ProofResult } from './smt.ts';

const cacheVersion = 1;
const maxEntries = 2000;

interface CachedEntry {
  result: Extract<ProofResult, { kind: 'proved' | 'bounded' }>;
  at: number;
}

interface StoredCache {
  version: number;
  entries: Record<string, CachedEntry>;
}

function toolStamp(env: string, binary: string): string {
  const cmd = toolCommand(env, binary);
  const target = cmd.args[0] ?? cmd.file;
  try {
    const st = statSync(target);
    return `${cmd.file}:${cmd.args.join(',')}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `${cmd.file}:${cmd.args.join(',')}`;
  }
}

/** Fingerprint of the solver + certificate toolchain relevant to a proof query. */
export function toolchainFingerprint(
  solvers: readonly SolverName[] | undefined,
  certify: CertifyMode | undefined,
): string {
  const parts = [z3Fingerprint()];
  const usesCvc5 = (solvers?.includes('cvc5') ?? false) || (certify !== undefined && certify !== false);
  if (usesCvc5) parts.push(`cvc5=${toolStamp('TSLAWS_CVC5', 'cvc5')}`);
  if (certify !== undefined && certify !== false) parts.push(`carcara=${toolStamp('TSLAWS_CARCARA', 'carcara')}`);
  return parts.join('|');
}

export interface ProofCache {
  get(key: string, keep?: { dir: string; name: string; root: string }): ProofResult | undefined;
  set(key: string, result: ProofResult): void;
  flush(): void;
}

const noopCache: ProofCache = {
  get: () => undefined,
  set: () => undefined,
  flush: () => undefined,
};

/** Computes the cache key for an exact SMT-LIB query (or Horn system) under the given solver/certify configuration. */
export function proofCacheKey(input: {
  query: string;
  bounded: readonly string[];
  assumptions: readonly string[];
  solvers: readonly SolverName[] | undefined;
  certify: CertifyMode | undefined;
}): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify([
      cacheVersion,
      input.query,
      input.bounded,
      input.assumptions,
      input.solvers ?? ['z3'],
      input.certify ?? false,
      toolchainFingerprint(input.solvers, input.certify),
    ]),
  );
  return hash.digest('hex');
}

/** Verifies that a cached certified result still has intact saved proof files on disk when `keep` is requested. */
function keptFilesIntact(
  certificate: Certificate | undefined,
  keep: { dir: string; name: string; root: string } | undefined,
): boolean {
  if (certificate === undefined || certificate.status !== 'certified' || keep === undefined) return true;
  const smtFile = join(keep.dir, `${keep.name}.smt2`);
  const proofFile = join(keep.dir, `${keep.name}.alethe`);
  if (!existsSync(smtFile) || !existsSync(proofFile)) return false;
  try {
    if (certificate.problemHash !== undefined && hashOf(readFileSync(smtFile, 'utf8')) !== certificate.problemHash)
      return false;
    if (certificate.proofHash !== undefined && hashOf(readFileSync(proofFile, 'utf8')) !== certificate.proofHash)
      return false;
    if (certificate.systemHash !== undefined) {
      const hornFile = join(keep.dir, `${keep.name}.horn`);
      const invFile = join(keep.dir, `${keep.name}.inv`);
      if (!existsSync(hornFile) || !existsSync(invFile)) return false;
      if (hashOf(readFileSync(hornFile, 'utf8')) !== certificate.systemHash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Opens the project's proof cache (`.tslaws/proof-cache.json`). Deferred write: call `flush()` once at end of check. */
export function openProofCache(cwd: string): ProofCache {
  if (process.env.TSLAWS_NO_PROOF_CACHE === '1') return noopCache;
  const path = join(cwd, '.tslaws', 'proof-cache.json');
  let stored: StoredCache = { version: cacheVersion, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredCache;
    if (parsed?.version === cacheVersion && typeof parsed.entries === 'object' && parsed.entries !== null)
      stored = parsed;
  } catch {
    // No cache yet.
  }
  let dirty = false;
  return {
    get(key, keep) {
      const entry = stored.entries[key];
      if (entry === undefined) return undefined;
      // Never serve an unavailable/uncertified certificate from cache so newly installed tools are picked up immediately.
      if (entry.result.certificate !== undefined && entry.result.certificate.status !== 'certified') return undefined;
      if (!keptFilesIntact(entry.result.certificate, keep)) return undefined;
      entry.at = Date.now();
      return entry.result;
    },
    set(key, result) {
      if (result.kind !== 'proved' && result.kind !== 'bounded') return;
      if (result.certificate !== undefined && result.certificate.status !== 'certified') return;
      stored.entries[key] = { result, at: Date.now() };
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      dirty = false;
      try {
        const keys = Object.keys(stored.entries);
        if (keys.length > maxEntries) {
          keys
            .sort((a, b) => (stored.entries[a]?.at ?? 0) - (stored.entries[b]?.at ?? 0))
            .slice(0, keys.length - maxEntries)
            .forEach((k) => delete stored.entries[k]);
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(stored));
      } catch {
        // Not caching is only slower.
      }
    },
  };
}
