// `tslaws github <report|command|merge|verify>`: the GitHub side of accepting laws. See github.ts for the policy.
//
//   report   pull_request: runs every law (proposals included), flags each proposal on its line, keeps one sticky
//            comment up to date, and fails when an accepted law fails, a proposal fails, or (comment mode) a proposal
//            waits for an accept. Advisory: it runs the pull request's code, so it decides nothing about the lock.
//   command  issue_comment: reads `/tslaws accept|reject ...`, checks the commenter may accept, and records the
//            fingerprints accepted in a comment of the bot's. Reads the pull request's files as data; runs none of it.
//   merge    push to the configured branch, or workflow_dispatch by someone with admin or maintain access: runs the
//            laws on the branch's code, accepts what passes (and, in comment mode, what was accepted for that exact
//            version) and commits tsc-laws.lock through the API as the bot. The only place the workflow writes the
//            lock. While a project's "local" is true (the default) a person may also change its lock by hand, through
//            `tslaws accept` or a merged pull request that a maintainer wrote and merged; merge accepts such a change
//            as it stands and builds on it, and on demand it first checks where the branch's lock came from.
//   verify   pull_request_target: fails when the pull request changes a lock (unless the project's "local" is true
//            and the pull request's author, and the author of each commit that changes the lock, has admin or maintain
//            access), the "github" section of tslaws.json or a protected path. Reads the base branch's config, never
//            the pull request's.
//
// From a monorepo root every mode covers all the projects in one process (`ctx.projects`): one sticky comment with a
// section per project, one commit for all the locks, approvals that count only for their own project, and a project
// list that verify and merge read from the base commit through the API, never from files the pull request controls.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { exemptionsOf } from './check.ts';
import { checkIsolated, readReport, type Expected } from './isolate.ts';
import type { CheckReport } from './check.ts';
import { extendsTarget, readConfig } from './coverage.ts';
import { discoverFromFiles, discoverySignature, type DiscoveryInputs } from './projects.ts';
import { readManifest } from './compile.ts';
import {
  acceptedFingerprints,
  inert,
  recordComment,
  decide,
  parseCommands,
  isSharedBot,
  parseGithubConfig,
  proposalsOf,
  pullRequestVerdict,
  readApprovals,
  renderSticky,
  renderStickyAll,
  resolveNames,
  stickyMarkerFor,
  type ApprovalRecord,
  type GithubConfig,
  type IssueComment,
  type Proposal,
} from './github.ts';
import { classifyLawFile, lockLevels } from './lawKinds.ts';
import { acceptChanges, lawKey, lockChanges, readLock, writeLockValue, type Lock } from './lock.ts';
import { escapeGithubData, escapeGithubProperty } from './reporters.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

export interface GithubContext {
  cwd: string;
  /**
   * Where the project sits in the repository, repo-relative with '/' separators and no trailing slash ('' at the root).
   * Every REST path and annotation names files from the repository root, so they carry it.
   */
  projectPath?: string;
  /** The check options for the whole project (every laws file, the lock at the root). */
  options: CheckOptions;
  env: NodeJS.ProcessEnv;
  flags: Map<string, string | true>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** For tests: a stand-in for the GitHub REST API. */
  api?: Api;
  /**
   * Set when the run covers a monorepo root: every selected project, each with its own directory and options. `cwd`
   * and `projectPath` then name the root, and `options` is unused.
   */
  projects?: Unit[];
  /** Every project under the root, standalone ones included (project-relative paths, '' for the root itself). */
  discovered?: string[];
  /** The check options of a discovered project, or undefined when it is not one. */
  optionsFor?: (rel: string) => CheckOptions | undefined;
}

/** One project of a run. */
export interface Unit {
  cwd: string;
  /** Relative to the monorepo root ('' for the root itself). */
  rel: string;
  /** From the repository root, with '/' separators ('' for the repository root). */
  path: string;
  options: CheckOptions;
}

/** A project-relative file as the repository names it: the project's prefix, then the path. */
function repoPath(ctx: GithubContext, file: string): string {
  const prefix = (ctx.projectPath ?? '').replace(/^\/+|\/+$/g, '');
  return joinRepo(prefix, file);
}

/** Two repo-relative paths joined; either may be ''. */
export function joinRepo(prefix: string, file: string): string {
  const clean = file.replaceAll('\\', '/').replace(/^\/+/, '');
  if (prefix === '') return clean;
  return clean === '' ? prefix : `${prefix}/${clean}`;
}

/** `--project-path`, else where `cwd` sits inside its git repository (`git rev-parse --show-prefix`), else ''. */
export function projectPathOf(cwd: string, flag: string | true | undefined): string {
  let raw = typeof flag === 'string' ? flag : '';
  if (typeof flag !== 'string') {
    try {
      raw = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-prefix'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      raw = '';
    }
  }
  return raw
    .trim()
    .replaceAll('\\', '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+|\/+$/g, '');
}

// ---- REST -----------------------------------------------------------------------------------------------------------

export type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

function restApi(env: NodeJS.ProcessEnv): Api {
  const base = env.GITHUB_API_URL ?? 'https://api.github.com';
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token === undefined || token === '') throw new Error('GITHUB_TOKEN is not set');
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tslaws',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  };
}

async function all<T>(api: Api, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = (await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)) as T[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

interface Person {
  login: string;
  type?: string;
}

interface PullRequest {
  number: number;
  user: { login: string; type: string };
  head: { sha: string };
  base: { ref: string; sha: string };
  /** How many files the pull request changes, as GitHub counts them (the files list is capped at 3000). */
  changed_files?: number;
  requested_reviewers?: { login: string }[];
  merged?: boolean;
  merged_at?: string | null;
}

// ---- shared ---------------------------------------------------------------------------------------------------------

function repo(env: NodeJS.ProcessEnv): string {
  const name = env.GITHUB_REPOSITORY;
  if (name === undefined || !/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error('GITHUB_REPOSITORY is not set');
  return name;
}

function event(env: NodeJS.ProcessEnv): Record<string, any> {
  const path = env.GITHUB_EVENT_PATH;
  return path !== undefined && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>) : {};
}

/** The `github` section of a tslaws.json text, with defaults. It must exist: it names the bot every check trusts. */
export function githubConfigOf(text: string | undefined): GithubConfig {
  const raw = text === undefined ? undefined : (JSON.parse(text) as { github?: unknown }).github;
  if (raw === undefined) throw new Error('tslaws github needs a "github" section in tslaws.json');
  return parseGithubConfig(raw);
}

interface ProjectState {
  laws: ManifestLaw[];
  exempt: string[];
  levels: Record<string, string> | undefined;
  lock: Lock | undefined;
}

/** What the lock would record if everything were accepted now. Compiles the project; runs none of it. */
/** The id git gives a file's content: what the contents API reports as a file's `sha`. */
function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function projectState(options: CheckOptions): ProjectState {
  const lock = readLock(options.lockFile);
  const laws = readManifest(options.compiler, options.files, options.cwd);
  const exempt = exemptionsOf(options);
  const mode = readConfig(options.cwd).levels ?? 'names';
  const levels =
    mode === 'imports'
      ? lockLevels(options.cwd, laws, 'imports')
      : lock?.levels !== undefined
        ? Object.fromEntries(
            [...new Set(laws.map((l) => l.file.replaceAll('\\', '/')))].map((f) => [
              f,
              classifyLawFile(options.cwd, f, 'names').kind,
            ]),
          )
        : undefined;
  return { laws, exempt, levels, lock };
}

async function issueComments(api: Api, name: string, pr: number): Promise<IssueComment[]> {
  return all<IssueComment>(api, `/repos/${name}/issues/${pr}/comments`);
}

async function upsertSticky(
  api: Api,
  name: string,
  pr: number,
  bots: string[],
  body: string,
  comments: IssueComment[],
  marker: string,
) {
  const mine = comments.find((c) => bots.includes(c.user.login) && c.body.startsWith(marker));
  if (mine === undefined) await api('POST', `/repos/${name}/issues/${pr}/comments`, { body });
  else if (mine.body !== body) await api('PATCH', `/repos/${name}/issues/comments/${mine.id}`, { body });
}

function linkFor(env: NodeJS.ProcessEnv, sha: string, project: string): (p: Proposal) => string {
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const name = env.GITHUB_REPOSITORY ?? '';
  // Raw text: renderSticky makes the whole cell inert. Brackets and backticks would break the link's markdown.
  return (p) => {
    const label = p.name.replace(/[`[\]]/g, "'");
    if (p.line === 0 || name === '') return `${label} (${p.file})`;
    return `[${label}](${server}/${name}/blob/${sha}/${joinRepo(project, p.file).split('/').map(encodeURIComponent).join('/')}#L${p.line})`;
  };
}

/** A law name or path from the pull request, for a bot comment: inert, and quoted without a code span. */
function shown(text: string): string {
  return `“${inert(text)}”`;
}

function summary(env: NodeJS.ProcessEnv, text: string): void {
  if (env.GITHUB_STEP_SUMMARY !== undefined) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function setOutput(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (env.GITHUB_OUTPUT !== undefined) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

// ---- units ----------------------------------------------------------------------------------------------------------

/** The projects a run covers: one (the directory it runs in), or every selected project of a monorepo root. */
function unitsOf(ctx: GithubContext): Unit[] {
  return ctx.projects ?? [{ cwd: ctx.cwd, rel: '', path: repoPath(ctx, ''), options: ctx.options }];
}

const label = (unit: Unit): string => (unit.path === '' ? '.' : unit.path);

/** The `github` settings in the tslaws.json of `dir`, `extends` followed (the project's own keys win); undefined if none. */
function configIn(dir: string): GithubConfig | undefined {
  const raw = readConfig(dir).github;
  return raw === undefined ? undefined : parseGithubConfig(raw);
}

interface Active {
  unit: Unit;
  config: GithubConfig;
}

/**
 * The projects the shared flow covers, each with its own settings. A project with no `github` section is left out of a
 * root run (and is an error in a single-project run, as it always was); so is one whose flow is `own`.
 */
function plan(ctx: GithubContext, units: Unit[], dirOf: (unit: Unit) => string): { active: Active[]; all: Active[] } {
  const monorepo = ctx.projects !== undefined;
  const active: Active[] = [];
  const all: Active[] = [];
  for (const unit of units) {
    const config = configIn(dirOf(unit));
    if (config === undefined) {
      if (!monorepo) throw new Error('tslaws github needs a "github" section in tslaws.json');
      ctx.out(
        `::notice title=tslaws::${escapeGithubData(label(unit))} has no "github" section; the shared flow leaves it out\n`,
      );
      continue;
    }
    all.push({ unit, config });
    if (monorepo && config.flow === 'own') {
      ctx.out(
        `::notice title=tslaws::${escapeGithubData(label(unit))} has "flow": "own"; its own workflow covers it\n`,
      );
      continue;
    }
    active.push({ unit, config });
  }
  if (monorepo && all.length === 0) throw new Error('no project here has a "github" section in tslaws.json');
  if (monorepo && active.length === 0)
    ctx.out('tslaws: every project with a "github" section runs its own flow; nothing to do here\n');
  return { active, all };
}

// ---- running the laws ----------------------------------------------------------------------------------------------

/**
 * What the laws job hands to the job that holds the token: each project's report, as data, and the lock it was run
 * against. Laws never run in the process that has the token (see isolate.ts); with `--results-out` they do not run in
 * the same job either.
 */
interface Results {
  version: 1;
  mode: 'report' | 'merge';
  sha: string;
  projects: Record<string, { lockSha: string; report?: unknown; error?: string }>;
}

/** The laws a project has, as this process sees them: a compile that runs none of the project. A report is held to it. */
function expectedOf(unit: Unit): Expected {
  const state = projectState(unit.options);
  return {
    laws: new Set(state.laws.map((law) => lawKey(law.file, law.name))),
    lock: new Set(Object.keys(state.lock?.laws ?? {})),
    exempt: new Set(state.exempt),
  };
}

const lockShaOf = (unit: Unit): string =>
  existsSync(unit.options.lockFile) ? gitBlobSha(readFileSync(unit.options.lockFile)) : '';

const resultsRead = new WeakMap<Map<string, string | true>, Results>();

function resultsOf(ctx: GithubContext, file: string, mode: Results['mode'], sha: string): Results {
  const known = resultsRead.get(ctx.flags);
  if (known !== undefined) return known;
  let value: Partial<Results>;
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as Partial<Results>;
  } catch (error) {
    throw new Error(`cannot read the results in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== 'object' || value === null || value.version !== 1 || typeof value.projects !== 'object')
    throw new Error(`${file} is not a tslaws results file`);
  if (value.mode !== mode) throw new Error(`${file} holds results for ${String(value.mode)}, not ${mode}`);
  if (value.sha !== sha)
    throw new Error(
      `${file} was made for commit ${String(value.sha).slice(0, 7)}, but this run is for ${sha.slice(0, 7)}`,
    );
  resultsRead.set(ctx.flags, value as Results);
  return value as Results;
}

/**
 * The report of one project's laws: from the results file when `--results` names one, else from a run in a child with no
 * credentials. Either way it is validated as data before anything acts on it.
 */
async function runLaws(ctx: GithubContext, unit: Unit, mode: Results['mode'], sha: string): Promise<CheckReport> {
  const file = ctx.flags.get('results');
  if (typeof file !== 'string') return checkIsolated(unit.options, true, expectedOf(unit));
  const entry = Object.hasOwn(resultsOf(ctx, file, mode, sha).projects, unit.path)
    ? resultsOf(ctx, file, mode, sha).projects[unit.path]
    : undefined;
  if (entry === undefined) throw new Error(`${file} has no results for ${label(unit)}`);
  if (typeof entry.error === 'string') throw new Error(entry.error);
  if (entry.lockSha !== lockShaOf(unit))
    throw new Error(`${label(unit)}'s lock is not the one its laws were run against`);
  return readReport(entry.report, expectedOf(unit));
}

/** `--results-out <file>`: run the laws of every project and write the reports, doing nothing else. Needs no token. */
async function collect(ctx: GithubContext, mode: Results['mode'], file: string): Promise<number> {
  const { active } = plan(ctx, unitsOf(ctx), (u) => u.cwd);
  const ev = event(ctx.env);
  const sha = String(
    mode === 'report' ? (ev.pull_request?.head?.sha ?? ctx.env.GITHUB_SHA) : (ev.after ?? ctx.env.GITHUB_SHA),
  );
  const projects: Results['projects'] = {};
  for (const { unit } of active) {
    const entry: Results['projects'][string] = { lockSha: lockShaOf(unit) };
    try {
      entry.report = await checkIsolated(unit.options, true, expectedOf(unit));
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    projects[unit.path] = entry;
  }
  writeFileSync(file, JSON.stringify({ version: 1, mode, sha, projects } satisfies Results));
  ctx.out(
    `tslaws: ran the laws of ${active.length} project${active.length === 1 ? '' : 's'}; results are in ${file}\n`,
  );
  return 0;
}

// ---- report ---------------------------------------------------------------------------------------------------------

interface UnitReport {
  active: Active;
  proposals: Proposal[];
  approvals: Map<string, string>;
  verdict: { ok: boolean; problems: string[] };
}

async function report(ctx: GithubContext): Promise<number> {
  const monorepo = ctx.projects !== undefined;
  const { active } = plan(ctx, unitsOf(ctx), (u) => u.cwd);
  if (active.length === 0) return 0;
  const ev = event(ctx.env);
  const pr = Number(ctx.flags.get('pr') ?? ev.pull_request?.number ?? NaN);
  const sha = String(ev.pull_request?.head?.sha ?? ctx.env.GITHUB_SHA ?? '');
  const ran: { active: Active; checked: CheckReport | undefined; proposals: Proposal[]; failed?: string }[] = [];
  for (const a of active) {
    try {
      const checked: CheckReport = await runLaws(ctx, a.unit, 'report', sha);
      const state = projectState(a.unit.options);
      ran.push({
        active: a,
        checked,
        proposals: proposalsOf(lockChanges(state.lock, state.laws, state.exempt, state.levels), checked, a.unit.path),
      });
    } catch (error) {
      if (!monorepo) throw error;
      // One project that cannot run must not hide the others' reports.
      ran.push({
        active: a,
        checked: undefined,
        proposals: [],
        failed: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let api: Api | undefined;
  let comments: IssueComment[] = [];
  try {
    api = ctx.api ?? restApi(ctx.env);
    if (Number.isInteger(pr)) comments = await issueComments(api, repo(ctx.env), pr);
  } catch (error) {
    ctx.err(`tslaws: cannot read the pull request's comments (${String(error)}); reporting without approvals\n`);
    api = undefined;
  }
  const reports: UnitReport[] = ran.map(({ active: a, checked, proposals, failed }) => {
    // Only the records of this project count, and only those its own bot wrote.
    const approvals = acceptedFingerprints(readApprovals(comments, a.config.bot), a.unit.path);
    const verdict =
      checked === undefined
        ? { ok: false, problems: [`the project could not be checked: ${failed ?? 'unknown error'}`] }
        : pullRequestVerdict(checked, proposals, a.config, approvals);
    return { active: a, proposals, approvals, verdict };
  });

  for (const { active: a, proposals } of reports)
    for (const p of proposals) {
      const level = p.passes ? 'notice' : 'error';
      const title = `tslaws proposal: ${p.name}`;
      const message =
        p.outcome === undefined
          ? 'did not run'
          : `${p.reason}; if accepted: ${p.outcome.status}${p.outcome.counterexample ? `; counterexample ${p.outcome.counterexample}` : ''}`;
      ctx.out(
        `::${level} file=${escapeGithubProperty(joinRepo(a.unit.path, p.file))},line=${Math.max(1, p.line)},title=${escapeGithubProperty(title)}::${escapeGithubData(message)}\n`,
      );
    }
  const rootPath = repoPath(ctx, '');
  const marker = stickyMarkerFor(rootPath);
  const body = monorepo
    ? renderStickyAll(
        reports.map((r) => ({
          project: r.active.unit.path,
          proposals: r.proposals,
          config: r.active.config,
          approvals: r.approvals,
          link: linkFor(ctx.env, sha, r.active.unit.path),
        })),
        marker,
      )
    : (() => {
        const [only] = reports;
        return renderSticky(
          only!.proposals,
          only!.active.config,
          only!.approvals,
          linkFor(ctx.env, sha, rootPath),
          rootPath,
        );
      })();
  summary(ctx.env, body.replace(marker, ''));
  const bots = [...new Set(active.map((a) => a.config.bot))];
  if (api !== undefined && Number.isInteger(pr) && ctx.flags.has('comment')) {
    try {
      await upsertSticky(api, repo(ctx.env), pr, bots, body, comments, marker);
      // A root run's one comment replaces the per-project comments an earlier, per-project workflow left.
      if (monorepo)
        for (const { unit } of active) {
          if (unit.path === rootPath) continue;
          const old = stickyMarkerFor(unit.path);
          for (const c of comments)
            if (bots.includes(c.user.login) && c.body.startsWith(old))
              await api('DELETE', `/repos/${repo(ctx.env)}/issues/comments/${c.id}`).catch(() => undefined);
        }
    } catch (error) {
      // A pull request from a fork gets a read-only token: the step summary and annotations still carry the report.
      ctx.err(`tslaws: cannot write the sticky comment (${String(error)})\n`);
    }
  }
  const proposals = reports.flatMap((r) => r.proposals);
  const ok = reports.every((r) => r.verdict.ok);
  const outFile = ctx.flags.get('out');
  if (typeof outFile === 'string') {
    const verdict = {
      ok,
      problems: reports.flatMap((r) =>
        r.verdict.problems.map((p) => (monorepo ? `[${label(r.active.unit)}] ${p}` : p)),
      ),
    };
    const projects = monorepo
      ? {
          projects: reports.map((r) => ({ project: r.active.unit.path, proposals: r.proposals, verdict: r.verdict })),
        }
      : {};
    writeFileSync(outFile, `${JSON.stringify({ sha, proposals, verdict, ...projects }, null, 2)}\n`);
  }
  setOutput(ctx.env, 'proposals', String(proposals.length));
  for (const r of reports)
    for (const problem of r.verdict.problems) ctx.out(`${monorepo ? `[${label(r.active.unit)}] ` : ''}${problem}\n`);
  ctx.out(
    ok
      ? `tslaws: ${proposals.length} proposal(s)${monorepo ? ` in ${reports.length} project(s)` : ''}, all passing\n`
      : 'tslaws: the pull request is not ready\n',
  );
  return ok ? 0 : 1;
}

// ---- command --------------------------------------------------------------------------------------------------------

const rank: Record<string, number> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

/** The repository permission `login` holds, as a rank (0 for a non-collaborator). Throws when GitHub cannot say. */
async function permissionRank(api: Api, name: string, login: string): Promise<number> {
  const permission = (await api('GET', `/repos/${name}/collaborators/${encodeURIComponent(login)}/permission`)) as {
    permission?: string;
    role_name?: string;
  };
  return Math.max(rank[permission?.permission ?? ''] ?? 0, rank[permission?.role_name ?? ''] ?? 0);
}

/**
 * Whether `login` has `admin` or `maintain` access: the people who may change tsc-laws.lock by hand or run the merge
 * job on demand. A bot never counts, and neither does a login whose permission cannot be read.
 */
export async function maintains(api: Api, name: string, login: string, type = 'User'): Promise<boolean> {
  if (type === 'Bot' || login.endsWith('[bot]')) return false;
  try {
    return (await permissionRank(api, name, login)) >= rank.maintain!;
  } catch {
    return false;
  }
}

/** Why `login` may not accept on this pull request, or undefined when they may. */
export async function refusal(
  api: Api,
  name: string,
  pr: PullRequest,
  login: string,
  type: string,
  config: GithubConfig,
): Promise<string | undefined> {
  if (type === 'Bot' || login.endsWith('[bot]')) return 'bots cannot accept laws';
  const level = await permissionRank(api, name, login);
  if (level < rank.write!) return `@${login} needs write access to the repository`;
  for (const kind of config.approvers) {
    if (kind === 'author' && pr.user.login === login && pr.user.type !== 'Bot') return undefined;
    if (kind === 'reviewers') {
      if ((pr.requested_reviewers ?? []).some((r) => r.login === login)) return undefined;
      const reviews = await all<{ user: { login: string } | null }>(api, `/repos/${name}/pulls/${pr.number}/reviews`);
      if (reviews.some((r) => r.user?.login === login && login !== pr.user.login)) return undefined;
    }
    if ((kind === 'write' || kind === 'maintain' || kind === 'admin') && level >= rank[kind]!) return undefined;
  }
  return `@${login} is not one of the approvers this project names (${config.approvers.join(', ')})`;
}

/**
 * Whether the bot may approve the pull request: every project with proposals, whatever its flow, has all of them
 * accepted here and has opted in with `approvePullRequest`. A project that was declined, skipped, runs its own flow, or
 * cannot be read counts against it, so one project's acceptance never approves another's pending proposals.
 */
async function everyProposalAccepted(
  all: Active[],
  eligible: Active[],
  byProject: Map<string, Proposal[]>,
  comments: Awaited<ReturnType<typeof issueComments>>,
): Promise<boolean> {
  let any = false;
  for (const a of all) {
    const counted = eligible.some((e) => e.unit.path === a.unit.path);
    let proposals: Proposal[];
    try {
      proposals =
        byProject.get(a.unit.path) ??
        (() => {
          const state = projectState(a.unit.options);
          return proposalsOf(lockChanges(state.lock, state.laws, state.exempt, state.levels), undefined, a.unit.path);
        })();
    } catch {
      return false;
    }
    if (proposals.length === 0) continue;
    any = true;
    if (!counted || !a.config.approvePullRequest) return false;
    const approvals = acceptedFingerprints(readApprovals(comments, a.config.bot), a.unit.path);
    if (!proposals.every((p) => approvals.has(p.fingerprint))) return false;
  }
  return any;
}

/**
 * Whether the projects this run decided over are the projects the base commit has. The list in the pull request's own
 * checkout can be steered by the pull request, so before approving, the base's list is read through the API and the
 * pull request must not change how projects are found, nor any project's `github` (so `flow`), `standalone` or lock.
 * It also must not add or remove a project. Anything unreadable counts as a change: no approval.
 */
async function discoveryHolds(
  ctx: GithubContext,
  api: Api,
  name: string,
  pr: PullRequest,
  discovered: string[],
): Promise<boolean> {
  const problems: string[] = [];
  try {
    const read = readerOf(api, name);
    const changed = await changedFiles(api, name, pr);
    const { baseSide, headSide } = await inspectMonorepo(api, name, read, pr, changed, repoPath(ctx, ''), problems);
    const head = new Set(headSide.paths);
    const decided = new Set(discovered);
    for (const rel of baseSide.paths) {
      if (!head.has(rel)) problems.push(`${rel || '.'} is a project on the base and not on the pull request`);
      if (!decided.has(rel)) problems.push(`${rel || '.'} is a project on the base that this run did not read`);
    }
    const base = new Set(baseSide.paths);
    for (const rel of headSide.paths) if (!base.has(rel)) problems.push(`${rel || '.'} is a new project`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0)
    ctx.out(
      `::notice title=tslaws::${escapeGithubData(`not approving the pull request: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`)}\n`,
    );
  return problems.length === 0;
}

async function command(ctx: GithubContext): Promise<number> {
  const monorepo = ctx.projects !== undefined;
  // The base branch's config: the workflow checks the default branch out at the root and the pull request beside it.
  const trusted = String(ctx.flags.get('config-from') ?? ctx.cwd);
  const { active, all } = plan(ctx, unitsOf(ctx), (u) => join(trusted, u.rel));
  if (active.length === 0) return 0;
  const ev = event(ctx.env);
  if (ev.action !== 'created' || ev.issue?.pull_request === undefined) return 0;
  const body = String(ev.comment?.body ?? '');
  const commands = parseCommands(body);
  if (commands.length === 0) return 0;
  const api = ctx.api ?? restApi(ctx.env);
  const name = repo(ctx.env);
  const number = Number(ev.issue.number);
  const reply = (text: string) => api('POST', `/repos/${name}/issues/${number}/comments`, { body: text });
  const login = String(ev.comment.user.login);
  // A command that cannot be followed records nothing, even beside commands that can: a `--project` with no directory
  // would otherwise read as "every project".
  const unusable = commands.find((c) => c.error !== undefined);
  if (unusable !== undefined) {
    await reply(`@${login} Not recorded: ${unusable.error}.`);
    return 0;
  }
  const pr = (await api('GET', `/repos/${name}/pulls/${number}`)) as PullRequest;
  // Each project decides for itself: its own mode and its own approvers. The commenter accepts only where they may.
  const eligible: Active[] = [];
  const declined: string[] = [];
  for (const a of active) {
    if (a.config.accept !== 'comment') {
      const text = `this project accepts passing proposals on merge into \`${a.config.branch}\`; there is nothing to accept by comment`;
      if (!monorepo) {
        await reply(`@${login} ${text}.`);
        return 0;
      }
      declined.push(`- ${shown(label(a.unit))}: ${text}`);
      continue;
    }
    const refused = await refusal(api, name, pr, login, String(ev.comment.user.type ?? 'User'), a.config);
    if (refused !== undefined) {
      if (!monorepo) {
        await reply(`Not recorded: ${refused}.`);
        return 0;
      }
      declined.push(`- ${shown(label(a.unit))}: not recorded, ${refused}`);
      continue;
    }
    eligible.push(a);
  }
  if (eligible.length === 0) {
    if (declined.length > 0) await reply(`@${login}\n${declined.join('\n')}`);
    return 0;
  }
  const checkedOut = String(ctx.flags.get('head-sha') ?? '');
  if (checkedOut !== pr.head.sha) {
    await reply(`Not recorded: the pull request moved to ${pr.head.sha.slice(0, 7)} while this ran; say it again.`);
    return 0;
  }
  const pinned = /@([0-9a-f]{7,40})\b/i.exec(body)?.[1];
  if (pinned !== undefined && !pr.head.sha.startsWith(pinned.toLowerCase())) {
    await reply(`Not recorded: you named ${pinned}, but the pull request is at ${pr.head.sha.slice(0, 7)}.`);
    return 0;
  }
  const byProject = new Map<string, Proposal[]>();
  for (const a of eligible) {
    const state = projectState(a.unit.options);
    byProject.set(
      a.unit.path,
      proposalsOf(lockChanges(state.lock, state.laws, state.exempt, state.levels), undefined, a.unit.path),
    );
  }
  const proposals = [...byProject.values()].flat();
  const lines: string[] = [...declined];
  const records: ApprovalRecord[] = [];
  const where = (p: Proposal) => (monorepo ? `${shown(p.project ?? '')}, ` : '');
  for (const cmd of commands) {
    const { matched, unknown, ambiguous } = resolveNames(proposals, cmd);
    if (unknown.length > 0) lines.push(`- no proposal named ${unknown.map(shown).join(', ')}`);
    if (ambiguous.length > 0)
      lines.push(
        monorepo
          ? `- ${ambiguous.map(shown).join(', ')} names laws in several files or projects; use the path from the repository root with \`::name\`, or add \`--project <dir>\``
          : `- ${ambiguous.map(shown).join(', ')} names laws in several files; use \`file::name\``,
      );
    if (matched.length === 0) continue;
    // One record per project, each carrying its project: it counts for that project's lock and nowhere else.
    for (const path of new Set(matched.map((p) => p.project ?? ''))) {
      records.push({
        verb: cmd.verb,
        by: login,
        sha: pr.head.sha,
        project: path,
        items: matched
          .filter((p) => (p.project ?? '') === path)
          .map((p) => ({ key: p.key, fingerprint: p.fingerprint })),
      });
    }
    lines.push(
      `- ${cmd.verb === 'accept' ? 'accepted' : 'withdrew'} ${matched.map((p) => `${shown(p.name)} (${where(p)}${shown(p.file)}, ${p.reason})`).join(', ')}`,
    );
  }
  const text = `@${login} at ${pr.head.sha.slice(0, 7)}:\n${lines.join('\n') || '- nothing matched'}\n\n${records.length > 0 ? 'Recorded. The laws are written to `tsc-laws.lock` on merge, if they still pass and have not changed since.' : ''}`;
  await reply(text);
  // The records go in a comment of their own that holds nothing else, the only shape readApprovals counts.
  if (records.length > 0) await reply(recordComment(records));
  try {
    await api('POST', `/repos/${name}/issues/comments/${ev.comment.id}/reactions`, {
      content: records.length > 0 ? '+1' : 'confused',
    });
  } catch {
    // a reaction is a courtesy
  }
  if (records.length > 0 && eligible.some((a) => a.config.approvePullRequest)) {
    const comments = await issueComments(api, name, number);
    if (
      (await everyProposalAccepted(all, eligible, byProject, comments)) &&
      (!monorepo || (await discoveryHolds(ctx, api, name, pr, ctx.discovered ?? all.map((a) => a.unit.rel))))
    )
      await api('POST', `/repos/${name}/pulls/${number}/reviews`, {
        commit_id: pr.head.sha,
        event: 'APPROVE',
        body: 'tslaws: every proposal in this pull request has been accepted.',
      });
  }
  // Re-run the pull request's report so its check sees the new approvals.
  const workflow = ctx.flags.get('rerun-workflow');
  if (typeof workflow === 'string' && records.length > 0) {
    const runs = (await api(
      'GET',
      `/repos/${name}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=5`,
    )) as { workflow_runs: { id: number }[] };
    const latest = runs.workflow_runs[0];
    if (latest !== undefined) await api('POST', `/repos/${name}/actions/runs/${latest.id}/rerun`);
  }
  return 0;
}

// ---- discovery through the API ----------------------------------------------------------------------------------------

type Reader = (path: string, ref: string) => Promise<string | undefined>;

/**
 * The contents API URL of a repository path. Every segment and the ref are encoded, so a `?`, `#`, `&` or `%` in a name
 * a pull request controls cannot add to or override the query string (for example the `ref`).
 */
function contentsUrl(name: string, path: string, ref?: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `/repos/${name}/contents/${encoded}${ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`}`;
}

function readerOf(api: Api, name: string): Reader {
  return async (path, ref) => {
    let file: { type?: string; content?: string } | { type?: string; content?: string }[];
    try {
      file = (await api('GET', contentsUrl(name, path, ref))) as typeof file;
    } catch {
      return undefined;
    }
    // A symlink, a submodule or a directory is not a blob: refuse it rather than read it as missing.
    if (Array.isArray(file) || (file.type !== undefined && file.type !== 'file') || typeof file.content !== 'string')
      throw new Error(`${path} is not a regular file at ${ref.slice(0, 7)} (a symlink, a submodule or a directory)`);
    return Buffer.from(file.content, 'base64').toString('utf8');
  };
}

/** `tsc-laws.lock` by name, wherever it is. */
const isLock = (path: string): boolean => path === 'tsc-laws.lock' || path.endsWith('/tsc-laws.lock');

/**
 * The projects a commit has, from the repository's tree and the three files that decide it, read through the API:
 * paths relative to the monorepo root (`prefix` is where that root sits in the repository). Never from a checkout, so
 * a pull request cannot change what is read by changing its own files.
 */
async function projectsAt(
  api: Api,
  name: string,
  read: Reader,
  sha: string,
  prefix: string,
): Promise<{ paths: string[]; inputs: DiscoveryInputs; truncated: boolean; locks: Map<string, string> }> {
  const tree = await treeAt(api, name, sha);
  const lead = prefix === '' ? '' : `${prefix}/`;
  const files = (tree.tree ?? [])
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith(lead))
    .map((entry) => entry.path.slice(lead.length));
  const inputs: DiscoveryInputs = {};
  const [tslaws, packageJson, pnpmWorkspace] = await Promise.all(
    ['tslaws.json', 'package.json', 'pnpm-workspace.yaml'].map((file) => read(joinRepo(prefix, file), sha)),
  );
  if (tslaws !== undefined) inputs.tslaws = tslaws;
  if (packageJson !== undefined) inputs.packageJson = packageJson;
  if (pnpmWorkspace !== undefined) inputs.pnpmWorkspace = pnpmWorkspace;
  return { paths: discoverFromFiles(files, inputs), inputs, truncated: tree.truncated === true, locks: tree.locks };
}

/** Every blob of a commit's tree, and the blob id of each `tsc-laws.lock`: a changed id is a changed lock. */
async function treeAt(
  api: Api,
  name: string,
  sha: string,
): Promise<{ tree: { path: string; type: string }[]; truncated: boolean; locks: Map<string, string> }> {
  const got = (await api('GET', `/repos/${name}/git/trees/${encodeURIComponent(sha)}?recursive=1`)) as {
    tree?: { path: string; type: string; sha?: string }[];
    truncated?: boolean;
  };
  const tree = got.tree ?? [];
  const locks = new Map<string, string>();
  for (const entry of tree) if (entry.type === 'blob' && isLock(entry.path)) locks.set(entry.path, entry.sha ?? '');
  return { tree, truncated: got.truncated === true, locks };
}

/** The locks that differ between two commits: added, removed or changed, by repository path. */
function lockDifferences(base: Map<string, string>, head: Map<string, string>): string[] {
  const paths = new Set([...base.keys(), ...head.keys()]);
  return [...paths].filter((path) => base.get(path) !== head.get(path)).sort();
}

/**
 * A project's `github` section and `standalone` flag at a commit, with every file read to find them: its tslaws.json
 * and the files it `extends`, the project's own keys winning, as `readConfig` does on disk.
 */
async function settingsAt(
  read: Reader,
  ref: string,
  dir: string,
): Promise<{ github: unknown; standalone: boolean; files: string[] }> {
  const files: string[] = [];
  let standalone = false;
  const load = async (path: string, first: boolean, trail: string[]): Promise<unknown> => {
    if (trail.includes(path)) throw new Error(`${path}: "extends" forms a cycle (${[...trail, path].join(' -> ')})`);
    if (!files.includes(path)) files.push(path);
    const text = await read(path, ref);
    if (text === undefined) {
      // The project's own file may be absent (a project with no tslaws.json); an `extends` target that cannot be read is
      // not, because the settings would then be a guess.
      if (first) return undefined;
      throw new Error(`${path} is named by "extends" and cannot be read at ${ref.slice(0, 7)}`);
    }
    let json: { github?: unknown; extends?: unknown; standalone?: unknown } | null;
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // The parser's message quotes the file's text, which is not ours to echo into a log.
      throw new Error(`${path} is not valid JSON`);
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error(`${path} is not an object`);
    if (first) standalone = json.standalone === true;
    // The same rules loadMerged applies to the files on disk (coverage.ts), so both sides resolve one target.
    const inherited =
      json.extends === undefined ? undefined : await load(extendsTarget(path, json.extends), false, [...trail, path]);
    const own = json.github;
    if (own === undefined) return inherited;
    const plain = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    return plain(inherited) && plain(own) ? { ...inherited, ...own } : own;
  };
  const github = await load(joinRepo(dir, 'tslaws.json'), true, []);
  return { github, standalone, files };
}

// ---- merge ----------------------------------------------------------------------------------------------------------

interface Write {
  path: string;
  text: string;
  /** The blob sha of the lock this text replaces, on the branch; absent when the branch has none. */
  was: string | undefined;
  unit: Unit;
  accepted: Proposal[];
  approvals: Map<string, string>;
}

async function merge(ctx: GithubContext): Promise<number> {
  const monorepo = ctx.projects !== undefined;
  const rootPath = repoPath(ctx, '');
  const failures: string[] = [];
  const fail = (text: string): void => {
    failures.push(text);
    ctx.err(`${text}\n`);
  };
  let units = unitsOf(ctx);
  const ev = event(ctx.env);
  const ref = String(ev.ref ?? ctx.env.GITHUB_REF ?? '');
  const sha = String(ev.after ?? ctx.env.GITHUB_SHA ?? '');
  const before = String(ev.before ?? '');
  const known = /^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before);
  const api = ctx.api ?? restApi(ctx.env);
  const name = repo(ctx.env);

  if (monorepo && known) {
    // The projects the base of this push had count too, whatever the pushed files now say discovers.
    try {
      const base = await projectsAt(api, name, readerOf(api, name), before, rootPath);
      if (base.truncated)
        fail('tslaws: the repository is too large for the API to list its files; cannot check the projects');
      const here = new Set(ctx.discovered ?? units.map((u) => u.rel));
      for (const rel of base.paths) {
        if (here.has(rel)) continue;
        const options = ctx.optionsFor?.(rel);
        if (options === undefined) {
          ctx.out(
            `::notice title=tslaws::${escapeGithubData(rel || '.')} was a project before this push and is gone\n`,
          );
          continue;
        }
        fail(
          `tslaws: ${rel || '.'} was a project before this push and still exists, but is no longer discovered; its lock is checked here anyway`,
        );
        units = [...units, { cwd: join(ctx.cwd, rel), rel, path: joinRepo(rootPath, rel), options }];
      }
    } catch (error) {
      fail(`tslaws: cannot read the projects of ${before.slice(0, 7)} (${String(error)})`);
    }
  }
  const { active, all } = plan(ctx, units, (u) => u.cwd);
  for (const a of active)
    if (isSharedBot(a.config))
      ctx.out(
        `::warning title=tslaws::"bot" is ${a.config.bot}, which every workflow can act as; only a ruleset on ${a.config.branch} that restricts ${joinRepo(a.unit.path, 'tsc-laws.lock')} keeps other workflows from writing it. A dedicated GitHub App closes this.
`,
      );
  const onBranch = active.filter((a) => ref === `refs/heads/${a.config.branch}`);
  if (active.length === 0) return 0;
  if (onBranch.length === 0) {
    const branches = [...new Set(active.map((a) => `refs/heads/${a.config.branch}`))];
    ctx.err(
      `tslaws: ${ref} is not ${branches.join(' or ') || 'a branch any project writes'}; the lock is written only there\n`,
    );
    return 1;
  }
  const eventName = ctx.env.GITHUB_EVENT_NAME;
  if (eventName !== undefined && eventName !== 'push' && eventName !== 'workflow_dispatch') {
    ctx.err('tslaws: merge runs on push and workflow_dispatch only\n');
    return 1;
  }
  // On demand there is no push and no pull request, so whoever started the run is the authority, and only someone
  // with admin or maintain access may start it. A re-run keeps GITHUB_ACTOR (who first started the workflow) and names
  // the person who re-ran it in GITHUB_TRIGGERING_ACTOR, so both must qualify.
  const dispatched = eventName === 'workflow_dispatch';
  const starter = String(ctx.env.GITHUB_ACTOR ?? ev.sender?.login ?? '');
  const rerunner = String(ctx.env.GITHUB_TRIGGERING_ACTOR ?? '');
  const actor = rerunner === '' ? starter : rerunner;
  if (dispatched)
    for (const login of new Set(rerunner === '' ? [starter] : [starter, rerunner])) {
      if (login === '' || !(await maintains(api, name, login))) {
        ctx.err(
          `tslaws: ${login === '' ? 'nobody' : `@${login}`} needs admin or maintain access to run this on demand\n`,
        );
        return 1;
      }
    }
  const branch = ref.slice('refs/heads/'.length);
  // A run can wait in the queue while the branch moves on. It would then test an older checkout and write its lock over
  // the newer commits, so an on-demand run must be on the branch's current head, read from the API.
  if (dispatched) {
    const head = (await api('GET', `/repos/${name}/git/ref/heads/${encodeURIComponent(branch)}`).catch(
      () => undefined,
    )) as { object?: { sha?: string } } | undefined;
    const current = head?.object?.sha;
    const checkedOut = String(ctx.env.GITHUB_SHA ?? '');
    if (current === undefined || checkedOut === '' || current !== checkedOut) {
      ctx.err(
        `tslaws: ${
          current === undefined
            ? `the head of ${branch} could not be read`
            : `${branch} is at ${current.slice(0, 7)} but this run checked out ${checkedOut === '' ? 'no commit' : checkedOut.slice(0, 7)}`
        }; nothing accepted. Run it again on the current head.
`,
      );
      return 1;
    }
  }
  const commits = (ev.commits ?? []) as {
    id: string;
    modified?: string[];
    added?: string[];
    removed?: string[];
    author?: { username?: string };
  }[];
  const pathsOf = (c: (typeof commits)[number]) => [...(c.modified ?? []), ...(c.added ?? []), ...(c.removed ?? [])];
  const lockOf = (unit: Unit) => joinRepo(unit.path, 'tsc-laws.lock');
  // Every lock this repository has, with the bot that may write it where its settings are known.
  const botsOf = new Map<string, string[]>();
  for (const a of all) botsOf.set(lockOf(a.unit), [a.config.bot]);
  const anyBot = [...new Set(all.map((a) => a.config.bot))];
  for (const rel of ctx.discovered ?? []) {
    const lock = joinRepo(joinRepo(rootPath, rel), 'tsc-laws.lock');
    if (botsOf.has(lock)) continue;
    let bot: string | undefined;
    try {
      bot = configIn(join(ctx.cwd, rel))?.bot;
    } catch {
      bot = undefined;
    }
    botsOf.set(lock, bot === undefined ? anyBot : [bot]);
  }
  const watched = (path: string): boolean => (monorepo ? isLock(path) : onBranch.some((a) => lockOf(a.unit) === path));
  const touches = (c: (typeof commits)[number]) => pathsOf(c).filter(watched);
  // Made by the bot, as GitHub sees it: the account and a signature GitHub verified. The push payload's author name
  // comes from the commit's e-mail address, which anyone can set, so it is not enough on its own.
  const details = new Map<
    string,
    Promise<{ author: { login: string } | null; commit: { verification?: { verified: boolean } } }>
  >();
  const byBot = async (id: string, bots: string[]): Promise<boolean> => {
    if (!details.has(id))
      details.set(
        id,
        api('GET', `/repos/${name}/commits/${id}`) as Promise<{
          author: { login: string } | null;
          commit: { verification?: { verified: boolean } };
        }>,
      );
    const detail = await details.get(id)!;
    return bots.includes(detail.author?.login ?? '') && detail.commit.verification?.verified === true;
  };
  const botsFor = (path: string): string[] => botsOf.get(path) ?? anyBot;
  // Or, while the project's "local" is true, one that reached its branch through a merged pull request where the pull
  // request's author, the person who merged it, and the commit's own author (as GitHub sees them) all have admin
  // or maintain access: that person changed the lock by hand and answers for it.
  const people = new Map<string, boolean>();
  const maintainer = async (person?: Person | null): Promise<boolean> => {
    if (person === undefined || person === null || person.login === '') return false;
    if (!people.has(person.login)) people.set(person.login, await maintains(api, name, person.login, person.type));
    return people.get(person.login) === true;
  };
  const viaMaintainer = async (id: string, branchName: string): Promise<boolean> => {
    const detail = (await api('GET', `/repos/${name}/commits/${id}`).catch(() => undefined)) as
      | { author?: Person | null }
      | undefined;
    if (!(await maintainer(detail?.author))) return false;
    const found = await api('GET', `/repos/${name}/commits/${id}/pulls`).catch(() => undefined);
    for (const listed of Array.isArray(found) ? (found as PullRequest[]) : []) {
      if ((listed.merged_at ?? null) === null && listed.merged !== true) continue;
      if (listed.base.ref !== branchName) continue;
      if (!(await maintainer(listed.user))) continue;
      // The list omits who merged it.
      const full = (await api('GET', `/repos/${name}/pulls/${listed.number}`).catch(() => undefined)) as
        | { merged_by?: Person | null }
        | undefined;
      if (await maintainer(full?.merged_by)) return true;
    }
    return false;
  };
  const trustedLock = async (id: string, config: GithubConfig): Promise<boolean> =>
    (await byBot(id, [config.bot])) || (config.local && (await viaMaintainer(id, config.branch)));
  // Every commit from `from` to `to` that changed the lock is trusted, and the range is whole (no gap, no cut list).
  const lockTrustedBetween = async (
    from: string,
    to: string,
    lockPath: string,
    config: GithubConfig,
  ): Promise<boolean> => {
    const range = (await api('GET', `/repos/${name}/compare/${from}...${to}`)) as {
      status: string;
      ahead_by: number;
      commits: { sha: string }[];
    };
    const since = new Set(range.commits.map((c) => c.sha));
    const touched = (await api(
      'GET',
      `/repos/${name}/commits?sha=${to}&path=${encodeURIComponent(lockPath)}&per_page=100`,
    )) as { sha: string }[];
    if (range.status !== 'ahead' || range.ahead_by !== range.commits.length || touched.length >= 100) return false;
    for (const c of touched) if (since.has(c.sha) && !(await trustedLock(c.sha, config))) return false;
    return true;
  };
  const who = (config: GithubConfig): string =>
    config.local
      ? `${config.bot} with a verified signature, nor merged through a pull request from someone with admin or maintain access`
      : `${config.bot} with a verified signature`;
  // The payload lists at most 20 commits; a longer push is never taken for the bot's.
  if (!dispatched && commits.length > 0 && commits.length < 20 && commits.every((c) => touches(c).length > 0)) {
    let bots = true;
    for (const c of commits) for (const path of touches(c)) if (!(await byBot(c.id, botsFor(path)))) bots = false;
    if (bots && failures.length === 0) {
      ctx.out('tslaws: this push is the bot writing the lock; nothing to do\n');
      return 0;
    }
  }
  // A lock that belongs to no project here (one a pull request added, or a project it dropped from discovery) is
  // outside every flow: nothing may change it but the bot.
  if (monorepo) {
    const owned = new Set(onBranch.map((a) => lockOf(a.unit)));
    for (const c of commits)
      for (const path of touches(c))
        if (!owned.has(path) && !(await byBot(c.id, botsFor(path))))
          fail(
            `tslaws: commit ${c.id.slice(0, 7)} changed ${path} but was not made by ${botsFor(path).join(' or ')} with a verified signature; revert it`,
          );
  }
  const pulls = dispatched ? [] : ((await api('GET', `/repos/${name}/commits/${sha}/pulls`)) as PullRequest[]);
  const commentsOf = new Map<number, Promise<IssueComment[]>>();
  const commentsFor = (pr: PullRequest) => {
    if (!commentsOf.has(pr.number)) commentsOf.set(pr.number, issueComments(api, name, pr.number));
    return commentsOf.get(pr.number)!;
  };
  const verdicts = new Map<string, boolean>();

  const writes: Write[] = [];
  const sections: string[] = [];
  let held = 0;
  let accepted = 0;
  for (const { unit, config } of onBranch) {
    const lockPath = lockOf(unit);
    const lockFile = unit.options.lockFile;
    // Per project: one project's failure leaves the others' locks to be written.
    const stop = (text: string): void => {
      fail(text);
      sections.push(`- 🚫 ${shown(label(unit))}: not accepted: ${text.replace(/^tslaws: /, '')}`);
    };
    // On demand, the run builds on the lock as the branch holds it, so where that lock came from matters: the latest
    // commit that changed it must be trusted. (The bot refuses to build on an untrusted lock, and a maintainer answers
    // for the lock they merge, so an older change under a trusted commit was vouched for by whoever made that commit.)
    if (dispatched) {
      // No pull request means no author or reviewers to match, so the project's access levels decide: whoever starts
      // or re-runs the job must reach the lowest level its "approvers" names (admin when it names only admin), and
      // never less than maintain.
      const levels = config.approvers.flatMap((kind) => (kind in rank ? [rank[kind]!] : []));
      const needed = Math.max(rank.maintain!, ...(levels.length > 0 ? [Math.min(...levels)] : []));
      let short: string | undefined;
      for (const login of new Set(rerunner === '' ? [starter] : [starter, rerunner]))
        if (short === undefined && (await permissionRank(api, name, login).catch(() => 0)) < needed) short = login;
      if (short !== undefined) {
        stop(
          `tslaws: @${short} needs ${needed >= rank.admin! ? 'admin' : 'admin or maintain'} access to accept in this project on demand (its approvers are ${config.approvers.join(', ')}); nothing accepted.`,
        );
        continue;
      }
      const latest = await api(
        'GET',
        `/repos/${name}/commits?sha=${encodeURIComponent(config.branch)}&path=${encodeURIComponent(lockPath)}&per_page=1`,
      ).catch(() => undefined);
      const newest = Array.isArray(latest) ? (latest[0] as { sha: string } | undefined) : undefined;
      if (
        !Array.isArray(latest) ||
        (newest !== undefined && !(await trustedLock(newest.sha, config).catch(() => false)))
      ) {
        stop(
          `tslaws: ${newest === undefined ? `the history of ${lockPath} on ${config.branch} could not be read` : `the latest commit that changed ${lockPath} on ${config.branch} (${newest.sha.slice(0, 7)}) was not made by ${who(config)}`}; nothing accepted. Merge the lock through a pull request from a maintainer, or revert that commit.`,
        );
        continue;
      }
    }
    const mine = commits.filter((c) => pathsOf(c).includes(lockPath));
    let refused = false;
    for (const c of mine)
      if (!refused && !(await trustedLock(c.id, config))) {
        stop(
          `tslaws: commit ${c.id.slice(0, 7)} changed ${lockPath} but was not made by ${who(config)}; nothing accepted. Revert it.`,
        );
        refused = true;
      }
    if (refused) continue;
    // The push event lists at most 20 commits, and their file lists can be cut short, so compare the lock itself: this
    // push is not the bot's alone (that case returned above), so it must leave the lock exactly as it was, or change it
    // only through commits shown to be trusted.
    const lockAt = async (at: string): Promise<string | undefined> => {
      try {
        return ((await api('GET', contentsUrl(name, lockPath, at))) as { sha: string }).sha;
      } catch {
        return undefined;
      }
    };
    if (
      known &&
      (await lockAt(before)) !== (await lockAt(sha)) &&
      !(config.local && (await lockTrustedBetween(before, sha, lockPath, config).catch(() => false)))
    ) {
      stop(
        `tslaws: this push changed ${lockPath}, and not only through ${config.bot}; nothing accepted. Revert the change.`,
      );
      continue;
    }
    // Runs queue behind one another (the concurrency group), so this checkout can predate a lock commit that an earlier
    // run made. Start from the lock on the branch, so this run never undoes what an earlier one accepted, once every
    // commit since this push that changed the lock is shown to be the bot's.
    const branchRef = encodeURIComponent(config.branch);
    const headLock = (await api('GET', contentsUrl(name, lockPath, config.branch)).catch(() => undefined)) as
      | { sha: string; content: string }
      | undefined;
    const localBlob = existsSync(lockFile) ? gitBlobSha(readFileSync(lockFile)) : undefined;
    // With results from another job, the lock they were made against must be the branch's lock now: a lock that is gone (or
    // cannot be read) counts as movement when the checkout has one, so a stale lock is never written back.
    if (typeof ctx.flags.get('results') === 'string' && headLock?.sha !== localBlob) {
      stop(
        `tslaws: ${lockPath} on ${config.branch} has moved on since the laws ran on this checkout; nothing accepted. Run the workflow again.`,
      );
      continue;
    }
    if (headLock !== undefined && headLock.sha !== localBlob) {
      if (!(await lockTrustedBetween(sha, branchRef, lockPath, config))) {
        stop(
          `tslaws: ${lockPath} on ${config.branch} has moved on since this push, and not only through ${config.bot}${config.local ? ' or a maintainer' : ''}; nothing accepted`,
        );
        continue;
      }
      writeFileSync(lockFile, Buffer.from(headLock.content, 'base64'));
    }
    let checked: CheckReport;
    let state: ProjectState;
    try {
      checked = await runLaws(ctx, unit, 'merge', sha);
      state = projectState(unit.options);
    } catch (error) {
      if (!monorepo) throw error;
      stop(`tslaws: ${label(unit)} could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const proposals = proposalsOf(lockChanges(state.lock, state.laws, state.exempt, state.levels), checked, unit.path);
    if (proposals.length === 0) {
      ctx.out(`tslaws: ${monorepo ? `${label(unit)}: ` : ''}the lock already records every law\n`);
      continue;
    }
    // Each record's author is checked again now, against this project's own approvers: someone who lost write access,
    // or a rule that changed since the comment, leaves their records out.
    const records: ApprovalRecord[] = [];
    if (config.accept === 'comment')
      for (const pr of pulls)
        for (const record of readApprovals(await commentsFor(pr), config.bot)) {
          if ((record.project ?? '') !== unit.path) continue;
          const key = `${unit.path}\0${pr.number}\0${record.by}`;
          if (!verdicts.has(key))
            verdicts.set(key, (await refusal(api, name, pr, record.by, 'User', config)) === undefined);
          if (verdicts.get(key)) records.push(record);
          else ctx.err(`tslaws: ignoring the records of @${record.by} on #${pr.number}: no longer an approver\n`);
        }
    // The maintainer who started a run on demand accepts everything that passes, as an approver would on a pull request.
    const approvals = dispatched
      ? new Map(proposals.map((p): [string, string] => [p.fingerprint, actor]))
      : acceptedFingerprints(records, unit.path);
    const decision = decide(proposals, config, approvals);
    const wins = proposals.filter((p) => decision.accept.has(p.fingerprint));
    if (wins.length > 0) {
      const next = acceptChanges(state.lock, state.laws, state.exempt, state.levels, decision.accept);
      // A certificate would come from the run of the laws, which is not trusted with the lock: readReport drops them, and a
      // lock written here records none (a record the lock already holds stays only while its law and problem match).
      writeLockValue(lockFile, next);
      writes.push({
        path: lockPath,
        text: readFileSync(lockFile, 'utf8'),
        was: headLock?.sha,
        unit,
        accepted: wins,
        approvals,
      });
    }
    accepted += wins.length;
    held += decision.held.length;
    sections.push(
      [
        ...(monorepo ? [`#### \`${label(unit).replace(/`/g, "'")}\`\n`] : []),
        ...wins.map(
          (p) =>
            `- ✅ ${shown(p.name)} (${shown(p.file)}, ${p.reason}) accepted${approvals.has(p.fingerprint) ? ` — @${approvals.get(p.fingerprint)}` : ''}`,
        ),
        ...decision.held.map(
          ({ proposal, why }) =>
            `- 🚫 ${shown(proposal.name)} (${shown(proposal.file)}, ${proposal.reason}) not accepted: ${why}`,
        ),
      ].join('\n'),
    );
  }

  if (writes.length > 0 && !ctx.flags.has('dry-run')) {
    const detail = (w: Write) =>
      w.accepted
        .map(
          (p) =>
            `- ${monorepo ? `${joinRepo(w.unit.path, '')}`.replace(/\/$/, '') + (w.unit.path === '' ? '' : ': ') : ''}${p.key} (${p.reason}${p.outcome ? `, ${p.outcome.status}` : ''}${w.approvals.has(p.fingerprint) ? `, accepted by @${w.approvals.get(p.fingerprint)}` : ''})`,
        )
        .join('\n');
    const count = writes.reduce((n, w) => n + w.accepted.length, 0);
    const message = `chore(tslaws): accept ${count} law change${count === 1 ? '' : 's'}${writes.length > 1 ? ` in ${writes.length} projects` : ''}${pulls[0] ? ` from #${pulls[0].number}` : dispatched ? ` on request of @${actor}` : ''}\n\n${writes.map(detail).join('\n')}`;
    if (writes.length === 1) {
      const [only] = writes;
      // Through the contents API, so GitHub signs the commit as the bot and `verify` can tell it from a forgery. The
      // lock this run started from is the one it replaces: if anything wrote the lock since, GitHub refuses the write.
      await api('PUT', contentsUrl(name, only!.path), {
        message,
        content: Buffer.from(only!.text).toString('base64'),
        branch,
        ...(only!.was === undefined ? {} : { sha: only!.was }),
      });
    } else {
      await commitTogether(api, name, branch, writes, message);
    }
  }
  const where = repoPath(ctx, '');
  const note = `### tslaws on \`${branch}\`${monorepo || where === '' ? '' : ` (\`${where}\`)`}\n\n${sections.join('\n')}\n${held > 0 ? `\n\`tslaws check\` fails on \`${branch}\` until the held proposals are fixed or removed.\n` : ''}`;
  if (sections.length > 0) {
    summary(ctx.env, note);
    ctx.out(`${note}\n`);
    for (const pr of pulls)
      await api('POST', `/repos/${name}/issues/${pr.number}/comments`, { body: note }).catch(() => undefined);
  }
  setOutput(ctx.env, 'accepted', String(accepted));
  if (failures.length > 0 && writes.length > 0)
    ctx.out(`tslaws: wrote ${writes.length} lock(s); ${failures.length} problem(s) above leave the job failed\n`);
  return held === 0 && failures.length === 0 ? 0 : 1;
}

/**
 * Several locks in one commit, through the git data API: the parent is the branch's head now, each lock must still be
 * the one this run built on, and the branch moves by a plain (never forced) update, so GitHub refuses it if anything
 * landed in between.
 */
async function commitTogether(api: Api, name: string, branch: string, writes: Write[], message: string): Promise<void> {
  const ref = encodeURIComponent(branch);
  const head = ((await api('GET', `/repos/${name}/git/ref/heads/${ref}`)) as { object: { sha: string } }).object.sha;
  for (const w of writes) {
    let now: string | undefined;
    try {
      now = ((await api('GET', contentsUrl(name, w.path, head))) as { sha: string }).sha;
    } catch {
      now = undefined;
    }
    if (now !== w.was) throw new Error(`${w.path} changed on ${branch} while this ran; nothing written`);
  }
  const parent = (await api('GET', `/repos/${name}/git/commits/${head}`)) as { tree: { sha: string } };
  const tree = (await api('POST', `/repos/${name}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: writes.map((w) => ({ path: w.path, mode: '100644', type: 'blob', content: w.text })),
  })) as { sha: string };
  const made = (await api('POST', `/repos/${name}/git/commits`, { message, tree: tree.sha, parents: [head] })) as {
    sha: string;
  };
  await api('PATCH', `/repos/${name}/git/refs/heads/${ref}`, { sha: made.sha, force: false });
}

/**
 * What a project's settings were and are. Always read at both commits and compared: the list of changed files is capped
 * by the API, so it cannot be what decides whether to look.
 */
async function checkProjectAt(
  read: Reader,
  pull: PullRequest,
  problems: string[],
  dir: string,
): Promise<GithubConfig | undefined> {
  const configPath = joinRepo(dir, 'tslaws.json');
  const base = await settingsAt(read, pull.base.sha, dir);
  let head: Awaited<ReturnType<typeof settingsAt>> | undefined;
  try {
    head = await settingsAt(read, pull.head.sha, dir);
  } catch (error) {
    problems.push(
      `${configPath} does not read on the pull request: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (head !== undefined) {
    if (JSON.stringify(base.github) !== JSON.stringify(head.github))
      problems.push(
        `the pull request changes the "github" section of ${configPath}, which decides who may accept laws`,
      );
    else if (base.standalone !== head.standalone)
      problems.push(`the pull request changes "standalone" in ${configPath}, which decides whether root runs cover it`);
  }

  return base.github === undefined ? undefined : parseGithubConfig(base.github);
}

interface PullCommit {
  sha: string;
  author?: Person | null;
  files: { filename: string; previous_filename?: string }[];
}

/** What a hand-made lock change has to show, read once per pull request however many locks it changes. */
interface LockEvidence {
  author?: Promise<boolean>;
  /** The pull request's commits; `full` when GitHub's list of them may be cut short (250 is its limit). */
  commits?: Promise<{ full: boolean; list: PullCommit[] }>;
}

/**
 * Why a pull request may not change `lockPath`, for a project whose base settings are `config`. With "local" on, a
 * maintainer's pull request may: its author needs admin or maintain access, and so does the author of each commit that
 * changes the lock, so a maintainer cannot carry someone else's lock through. Without it, only the bot writes the lock.
 */
async function lockChangeProblems(
  api: Api,
  name: string,
  pull: PullRequest,
  lockPath: string,
  config: GithubConfig,
  evidence: LockEvidence,
): Promise<string[]> {
  if (!config.local)
    return [`the pull request changes ${lockPath}; only ${config.bot} writes the lock, on merge into ${config.branch}`];
  evidence.author ??= maintains(api, name, pull.user.login, pull.user.type);
  if (!(await evidence.author))
    return [
      `the pull request changes ${lockPath}; only ${config.bot} writes the lock, on merge into ${config.branch}, unless its author has admin or maintain access to the repository`,
    ];
  // GitHub lists at most 300 files for a commit; a full list may hide the lock, so it counts as touching it. It lists at
  // most 250 commits for a pull request; a full list may hide a commit, so the pull request cannot be checked. The
  // author is the one GitHub matches from the commit's e-mail, which anyone with push access to the branch can set: the
  // pull request's author, a maintainer, answers for what is pushed to it, and the ruleset is the hard control.
  evidence.commits ??= (async () => {
    const listed = await all<{ sha: string }>(api, `/repos/${name}/pulls/${pull.number}/commits`);
    const list: PullCommit[] = [];
    // At the limit the pull request fails whatever its commits say, so they are not read.
    for (const c of listed.length >= 250 ? [] : listed) {
      const detail = (await api('GET', `/repos/${name}/commits/${c.sha}`)) as {
        author?: Person | null;
        files?: { filename: string; previous_filename?: string }[];
      };
      list.push({ sha: c.sha, author: detail.author, files: detail.files ?? [] });
    }
    return { full: listed.length >= 250, list };
  })();
  const { full, list } = await evidence.commits;
  const problems: string[] = [];
  if (full)
    problems.push(
      `the pull request changes ${lockPath} and has 250 or more commits, more than GitHub lists; split it so each commit can be checked`,
    );
  for (const c of list) {
    const touchesLock =
      c.files.length >= 300 || c.files.some((f) => f.filename === lockPath || f.previous_filename === lockPath);
    if (touchesLock && !(await maintains(api, name, c.author?.login ?? '', c.author?.type)))
      problems.push(
        `commit ${c.sha.slice(0, 7)} in the pull request changes ${lockPath}, but ${c.author?.login ? `@${c.author.login} does not` : 'its author does not'} have admin or maintain access to the repository`,
      );
  }
  return problems;
}

/** The most files the pull request files API lists (30 pages of 100); a pull request with more is cut short. */
const filesListLimit = 3000;

/**
 * The files a pull request changes, with the old name of each file it renames. Fails when the list cannot be the whole
 * of it: at the API's cap, or not the number GitHub says the pull request changes. The security checks do not decide
 * from this list alone, but a list that may be short is never used.
 */
async function changedFiles(api: Api, name: string, pull: PullRequest): Promise<Set<string>> {
  const files = await all<{ filename: string; previous_filename?: string }>(
    api,
    `/repos/${name}/pulls/${pull.number}/files`,
  );
  if (files.length >= filesListLimit)
    throw new Error(
      `the pull request changes ${filesListLimit} files or more, which the API cannot list in full; nothing can be checked`,
    );
  if (files.length !== pull.changed_files)
    throw new Error(
      `GitHub lists ${files.length} changed files for the pull request but reports ${pull.changed_files ?? 'no count of'} files changed; nothing can be checked`,
    );
  return new Set(files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]));
}

/**
 * Everything a pull request must not change from under a monorepo's checks, read through the API at the base and at the
 * head: the project list (and how it is found), each project's `github` and `standalone` settings, and any lock. Adds a
 * line to `problems` for each. Returns what it read, for a caller that decides more from it. A lock change is a problem
 * unless `maintainersMayChangeLocks` and its project's base settings have "local" on and a maintainer wrote it.
 */
async function inspectMonorepo(
  api: Api,
  name: string,
  read: Reader,
  pull: PullRequest,
  changed: Set<string>,
  rootPath: string,
  problems: string[],
  maintainersMayChangeLocks = false,
): Promise<{ baseSide: { paths: string[] }; headSide: { paths: string[] }; union: string[] }> {
  const checkProject = (dir: string) => checkProjectAt(read, pull, problems, dir);
  // Every project of the base and every project of the head, read through the API: a pull request that edits the
  // files that discover projects cannot hide a project from this check.
  const baseSide = await projectsAt(api, name, read, pull.base.sha, rootPath);
  const headSide = await projectsAt(api, name, read, pull.head.sha, rootPath);
  if (baseSide.truncated || headSide.truncated)
    problems.push('the repository is too large for the API to list its files; the projects cannot be checked');
  const label = (rel: string) => joinRepo(rootPath, rel) || '.';
  const headSet = new Set(headSide.paths);
  for (const rel of baseSide.paths)
    if (!headSet.has(rel))
      problems.push(
        `${label(rel)} is a project on ${pull.base.ref} but the pull request no longer discovers it, so its lock would go unwatched: restore it, or merge this in a pull request of its own by an administrator`,
      );
  const inputs: [string, keyof DiscoveryInputs][] = [
    ['tslaws.json', 'tslaws'],
    ['package.json', 'packageJson'],
    ['pnpm-workspace.yaml', 'pnpmWorkspace'],
  ];
  for (const [file, key] of inputs) {
    const path = joinRepo(rootPath, file);
    const was = baseSide.inputs[key];
    const now = headSide.inputs[key];
    const sig = (text: string | undefined) => (text === undefined ? 'absent' : discoverySignature({ [key]: text }));
    if (sig(was) !== sig(now))
      problems.push(
        `the pull request changes how projects are discovered (${path}), which decides what this check watches`,
      );
  }
  const union = [...new Set([...baseSide.paths, ...headSide.paths])];
  const configs = new Map<string, GithubConfig | undefined>();
  const evidence: LockEvidence = {};
  // Every project, whatever the pull request changed: a settings file need not end in .json (an `extends` base in a
  // .jsonc file, say), so no extension decides whether to look. checkProject compares only the files a project reads.
  for (const rel of union)
    try {
      configs.set(rel, await checkProject(joinRepo(rootPath, rel)));
    } catch (error) {
      problems.push(`${label(rel)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  // Any lock the pull request touches, in a project or not: the bot writes locks, after the merge. Found by comparing the
  // two trees' blob ids (not only the files list, which can be cut short).
  for (const file of new Set([...lockDifferences(baseSide.locks, headSide.locks), ...[...changed].filter(isLock)])) {
    const owner = union.find((rel) => joinRepo(rootPath, joinRepo(rel, 'tsc-laws.lock')) === file);
    const config = owner === undefined ? undefined : configs.get(owner);
    if (config !== undefined && maintainersMayChangeLocks) {
      // The project's own settings, as the base has them: a maintainer may change its lock while its "local" is true.
      problems.push(...(await lockChangeProblems(api, name, pull, file, config, evidence)));
      continue;
    }
    problems.push(
      config === undefined
        ? `the pull request changes ${file}; a lock changes only when the bot writes it on merge, and this one is ${owner === undefined ? 'outside every project' : 'in a project with no "github" settings'}`
        : `the pull request changes ${file}; only ${config.bot} writes the lock, on merge into ${config.branch}`,
    );
  }
  return { baseSide, headSide, union };
}

// ---- verify ---------------------------------------------------------------------------------------------------------

async function verify(ctx: GithubContext): Promise<number> {
  const monorepo = ctx.projects !== undefined;
  const ev = event(ctx.env);
  const pull = ev.pull_request as PullRequest | undefined;
  if (pull === undefined) {
    ctx.err('tslaws: verify runs on pull_request_target\n');
    return 1;
  }
  const api = ctx.api ?? restApi(ctx.env);
  const name = repo(ctx.env);
  const read = readerOf(api, name);
  const rootPath = repoPath(ctx, '');
  const problems: string[] = [];
  const changed = await changedFiles(api, name, pull);
  const protectedPaths = String(ctx.flags.get('protect') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const path of protectedPaths)
    if (changed.has(path))
      problems.push(`${path} is protected: change it in a pull request of its own, merged by an administrator`);

  const checkProject = (dir: string) => checkProjectAt(read, pull, problems, dir);

  if (!monorepo) {
    // One project, as a package's own workflow runs it: its lock and its settings only.
    const configPath = joinRepo(rootPath, 'tslaws.json');
    const lockPath = joinRepo(rootPath, 'tsc-laws.lock');
    const config = await checkProject(rootPath);
    if (config === undefined) throw new Error('tslaws github needs a "github" section in tslaws.json');
    // The bot never commits to a pull request's branch: it writes the lock on ${config.branch} after the merge. So any
    // change to the lock in the pull request's diff (the full list, paginated above) is a forgery. Checking the diff, not
    // each commit, also covers commits whose file list GitHub truncates (the commit API lists at most 300 files). With
    // "local" on, a pull request from someone with admin or maintain access may change it: see lockChangeProblems.
    const [baseTree, headTree] = await Promise.all([
      treeAt(api, name, pull.base.sha),
      treeAt(api, name, pull.head.sha),
    ]);
    if (baseTree.truncated || headTree.truncated)
      problems.push('the repository is too large for the API to list its files; the lock cannot be checked');
    if (changed.has(lockPath) || lockDifferences(baseTree.locks, headTree.locks).includes(lockPath))
      problems.push(...(await lockChangeProblems(api, name, pull, lockPath, config, {})));
    void configPath;
  } else {
    await inspectMonorepo(api, name, read, pull, changed, rootPath, problems, true);
  }
  for (const problem of problems) ctx.out(`::error::${escapeGithubData(problem)}\n`);
  if (problems.length === 0) ctx.out('tslaws: the lock and its settings are untouched by this pull request\n');
  return problems.length === 0 ? 0 : 1;
}

// ---- entry ----------------------------------------------------------------------------------------------------------

export async function githubCommand(action: string | undefined, ctx: GithubContext): Promise<number> {
  try {
    const out = ctx.flags.get('results-out');
    if (out !== undefined || ctx.flags.has('results')) {
      if (action !== 'report' && action !== 'merge') {
        ctx.err('tslaws github: --results and --results-out are for report and merge\n');
        return 1;
      }
      if (out !== undefined && ctx.flags.has('results')) {
        ctx.err('tslaws github: use --results-out to run the laws or --results to act on them, not both\n');
        return 1;
      }
      if (out !== undefined) {
        if (typeof out !== 'string') {
          ctx.err('tslaws github: --results-out needs a file\n');
          return 1;
        }
        return await collect(ctx, action, out);
      }
      if (typeof ctx.flags.get('results') !== 'string') {
        ctx.err('tslaws github: --results needs a file\n');
        return 1;
      }
    }
    if (action === 'report') return await report(ctx);
    if (action === 'command') return await command(ctx);
    if (action === 'merge') return await merge(ctx);
    if (action === 'verify') return await verify(ctx);
  } catch (error) {
    ctx.err(`tslaws github ${action}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  ctx.err('usage: tslaws github report|command|merge|verify\n');
  return 1;
}
