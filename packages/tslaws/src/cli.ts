import { createInterface } from 'node:readline/promises';
import { readdirSync, statSync, watch } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { resolveEngine } from './browser.ts';
import { bundledCompiler } from './bundled.ts';
import { check, exemptionsOf } from './check.ts';
import type { CheckReport } from './check.ts';
import { readManifest } from './compile.ts';
import { hintFor } from './hints.ts';
import { init, nextStep } from './init.ts';
import { serveMcp } from './mcp.ts';
import { promoteFiles } from './promote.ts';
import { clearCorpus, listCorpus } from './regressions.ts';
import { reporterNames, reportAs } from './reporters.ts';
import { readConfig } from './coverage.ts';
import { mutate, renderMutation } from './mutate.ts';
import { mutateDefaults, resolveSettings } from './settings.ts';
import { serveUi } from './ui.ts';
import { writeLock } from './lock.ts';
import type { CheckOptions, LawResult } from './types.ts';

const usage = `tslaws init [--force]       scaffold tslaws.json, .gitignore, AGENTS.md, Claude Code hooks and a starter law (never writes the lock)
tslaws check [files...] [--reporter text|json|junit|github] [--json] [--summary] [--watch] [--runs N] [--seed N] [--no-prove] [--no-regressions] [--bound N] [--proof-timeout MS] [--property-timeout MS] [--proposed] [--compiler PATH] [--browser chromium|firefox|webkit]
tslaws ui [files...] [--port N] [--no-open]   open a dashboard of the laws in a browser: tree, filters, search, source, live reruns on save
tslaws mutate [files...] [--max N] [--seed N] [--runs N] [--bound N] [--proof-timeout MS] [--property-timeout MS] [--browser ENGINE] [--json]   mutation-test the laws: mutate covered code, report mutants no law kills
tslaws regressions [list|clear]   show or delete the stored counterexamples (.tslaws/regressions); check replays them first, --no-regressions skips them
tslaws accept [files...]     record the current laws in tsc-laws.lock (people only: needs a terminal)
tslaws promote [file] [--all]   move proposed laws (*.proposed.laws.ts) into the accepted *.laws.ts, asking per law (people only: needs a terminal; run accept afterwards)
tslaws mcp [--compiler PATH]   serve check, check_proposed, explain and propose as Model Context Protocol tools on stdio (cannot accept or touch the lock)

Without files, every *.laws.ts under the current directory is checked (*.proposed.laws.ts only with --proposed).
Exit status is 0 only when every law is proved, bounded or tested and nothing is open, failed, uncovered or tampered with.
  --json      machine-readable report; each result carries a hint with the next action (same as --reporter json)
  --reporter  text (default), json, junit (JUnit XML) or github (workflow annotations; appends a table to $GITHUB_STEP_SUMMARY)
  --summary   one line per non-passing law, then the totals line
  --watch     rerun the check when a .ts file under the current directory changes (Ctrl+C exits)
  --force     init: overwrite tslaws.json and replace the AGENTS.md section`;

const ignoredDirs = new Set(['node_modules', '.tslaws', '.git']);
const passing = new Set(['proved', 'bounded', 'tested']);

function discover(cwd: string, proposed: boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (ignoredDirs.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.laws.ts') && entry.endsWith('.proposed.laws.ts') === proposed) found.push(full);
    }
  };
  walk(cwd);
  return found.map((f) => relative(cwd, f).replace(/\\/g, '/')).sort();
}

function parse(args: string[]): { command: string; flags: Map<string, string | true>; files: string[] } {
  const flags = new Map<string, string | true>();
  const files: string[] = [];
  let command = 'check';
  const valued = new Set([
    'runs',
    'seed',
    'compiler',
    'bound',
    'proof-timeout',
    'property-timeout',
    'browser',
    'port',
    'reporter',
    'max',
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valued.has(name)) flags.set(name, args[(i += 1)] ?? '');
      else flags.set(name, true);
    } else if (
      i === 0 &&
      (arg === 'check' ||
        arg === 'accept' ||
        arg === 'init' ||
        arg === 'ui' ||
        arg === 'mutate' ||
        arg === 'regressions' ||
        arg === 'mcp' ||
        arg === 'promote')
    )
      command = arg;
    else files.push(arg);
  }
  return { command, flags, files };
}

function describe(result: LawResult): string {
  const where = `${result.file}:${result.line}`;
  const head = `${result.status.toUpperCase().padEnd(8)} ${result.name} (${where}) [${result.method}]`;
  const lines = [head];
  if (result.message !== undefined) lines.push(`         ${result.message}`);
  if (result.counterexample !== undefined) lines.push(`         counterexample: ${result.counterexample}`);
  if (result.status === 'failed' && result.seed !== undefined)
    lines.push(`         reproduce with --seed ${result.seed}`);
  const hint = hintFor(result);
  if (hint !== undefined) lines.push(`         hint: ${hint}`);
  return lines.join('\n');
}

function summarise(result: LawResult): string {
  const detail = [
    result.message,
    result.counterexample !== undefined ? `counterexample: ${result.counterexample}` : undefined,
  ]
    .filter((d): d is string => d !== undefined)
    .join(' | ')
    .replace(/\s+/g, ' ');
  return `${result.status.toUpperCase()} ${result.name} (${result.file}:${result.line})${detail === '' ? '' : ` ${detail}`}`;
}

function totals(report: CheckReport): string {
  const count = (status: string): number => report.results.filter((r) => r.status === status).length;
  return `${report.results.length} laws: ${count('proved')} proved, ${count('bounded')} bounded, ${count('tested')} tested, ${count('open')} open, ${count('failed')} failed, ${count('tampered')} tampered, ${count('error')} errors`;
}

function render(report: CheckReport, flags: Map<string, string | true>): string {
  const reporter = String(flags.get('reporter') ?? (flags.has('json') ? 'json' : 'text'));
  if (!(reporterNames as readonly string[]).includes(reporter)) {
    throw new Error(`unknown reporter '${reporter}' (expected ${reporterNames.join(', ')})`);
  }
  if (reporter === 'junit' || reporter === 'github') return reportAs(reporter, report);
  if (reporter === 'json') {
    return `${JSON.stringify({ ...report, results: report.results.map((r) => ({ ...r, hint: hintFor(r) })) }, null, 2)}\n`;
  }
  let text = '';
  if (report.compileDiagnostics !== '') text += `${report.compileDiagnostics}\n\n`;
  if (report.lockMissing) text += 'tsc-laws.lock is missing: a person must run `tslaws accept`\n\n';
  if (flags.has('summary')) {
    for (const result of report.results) if (!passing.has(result.status)) text += `${summarise(result)}\n`;
    return `${text}${totals(report)}\n`;
  }
  for (const result of report.results) text += `${describe(result)}\n`;
  return `${text}\n${totals(report)}\n`;
}

function options(cwd: string, flags: Map<string, string | true>, chosen: string[]): CheckOptions {
  const settings = resolveSettings(flags, readConfig(cwd));
  return {
    files: chosen,
    cwd,
    runs: settings.runs,
    seed: flags.has('seed') ? Number(flags.get('seed')) : undefined,
    compiler: String(flags.get('compiler') ?? process.env.TSC_LAWS_BIN ?? bundledCompiler() ?? 'tsc-laws'),
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: flags.has('no-prove'),
    noRegressions: flags.has('no-regressions'),
    bound: settings.bound,
    proofTimeoutMs: settings.proofTimeoutMs,
    propertyTimeoutMs: settings.propertyTimeoutMs,
    explicit: settings.explicit,
    browser: flags.has('browser')
      ? (resolveEngine(String(flags.get('browser'))) as CheckOptions['browser'])
      : undefined,
  };
}

function lawFiles(cwd: string, flags: Map<string, string | true>, files: string[]): string[] {
  return files.length > 0
    ? files.map((f) => relative(cwd, resolve(cwd, f)).replace(/\\/g, '/'))
    : discover(cwd, flags.has('proposed'));
}

/** One check of the project. Resolves the exit status. */
async function runCheck(cwd: string, flags: Map<string, string | true>, files: string[]): Promise<number> {
  const chosen = lawFiles(cwd, flags, files);
  if (chosen.length === 0) {
    process.stderr.write('no laws files found (looking for *.laws.ts)\n');
    return 1;
  }
  const report = await check(options(cwd, flags, chosen), !flags.has('proposed'));
  process.stdout.write(render(report, flags));
  return report.ok ? 0 : 1;
}

function watched(filename: string | null): boolean {
  if (filename === null || !filename.endsWith('.ts')) return false;
  return !filename.split(/[\\/]/).some((part) => ignoredDirs.has(part));
}

/** Checks now and after every .ts change under cwd (debounced 300 ms). Resolves the last exit status on Ctrl+C. */
async function watchChecks(cwd: string, flags: Map<string, string | true>, files: string[]): Promise<number> {
  let last = 0;
  let running = false;
  let queued: string | undefined;
  let timer: NodeJS.Timeout | undefined;

  const cycle = async (why: string): Promise<void> => {
    if (running) {
      queued = why;
      return;
    }
    running = true;
    let next: string | undefined = why;
    while (next !== undefined) {
      queued = undefined;
      process.stdout.write(`\n==== ${new Date().toLocaleTimeString()} tslaws check (${next}) ====\n`);
      try {
        last = await runCheck(cwd, flags, files);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        last = 1;
      }
      process.stdout.write(
        `==== exit status ${last}${last === 0 ? ' (ok)' : ' (failing)'}; watching for changes, Ctrl+C exits ====\n`,
      );
      next = queued;
    }
    running = false;
  };

  await cycle('initial run');
  return new Promise<number>((done) => {
    const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
      const name = filename === null ? null : String(filename);
      if (name === null || !watched(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void cycle(`changed: ${name.split(sep).join('/')}`), 300);
    });
    process.once('SIGINT', () => {
      clearTimeout(timer);
      watcher.close();
      done(last);
    });
  });
}

export async function main(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const { command, flags, files } = parse(args);
  const cwd = process.cwd();

  if (command === 'init') {
    process.stdout.write(`${init({ cwd, force: flags.has('force') }).join('\n')}\n\n${nextStep}\n`);
    return 0;
  }

  if (command === 'accept') {
    const chosen = lawFiles(cwd, flags, files);
    if (chosen.length === 0) {
      process.stderr.write('no laws files found (looking for *.laws.ts)\n');
      return 1;
    }
    if (!process.stdin.isTTY || process.env.TSLAWS_AGENT !== undefined || process.env.CI !== undefined) {
      process.stderr.write('accept records laws as correct and needs a person at a terminal; it will not run here\n');
      return 1;
    }
    const opts = options(cwd, flags, chosen);
    const laws = readManifest(opts.compiler, opts.files, cwd);
    process.stdout.write(
      `${laws.length} laws in ${chosen.length} files:\n${laws.map((l) => `  ${l.file}:${l.line} ${l.name}`).join('\n')}\n`,
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type ACCEPT to write tsc-laws.lock: ');
    rl.close();
    if (answer.trim() !== 'ACCEPT') return 1;
    const exempt = exemptionsOf(opts);
    if (exempt.length > 0) process.stdout.write(`exempt from coverage:\n${exempt.map((e) => `  ${e}`).join('\n')}\n`);
    writeLock(opts.lockFile, laws, exempt);
    process.stdout.write('tsc-laws.lock written\n');
    return 0;
  }

  if (command === 'mcp') return serveMcp({ cwd, compiler: options(cwd, flags, []).compiler });

  if (command === 'promote') {
    if (!process.stdin.isTTY || process.env.TSLAWS_AGENT !== undefined || process.env.CI !== undefined) {
      process.stderr.write(
        'promote moves laws into the accepted set and needs a person at a terminal; it will not run here\n',
      );
      return 1;
    }
    const proposedFiles = files.length > 0 ? lawFiles(cwd, flags, files) : flags.has('all') ? discover(cwd, true) : [];
    if (proposedFiles.length === 0) {
      const known = discover(cwd, true).map((f) => `  ${f}`);
      process.stderr.write(
        files.length > 0 || flags.has('all')
          ? 'no proposed laws files found (looking for *.proposed.laws.ts)\n'
          : `name a proposed file or pass --all:\n${known.join('\n')}\n`,
      );
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await promoteFiles(
        {
          cwd,
          ask: (question) => rl.question(question),
          out: (text) => process.stdout.write(text),
          checkFile: async (file) => {
            const report = await check(options(cwd, flags, [file]), false);
            const brief = (r: LawResult): string =>
              r.message === undefined ? r.status : `${r.status}: ${r.message.split('\n')[0]}`;
            return new Map(report.results.map((r) => [r.name, brief(r)]));
          },
        },
        proposedFiles,
      );
    } finally {
      rl.close();
    }
    return 0;
  }

  if (command === 'mutate') {
    // *.laws.ts arguments choose the laws; other files restrict which covered sources are mutated.
    const chosen = lawFiles(
      cwd,
      flags,
      files.filter((f) => f.endsWith('.laws.ts')),
    );
    if (chosen.length === 0) {
      process.stderr.write('no laws files found (looking for *.laws.ts)\n');
      return 1;
    }
    const settings = resolveSettings(flags, readConfig(cwd), mutateDefaults);
    const report = await mutate({
      cwd,
      lawFiles: chosen,
      lawsNamed: files.some((f) => f.endsWith('.laws.ts')),
      runs: settings.runs,
      bound: settings.bound,
      proofTimeoutMs: settings.proofTimeoutMs,
      propertyTimeoutMs: settings.propertyTimeoutMs,
      browser: options(cwd, flags, chosen).browser,
      targets: files.filter((f) => !f.endsWith('.laws.ts')).map((f) => relative(cwd, resolve(cwd, f))),
      compiler: options(cwd, flags, chosen).compiler,
      max: Number(flags.get('max') ?? 50),
      seed: flags.has('seed') ? Number(flags.get('seed')) : undefined,
      onProgress: flags.has('json') ? undefined : (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(flags.has('json') ? `${JSON.stringify(report, null, 2)}\n` : renderMutation(report));
    return report.ok ? 0 : 1;
  }

  if (command === 'regressions') {
    const action = files[0] ?? 'list';
    if (action === 'clear') {
      process.stdout.write(clearCorpus(cwd) ? 'cleared .tslaws/regressions\n' : 'no regression corpus to clear\n');
      return 0;
    }
    if (action !== 'list') {
      process.stderr.write(`unknown action '${action}' (expected list or clear)\n`);
      return 1;
    }
    const corpus = listCorpus(cwd);
    process.stdout.write(
      corpus.length === 0
        ? 'no stored counterexamples\n'
        : `${corpus.map((e) => `${e.file} ${e.law}: ${e.count} example${e.count === 1 ? '' : 's'}`).join('\n')}\n`,
    );
    return 0;
  }

  if (command === 'ui') {
    const chosen = lawFiles(cwd, flags, files);
    if (chosen.length === 0) {
      process.stderr.write('no laws files found (looking for *.laws.ts)\n');
      return 1;
    }
    return serveUi({
      cwd,
      port: Number(flags.get('port') ?? 51205),
      open: !flags.has('no-open'),
      // A watcher sees a browser page only if it stays as the law left it for a moment.
      run: (only, onEvent, laws) =>
        check(
          { ...options(cwd, flags, only ?? chosen), only: laws, onEvent, browserPauseMs: 120 },
          !flags.has('proposed'),
        ),
      log: (line) => process.stdout.write(`${line}\n`),
    });
  }

  return flags.has('watch') ? watchChecks(cwd, flags, files) : runCheck(cwd, flags, files);
}
