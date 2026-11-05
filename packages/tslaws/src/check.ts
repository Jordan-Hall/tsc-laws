import { createRequire } from 'node:module';
import ts from 'typescript';
import { build, readManifest } from './compile.ts';
import {
  compilerOptions,
  declarationFiles,
  isDiscard,
  jsPath,
  runLawGuarded,
  typesOf,
  type LawTypes,
  type PropertyOutcome,
} from './property.ts';
import { analyzeCoverage, coverFiles, readConfig } from './coverage.ts';
import { compareLock, lawKey, readLock, type Lock } from './lock.ts';
import { proveLaw } from './smt.ts';
import { decodeExample, loadExamples, regressionMessage, saveExample } from './regressions.ts';
import { closeBrowser, runBrowserLaw } from './browser.ts';
import { ensureServer, runE2eLaw, stopServer } from './e2e.ts';
import { inProposals } from './lawFiles.ts';
import { classifyLawFile, type KindVerdict } from './lawKinds.ts';
import { isProposedLawFile } from './lawNames.ts';
import { normaliseProposal } from './proposals.ts';
import { declarationOf, exercisesOf, markFailing, Sources, type Exercised } from './exercises.ts';
import type { CheckOptions, LawResult, ManifestLaw } from './types.ts';

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
  const program = ts.createProgram(declarationFiles(built.outDir), compilerOptions);
  return analyzeCoverage({
    cwd: options.cwd,
    outDir: built.outDir,
    lawFiles: options.files,
    coverFiles: covered,
    program,
  }).exempt;
}

export async function check(options: CheckOptions, enforceLock: boolean): Promise<CheckReport> {
  // A proposal placed in .tslaws/proposals by hand may write its imports from the project root; store them where they resolve.
  for (const file of options.files) if (inProposals(file)) normaliseProposal(options.cwd, file);
  const laws = readManifest(options.compiler, options.files, options.cwd);
  const results: LawResult[] = [];
  const blocked = new Set<string>();
  const notices: string[] = [];
  for (const file of options.files) {
    if (isProposedLawFile(file))
      notices.push(
        `${file}: in-tree *.proposed.laws.ts names are deprecated; keep proposals in .tslaws/proposals/ (outside the tree, git-ignored), where \`tslaws propose\` writes them`,
      );
  }
  // The level of a laws file comes from what it imports; looked at once per file.
  const verdicts = new Map<string, KindVerdict>();
  const verdictOf = (file: string): KindVerdict => {
    let verdict = verdicts.get(file);
    if (verdict === undefined) {
      verdict = classifyLawFile(options.cwd, file);
      verdicts.set(file, verdict);
      for (const notice of verdict.notices) notices.push(notice);
    }
    return verdict;
  };
  const sources = new Sources(options.cwd);
  // What a law reaches is syntactic and cheap; a project that cannot be read this way just has no locations.
  const exercisesFor = (law: ManifestLaw): Exercised[] => {
    try {
      return exercisesOf(sources, law);
    } catch {
      return [];
    }
  };
  const add = (law: ManifestLaw, status: LawResult['status'], method: string, extra: Partial<LawResult> = {}): void => {
    const exercises = status === 'tampered' ? [] : (extra.exercises ?? exercisesFor(law));
    const result: LawResult = {
      file: law.file,
      name: law.name,
      line: law.line,
      status,
      method,
      ...extra,
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
    for (const violation of compareLock(lock?.laws, laws)) {
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
        });
      } else {
        add(law, 'tampered', 'lock', {
          message:
            violation.reason === 'added'
              ? 'law is not in the lock; a person must run `tslaws accept`'
              : 'law changed since the lock was accepted',
        });
      }
    }
  }

  for (const law of laws) {
    if (law.problems.length > 0 && !blocked.has(lawKey(law.file, law.name)))
      add(law, 'error', 'manifest', { message: law.problems.join('; ') });
  }

  const covered = coverFiles(options.cwd, readConfig(options.cwd).cover ?? []);
  const compiled = [...new Set([...options.files, ...covered])];
  const built = build(options.compiler, compiled, options.cwd);
  const program = ts.createProgram(declarationFiles(built.outDir), compilerOptions);
  const require = createRequire(import.meta.url);

  for (const law of laws) {
    if (options.only !== undefined && !options.only.includes(law.name)) continue;
    if (blocked.has(lawKey(law.file, law.name))) continue;
    options.onEvent?.({ type: 'start', file: law.file, name: law.name });
    let types: LawTypes;
    try {
      types = typesOf(program, built.outDir, law);
    } catch (error) {
      add(law, 'error', 'generators', { message: (error as Error).message });
      continue;
    }
    const verdict = verdictOf(law.file);
    if (verdict.error !== undefined) {
      add(law, 'error', 'manifest', { message: verdict.error });
      continue;
    }
    const browser = verdict.kind === 'browser';
    const e2e = verdict.kind === 'e2e';
    const method = browser ? 'browser' : e2e ? 'e2e' : 'property';
    let fn: ((...args: unknown[]) => unknown) | undefined;
    // A browser law touches the DOM when it loads, so only the browser loads it.
    if (!browser) {
      try {
        fn = (require(jsPath(built.outDir, law.file)) as Record<string, (...args: unknown[]) => unknown>)[law.name];
      } catch (error) {
        add(law, 'error', 'load', { message: `cannot load compiled law: ${(error as Error).message}` });
        continue;
      }
      if (typeof fn !== 'function') {
        add(law, 'error', 'load', { message: 'compiled module does not export the law' });
        continue;
      }
    }
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
              { file: law.file, name: law.name, jsFile: jsPath(built.outDir, law.file), generators: types.generators },
              lawOptions,
            )
          : await runLawGuarded(built.outDir, law, lawOptions);
    } catch (error) {
      add(law, 'error', method, { message: (error as Error).message });
      continue;
    }
    if (details === 'timeout') {
      add(law, 'error', method, {
        message: `property test ran longer than ${limitMs / 1000}s; the law or the code it calls may not terminate`,
      });
      continue;
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
      continue;
    }
    // Browser and async laws are tested, never proved: the prover cannot model a DOM or an await.
    const unprovable =
      browser || e2e ? 'runs in a browser' : fn!.constructor.name === 'AsyncFunction' ? 'is async' : undefined;
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
      continue;
    }
    const holds = (inputs: unknown[]): boolean => {
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
    });
    if (proof.kind === 'proved') add(law, 'proved', 'smt', { runs: details.numRuns, seed: details.seed });
    else if (proof.kind === 'bounded') {
      // `law proved` promises every input; a bounded proof is the most Z3 could show.
      const message = `holds within bounds: ${proof.limits.join('; ')}`;
      if (law.proved)
        add(law, 'open', 'smt', {
          runs: details.numRuns,
          seed: details.seed,
          message: `marked proved but only ${message}`,
        });
      else add(law, 'bounded', 'smt', { runs: details.numRuns, seed: details.seed, message });
    } else if (proof.kind === 'refuted')
      add(law, 'failed', 'smt', { counterexample: proof.model, message: 'refuted by the prover' });
    else if (law.proved)
      add(law, 'open', 'smt', {
        runs: details.numRuns,
        seed: details.seed,
        message: `marked proved but not proved: ${proof.reason}`,
      });
    else add(law, 'tested', 'property', { runs: details.numRuns, seed: details.seed, message: proof.reason });
  }

  if (enforceLock) {
    const coverage = analyzeCoverage({
      cwd: options.cwd,
      outDir: built.outDir,
      lawFiles: options.files,
      coverFiles: covered,
      program,
    });
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
        message: 'exempted from coverage but not in the lock; a person must run `tslaws accept`',
      });
    }
  }

  await closeBrowser();
  await stopServer();

  const ok =
    built.ok &&
    !lockMissing &&
    results.every((r) => r.status === 'proved' || r.status === 'bounded' || r.status === 'tested');
  return { results, compileDiagnostics: built.diagnostics, compileOk: built.ok, lockMissing, notices, ok };
}
