import { createInterface } from 'node:readline/promises';
import { readdirSync, statSync, watch } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { bundledCompiler } from './bundled.ts';
import { check, exemptionsOf } from './check.ts';
import type { CheckReport } from './check.ts';
import { readManifest } from './compile.ts';
import { hintFor } from './hints.ts';
import { init, nextStep } from './init.ts';
import { reporterNames, reportAs } from './reporters.ts';
import { serveUi } from './ui.ts';
import { writeLock } from './lock.ts';
import type { CheckOptions, LawResult } from './types.ts';

const usage = `tslaws init [--force]       scaffold tslaws.json, .gitignore, AGENTS.md, Claude Code hooks and a starter law (never writes the lock)
tslaws check [files...] [--reporter text|json|junit|github] [--json] [--summary] [--watch] [--runs N] [--seed N] [--no-prove] [--bound N] [--proof-timeout MS] [--property-timeout MS] [--proposed] [--compiler PATH]
tslaws ui [files...] [--port N] [--no-open]   open a dashboard of the laws in a browser: tree, filters, search, source, live reruns on save
tslaws accept [files...]     record the current laws in tsc-laws.lock (people only: needs a terminal)

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
  const valued = new Set(['runs', 'seed', 'compiler', 'bound', 'proof-timeout', 'property-timeout', 'port', 'reporter']);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valued.has(name)) flags.set(name, args[(i += 1)] ?? '');
      else flags.set(name, true);
    } else if (i === 0 && (arg === 'check' || arg === 'accept' || arg === 'init' || arg === 'ui')) command = arg;
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
  return {
    files: chosen,
    cwd,
    runs: Number(flags.get('runs') ?? 200),
    seed: flags.has('seed') ? Number(flags.get('seed')) : undefined,
    compiler: String(flags.get('compiler') ?? process.env.TSC_LAWS_BIN ?? bundledCompiler() ?? 'tsc-laws'),
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: flags.has('no-prove'),
    bound: Number(flags.get('bound') ?? 4),
    proofTimeoutMs: Number(flags.get('proof-timeout') ?? 5000),
    propertyTimeoutMs: Number(flags.get('property-timeout') ?? 30000),
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
      run: (only, onEvent) =>
        check({ ...options(cwd, flags, only ?? chosen), onEvent, browserPauseMs: 120 }, !flags.has('proposed')),
      log: (line) => process.stdout.write(`${line}\n`),
    });
  }

  return flags.has('watch') ? watchChecks(cwd, flags, files) : runCheck(cwd, flags, files);
}
