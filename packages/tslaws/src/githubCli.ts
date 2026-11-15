// `tslaws github <report|command|merge|verify>`: the GitHub side of accepting laws. See github.ts for the policy.
//
//   report   pull_request: runs every law (proposals included), flags each proposal on its line, keeps one sticky
//            comment up to date, and fails when an accepted law fails, a proposal fails, or (comment mode) a proposal
//            waits for an accept. Advisory: it runs the pull request's code, so it decides nothing about the lock.
//   command  issue_comment: reads `/tslaws accept|reject ...`, checks the commenter may accept, and records the
//            fingerprints accepted in a comment of the bot's. Reads the pull request's files as data; runs none of it.
//   merge    push to the configured branch: runs the laws on the merged code, accepts what passes (and, in comment
//            mode, what was accepted for that exact version) and commits tsc-laws.lock through the API as the bot.
//            The only place the lock is written.
//   verify   pull_request_target: fails when a commit in the pull request that the bot did not make (with a signature
//            GitHub verified) touches tsc-laws.lock, or when the pull request changes the "github" section of
//            tslaws.json or a protected path. Reads the base branch's config, never the pull request's.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { check, exemptionsOf } from './check.ts';
import type { CheckReport } from './check.ts';
import { readConfig } from './coverage.ts';
import { readManifest } from './compile.ts';
import {
  acceptedFingerprints,
  inert,
  recordComment,
  decide,
  parseCommands,
  parseGithubConfig,
  proposalsOf,
  pullRequestVerdict,
  readApprovals,
  renderSticky,
  resolveNames,
  stickyMarker,
  type ApprovalRecord,
  type GithubConfig,
  type IssueComment,
  type Proposal,
} from './github.ts';
import { classifyLawFile, lockLevels } from './lawKinds.ts';
import { acceptChanges, lockChanges, readLock, writeLockValue, type Lock } from './lock.ts';
import { escapeGithubData, escapeGithubProperty } from './reporters.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

export interface GithubContext {
  cwd: string;
  /** The check options for the whole project (every laws file, the lock at the root). */
  options: CheckOptions;
  env: NodeJS.ProcessEnv;
  flags: Map<string, string | true>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** For tests: a stand-in for the GitHub REST API. */
  api?: Api;
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

interface PullRequest {
  number: number;
  user: { login: string; type: string };
  head: { sha: string };
  base: { ref: string; sha: string };
  requested_reviewers?: { login: string }[];
  merged?: boolean;
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
  if (raw === undefined)
    throw new Error('tslaws github needs a "github" section in tslaws.json, with "bot" set to the tslaws GitHub App');
  return parseGithubConfig(raw);
}

interface ProjectState {
  laws: ManifestLaw[];
  exempt: string[];
  levels: Record<string, string> | undefined;
  lock: Lock | undefined;
}

/** What the lock would record if everything were accepted now. Compiles the project; runs none of it. */
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

async function upsertSticky(api: Api, name: string, pr: number, bot: string, body: string, comments: IssueComment[]) {
  const mine = comments.find((c) => c.user.login === bot && c.body.startsWith(stickyMarker));
  if (mine === undefined) await api('POST', `/repos/${name}/issues/${pr}/comments`, { body });
  else if (mine.body !== body) await api('PATCH', `/repos/${name}/issues/comments/${mine.id}`, { body });
}

function linkFor(env: NodeJS.ProcessEnv, sha: string): (p: Proposal) => string {
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const name = env.GITHUB_REPOSITORY ?? '';
  // Raw text: renderSticky makes the whole cell inert. Brackets and backticks would break the link's markdown.
  return (p) => {
    const label = p.name.replace(/[`[\]]/g, "'");
    if (p.line === 0 || name === '') return `${label} (${p.file})`;
    return `[${label}](${server}/${name}/blob/${sha}/${p.file.split('/').map(encodeURIComponent).join('/')}#L${p.line})`;
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

// ---- report ---------------------------------------------------------------------------------------------------------

async function report(ctx: GithubContext): Promise<number> {
  const config = githubConfigOf(readText(join(ctx.cwd, 'tslaws.json')));
  const ev = event(ctx.env);
  const pr = Number(ctx.flags.get('pr') ?? ev.pull_request?.number ?? NaN);
  const sha = String(ev.pull_request?.head?.sha ?? ctx.env.GITHUB_SHA ?? '');
  const checked: CheckReport = await check(ctx.options, true);
  const state = projectState(ctx.options);
  const proposals = proposalsOf(lockChanges(state.lock, state.laws, state.exempt, state.levels), checked);

  let api: Api | undefined;
  let comments: IssueComment[] = [];
  try {
    api = ctx.api ?? restApi(ctx.env);
    if (Number.isInteger(pr)) comments = await issueComments(api, repo(ctx.env), pr);
  } catch (error) {
    ctx.err(`tslaws: cannot read the pull request's comments (${String(error)}); reporting without approvals\n`);
    api = undefined;
  }
  const approvals = acceptedFingerprints(readApprovals(comments, config.bot));
  const verdict = pullRequestVerdict(checked, proposals, config, approvals);

  for (const p of proposals) {
    const level = p.passes ? 'notice' : 'error';
    const title = `tslaws proposal: ${p.name}`;
    const message =
      p.outcome === undefined
        ? 'did not run'
        : `${p.reason}; if accepted: ${p.outcome.status}${p.outcome.counterexample ? `; counterexample ${p.outcome.counterexample}` : ''}`;
    ctx.out(
      `::${level} file=${escapeGithubProperty(p.file)},line=${Math.max(1, p.line)},title=${escapeGithubProperty(title)}::${escapeGithubData(message)}\n`,
    );
  }
  const body = renderSticky(proposals, config, approvals, linkFor(ctx.env, sha));
  summary(ctx.env, body.replace(stickyMarker, ''));
  if (api !== undefined && Number.isInteger(pr) && ctx.flags.has('comment')) {
    try {
      await upsertSticky(api, repo(ctx.env), pr, config.bot, body, comments);
    } catch (error) {
      // A pull request from a fork gets a read-only token: the step summary and annotations still carry the report.
      ctx.err(`tslaws: cannot write the sticky comment (${String(error)})\n`);
    }
  }
  const outFile = ctx.flags.get('out');
  if (typeof outFile === 'string') writeFileSync(outFile, `${JSON.stringify({ sha, proposals, verdict }, null, 2)}\n`);
  setOutput(ctx.env, 'proposals', String(proposals.length));
  for (const problem of verdict.problems) ctx.out(`${problem}\n`);
  ctx.out(
    verdict.ok ? `tslaws: ${proposals.length} proposal(s), all passing\n` : 'tslaws: the pull request is not ready\n',
  );
  return verdict.ok ? 0 : 1;
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

// ---- command --------------------------------------------------------------------------------------------------------

const rank: Record<string, number> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

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
  const permission = (await api('GET', `/repos/${name}/collaborators/${encodeURIComponent(login)}/permission`)) as {
    permission: string;
    role_name?: string;
  };
  const level = Math.max(rank[permission.permission] ?? 0, rank[permission.role_name ?? ''] ?? 0);
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

async function command(ctx: GithubContext): Promise<number> {
  // The base branch's config: the workflow checks the default branch out at the root and the pull request beside it.
  const config = githubConfigOf(readText(join(String(ctx.flags.get('config-from') ?? ctx.cwd), 'tslaws.json')));
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
  const pr = (await api('GET', `/repos/${name}/pulls/${number}`)) as PullRequest;
  if (config.accept !== 'comment') {
    await reply(
      `@${login} this project accepts passing proposals on merge into \`${config.branch}\`; there is nothing to accept by comment.`,
    );
    return 0;
  }
  const refused = await refusal(api, name, pr, login, String(ev.comment.user.type ?? 'User'), config);
  if (refused !== undefined) {
    await reply(`Not recorded: ${refused}.`);
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
  const state = projectState(ctx.options);
  const proposals = proposalsOf(lockChanges(state.lock, state.laws, state.exempt, state.levels), undefined);
  const lines: string[] = [];
  const records: ApprovalRecord[] = [];
  for (const cmd of commands) {
    const { matched, unknown, ambiguous } = resolveNames(proposals, cmd);
    if (unknown.length > 0) lines.push(`- no proposal named ${unknown.map(shown).join(', ')}`);
    if (ambiguous.length > 0)
      lines.push(`- ${ambiguous.map(shown).join(', ')} names laws in several files; use \`file::name\``);
    if (matched.length === 0) continue;
    records.push({
      verb: cmd.verb,
      by: login,
      sha: pr.head.sha,
      items: matched.map((p) => ({ key: p.key, fingerprint: p.fingerprint })),
    });
    lines.push(
      `- ${cmd.verb === 'accept' ? 'accepted' : 'withdrew'} ${matched.map((p) => `${shown(p.name)} (${shown(p.file)}, ${p.reason})`).join(', ')}`,
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
  if (records.length > 0 && config.approvePullRequest) {
    const comments = await issueComments(api, name, number);
    const approvals = acceptedFingerprints(readApprovals(comments, config.bot));
    if (proposals.length > 0 && proposals.every((p) => approvals.has(p.fingerprint)))
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

// ---- merge ----------------------------------------------------------------------------------------------------------

async function merge(ctx: GithubContext): Promise<number> {
  const configText = readText(join(ctx.cwd, 'tslaws.json'));
  const config = githubConfigOf(configText);
  const ev = event(ctx.env);
  const ref = String(ev.ref ?? ctx.env.GITHUB_REF ?? '');
  if (ref !== `refs/heads/${config.branch}`) {
    ctx.err(`tslaws: ${ref} is not refs/heads/${config.branch}; the lock is written only there\n`);
    return 1;
  }
  if (ctx.env.GITHUB_EVENT_NAME !== undefined && ctx.env.GITHUB_EVENT_NAME !== 'push') {
    ctx.err('tslaws: merge runs on push only\n');
    return 1;
  }
  const commits = (ev.commits ?? []) as {
    id: string;
    modified?: string[];
    added?: string[];
    removed?: string[];
    author?: { username?: string };
  }[];
  const touches = (c: (typeof commits)[number]) =>
    [...(c.modified ?? []), ...(c.added ?? []), ...(c.removed ?? [])].includes('tsc-laws.lock');
  const api = ctx.api ?? restApi(ctx.env);
  const name = repo(ctx.env);
  const sha = String(ev.after ?? ctx.env.GITHUB_SHA ?? '');
  // Made by the bot, as GitHub sees it: the account and a signature GitHub verified. The push payload's author name
  // comes from the commit's e-mail address, which anyone can set, so it is not enough on its own.
  const byBot = async (id: string): Promise<boolean> => {
    const detail = (await api('GET', `/repos/${name}/commits/${id}`)) as {
      author: { login: string } | null;
      commit: { verification?: { verified: boolean } };
    };
    return detail.author?.login === config.bot && detail.commit.verification?.verified === true;
  };
  // The payload lists at most 20 commits; a longer push is never taken for the bot's.
  if (commits.length > 0 && commits.length < 20 && commits.every(touches)) {
    let all = true;
    for (const c of commits) if (!(await byBot(c.id))) all = false;
    if (all) {
      ctx.out('tslaws: this push is the bot writing the lock; nothing to do\n');
      return 0;
    }
  }
  for (const c of commits.filter(touches))
    if (!(await byBot(c.id))) {
      ctx.err(
        `tslaws: commit ${c.id.slice(0, 7)} changed tsc-laws.lock but was not made by ${config.bot} with a verified signature; nothing accepted. Revert it.\n`,
      );
      return 1;
    }
  // The push event lists at most 20 commits, and their file lists can be cut short, so compare the lock itself: this
  // push is not the bot's alone (that case returned above), so it must leave the lock exactly as it was.
  const before = String(ev.before ?? '');
  if (/^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before)) {
    const lockAt = async (ref: string): Promise<string | undefined> => {
      try {
        return ((await api('GET', `/repos/${name}/contents/tsc-laws.lock?ref=${ref}`)) as { sha: string }).sha;
      } catch {
        return undefined;
      }
    };
    if ((await lockAt(before)) !== (await lockAt(sha))) {
      ctx.err(`tslaws: this push changed tsc-laws.lock, and not only through ${config.bot}; nothing accepted. Revert the change.
`);
      return 1;
    }
  }
  const pulls = (await api('GET', `/repos/${name}/commits/${sha}/pulls`)) as PullRequest[];
  const checked = await check(ctx.options, true);
  const state = projectState(ctx.options);
  const proposals = proposalsOf(lockChanges(state.lock, state.laws, state.exempt, state.levels), checked);
  if (proposals.length === 0) {
    ctx.out('tslaws: the lock already records every law\n');
    return 0;
  }
  // Each record's author is checked again now: someone who lost write access, or a rule that changed since the
  // comment, leaves their records out.
  let records: ApprovalRecord[] = [];
  if (config.accept === 'comment')
    for (const pr of pulls) {
      const verdicts = new Map<string, boolean>();
      for (const record of readApprovals(await issueComments(api, name, pr.number), config.bot)) {
        if (!verdicts.has(record.by))
          verdicts.set(record.by, (await refusal(api, name, pr, record.by, 'User', config)) === undefined);
        if (verdicts.get(record.by)) records.push(record);
        else ctx.err(`tslaws: ignoring the records of @${record.by} on #${pr.number}: no longer an approver\n`);
      }
    }
  const approvals = acceptedFingerprints(records);
  const decision = decide(proposals, config, approvals);
  const accepted = proposals.filter((p) => decision.accept.has(p.fingerprint));
  if (accepted.length > 0) {
    const next = acceptChanges(state.lock, state.laws, state.exempt, state.levels, decision.accept);
    writeLockValue(ctx.options.lockFile, next);
    const text = readFileSync(ctx.options.lockFile, 'utf8');
    if (!ctx.flags.has('dry-run')) {
      // Through the contents API, so GitHub signs the commit as the bot and `verify` can tell it from a forgery.
      const current = (await api(
        'GET',
        `/repos/${name}/contents/tsc-laws.lock?ref=${encodeURIComponent(config.branch)}`,
      ).catch(() => undefined)) as { sha?: string } | undefined;
      await api('PUT', `/repos/${name}/contents/tsc-laws.lock`, {
        message: `chore(tslaws): accept ${accepted.length} law change${accepted.length === 1 ? '' : 's'}${pulls[0] ? ` from #${pulls[0].number}` : ''}\n\n${accepted.map((p) => `- ${p.key} (${p.reason}${p.outcome ? `, ${p.outcome.status}` : ''}${approvals.has(p.fingerprint) ? `, accepted by @${approvals.get(p.fingerprint)}` : ''})`).join('\n')}`,
        content: Buffer.from(text).toString('base64'),
        branch: config.branch,
        ...(current?.sha === undefined ? {} : { sha: current.sha }),
      });
    }
  }
  const lines = [
    ...accepted.map(
      (p) =>
        `- ✅ ${shown(p.name)} (${shown(p.file)}, ${p.reason}) accepted${approvals.has(p.fingerprint) ? ` — @${approvals.get(p.fingerprint)}` : ''}`,
    ),
    ...decision.held.map(
      ({ proposal, why }) =>
        `- 🚫 ${shown(proposal.name)} (${shown(proposal.file)}, ${proposal.reason}) not accepted: ${why}`,
    ),
  ];
  const note = `### tslaws on \`${config.branch}\`\n\n${lines.join('\n')}\n${decision.held.length > 0 ? `\n\`tslaws check\` fails on \`${config.branch}\` until the held proposals are fixed or removed.\n` : ''}`;
  summary(ctx.env, note);
  ctx.out(`${note}\n`);
  for (const pr of pulls)
    await api('POST', `/repos/${name}/issues/${pr.number}/comments`, { body: note }).catch(() => undefined);
  setOutput(ctx.env, 'accepted', String(accepted.length));
  return decision.held.length === 0 ? 0 : 1;
}

// ---- verify ---------------------------------------------------------------------------------------------------------

async function verify(ctx: GithubContext): Promise<number> {
  const ev = event(ctx.env);
  const pull = ev.pull_request as PullRequest | undefined;
  if (pull === undefined) {
    ctx.err('tslaws: verify runs on pull_request_target\n');
    return 1;
  }
  const api = ctx.api ?? restApi(ctx.env);
  const name = repo(ctx.env);
  const contents = async (path: string, ref: string): Promise<string | undefined> => {
    try {
      const file = (await api('GET', `/repos/${name}/contents/${path}?ref=${ref}`)) as { content: string };
      return Buffer.from(file.content, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  };
  const baseText = await contents('tslaws.json', pull.base.sha);
  const config = githubConfigOf(baseText);
  const problems: string[] = [];
  const files = await all<{ filename: string; previous_filename?: string }>(
    api,
    `/repos/${name}/pulls/${pull.number}/files`,
  );
  const changed = new Set(files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]));
  const protectedPaths = String(ctx.flags.get('protect') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const path of protectedPaths)
    if (changed.has(path))
      problems.push(`${path} is protected: change it in a pull request of its own, merged by an administrator`);
  if (changed.has('tslaws.json')) {
    const headText = await contents('tslaws.json', pull.head.sha);
    const section = (text: string | undefined) =>
      JSON.stringify(text === undefined ? undefined : (JSON.parse(text) as { github?: unknown }).github);
    try {
      if (section(baseText) !== section(headText))
        problems.push(
          'the pull request changes the "github" section of tslaws.json, which decides who may accept laws',
        );
    } catch {
      problems.push('tslaws.json does not parse');
    }
  }
  // The bot never commits to a pull request's branch: it writes the lock on ${config.branch} after the merge. So any
  // change to the lock in the pull request's diff (the full list, paginated above) is a forgery. Checking the diff, not
  // each commit, also covers commits whose file list GitHub truncates (the commit API lists at most 300 files).
  if (changed.has('tsc-laws.lock'))
    problems.push(
      `the pull request changes tsc-laws.lock; only ${config.bot} writes the lock, on merge into ${config.branch}`,
    );
  for (const problem of problems) ctx.out(`::error::${escapeGithubData(problem)}\n`);
  if (problems.length === 0) ctx.out('tslaws: the lock and its settings are untouched by this pull request\n');
  return problems.length === 0 ? 0 : 1;
}

// ---- entry ----------------------------------------------------------------------------------------------------------

export async function githubCommand(action: string | undefined, ctx: GithubContext): Promise<number> {
  try {
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
