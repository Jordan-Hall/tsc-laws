import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { build, readManifest } from './compile.ts';
import { withResolution } from './lawRuntime.ts';
import {
  compilerOptions,
  declarationFiles,
  isDiscard,
  jsPath,
  runLawGuarded,
  warmWorkers,
  typesOf,
  type LawTypes,
  type PropertyOutcome,
} from './property.ts';
import { analyzeCoverage, coverFiles, lawEnv, readConfig } from './coverage.ts';
import { parseGithubConfig } from './github.ts';
import { derivedStore } from './derived.ts';
import { budget, configureJobs } from './pool.ts';
import { hostConfig, LawLoadError, Sandbox, useSandbox, warnE2e, warmSandbox } from './sandbox.ts';
import {
  bindingOf,
  certificateFailure,
  hashOf,
  noCertificate,
  recordOf,
  staleRecord,
  verifyRecord,
  writeRecords,
  readRecords,
  type CertificateRecord,
} from './certificates.ts';
import { compareLock, lawHash, lawKey, lockFormat, proofStatus, readLock, scopeOf, type Lock } from './lock.ts';
import { crossCheck, disagreement } from './propertyRun.ts';
import { prepareRuntime } from './runtimeEnv.ts';
import { problemTexts, proveLaw } from './smt.ts';
import { decodeExample, loadExamples, regressionMessage, saveExample } from './regressions.ts';
import { closeBrowser, runBrowserLaw } from './browser.ts';
import { ensureServer, runE2eLaw, stopServer } from './e2e.ts';
import { inProposals } from './lawFiles.ts';
import { classifyLawFile, type KindVerdict } from './lawKinds.ts';
import { normaliseProposal } from './proposals.ts';
import { declarationOf, exercisesOf, markFailing, Sources, type Exercised } from './exercises.ts';
import type { CheckOptions, ProposalOutcome, LawResult, ManifestLaw } from './types.ts';

type Add = (law: ManifestLaw, status: LawResult['status'], method: string, extra?: Partial<LawResult>) => void;

/** Runs at most `limit` tasks at once. The CPU limit is the process-wide budget (pool.ts); this holds the single page. */
class Semaphore {
  private free: number;
  private readonly queue: (() => void)[] = [];

  constructor(limit: number) {
    this.free = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.queue.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next === undefined) this.free += 1;
      else next();
    }
  }
}

export interface CheckReport {
  results: LawResult[];
  compileDiagnostics: string;
  compileOk: boolean;
  lockMissing: boolean;
  /** Things worth a person's attention that do not fail the check: a file name that its imports do not back. */
  notices: string[];
  /** Whether every law holds and nothing is open, failed or tampered with. */
  ok: boolean;
}

/** The `@tslaws-exempt` functions of the project, for `tslaws accept` to record. */
export function exemptionsOf(options: CheckOptions): string[] {
  const covered = coverFiles(options.cwd, readConfig(options.cwd).cover ?? []);
  const compiled = [...new Set([...options.files, ...covered])];
  const built = build(options.compiler, compiled, options.cwd);
  const program = ts.createProgram(declarationFiles(built.outDir), withResolution(built.outDir, compilerOptions));
  return analyzeCoverage({
    cwd: options.cwd,
    outDir: built.outDir,
    lawFiles: options.files,
    coverFiles: covered,
    program,
  }).exempt;
}

/**
 * The hash of each SMT-LIB problem the prover would send for each law now, rebuilt from the compiled code without
 * running a solver. A certificate is for a law only while its problem hash is one of these.
 */
export function problemHashesOf(options: CheckOptions, laws: ManifestLaw[]): Map<string, Set<string>> {
  const covered = coverFiles(options.cwd, readConfig(options.cwd).cover ?? []);
  const built = build(options.compiler, [...new Set([...options.files, ...covered])], options.cwd);
  const program =
    built.program ?? ts.createProgram(declarationFiles(built.outDir), withResolution(built.outDir, compilerOptions));
  const sourceCwd = built.program === undefined ? undefined : options.cwd;
  const hashes = new Map<string, Set<string>>();
  for (const law of laws) {
    if (law.problems.length > 0) continue;
    try {
      const types = typesOf(program, built.outDir, law, sourceCwd);
      const texts = problemTexts({
        law,
        shapes: types.shapes,
        jsFile: jsPath(built.outDir, law.file),
        bound: options.bound,
        timeoutMs: options.proofTimeoutMs,
        holds: () => true,
      });
      hashes.set(lawKey(law.file, law.name), new Set(texts.map(hashOf)));
    } catch {
      // A law whose types cannot be read has no problem to match.
    }
  }
  return hashes;
}

/**
 * The certificates `tslaws accept` writes into the lock. The ones in the old lock stay only while their law and their
 * problem are unchanged. The ones `tslaws check --certify` left in the sidecar file enter only after `verifyRecord`
 * passes: the file is not trusted. Every record turned away is reported through `say`.
 */
export async function certificatesToAccept(
  options: CheckOptions,
  laws: ManifestLaw[],
  held: Record<string, CertificateRecord> | undefined,
  say: (text: string) => void,
): Promise<Record<string, CertificateRecord>> {
  const fresh = readRecords(options.cwd);
  const accepted: Record<string, CertificateRecord> = {};
  if (Object.keys(held ?? {}).length === 0 && Object.keys(fresh).length === 0) return accepted;
  const now = new Map(laws.map((law) => [lawKey(law.file, law.name), lawHash(law)]));
  const problems = problemHashesOf(options, laws);
  const drop = (key: string, why: string): void =>
    say(`certificate dropped for ${key}: ${why}
`);
  let toolsMissing = false;
  // The sidecar file is only a candidate: its records enter after `verifyRecord` passes.
  for (const [key, record] of Object.entries(fresh)) {
    const hash = now.get(key);
    if (hash === undefined) continue;
    const why = await verifyRecord(options.cwd, key, record, hash, problems.get(key) ?? new Set());
    if (why === undefined) accepted[key] = record;
    else {
      drop(key, why);
      if (why.includes('binary was not found')) toolsMissing = true;
    }
  }
  // A record the lock holds stays while its law and problem match, unless a verified fresh record replaced it, so a
  // failed candidate never costs the lock a certificate that is still current.
  for (const [key, record] of Object.entries(held ?? {})) {
    if (accepted[key] !== undefined) continue;
    if (now.get(key) === record?.law && problems.get(key)?.has(bindingOf(record)!)) accepted[key] = record;
    else drop(key, 'the law or its proof problem changed since it was certified');
  }
  if (toolsMissing)
    say('no new certificates were recorded: cvc5 and Carcara are needed to check them again when accepting\n');
  return accepted;
}

export async function check(options: CheckOptions, enforceLock: boolean): Promise<CheckReport> {
  // A proposal placed in .tslaws/proposals by hand may write its imports from the project root; store them where they resolve.
  for (const file of options.files) if (inProposals(file)) normaliseProposal(options.cwd, file);
  const laws = readManifest(options.compiler, options.files, options.cwd);
  const results: LawResult[] = [];
  const blocked = new Set<string>();
  const notices: string[] = [];
  // The level of a laws file comes from its name (the default) or its imports (`levels: "imports"`); looked at once per file.
  const config = readConfig(options.cwd);
  configureJobs({ config: config.jobs });
  const levelsMode = config.levels ?? 'names';
  const certifyMode = options.certify ?? config.certify ?? false;
  // The certificate each law proved this run got, or undefined when its proof was not certified.
  const records = new Map<string, CertificateRecord | undefined>();
  // Who records a law in the lock: a person locally, or the tslaws workflow on merge when "github" is configured. A
  // project that leaves "github.local" on lets a person accept by hand as well.
  const github = readConfig(options.cwd).github;
  const acceptor =
    github === undefined
      ? 'a person must run `tslaws accept`'
      : parseGithubConfig(github).local
        ? 'a person can run `tslaws accept`, or the tslaws workflow accepts it when the pull request merges'
        : 'it is accepted by the tslaws workflow when the pull request merges';
  const verdicts = new Map<string, KindVerdict>();
  const verdictOf = (file: string): KindVerdict => {
    let verdict = verdicts.get(file);
    if (verdict === undefined) {
      verdict = classifyLawFile(options.cwd, file, levelsMode);
      verdicts.set(file, verdict);
      for (const notice of verdict.notices) notices.push(notice);
    }
    return verdict;
  };
  // `only` (names) and `onlyKeys` (`file::name`) narrow the run; a law they leave out has no result and no event.
  const keyed = (law: ManifestLaw): boolean =>
    options.onlyKeys === undefined || options.onlyKeys.includes(lawKey(law.file, law.name));
  const selected = (law: ManifestLaw): boolean =>
    (options.only === undefined || options.only.includes(law.name)) && keyed(law);
  const sources = new Sources(options.cwd);
  // What a law reaches is syntactic and cheap; a project that cannot be read this way just has no locations.
  const exercisesFor = (law: ManifestLaw): Exercised[] => {
    try {
      return exercisesOf(sources, law);
    } catch {
      return [];
    }
  };
  // Laws the lock does not record as they are now: they still run, and their result is reported as what the law would
  // be once accepted, under a `tampered` status that keeps the check failing until the lock records them.
  const pending = new Map<string, { reason: ProposalOutcome['reason']; message: string }>();
  const add = (law: ManifestLaw, status: LawResult['status'], method: string, extra: Partial<LawResult> = {}): void => {
    const exercises = status === 'tampered' ? [] : (extra.exercises ?? exercisesFor(law));
    const proposed =
      status === 'tampered' || status === 'uncovered' ? undefined : pending.get(lawKey(law.file, law.name));
    const result: LawResult =
      proposed === undefined
        ? {
            file: law.file,
            name: law.name,
            line: law.line,
            status,
            method,
            ...extra,
            ...(exercises.length > 0 ? { exercises } : {}),
          }
        : {
            file: law.file,
            name: law.name,
            line: law.line,
            status: 'tampered',
            method: 'lock',
            message: proposed.message,
            ...(extra.seed === undefined ? {} : { seed: extra.seed }),
            ...(extra.runs === undefined ? {} : { runs: extra.runs }),
            ...(extra.screenshot === undefined ? {} : { screenshot: extra.screenshot }),
            proposal: {
              reason: proposed.reason,
              status: status as ProposalOutcome['status'],
              method,
              ...(extra.counterexample === undefined ? {} : { counterexample: extra.counterexample }),
              ...(extra.message === undefined ? {} : { message: extra.message }),
              ...(extra.certificate === undefined ? {} : { certificate: extra.certificate }),
            },
            ...(exercises.length > 0 ? { exercises } : {}),
          };
    results.push(result);
    blocked.add(lawKey(law.file, law.name));
    options.onEvent?.({ type: 'result', result });
  };
  options.onEvent?.({ type: 'plan', laws: laws.map((l) => ({ file: l.file, name: l.name, line: l.line })) });

  let lockMissing = false;
  let lock: Lock | undefined;
  if (enforceLock) {
    lock = readLock(options.lockFile);
    lockMissing = lock === undefined;
    const byKey = new Map(laws.map((l) => [lawKey(l.file, l.name), l]));
    // With levels from imports, the resolved level of each laws file is part of the lock. A lock that recorded levels
    // while the project no longer resolves any (levels went back to names) is tampered until accepted again.
    const levels =
      levelsMode === 'imports' || lock?.levels !== undefined
        ? {
            locked: lock?.levels,
            now:
              levelsMode === 'imports'
                ? Object.fromEntries(
                    [...new Set(laws.map((l) => l.file.replaceAll('\\', '/')))].map((f) => [f, verdictOf(f).kind]),
                  )
                : undefined,
          }
        : undefined;
    // A lock from before the hashes covered helpers, imports and run settings: every law differs from it by the format.
    const outdated = (lock?.version ?? lockFormat) < lockFormat;
    if (outdated)
      notices.push(
        `lock format upgraded: the lock was written in format ${lock?.version ?? 0} and tslaws now hashes helpers, imported code and run settings too (format ${lockFormat}); run \`tslaws accept\` to record the laws again`,
      );
    for (const violation of compareLock(
      lock?.laws,
      laws,
      levels,
      options.partial === true ? scopeOf(options.files) : undefined,
    )) {
      const law = byKey.get(violation.key);
      if (law === undefined) {
        const [file, name] = violation.key.split('::') as [string, string];
        results.push({
          file,
          name,
          line: 0,
          status: 'tampered',
          method: 'lock',
          message: 'law was removed since the lock was accepted',
          proposal: { reason: 'removed', status: 'proved', method: 'lock', message: 'removing a law runs nothing' },
        });
      } else {
        pending.set(violation.key, {
          reason: violation.reason,
          message:
            violation.reason === 'added'
              ? `law is not in the lock; ${acceptor}`
              : violation.reason === 'level'
                ? `the level this laws file runs at (node, browser or e2e) changed since the lock was accepted; ${acceptor}`
                : outdated
                  ? `lock format upgraded: this lock hashes only the law's own text; ${acceptor} to record it in the new format`
                  : 'law changed since the lock was accepted',
        });
      }
    }
  }

  for (const law of laws) {
    if (keyed(law) && law.problems.length > 0 && !blocked.has(lawKey(law.file, law.name)))
      add(law, 'error', 'manifest', { message: law.problems.join('; ') });
  }

  const covered = coverFiles(options.cwd, readConfig(options.cwd).cover ?? []);
  const compiled = [...new Set([...options.files, ...covered])];
  const nodeLaws = laws.filter(
    (law) => selected(law) && law.problems.length === 0 && verdictOf(law.file).kind === 'node',
  ).length;
  const runsHere = laws.filter(
    (law) => selected(law) && law.problems.length === 0 && verdictOf(law.file).kind !== 'browser',
  ).length;
  // The sandbox is on unless the person turned it off with `sandbox: false` (`--no-sandbox`), and a Node that cannot
  // enforce it is an error here, never a quiet fallback. End-to-end laws are no exception: see `allowE2e`.
  const sandboxed = runsHere > 0 && useSandbox(options);
  if (sandboxed) warmSandbox(options.cwd, nodeLaws);
  else warmWorkers(nodeLaws);
  const built = build(options.compiler, compiled, options.cwd);
  // What the sandbox may load: the build's output, what the seals of the laws cover (the lock digests the same files), and
  // the packages the manifests declare. Reviewed once, after the build.
  const sandbox = sandboxed
    ? new Sandbox(
        options.cwd,
        hostConfig(
          options.cwd,
          compiled,
          built.outDir,
          laws.filter((law) => law.problems.length === 0),
        ),
      )
    : undefined;
  // What the type checker works out is kept with the build it came from, so an unchanged project skips the checker.
  const derived = derivedStore(options.cwd, built.key);
  let programOf: ts.Program | undefined;
  const program = (): ts.Program =>
    (programOf ??=
      built.program ?? ts.createProgram(declarationFiles(built.outDir), withResolution(built.outDir, compilerOptions)));
  const sourceCwd = built.program === undefined ? undefined : options.cwd;
  // Compiled laws are CommonJS (see `build` in compile.ts): the one place a law is loaded, so `require` is unavoidable here
  // (`import()` would cache the module for good, and a recompiled law must load again).
  const require = createRequire(import.meta.url);
  // Laws that run here (end to end) and the code they load read `import.meta.env` and extensionless imports as bundled.
  prepareRuntime(lawEnv(options.cwd, 'node'));

  const runOne = async (law: ManifestLaw, index: number): Promise<void> => {
    const buffered: (() => void)[] = [];
    try {
      await runBody(law, (l, status, method, extra = {}) => {
        buffered.push(() => add(l, status, method, extra));
      });
    } finally {
      finished.set(index, buffered);
      flush();
    }
  };
  const runBody = async (law: ManifestLaw, add: Add): Promise<void> => {
    if (!selected(law)) return;
    if (blocked.has(lawKey(law.file, law.name))) return;
    options.onEvent?.({ type: 'start', file: law.file, name: law.name });
    let types: LawTypes;
    try {
      types = derived.law(law, () => typesOf(program(), built.outDir, law, sourceCwd));
    } catch (error) {
      add(law, 'error', 'generators', { message: (error as Error).message });
      return;
    }
    const verdict = verdictOf(law.file);
    if (verdict.error !== undefined) {
      add(law, 'error', 'manifest', { message: verdict.error });
      return;
    }
    const browser = verdict.kind === 'browser';
    const e2e = verdict.kind === 'e2e';
    // An end-to-end law needs processes (a browser, the app's server) that the sandbox refuses, so it would run in this
    // process with every permission it has. A law says for itself that it is end to end, so that is never taken as leave
    // to do so: the person must ask for it.
    if (e2e && sandboxed && options.allowE2e !== true) {
      add(law, 'error', 'e2e', {
        message:
          'end-to-end laws run outside the sandbox, with full access to this machine; run them with --allow-e2e (allowE2e) ' +
          'once you have reviewed them, or with --no-sandbox to turn the sandbox off',
      });
      return;
    }
    if (e2e && sandboxed) warnE2e();
    const method = browser ? 'browser' : e2e ? 'e2e' : 'property';
    let fn: ((...args: unknown[]) => unknown) | undefined;
    // A browser law touches the DOM when it loads, so only the browser loads it. A node law loads in its sandbox, not here
    // (an end-to-end law runs in this process once `allowE2e` lets it: it drives a browser, which needs processes the
    // sandbox refuses).
    let isAsync = false;
    if (!browser && (!sandboxed || e2e)) {
      try {
        fn = (require(jsPath(built.outDir, law.file)) as Record<string, (...args: unknown[]) => unknown>)[
          law.symbol ?? law.name
        ];
      } catch (error) {
        add(law, 'error', 'load', { message: `cannot load compiled law: ${(error as Error).message}` });
        return;
      }
      if (typeof fn !== 'function') {
        add(law, 'error', 'load', { message: 'compiled module does not export the law' });
        return;
      }
      isAsync = fn.constructor.name === 'AsyncFunction';
    }
    // One property run of the law: in the sandbox, or in a worker of this process when it is off or the law is end to end.
    const execute = async (runOptions: CheckOptions): Promise<PropertyOutcome | 'timeout'> => {
      if (!sandboxed || e2e) return runLawGuarded(built.outDir, law, runOptions, types.plans);
      if (sandbox === undefined) throw new Error('the law sandbox is on but was not set up');
      const ran = await sandbox.run(built.outDir, law, runOptions, types.plans);
      if (ran === 'timeout') return ran;
      isAsync = ran.async;
      return ran.outcome;
    };
    let details: PropertyOutcome | 'timeout';
    // Counterexamples found before are tried first.
    let lawOptions: CheckOptions = options.noRegressions
      ? options
      : { ...options, regressionExamples: loadExamples(options.cwd, law.file, law.name) };
    // End-to-end inputs are expensive: fewer runs and a longer limit, unless the command line says otherwise.
    const e2eConfig = e2e ? readConfig(options.cwd).e2e : undefined;
    let limitMs = options.propertyTimeoutMs ?? 30000;
    if (e2e) {
      if (!options.explicit?.includes('runs')) lawOptions = { ...lawOptions, runs: e2eConfig?.runs ?? 10 };
      if (!options.explicit?.includes('property-timeout')) limitMs = e2eConfig?.timeoutMs ?? 120000;
    }
    try {
      details = e2e
        ? await runE2eLaw(
            { file: law.file, name: law.name, fn: fn!, generators: types.generators },
            lawOptions,
            await ensureServer(e2eConfig ?? {}, options.cwd),
            limitMs,
          )
        : browser
          ? await runBrowserLaw(
              {
                file: law.file,
                name: law.name,
                symbol: law.symbol,
                jsFile: jsPath(built.outDir, law.file),
                generators: types.generators,
              },
              lawOptions,
            )
          : await execute(lawOptions);
    } catch (error) {
      if (error instanceof LawLoadError)
        add(law, 'error', 'load', { message: `cannot load compiled law: ${error.message}` });
      else add(law, 'error', method, { message: (error as Error).message });
      return;
    }
    if (details === 'timeout') {
      add(law, 'error', method, {
        message: `property test ran longer than ${limitMs / 1000}s; the law or the code it calls may not terminate`,
      });
      return;
    }
    if (details.failed) {
      if (details.counterexample === undefined) {
        add(law, 'open', method, {
          runs: details.numRuns,
          seed: details.seed,
          message: 'assume() discards nearly every generated input',
        });
      } else {
        if (!options.noRegressions && details.encoded !== undefined && !details.regression)
          saveExample(options.cwd, law.file, law.name, decodeExample(details.encoded));
        const reason =
          details.message === undefined || details.message.startsWith('Property failed by returning false')
            ? 'returned false'
            : `threw: ${details.message}`;
        add(law, 'failed', method, {
          exercises: markFailing(exercisesFor(law), details.stack, built.outDir),
          runs: details.numRuns,
          seed: details.seed,
          counterexample: details.counterexample,
          screenshot: details.screenshot,
          message: details.regression ? `${regressionMessage} (${details.counterexample}): ${reason}` : reason,
        });
      }
      return;
    }
    // Browser and async laws are tested, never proved: the prover cannot model a DOM or an await.
    const unprovable = browser || e2e ? 'runs in a browser' : isAsync ? 'is async' : undefined;
    if (options.noProve || unprovable !== undefined) {
      add(law, law.proved ? 'open' : 'tested', method, {
        runs: details.numRuns,
        seed: details.seed,
        message: law.proved
          ? unprovable !== undefined
            ? `marked proved but the law ${unprovable}`
            : 'marked proved but proving is disabled'
          : undefined,
      });
      return;
    }
    const holds = (inputs: unknown[]): boolean | Promise<boolean> => {
      if (sandboxed && sandbox === undefined) return false;
      if (sandbox !== undefined) return sandbox.holds(built.outDir, law, inputs, limitMs);
      try {
        return fn!(...inputs) !== false;
      } catch (error) {
        return isDiscard(error);
      }
    };
    const proof = await proveLaw({
      law,
      shapes: types.shapes,
      jsFile: jsPath(built.outDir, law.file),
      bound: options.bound,
      timeoutMs: options.proofTimeoutMs,
      holds,
      solvers: config.solvers,
      certify:
        certifyMode === false
          ? undefined
          : { mode: certifyMode, dir: join(options.cwd, '.tslaws', 'certificates'), root: options.cwd },
    });
    const certified = (certificate: LawResult['certificate']): Pick<LawResult, 'certificate'> =>
      certificate === undefined ? {} : { certificate };
    const assumed = (list: string[]): Pick<LawResult, 'assumptions'> => (list.length > 0 ? { assumptions: list } : {});
    if (proof.kind === 'proved' || proof.kind === 'bounded') {
      // With certifying on, every proof has a certificate; one that is missing counts as uncertified, so `require`
      // cannot pass a proof nobody checked.
      if (certifyMode !== false) proof.certificate ??= noCertificate;
      if (proof.certificate !== undefined) {
        records.set(lawKey(law.file, law.name), recordOf(lawHash(law), proof.certificate));
        const required = certificateFailure(certifyMode, proof.certificate);
        if (required !== undefined) {
          add(law, 'error', 'smt', { certificate: proof.certificate, message: required });
          return;
        }
        // A lock certificate for a different problem than the one proved now no longer vouches for the law.
        if (lock !== undefined && staleRecord(lock.certificates?.[lawKey(law.file, law.name)], proof.certificate))
          notices.push(
            `${lawKey(law.file, law.name)}: the certificate in the lock is for a different proof problem; run \`tslaws accept --certify\` to record the new one`,
          );
      }
    }
    if (proof.kind === 'proved') {
      // The property run above used generators inside the proved domain; a short one is topped up before the proof stands.
      const passed = details;
      const rerun = (runs: number): Promise<PropertyOutcome | 'timeout'> =>
        execute({ ...lawOptions, runs, seed: passed.seed });
      let disagrees: PropertyOutcome | 'timeout' | undefined;
      try {
        disagrees = await crossCheck(details, types.plans.length, rerun);
      } catch (error) {
        add(law, 'error', 'smt', { message: (error as Error).message });
        return;
      }
      if (disagrees === 'timeout')
        add(law, 'error', 'smt', {
          message: `proved, but the cross-check run in JavaScript ran longer than ${limitMs / 1000}s`,
        });
      else if (disagrees !== undefined) {
        if (!options.noRegressions && disagrees.encoded !== undefined)
          saveExample(options.cwd, law.file, law.name, decodeExample(disagrees.encoded));
        add(law, 'failed', 'smt', {
          exercises: markFailing(exercisesFor(law), disagrees.stack, built.outDir),
          runs: disagrees.numRuns,
          seed: disagrees.seed,
          counterexample: disagrees.counterexample,
          message: disagreement(disagrees),
        });
      } else
        add(law, 'proved', 'smt', {
          runs: details.numRuns,
          seed: details.seed,
          ...assumed(proof.assumptions),
          ...certified(proof.certificate),
        });
    } else if (proof.kind === 'bounded') {
      // `law proved` promises every input; a bounded proof is the most Z3 could show.
      const message = `holds within bounds: ${proof.limits.join('; ')}`;
      if (law.proved)
        add(law, 'open', 'smt', {
          runs: details.numRuns,
          seed: details.seed,
          message: `marked proved but only ${message}`,
        });
      else
        add(law, 'bounded', 'smt', {
          runs: details.numRuns,
          seed: details.seed,
          message,
          ...assumed(proof.assumptions),
          ...certified(proof.certificate),
        });
    } else if (proof.kind === 'error') add(law, 'error', 'smt', { message: proof.message });
    else if (proof.kind === 'refuted')
      add(law, 'failed', 'smt', { counterexample: proof.model, message: 'refuted by the prover' });
    else if (law.proved)
      add(law, 'open', 'smt', {
        runs: details.numRuns,
        seed: details.seed,
        message: `marked proved but not proved: ${proof.reason}`,
      });
    else add(law, 'tested', 'property', { runs: details.numRuns, seed: details.seed, message: proof.reason });
  };
  const finished = new Map<number, (() => void)[]>();
  let nextToFlush = 0;
  const flush = (): void => {
    for (let ready = finished.get(nextToFlush); ready !== undefined; ready = finished.get(nextToFlush)) {
      for (const emit of ready) emit();
      finished.delete(nextToFlush);
      nextToFlush += 1;
    }
  };
  // Every law takes a slot of the process-wide CPU budget, and what it starts (a proof, a solver, a law process) runs on
  // that slot. Browser and end-to-end laws also share one page and one server, so they queue for it first.
  const page = new Semaphore(1);
  await Promise.all(
    laws.map(async (law, index) => {
      const skipped = !selected(law) || blocked.has(lawKey(law.file, law.name));
      if (skipped) {
        finished.set(index, []);
        flush();
        return;
      }
      const inSlot = (): Promise<void> => budget.run(() => runOne(law, index));
      await (verdictOf(law.file).kind !== 'node' ? page.run(inSlot) : inSlot());
    }),
  );

  if (enforceLock && options.onlyKeys === undefined) {
    const coverage = derived.coverage(() =>
      analyzeCoverage({
        cwd: options.cwd,
        outDir: built.outDir,
        lawFiles: options.files,
        coverFiles: covered,
        program: program(),
        moduleOf: sourceCwd === undefined ? undefined : (file) => resolve(sourceCwd, file),
      }),
    );
    for (const { file, name } of coverage.uncovered) {
      results.push({
        file,
        name,
        line: declarationOf(sources, file, name)?.line ?? 0,
        status: 'uncovered',
        method: 'coverage',
        message: 'no law reaches this exported function; add a law, or a person can mark it @tslaws-exempt and accept',
      });
    }
    for (const key of coverage.exempt) {
      if (lock?.exempt.includes(key) === true) continue;
      const [file, name] = key.split('::') as [string, string];
      results.push({
        file,
        name,
        line: 0,
        status: 'tampered',
        method: 'lock',
        message: `exempted from coverage but not in the lock; ${acceptor}`,
        proposal: { reason: 'exempt', status: 'proved', method: 'lock', message: 'an exemption runs nothing' },
      });
    }
  }

  await closeBrowser();
  await stopServer();

  // Records for `tslaws accept` to consider; a law that did not end proved or bounded keeps no certificate.
  if (certifyMode !== false && enforceLock && records.size > 0) {
    // A law the lock does not record yet is reported `tampered`; its proof counts through the proposal it carries.
    const held = new Set(results.filter((r) => proofStatus(r) !== undefined).map((r) => lawKey(r.file, r.name)));
    for (const key of records.keys()) if (!held.has(key)) records.set(key, undefined);
    writeRecords(options.cwd, records);
  }

  const ok =
    built.ok &&
    !lockMissing &&
    results.every((r) => r.status === 'proved' || r.status === 'bounded' || r.status === 'tested');
  return { results, compileDiagnostics: built.diagnostics, compileOk: built.ok, lockMissing, notices, ok };
}
