import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, watch } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { resolveEngine } from './browser.ts';
import { bundledCompiler, checkoutCompiler } from './bundled.ts';
import { certificatesToAccept, check, exemptionsOf } from './check.ts';
import type { CheckReport } from './check.ts';
import { readManifest } from './compile.ts';
import { hintFor } from './hints.ts';
import { discoverLaws, discoverProposals, ignoredDirs } from './lawFiles.ts';
import { isProposedLawFile } from './lawNames.ts';
import { init, nextStep } from './init.ts';
import { listLawFiles, renderList } from './list.ts';
import { serveMcp } from './mcp.ts';
import { affectedProjects, changedSince, discoverProjects, isMonorepoRoot } from './projects.ts';
import type { Project } from './projects.ts';
import { promoteFiles, promoteProposal } from './promote.ts';
import { addProposal, ProposalError } from './proposals.ts';
import { clearCorpus, listCorpus } from './regressions.ts';
import { proposalText, reporterNames, reportAs } from './reporters.ts';
import { readConfig } from './coverage.ts';
import { parseGithubConfig } from './github.ts';
import { migrateCommand, migrateUsage } from './migrate/index.ts';
import { mutate, renderMutation } from './mutate.ts';
import { mutateDefaults, resolveSettings } from './settings.ts';
import { serveUi } from './ui.ts';
import {
  acceptGate,
  defaultDuration,
  describeGrants,
  fileHash,
  grantFor,
  logDelegatedAccept,
  parseDuration,
  personOnly,
  revokeFor,
} from './delegation.ts';
import { certificateLabel } from './certificates.ts';
import { fileOfKey, lockFormat, lockOf, mergeScoped, readLock, scopeOf, writeLockValue } from './lock.ts';
import { lockLevels } from './lawKinds.ts';
import type { CheckOptions, LawEvent, LawResult } from './types.ts';

import { securityUsage } from './security/cli.ts';
import { plural } from './plural.ts';
import { configureJobs } from './pool.ts';

const usage = `tslaws init [--force]       scaffold tslaws.json, .gitignore, AGENTS.md, Claude Code hooks and a starter law (never writes the lock)
tslaws check [files...] [--reporter text|json|junit|github|ndjson] [--law NAME[,NAME]] [--json] [--summary] [--watch] [--runs N] [--seed N] [--no-prove] [--certify] [--require-certify] [--no-regressions] [--no-sandbox] [--allow-e2e] [--bound N] [--proof-timeout MS] [--property-timeout MS] [--jobs N] [--proposed] [--compiler PATH] [--browser chromium|firefox|webkit]
tslaws ui [files...] [--port N] [--no-open] [--tab]   open a dashboard of the laws in its own desktop window (--tab: a browser tab): tree, filters, search, source, live reruns on save
tslaws mutate [files...] [--max N] [--seed N] [--runs N] [--bound N] [--proof-timeout MS] [--property-timeout MS] [--jobs N] [--browser ENGINE] [--no-sandbox] [--allow-e2e] [--json]   mutation-test the laws: mutate covered code, report mutants no law kills
tslaws regressions [list|clear]   show or delete the stored counterexamples (.tslaws/regressions); check replays them first, --no-regressions skips them
tslaws accept [files...]     record the current laws in tsc-laws.lock (people only: needs a terminal, or a live delegation; never under CI)
tslaws delegate grant [--for 1h|8h|1d|7d] [--root DIR]   lend accept to an agent for a limited time (people only; default 8h, max 7d)
tslaws delegate revoke [--root DIR]   withdraw the delegation for a project (people only)
tslaws delegate status        list delegations and when they end
tslaws propose <file.ts> [--from PATH]   write a proposal into .tslaws/proposals/ from PATH or stdin (outside the tree, git-ignored; never touches the lock or any other file)
tslaws promote <proposal> [--to PATH] [--yes]   move a proposal from .tslaws/proposals/ into the tree at a path you confirm (people only: needs a terminal; run accept afterwards). It prints the imports and helper code it would add and asks first, and refuses an import of a file outside the project, under .tslaws/, node_modules or .git, or git-ignored; --yes adds it without asking (it is still printed; it never lets promote run without a terminal). In-tree *.proposed.laws.ts files (the usual proposals) promote with --all or by name
tslaws list [--json]   the laws files and proposals of the project: the level each runs at (from its name, or its imports with levels: imports) and whether it is accepted, unaccepted or proposed (reads files and the lock; runs nothing)
tslaws github report|command|merge|verify   accept laws on GitHub: flag and run each proposal on a pull request, record /tslaws accept comments, and write tsc-laws.lock on merge or on demand (workflow_dispatch) (CI only; see "github" in tslaws.json)
tslaws mcp [--compiler PATH]   serve check, check_proposed, explain and propose as Model Context Protocol tools on stdio (cannot accept, promote or touch the lock)
${migrateUsage}
${securityUsage}

In a monorepo (a root tslaws.json with "projects", or package.json/pnpm workspaces whose packages have a tslaws.json), run from the root: check, accept, list, mutate, regressions and security deps run in every project, one after another, each with its own config and lock, and end with one summary line. --json and --reporter json print one object keyed by project path; --reporter ndjson tags each line with "project". init, ui, mcp, github, propose, promote, delegate, migrate and --watch run in one project: pick it with --project when the root has several.
  --project   run only in this project directory (repeat it, or comma-separate: --project packages/a,packages/b)
  --filter    run only in projects whose path matches this glob (repeatable; a leading ! excludes), for example --filter 'packages/*'
  --changed   run only the projects affected since the merge-base of this ref and HEAD (committed, staged and untracked changes): the projects holding a changed file and everything that depends on them; a root config change runs all. Combines with --project and --filter. In one project: runs only if something there changed. For example --changed origin/main

Without files, every *.laws.ts under the current directory (and every file the "laws" globs of tslaws.json pick that declares a law) is checked; with --proposed, the in-tree *.proposed.laws.ts files are (and any proposals in .tslaws/proposals/), with no lock and no coverage gate.
A laws file's level comes from its name by default: *.browser.laws.ts is a browser law, *.e2e.laws.ts an end-to-end law, anything else runs in Node. With "levels": "imports" in tslaws.json it comes from the import graph instead (tslaws/browser, tslaws/adapters/* or tslaws/e2e, directly or through the file's own modules), and the names are hints.
Exit status is 0 only when every law is proved, bounded or tested and nothing is open, failed, uncovered or tampered with.
  --json      machine-readable report; each result carries a hint with the next action (same as --reporter json)
  --reporter  text (default), json, junit (JUnit XML), github (workflow annotations; appends a table to $GITHUB_STEP_SUMMARY) or ndjson (one JSON event per line as the check proceeds, then the report; for editors)
  --law       check only the laws with these names (comma-separated), in the files chosen
  --summary   one line per non-passing law, then the totals line
  --watch     rerun the check when a .ts file under the current directory changes (Ctrl+C exits)
  --force     init: overwrite tslaws.json and replace the AGENTS.md section`;

const passing = new Set(['proved', 'bounded', 'tested']);

function discover(cwd: string, proposed: boolean): string[] {
  return proposed ? [...discoverLaws(cwd, true), ...discoverProposals(cwd)] : discoverLaws(cwd, false);
}

interface Parsed {
  command: string;
  flags: Map<string, string | true>;
  files: string[];
  /** `--project` values, comma lists split. */
  projects: string[];
  /** `--filter` values, one glob each (a glob may hold commas). */
  filters: string[];
}

function parse(args: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const files: string[] = [];
  const projects: string[] = [];
  const filters: string[] = [];
  let command = 'check';
  const valued = new Set([
    'runs',
    'seed',
    'compiler',
    'bound',
    'proof-timeout',
    'property-timeout',
    'jobs',
    'browser',
    'port',
    'reporter',
    'law',
    'max',
    'for',
    'root',
    'to',
    'from',
    'out',
    'pr',
    'config-from',
    'results',
    'results-out',
    'head-sha',
    'rerun-workflow',
    'protect',
    'project-path',
    'fail-on',
    'changed',
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (name === 'project') {
        projects.push(
          ...(args[(i += 1)] ?? '')
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean),
        );
      } else if (name === 'filter') {
        const glob = args[(i += 1)] ?? '';
        if (glob !== '') filters.push(glob);
      } else if (valued.has(name)) flags.set(name, args[(i += 1)] ?? '');
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
        arg === 'promote' ||
        arg === 'propose' ||
        arg === 'list' ||
        arg === 'migrate' ||
        arg === 'delegate' ||
        arg === 'github' ||
        arg === 'security')
    )
      command = arg;
    else files.push(arg);
  }
  return { command, flags, files, projects, filters };
}

function describe(result: LawResult): string {
  const where = `${result.file}:${result.line}`;
  const head = `${result.status.toUpperCase().padEnd(8)} ${result.name} (${where}) [${result.method}]`;
  const lines = [head];
  if (result.message !== undefined) lines.push(`         ${result.message}`);
  if (result.assumptions !== undefined && result.assumptions.length > 0)
    lines.push(`         assuming: ${result.assumptions.join('; ')}`);
  if (result.certificate !== undefined) lines.push(`         certificate: ${certificateLabel(result.certificate)}`);
  const proposed = proposalText(result);
  if (proposed !== undefined) lines.push(`         ${proposed}`);
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
    proposalText(result),
    result.counterexample !== undefined ? `counterexample: ${result.counterexample}` : undefined,
  ]
    .filter((d): d is string => d !== undefined)
    .join(' | ')
    .replace(/\s+/g, ' ');
  return `${result.status.toUpperCase()} ${result.name} (${result.file}:${result.line})${detail === '' ? '' : ` ${detail}`}`;
}

export function totals(report: CheckReport): string {
  const count = (status: string): number => report.results.filter((r) => r.status === status).length;
  return `${plural(report.results.length, 'law')}: ${count('proved')} proved, ${count('bounded')} bounded, ${count('tested')} tested, ${count('open')} open, ${count('failed')} failed, ${count('tampered')} tampered, ${plural(count('error'), 'error')}`;
}

function render(report: CheckReport, flags: Map<string, string | true>, project?: string): string {
  const reporter = String(flags.get('reporter') ?? (flags.has('json') ? 'json' : 'text'));
  if (!(reporterNames as readonly string[]).includes(reporter)) {
    throw new Error(`unknown reporter '${reporter}' (expected ${reporterNames.join(', ')})`);
  }
  if (reporter === 'junit' || reporter === 'github') return reportAs(reporter, report);
  if (reporter === 'json') {
    return `${JSON.stringify({ ...report, results: report.results.map((r) => ({ ...r, hint: hintFor(r) })) }, null, 2)}\n`;
  }
  if (reporter === 'ndjson') {
    return `${JSON.stringify({ ...(project === undefined ? {} : { project }), type: 'report', ...report, results: report.results.map((r) => ({ ...r, hint: hintFor(r) })) })}\n`;
  }
  let text = '';
  if (report.compileDiagnostics !== '') text += `${report.compileDiagnostics}\n\n`;
  if (report.lockMissing) text += 'tsc-laws.lock is missing: a person must run `tslaws accept`\n\n';
  for (const notice of report.notices) text += `notice: ${notice}\n`;
  if (report.notices.length > 0) text += '\n';
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
    compiler: String(
      flags.get('compiler') ?? process.env.TSC_LAWS_BIN ?? bundledCompiler() ?? checkoutCompiler(cwd) ?? 'tsc-laws',
    ),
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: flags.has('no-prove'),
    // `--certify` turns certificates on (and keeps a "require" from tslaws.json); `--require-certify` makes them required.
    certify: flags.has('require-certify')
      ? 'require'
      : flags.has('certify')
        ? readConfig(cwd).certify === 'require'
          ? 'require'
          : true
        : undefined,
    noRegressions: flags.has('no-regressions'),
    sandbox: !flags.has('no-sandbox'),
    allowE2e: flags.has('allow-e2e'),
    only: typeof flags.get('law') === 'string' ? String(flags.get('law')).split(',').filter(Boolean) : undefined,
    bound: settings.bound,
    proofTimeoutMs: settings.proofTimeoutMs,
    propertyTimeoutMs: settings.propertyTimeoutMs,
    explicit: settings.explicit,
    browser: flags.has('browser')
      ? (resolveEngine(String(flags.get('browser'))) as CheckOptions['browser'])
      : undefined,
  };
}

/** Files outside the directories `skip` (project-relative paths of projects nested in this one). */
function outside(files: string[], skip: string[]): string[] {
  return skip.length === 0 ? files : files.filter((f) => !skip.some((dir) => f === dir || f.startsWith(`${dir}/`)));
}

function lawFiles(cwd: string, flags: Map<string, string | true>, files: string[], skip: string[] = []): string[] {
  return files.length > 0
    ? files.map((f) => relative(cwd, resolve(cwd, f)).replace(/\\/g, '/'))
    : outside(discover(cwd, flags.has('proposed')), skip);
}

/**
 * Where a run of one project writes and what it leaves alone. A root run gives each project its own: `out` can be a
 * buffer, `skip` lists the projects nested below this one (so a root that is itself a project does not run theirs) and
 * `tag` names the project on every ndjson line.
 */
interface Run {
  out: (text: string) => void;
  skip: string[];
  tag?: string;
}

const direct: Run = { out: (text) => void process.stdout.write(text), skip: [] };

/** One check of the project. Resolves the exit status. */
async function runCheck(
  cwd: string,
  flags: Map<string, string | true>,
  files: string[],
  run: Run = direct,
): Promise<number> {
  const chosen = lawFiles(cwd, flags, files, run.skip);
  if (chosen.length === 0) {
    process.stderr.write('no laws files found (looking for *.laws.ts)\n');
    return 1;
  }
  // `--reporter ndjson` streams one JSON event per line as the check proceeds, then the report, so an editor can show progress.
  const stream = flags.get('reporter') === 'ndjson';
  const onEvent = stream
    ? (event: LawEvent): void => {
        if (event.type !== 'frame')
          run.out(`${JSON.stringify(run.tag === undefined ? event : { project: run.tag, ...event })}\n`);
      }
    : undefined;
  const report = await check(
    { ...options(cwd, flags, chosen), partial: files.length > 0, onEvent },
    !flags.has('proposed'),
  );
  run.out(render(report, flags, run.tag));
  return report.ok ? 0 : 1;
}

export function watched(filename: string | null): boolean {
  if (filename === null || !filename.endsWith('.ts')) return false;
  const parts = filename.split(/[\\/]/);
  // The proposals directory is watched (a saved proposal reruns `check --proposed`); the rest of .tslaws is not.
  if (parts[0] === '.tslaws' && parts[1] === 'proposals' && !parts.slice(2, -1).some((p) => ignoredDirs.has(p)))
    return true;
  return !parts.some((part) => ignoredDirs.has(part));
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

/** What a command needs from its caller. `home` is for unit tests; the CLI never sets it. */
export interface CommandContext {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  home?: string;
  now?: Date;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Projects nested below `cwd`, project-relative: their laws are not this project's (set by a root run). */
  skip?: string[];
}

const stdoutWrite = (text: string): void => void process.stdout.write(text);
const stderrWrite = (text: string): void => void process.stderr.write(text);

export async function acceptCommand(
  cwd: string,
  flags: Map<string, string | true>,
  files: string[],
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.out ?? stdoutWrite;
  const err = ctx.err ?? stderrWrite;
  const chosen = lawFiles(cwd, flags, files, ctx.skip);
  if (chosen.length === 0) {
    err('no laws files found (looking for *.laws.ts)\n');
    return 1;
  }
  // A project that accepts laws on GitHub still lets a person accept by hand, unless it sets "github.local" to false.
  const github = readConfig(cwd).github;
  if (github !== undefined && !parseGithubConfig(github).local) {
    err(
      'this project accepts laws on GitHub only: tsc-laws.lock is written by the tslaws workflow, on merge or on demand (see "github" in tslaws.json, where "local" is false); propose the laws in a pull request instead\n',
    );
    return 1;
  }
  const gate = acceptGate({ isTTY: ctx.isTTY, env: ctx.env, root: cwd, now: ctx.now, home: ctx.home });
  if (!gate.ok) {
    err(`${gate.message}\n`);
    return 1;
  }
  const opts = options(cwd, flags, chosen);
  const laws = readManifest(opts.compiler, opts.files, cwd);
  out(
    `${plural(laws.length, 'law')} in ${plural(chosen.length, 'file')}:\n${laws.map((l) => `  ${l.file}:${l.line} ${l.name}`).join('\n')}\n`,
  );
  if (!gate.delegated) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Write tsc-laws.lock? Type accept, yes or y to confirm: ');
    rl.close();
    if (!['accept', 'yes', 'y'].includes(answer.trim().toLowerCase())) {
      out('Nothing written: the answer was not accept, yes or y. Run `tslaws accept` again to retry.\n');
      return 1;
    }
  }
  const before = fileHash(opts.lockFile);
  const exempt = exemptionsOf(opts);
  if (exempt.length > 0) out(`exempt from coverage:\n${exempt.map((e) => `  ${e}`).join('\n')}\n`);
  // With levels from imports the lock records each laws file's resolved level, so a helper that starts importing
  // tslaws/browser reads as tampered until a person accepts again. By name (the default) the lock is unchanged.
  const mode = readConfig(cwd).levels ?? 'names';
  const levels = lockLevels(cwd, laws, mode);
  // Certificates enter the lock only for the proofs and problems of this run; see certificatesToAccept.
  // Naming files accepts only those: the lock keeps every entry it has for the other files.
  const held = readLock(opts.lockFile);
  // The entries a partial accept keeps for the other files were hashed in the old format; keeping them under the new
  // version would make every one of them read as changed. Only a full accept can write the whole lock again.
  if (files.length > 0 && held !== undefined && (held.version ?? lockFormat) < lockFormat) {
    out(
      'Nothing written: lock format upgraded. The lock holds laws hashed in the old format for files you did not name; run `tslaws accept` without files to record them all.\n',
    );
    return 1;
  }
  const scope = scopeOf(chosen);
  const heldHere =
    files.length === 0
      ? held?.certificates
      : Object.fromEntries(Object.entries(held?.certificates ?? {}).filter(([key]) => scope.has(fileOfKey(key))));
  const certificates = await certificatesToAccept(opts, laws, heldHere, out);
  const next = lockOf(laws, exempt, levels, certificates);
  writeLockValue(opts.lockFile, files.length === 0 ? next : mergeScoped(held, scope, next));
  out('tsc-laws.lock written\n');
  if (gate.delegated) {
    logDelegatedAccept(cwd, gate.grant, before, fileHash(opts.lockFile), ctx.now ?? new Date());
    out(`DELEGATED ACCEPT: a person lent this act until ${gate.grant.expires}; recorded in .tslaws/accept.log\n`);
  }
  return 0;
}

/** `tslaws delegate <action> [--for D] [--root DIR]`; `argv` is everything after `delegate`. */
export function runDelegateCommand(argv: string[], cwd: string, ctx: CommandContext): number {
  const { flags, files } = parse(['delegate', ...argv]);
  return delegateCommand(cwd, files[0], flags, ctx);
}

function delegateCommand(
  cwd: string,
  action: string | undefined,
  flags: Map<string, string | true>,
  ctx: CommandContext,
): number {
  const out = ctx.out ?? stdoutWrite;
  const err = ctx.err ?? stderrWrite;
  const now = ctx.now ?? new Date();
  if (action === 'status') {
    out(`${describeGrants(now, ctx.home).join('\n')}\n`);
    return 0;
  }
  if (action !== 'grant' && action !== 'revoke') {
    err('usage: tslaws delegate grant|revoke|status\n');
    return 1;
  }
  if (!personOnly({ isTTY: ctx.isTTY, env: ctx.env })) {
    err(`delegate ${action} is a person's decision and needs a terminal; it will not run here\n`);
    return 1;
  }
  const rootFlag = flags.get('root');
  const target = rootFlag === undefined || rootFlag === true ? cwd : resolve(cwd, rootFlag);
  if (action === 'revoke') {
    const removed = revokeFor(target, ctx.home);
    if (typeof removed === 'string') {
      err(`${removed}\n`);
      return 1;
    }
    out(`${removed} delegation${removed === 1 ? '' : 's'} revoked\n`);
    return 0;
  }
  const lengthFlag = flags.get('for');
  const ms = parseDuration(lengthFlag === undefined ? defaultDuration : String(lengthFlag));
  if (ms === undefined) {
    err('--for takes 1h, 8h, 1d or 7d (the most is 7d)\n');
    return 1;
  }
  const granted = grantFor(target, ms, now, ctx.home);
  if (typeof granted === 'string') {
    err(`${granted}\n`);
    return 1;
  }
  out(`accept is lent to agents for ${granted.root} until ${granted.expires}\n`);
  return 0;
}

/** What `promote` and `propose` ask of their surroundings, beyond the context every command has. `ask`, `stdin` and `checkFile` are for unit tests; the CLI never sets them. */
export interface ProposalContext extends CommandContext {
  ask?: (question: string) => Promise<string>;
  stdin?: () => Promise<string>;
  checkFile?: (file: string) => Promise<Map<string, string>>;
}

const readStdin = async (): Promise<string> => {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

/**
 * `tslaws propose <file> [--from PATH]`: writes a proposal into `.tslaws/proposals/` from `--from PATH` or from stdin.
 * Anyone may run it, agents included: it writes only that directory and never touches the lock or the tree.
 */
export async function proposeCommand(
  cwd: string,
  flags: Map<string, string | true>,
  files: string[],
  ctx: ProposalContext,
): Promise<number> {
  const out = ctx.out ?? stdoutWrite;
  const err = ctx.err ?? stderrWrite;
  const [file] = files;
  if (file === undefined || files.length > 1) {
    err('usage: tslaws propose <file.ts> [--from PATH]   (the proposal comes from PATH, or from stdin)\n');
    return 1;
  }
  const from = flags.get('from');
  if (from === true || from === '') {
    err('--from takes a path\n');
    return 1;
  }
  if (from === undefined && ctx.isTTY && ctx.stdin === undefined) {
    err('pipe the proposal in on stdin, or name a file with --from PATH\n');
    return 1;
  }
  try {
    const source = from === undefined ? await (ctx.stdin ?? readStdin)() : readFileSync(resolve(cwd, from), 'utf8');
    const written = addProposal(cwd, file, source);
    out(
      `${written.file}: ${written.laws.length} law${written.laws.length === 1 ? '' : 's'} (${written.laws.join(', ')})\n` +
        `Try it with \`tslaws check --proposed\`. A proposal protects nothing: a person promotes it with \`tslaws promote ${written.file}\`.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ProposalError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
      err(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    throw error;
  }
}

/**
 * `tslaws promote <proposal> [--to PATH]`: a person moves a proposal out of `.tslaws/proposals/` into the tree. Refused
 * without a terminal, under CI, as an agent and with TSLAWS_AGENT set; a delegation does not cover it. Never writes the
 * lock. In-tree `*.proposed.laws.ts` files promote, per law, into the file of the same kind.
 */
export async function promoteCommand(
  cwd: string,
  flags: Map<string, string | true>,
  files: string[],
  ctx: ProposalContext,
): Promise<number> {
  const out = ctx.out ?? stdoutWrite;
  const err = ctx.err ?? stderrWrite;
  if (!personOnly({ isTTY: ctx.isTTY, env: ctx.env })) {
    err('promote moves laws into the tree and needs a person at a terminal; it will not run here\n');
    return 1;
  }
  const older = discoverLaws(cwd, true);
  const known = [...discoverProposals(cwd), ...older];
  const chosen = files.length > 0 ? files : flags.has('all') ? older : [];
  if (chosen.length === 0) {
    err(
      known.length === 0
        ? 'no proposals found (they live in .tslaws/proposals/)\n'
        : `name a proposal to promote:\n${known.map((f) => `  ${f}`).join('\n')}\n`,
    );
    return 1;
  }
  const to = flags.get('to');
  if (to === true || to === '' || (to !== undefined && chosen.length > 1)) {
    err('--to takes one path, for one proposal\n');
    return 1;
  }
  const yes = flags.get('yes') === true;
  const rl = ctx.ask === undefined ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = ctx.ask ?? ((question: string) => rl!.question(question));
  const checkFile =
    ctx.checkFile ??
    (async (file: string): Promise<Map<string, string>> => {
      const report = await check(options(cwd, flags, [file]), false);
      const brief = (r: LawResult): string =>
        r.message === undefined ? r.status : `${r.status}: ${r.message.split('\n')[0]}`;
      return new Map(report.results.map((r) => [r.name, brief(r)]));
    });
  try {
    for (const file of chosen) {
      const rel = relative(cwd, resolve(cwd, file)).replaceAll('\\', '/');
      if (isProposedLawFile(rel) && !file.startsWith('.tslaws')) {
        await promoteFiles({ cwd, ask, out, checkFile, yes }, [rel]);
        continue;
      }
      try {
        await promoteProposal({ cwd, ask, out, checkFile, yes }, file, to);
      } catch (error) {
        if (!(error instanceof ProposalError)) throw error;
        err(`${error.message}\n`);
        return 1;
      }
    }
  } finally {
    rl?.close();
  }
  return 0;
}

/** The projects a run is about, when the repository (or the flags) make it a question. */
interface Selection {
  /** The projects chosen by `--project` and `--filter`, or all of them. */
  chosen: Project[];
  /** Every project of the repository, to find those nested inside another. */
  all: Project[];
  /** Whether this is a run over several projects (headers, summary), as opposed to one project that was named. */
  fanOut: boolean;
  /** What `--changed` decided, one line each (empty without it). */
  notes: string[];
}

const list = (projects: Project[]): string => projects.map((p) => (p.path === '' ? '.' : p.path)).join(', ');

/** `undefined` for an ordinary single-project run: no project flags, and the directory is not a monorepo root. */
function selectProjects(cwd: string, only: string[], filter: string[], changed?: string): Selection | undefined {
  const asked = only.length > 0 || filter.length > 0;
  const monorepo = isMonorepoRoot(cwd);
  if (!asked && !monorepo) {
    if (changed === undefined) return undefined;
    const { files } = changedSince(cwd, changed);
    if (files.length > 0) return undefined;
    return {
      chosen: [],
      all: [],
      fanOut: false,
      notes: [`--changed ${changed}: nothing changed in this project, nothing to run`],
    };
  }
  // A standalone project ("standalone": true) is in `all`, but a run covers it only when --project names it.
  const all = discoverProjects(cwd, { standalone: true });
  let chosen = asked ? discoverProjects(cwd, { only, filter }) : all.filter((p) => !p.standalone);
  if (chosen.length === 0) {
    const named = [...only.map((p) => `--project ${p}`), ...filter.map((g) => `--filter ${g}`)].join(' ');
    throw new Error(
      all.length === 0
        ? 'no tslaws project found here (a project is a directory with a tslaws.json; see "projects" in tslaws.json)'
        : asked
          ? `no project matches ${named}; projects: ${list(all)}`
          : `every project here is standalone ("standalone": true), so a root run covers none of them: pick one with --project <dir> (${list(all)})`,
    );
  }
  const notes: string[] = [];
  if (changed !== undefined) {
    const { base, files } = changedSince(cwd, changed);
    const reasons = new Map(affectedProjects(cwd, files).map((a) => [a.project.path, a.reason]));
    chosen = chosen.filter((p) => reasons.has(p.path));
    notes.push(
      `--changed ${changed} (merge-base ${base.slice(0, 8)}, ${files.length} changed file${files.length === 1 ? '' : 's'}): ${chosen.length} of ${all.length} project${all.length === 1 ? '' : 's'} selected`,
      ...chosen.map((p) => `  ${p.path === '' ? '.' : p.path}: ${reasons.get(p.path)}`),
    );
  }
  return { chosen, all, fanOut: monorepo || chosen.some((p) => p.path !== ''), notes };
}

/** The projects nested below `project`, relative to it. */
function nestedIn(project: Project, all: Project[]): string[] {
  const prefix = project.path === '' ? '' : `${project.path}/`;
  return all
    .filter((other) => other.path !== project.path && other.path.startsWith(prefix))
    .map((other) => other.path.slice(prefix.length));
}

/** Commands that run once for every project of a monorepo; the rest run in one project. */
const fansOut = new Set(['check', 'accept', 'list', 'mutate', 'regressions', 'security']);

type Machine = 'text' | 'json' | 'ndjson';

/** How a root run lays out machine output: one JSON object keyed by project, or ndjson lines tagged with `project`. */
function machineOf(command: string, flags: Map<string, string | true>): Machine {
  if (command === 'check') {
    const reporter = String(flags.get('reporter') ?? (flags.has('json') ? 'json' : 'text'));
    if (reporter === 'junit')
      throw new Error('--reporter junit writes one XML document per project: pick one project with --project <dir>');
    return reporter === 'json' || reporter === 'ndjson' ? reporter : 'text';
  }
  return (command === 'list' || command === 'mutate' || command === 'security') && flags.has('json') ? 'json' : 'text';
}

/** One project at a time, each under a `── path ──` header, then one summary line. Nonzero if any project failed. */
async function runProjects(
  selection: Selection,
  machine: Machine,
  run: (project: Project, io: Run) => Promise<number>,
): Promise<number> {
  const failed: string[] = [];
  const keyed: Record<string, unknown> = {};
  for (const [index, project] of selection.chosen.entries()) {
    const label = project.path === '' ? '.' : project.path;
    let buffer = '';
    const io: Run = {
      out: machine === 'json' ? (text) => void (buffer += text) : stdoutWrite,
      skip: nestedIn(project, selection.all),
      tag: machine === 'ndjson' ? label : undefined,
    };
    if (machine === 'text') stdoutWrite(`${index === 0 ? '' : '\n'}── ${label} ──\n`);
    let status: number;
    let problem: string | undefined;
    try {
      status = await run(project, io);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      stderrWrite(`${label}: ${problem}\n`);
      status = 1;
    }
    if (status !== 0) failed.push(label);
    if (machine === 'json') {
      try {
        keyed[label] = buffer === '' ? { error: problem ?? 'no output (see stderr)' } : (JSON.parse(buffer) as unknown);
      } catch {
        keyed[label] = { error: problem ?? 'output was not JSON' };
      }
    }
  }
  if (machine === 'json') stdoutWrite(`${JSON.stringify(keyed, null, 2)}\n`);
  const count = selection.chosen.length;
  const summary = `${count} project${count === 1 ? '' : 's'}, ${failed.length} failed${failed.length === 0 ? '' : ` (${failed.join(', ')})`}\n`;
  if (machine === 'text') stdoutWrite(`\n${summary}`);
  else stderrWrite(summary);
  return failed.length === 0 ? 0 : 1;
}

export async function main(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const { command, flags, files, projects, filters } = parse(args);
  const cwd = process.cwd();
  if (flags.has('jobs')) {
    const given = Number(flags.get('jobs'));
    if (!Number.isInteger(given) || given < 1) {
      stderrWrite(`--jobs must be an integer of at least 1, got ${JSON.stringify(flags.get('jobs'))}
`);
      return 1;
    }
    configureJobs({ flag: given });
  }
  const changed = flags.has('changed') ? String(flags.get('changed')) : undefined;
  // `init --project .` scaffolds right here, in a root that has projects or not.
  const here = command === 'init' && projects.some((p) => p === '.' || p === './');
  let selection: Selection | undefined;
  try {
    selection = here ? undefined : selectProjects(cwd, projects, filters, changed);
  } catch (error) {
    stderrWrite(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (selection === undefined) return runOne(command, flags, files, cwd, direct);
  // The decision goes to stderr so that machine output on stdout stays whole.
  for (const note of selection.notes) stderrWrite(`${note}\n`);
  if (selection.chosen.length === 0) {
    if (flags.has('json') || flags.get('reporter') === 'json') stdoutWrite('{}\n');
    return 0;
  }

  // From the root with no --project: every project in one process (one comment, one commit for all the locks).
  if (command === 'github' && projects.length === 0 && isMonorepoRoot(cwd))
    return githubRoot(flags, files, cwd, selection);

  // One project and a reporter that writes one document (junit) runs plainly: there is nothing to join.
  const oneDocument =
    command === 'check' && flags.get('reporter') === 'junit' && selection.chosen.length === 1 && !flags.has('watch');
  if (selection.fanOut && fansOut.has(command) && !flags.has('watch') && !oneDocument) {
    // `security deps` names a subcommand, not a file.
    if (files.length > 0 && command !== 'regressions' && command !== 'security') {
      stderrWrite(
        `name files only inside one project: run \`tslaws ${command} ${files[0]}\` there, or pick it with --project <dir>\n`,
      );
      return 1;
    }
    let machine: Machine;
    try {
      machine = machineOf(command, flags);
    } catch (error) {
      stderrWrite(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    return runProjects(selection, machine, (project, io) => runOne(command, flags, files, project.dir, io));
  }

  if (selection.chosen.length > 1) {
    stderrWrite(
      `tslaws ${flags.has('watch') ? 'check --watch' : command} runs in one project and this repository has ${selection.chosen.length}: pick one with --project <dir> (${list(selection.chosen)})${command === 'init' ? ', or --project . to scaffold here' : ''}\n`,
    );
    return 1;
  }
  const [only] = selection.chosen;
  return runOne(command, flags, files, only!.dir, { ...direct, skip: nestedIn(only!, selection.all) });
}

/**
 * `tslaws github <mode>` from a monorepo root: every selected project in one run. Each project keeps its own options
 * and its own `github` settings (read in githubCli.ts); the projects nested in another are left out of that one's laws.
 */
async function githubRoot(
  flags: Map<string, string | true>,
  files: string[],
  cwd: string,
  selection: Selection,
): Promise<number> {
  const { githubCommand, projectPathOf, joinRepo } = await import('./githubCli.ts');
  // The token stays with tslaws, as in a single project (see runOne): laws run in a child that never gets it.
  const env = { ...process.env };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const trusted = flags.get('config-from');
  const prefix = projectPathOf(cwd, flags.get('project-path'));
  const optionsOf = (project: Project): CheckOptions => {
    const skip = nestedIn(project, selection.all);
    const chosen = options(project.dir, flags, outside(discover(project.dir, false), skip));
    // With --config-from the projects are a pull request's files, read as data: never run a compiler from among them.
    if (typeof trusted === 'string' && chosen.compiler === checkoutCompiler(project.dir))
      chosen.compiler = checkoutCompiler(resolve(cwd, trusted, project.path)) ?? 'tsc-laws';
    return chosen;
  };
  return githubCommand(files[0], {
    cwd,
    projectPath: prefix,
    options: optionsOf(selection.chosen[0]!),
    projects: selection.chosen.map((project) => ({
      cwd: project.dir,
      rel: project.path,
      path: joinRepo(prefix, project.path),
      options: optionsOf(project),
    })),
    discovered: selection.all.map((project) => project.path),
    optionsFor: (rel) => {
      // A directory the files here no longer discover still has the laws it had: merge checks it if the base had it.
      const project =
        selection.all.find((candidate) => candidate.path === rel) ??
        (existsSync(join(cwd, rel, 'tslaws.json')) ? { dir: join(cwd, rel), path: rel, standalone: false } : undefined);
      return project === undefined ? undefined : optionsOf(project);
    },
    env,
    flags,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  });
}

/** One command in one project directory. */
async function runOne(
  command: string,
  flags: Map<string, string | true>,
  files: string[],
  cwd: string,
  run: Run,
): Promise<number> {
  if (command === 'init') {
    process.stdout.write(`${init({ cwd, force: flags.has('force') }).join('\n')}\n\n${nextStep}\n`);
    return 0;
  }

  if (command === 'github') {
    const { githubCommand, projectPathOf } = await import('./githubCli.ts');
    // The token stays with tslaws: the laws run in a child process whose environment is an allowlist (see isolate.ts), so
    // a law under test cannot read it from process.env or /proc/self/environ and act as the bot.
    const env = { ...process.env };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    // With --config-from, the project is a pull request's files, read as data: never run a compiler from among them.
    const trusted = flags.get('config-from');
    const chosen = options(cwd, flags, discover(cwd, false));
    if (typeof trusted === 'string' && chosen.compiler === checkoutCompiler(cwd))
      chosen.compiler = checkoutCompiler(resolve(cwd, trusted)) ?? 'tsc-laws';
    return githubCommand(files[0], {
      cwd,
      projectPath: projectPathOf(cwd, flags.get('project-path')),
      options: chosen,
      env,
      flags,
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
    });
  }

  if (command === 'accept')
    return acceptCommand(cwd, flags, files, { isTTY: process.stdin.isTTY === true, env: process.env, skip: run.skip });
  if (command === 'delegate')
    return delegateCommand(cwd, files[0], flags, { isTTY: process.stdin.isTTY === true, env: process.env });

  if (command === 'migrate')
    return migrateCommand(cwd, files[0], files.slice(1), flags, (text) => process.stdout.write(text));

  if (command === 'security') {
    const { securityCommand } = await import('./security/cli.ts');
    return securityCommand(cwd, files, flags, run.out, undefined, run.skip);
  }

  if (command === 'mcp') return serveMcp({ cwd, compiler: options(cwd, flags, []).compiler });

  if (command === 'promote')
    return promoteCommand(cwd, flags, files, { isTTY: process.stdin.isTTY === true, env: process.env });
  if (command === 'list') {
    const listed = listLawFiles(cwd).filter((f) => outside([f.file], run.skip).length > 0);
    run.out(flags.has('json') ? `${JSON.stringify({ files: listed }, null, 2)}\n` : renderList(listed));
    return 0;
  }
  if (command === 'propose')
    return proposeCommand(cwd, flags, files, { isTTY: process.stdin.isTTY === true, env: process.env });

  if (command === 'mutate') {
    // *.laws.ts arguments choose the laws; other files restrict which covered sources are mutated.
    const chosen = lawFiles(
      cwd,
      flags,
      files.filter((f) => f.endsWith('.laws.ts')),
      run.skip,
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
      sandbox: !flags.has('no-sandbox'),
      allowE2e: flags.has('allow-e2e'),
      onProgress: flags.has('json') ? undefined : (line) => process.stderr.write(`${line}\n`),
    });
    run.out(flags.has('json') ? `${JSON.stringify(report, null, 2)}\n` : renderMutation(report));
    return report.ok ? 0 : 1;
  }

  if (command === 'regressions') {
    const action = files[0] ?? 'list';
    if (action === 'clear') {
      run.out(clearCorpus(cwd) ? 'cleared .tslaws/regressions\n' : 'no regression corpus to clear\n');
      return 0;
    }
    if (action !== 'list') {
      process.stderr.write(`unknown action '${action}' (expected list or clear)\n`);
      return 1;
    }
    const corpus = listCorpus(cwd);
    run.out(
      corpus.length === 0
        ? 'no stored counterexamples\n'
        : `${corpus.map((e) => `${e.file} ${e.law}: ${e.count} example${e.count === 1 ? '' : 's'}`).join('\n')}\n`,
    );
    return 0;
  }

  if (command === 'ui') {
    const chosen = lawFiles(cwd, flags, files, run.skip);
    if (chosen.length === 0) {
      process.stderr.write('no laws files found (looking for *.laws.ts)\n');
      return 1;
    }
    return serveUi({
      cwd,
      port: Number(flags.get('port') ?? 51205),
      open: !flags.has('no-open'),
      appWindow: !flags.has('tab'),
      // A watcher sees a browser page only if it stays as the law left it for a moment.
      run: (only, onEvent, laws) =>
        check(
          {
            ...options(cwd, flags, only ?? chosen),
            partial: only !== undefined || files.length > 0,
            only: laws,
            onEvent,
            browserPauseMs: 120,
          },
          !flags.has('proposed'),
        ),
      log: (line) => process.stdout.write(`${line}\n`),
    });
  }

  return flags.has('watch') ? watchChecks(cwd, flags, files) : runCheck(cwd, flags, files, run);
}
