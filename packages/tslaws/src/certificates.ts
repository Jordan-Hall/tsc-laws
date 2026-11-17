// Checkable proof certificates. Z3 answers `unsat` to a law's query, but its answer is a claim. With `"certify": true` in
// tslaws.json (or `--certify`), the same query goes to cvc5, which writes an Alethe proof of the `unsat`, and Carcara
// checks that proof independently. A law whose proof Carcara accepts is `certified`; the hashes of the problem, the
// proof and the checker's verdict are what the lock records beside the law.
//
// The tools are never required unless asked: when cvc5 or Carcara is missing the certificate is `unavailable` and the law
// keeps the status it had. `"certify": "require"` turns anything short of `certified` into an error.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cvc5Text, toolCommand } from './solvers.ts';

/** `certify` in tslaws.json: off (absent or false), on, or `"require"`, where a law without a certificate is an error. */
export type CertifyMode = boolean | 'require';

export type CertificateStatus = 'certified' | 'uncertified' | 'unavailable';

/** What certifying one proof produced. The hashes are set only for `certified`. */
export interface Certificate {
  status: CertificateStatus;
  /** Why the proof is not certified: what cvc5 or Carcara said, or which syntax cannot be certified. */
  reason?: string;
  /** SHA-256 of the SMT-LIB problem both tools read. */
  problemHash?: string;
  /** SHA-256 of the Alethe proof. */
  proofHash?: string;
  /** SHA-256 of the checker's verdict bound to the problem and proof it checked. */
  checkerHash?: string;
  /** Project-relative path of the saved proof, when a directory was given. */
  proofFile?: string;
}

/** What is wrong with a `certify` value from tslaws.json, or undefined when it is valid. */
export function certifyProblem(value: unknown): string | undefined {
  if (typeof value === 'boolean' || value === 'require') return undefined;
  return `"certify" must be true, false or "require", got ${JSON.stringify(value)}`;
}

/** `certified`, or `uncertified (reason)` or `unavailable (reason)`: the line a report shows for a law. */
export function certificateLabel(certificate: Certificate): string {
  return certificate.status === 'certified' || certificate.reason === undefined
    ? certificate.status
    : `${certificate.status} (${certificate.reason})`;
}

/** Whether a certificate satisfies the mode: with `require`, only a certified proof does. */
export function certificateFailure(mode: CertifyMode | undefined, certificate: Certificate): string | undefined {
  if (mode !== 'require' || certificate.status === 'certified') return undefined;
  return `"certify": "require" is set but the proof is ${certificateLabel(certificate)}`;
}

/**
 * What cvc5's Alethe proofs cannot cover. Alethe has no rules for floating point or for strings and regular
 * expressions, so a query that uses them has no proof Carcara could check. Returns the reason, or undefined when the
 * query is in the fragment cvc5 can prove in Alethe.
 */
export function uncertifiable(query: string): string | undefined {
  const text = query.replace(/\|[^|]*\|/g, ' ');
  if (
    /\b(?:FloatingPoint|Float(?:16|32|64|128)|RoundingMode)\b|\(\s*fp\.|\(\s*_\s+(?:to_fp|NaN|\+oo|-oo|\+zero|-zero)\b|\bR(?:NE|NA|TP|TN|TZ)\b/.test(
      text,
    )
  )
    return 'the law uses floating-point numbers, which Alethe proofs do not cover (use int or bigint)';
  if (/\bString\b|\(\s*(?:str|re)\.|\bRegLan\b/.test(text))
    return 'the law uses strings, which Alethe proofs do not cover';
  return undefined;
}

/**
 * The problem cvc5 and Carcara both read: the query as `cvc5Text` renders it (no Z3 timeout, no `(get-model)`, a logic
 * set), so the proof is checked against exactly the text cvc5 proved.
 */
export const problemText = cvc5Text;

/** Options that make cvc5 print an Alethe proof Carcara can check. */
export const cvc5ProofArgs: readonly string[] = [
  '--lang',
  'smt2',
  '--dump-proofs',
  '--proof-format-mode=alethe',
  '--proof-granularity=theory-rewrite',
  '--proof-alethe-res-pivots',
  '--dag-thresh=0',
  '--simplification=none',
  '--enum-inst-interleave',
  '--cegqi-all',
];

/** Carcara's arguments after `check <proof> <problem>`: the options cvc5's proofs need. */
export const carcaraArgs: readonly string[] = ['--allow-int-real-subtyping', '--expand-let-bindings'];

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Ran {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs a tool to the end; resolves `undefined` when the binary cannot be started and `'timeout'` when it overran. */
function run(file: string, args: string[], timeoutMs: number): Promise<Ran | undefined | 'timeout'> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const done = (value: Ran | undefined | 'timeout'): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      done('timeout');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES') done(undefined);
      else done({ stdout, stderr: error.message, code: null });
    });
    child.on('close', (code) => done({ stdout, stderr, code }));
  });
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';

const cvc5Missing =
  'the cvc5 binary was not found: install cvc5 (https://cvc5.github.io) so that cvc5 is on the PATH, or set TSLAWS_CVC5 to its path';
const carcaraMissing =
  'the carcara binary was not found: install Carcara (https://github.com/ufmg-smite/carcara) so that carcara is on the PATH, or set TSLAWS_CARCARA to its path';

export interface CertifyOptions {
  /** Wall-clock budget for each tool, in milliseconds. */
  timeoutMs: number;
  /** Where to keep the problem and proof (`<name>.smt2`, `<name>.alethe`); without it they are removed after the check. */
  keep?: { dir: string; name: string; root: string };
}

/** The hash that binds a checker's verdict to the problem and the proof it checked. */
const checkerHashOf = (verdict: string, problemHash: string, proofHash: string): string =>
  hashOf(JSON.stringify({ verdict, problem: problemHash, proof: proofHash }));

/** Runs Carcara on a saved proof and problem: `certified` (with its verdict) only when Carcara says `valid`. */
async function recheck(
  problemFile: string,
  proofFile: string,
  budget: number,
): Promise<(Certificate & { verdict: string }) | { status: 'uncertified' | 'unavailable'; reason: string }> {
  const carcara = toolCommand('TSLAWS_CARCARA', 'carcara');
  const checked = await run(carcara.file, [...carcara.args, 'check', proofFile, problemFile, ...carcaraArgs], budget);
  if (checked === undefined) return { status: 'unavailable', reason: carcaraMissing };
  if (checked === 'timeout') return { status: 'uncertified', reason: `Carcara did not finish within ${budget} ms` };
  const verdict = firstLine(checked.stdout);
  if (checked.code !== 0 || verdict !== 'valid') {
    const why =
      verdict === 'holey'
        ? 'the proof has steps Carcara could not check'
        : (verdict !== '' ? verdict : firstLine(checked.stderr)) || `exited with code ${checked.code}`;
    return { status: 'uncertified', reason: `Carcara did not accept the proof (${why})` };
  }
  return { status: 'certified', verdict };
}

/**
 * Certifies the `unsat` answer of a query: cvc5 proves it again in Alethe, Carcara checks the proof. Never throws for a
 * missing or failing tool; the outcome is in the certificate's status.
 */
export async function certify(query: string, options: CertifyOptions): Promise<Certificate> {
  const reason = uncertifiable(query);
  if (reason !== undefined) return { status: 'uncertified', reason };
  const problem = problemText(query);
  const work = mkdtempSync(join(tmpdir(), 'tslaws-cert-'));
  try {
    const problemFile = join(work, 'problem.smt2');
    const proofFile = join(work, 'proof.alethe');
    writeFileSync(problemFile, problem);
    // Alethe proofs are large; the budget covers cvc5's search and its printing.
    const budget = Math.max(options.timeoutMs, 1000) + 3000;
    const cvc5 = toolCommand('TSLAWS_CVC5', 'cvc5');
    const proved = await run(
      cvc5.file,
      [...cvc5.args, ...cvc5ProofArgs, '--tlimit', String(options.timeoutMs), problemFile],
      budget,
    );
    if (proved === undefined) return { status: 'unavailable', reason: cvc5Missing };
    if (proved === 'timeout') return { status: 'uncertified', reason: `cvc5 gave no proof within ${budget} ms` };
    const answer = firstLine(proved.stdout);
    if (proved.code !== 0 || answer !== 'unsat') {
      const why = answer !== '' ? answer : firstLine(proved.stderr) || `exited with code ${proved.code}`;
      return { status: 'uncertified', reason: `cvc5 gave no Alethe proof (${why})` };
    }
    const proof = proved.stdout.slice(proved.stdout.indexOf('\n') + 1).trim();
    if (proof === '') return { status: 'uncertified', reason: 'cvc5 answered unsat but printed no proof' };
    writeFileSync(proofFile, `${proof}\n`);
    const checked = await recheck(problemFile, proofFile, budget);
    if (checked.status !== 'certified') return checked;
    const verdict = checked.verdict;
    const problemHash = hashOf(problem);
    const proofHash = hashOf(`${proof}\n`);
    const certificate: Certificate = {
      status: 'certified',
      problemHash,
      proofHash,
      checkerHash: checkerHashOf(verdict, problemHash, proofHash),
    };
    if (options.keep !== undefined) {
      const { dir, name, root } = options.keep;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.smt2`), problem);
      writeFileSync(join(dir, `${name}.alethe`), `${proof}\n`);
      certificate.proofFile = join(dir, `${name}.alethe`)
        .slice(root.length + 1)
        .replaceAll('\\', '/');
    }
    return certificate;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * One certified law as the lock records it. `law` is the law's lock hash, so a later edit voids the record, and
 * `problemHash` is the hash of the exact SMT-LIB problem that was proved, so a change to code the law calls (which the
 * law's own hash does not cover) voids it too: a record is made only from a proof this run produced.
 */
export interface CertificateRecord {
  law: string;
  problemHash: string;
  proofHash: string;
  checkerHash: string;
}

/** The file name a law's problem and proof are kept under, beside `.tslaws/certificates/`. */
export function certificateName(key: string): string {
  const slug = key
    .slice(key.indexOf('::') + 2)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .slice(0, 40);
  return `${slug}-${hashOf(key).slice(0, 8)}`;
}

/** Where `tslaws check` keeps the problems and proofs of the laws it certified. */
export const certificatesDir = (cwd: string): string => join(cwd, '.tslaws', 'certificates');

/**
 * Where `tslaws check` leaves the records of the laws it certified, for `tslaws accept` to consider. Anyone can write this
 * file, so accept trusts none of it: see `verifyRecord`.
 */
export const recordsPath = (cwd: string): string => join(cwd, '.tslaws', 'certificates.json');

export function readRecords(cwd: string): Record<string, CertificateRecord> {
  const path = recordsPath(cwd);
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, CertificateRecord>;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Updates the records after a check: each law that was proved or bounded has its record replaced by the new one when it
 * is certified and removed when it is not (a law that did not run keeps what it had).
 */
export function writeRecords(cwd: string, updates: Map<string, CertificateRecord | undefined>): void {
  const records = readRecords(cwd);
  for (const [key, record] of updates) {
    if (record === undefined) delete records[key];
    else records[key] = record;
  }
  const path = recordsPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2) + '\n');
}

const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/**
 * Whether a record from the sidecar may enter the lock, or why not. Nothing in the sidecar is trusted. The record must
 * be for the law as it is now (`lawNow`) and for a problem the law still yields (`problems`, the hashes of the problems
 * `tslaws accept` rebuilt from the code); the saved problem and proof must exist and hash as the record says; and
 * Carcara must accept them again, here and now. With Carcara missing nothing is kept.
 */
export async function verifyRecord(
  cwd: string,
  key: string,
  record: unknown,
  lawNow: string,
  problems: ReadonlySet<string>,
  timeoutMs = 20000,
): Promise<string | undefined> {
  const r = record as Partial<CertificateRecord> | null;
  if (typeof r !== 'object' || r === null || !isHash(r.problemHash) || !isHash(r.proofHash) || !isHash(r.checkerHash))
    return 'the record is malformed';
  if (r.law !== lawNow) return 'the law changed since it was certified';
  if (!problems.has(r.problemHash)) return 'the record is for a different proof problem than the law yields now';
  const name = certificateName(key);
  const problemFile = join(certificatesDir(cwd), `${name}.smt2`);
  const proofFile = join(certificatesDir(cwd), `${name}.alethe`);
  if (!existsSync(problemFile) || !existsSync(proofFile)) return 'the saved problem or proof is missing';
  if (hashOf(readFileSync(problemFile, 'utf8')) !== r.problemHash) return 'the saved problem does not match the record';
  if (hashOf(readFileSync(proofFile, 'utf8')) !== r.proofHash) return 'the saved proof does not match the record';
  const checked = await recheck(problemFile, proofFile, timeoutMs);
  if (checked.status !== 'certified') return checked.reason;
  if (checkerHashOf(checked.verdict, r.problemHash, r.proofHash) !== r.checkerHash)
    return 'the checker verdict does not match the record';
  return undefined;
}

/** The record for a certified certificate, or undefined for any other. */
export function recordOf(lawHash: string, certificate: Certificate): CertificateRecord | undefined {
  if (certificate.status !== 'certified') return undefined;
  return {
    law: lawHash,
    problemHash: certificate.problemHash!,
    proofHash: certificate.proofHash!,
    checkerHash: certificate.checkerHash!,
  };
}

/** The certificate a proved or bounded law gets when certifying is on but no proof was checked. */
export const noCertificate: Certificate = { status: 'uncertified', reason: 'no certificate produced' };

/**
 * Whether a lock record still describes what a run just proved: the same problem. A law with no record, or a run
 * that did not certify it, has nothing to compare.
 */
export function staleRecord(record: CertificateRecord | undefined, certificate: Certificate): boolean {
  return record !== undefined && (certificate.status !== 'certified' || certificate.problemHash !== record.problemHash);
}
