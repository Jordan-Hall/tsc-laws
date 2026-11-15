// Accepting laws on GitHub: the pure part. A pull request that adds, changes or removes a law (or a coverage exemption)
// carries proposals; each one is flagged, run, and reported as passing or failing. The lock is never written on the
// pull request. It is written only by the tslaws workflow on the default branch, after the merge:
//
//   accept: "merge"    every proposal that passes is accepted when the pull request merges
//   accept: "comment"  a proposal is accepted on merge only if the author or a reviewer said `/tslaws accept <law>` or
//                      `/tslaws accept all` on the pull request, for the exact version of the law that merged
//
// Approvals are recorded by the bot, in comments only the bot writes, with the fingerprint of the content approved.
// Anyone can type the marker into a comment of their own, so a record counts only when the bot is its author.
import type { CheckReport } from './check.ts';
import type { LockChange } from './lock.ts';
import type { LawResult, ProposalOutcome } from './types.ts';

export interface GithubConfig {
  /** When proposals become accepted laws: on merge (default), or on merge once someone with authority said accept. */
  accept: 'merge' | 'comment';
  /** The branch whose merges write the lock. Default `master`. */
  branch: string;
  /**
   * The login that alone writes tsc-laws.lock and the approval records. Default `github-actions[bot]`, allowed only
   * with `accept: "merge"`: every workflow's token acts as that account, including jobs that run a pull request's
   * code, so it could forge approval records, and only a ruleset on the branch keeps it from writing the lock. A
   * dedicated GitHub App (`<app-slug>[bot]`) is required for `accept: "comment"` and is the stronger choice for both.
   */
  bot: string;
  /**
   * Who may accept in comment mode: `author` (the pull request's author, when a person), `reviewers` (anyone asked to
   * review or who has reviewed), and/or a minimum repository permission (`write`, `maintain`, `admin`). Every login also
   * needs write access to the repository. Default `["author", "reviewers"]`.
   */
  approvers: ('author' | 'reviewers' | 'write' | 'maintain' | 'admin')[];
  /** Comment mode: approve the pull request once every proposal is accepted. Default false. */
  approvePullRequest: boolean;
  /** A proposal that fails (or is open) is never accepted, whatever was said. Default true. */
  requirePassing: boolean;
}

export const githubDefaults: GithubConfig = {
  accept: 'merge',
  branch: 'master',
  bot: 'github-actions[bot]',
  approvers: ['author', 'reviewers'],
  approvePullRequest: false,
  requirePassing: true,
};

const approverKinds = ['author', 'reviewers', 'write', 'maintain', 'admin'] as const;

/** Logins any workflow can act as. */
const sharedBots = new Set(['github-actions[bot]', 'github-actions', 'dependabot[bot]']);

/** Whether the bot is an account any workflow can act as, rather than a dedicated GitHub App. */
export function isSharedBot(config: GithubConfig): boolean {
  return sharedBots.has(config.bot.toLowerCase());
}

/** Validates the `github` section of tslaws.json and fills in the defaults. */
export function parseGithubConfig(raw: unknown): GithubConfig {
  const fail = (message: string): never => {
    throw new Error(`tslaws.json: "github": ${message}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('must be an object');
  const o = raw as Record<string, unknown>;
  const known = ['accept', 'branch', 'bot', 'approvers', 'approvePullRequest', 'requirePassing'];
  for (const key of Object.keys(o))
    if (!known.includes(key)) fail(`unknown option "${key}"; supported: ${known.join(', ')}`);
  if (o.accept !== undefined && o.accept !== 'merge' && o.accept !== 'comment')
    fail(`"accept" must be "merge" or "comment", got ${JSON.stringify(o.accept)}`);
  for (const key of ['branch', 'bot'] as const)
    if (o[key] !== undefined && (typeof o[key] !== 'string' || o[key] === ''))
      fail(`"${key}" must be a non-empty string`);
  if (
    o.approvers !== undefined &&
    (!Array.isArray(o.approvers) ||
      o.approvers.length === 0 ||
      o.approvers.some((a) => !(approverKinds as readonly unknown[]).includes(a)))
  )
    fail(`"approvers" must be a non-empty array of ${approverKinds.join(', ')}`);
  for (const key of ['approvePullRequest', 'requirePassing'] as const)
    if (o[key] !== undefined && typeof o[key] !== 'boolean') fail(`"${key}" must be true or false`);
  const config: GithubConfig = { ...githubDefaults, ...(o as Partial<GithubConfig>) };
  if (config.accept === 'comment' && isSharedBot(config))
    fail(
      `accept "comment" needs "bot" set to a dedicated GitHub App, not ${JSON.stringify(config.bot)}: every workflow token acts as that account, so a pull request could forge approvals`,
    );
  return config;
}

// ---- proposals --------------------------------------------------------------------------------------------------

export interface Proposal {
  key: string;
  file: string;
  name: string;
  line: number;
  kind: LockChange['kind'];
  reason: LockChange['reason'];
  fingerprint: string;
  /** What the law did when it ran; undefined when the check did not report it (it did not run). */
  outcome?: ProposalOutcome;
  passes: boolean;
}

const passingStatuses = new Set(['proved', 'bounded', 'tested']);

/** Joins the lock changes with what the check reported for each. */
export function proposalsOf(changes: LockChange[], report: CheckReport | undefined): Proposal[] {
  const results = new Map<string, LawResult>();
  for (const result of report?.results ?? [])
    results.set(`${result.file.replaceAll('\\', '/')}::${result.name}`, result);
  return changes.map((change) => {
    const sep = change.key.lastIndexOf('::');
    const file = change.key.slice(0, sep);
    const name = change.key.slice(sep + 2);
    const result = results.get(change.key);
    const trivial = change.kind === 'exempt' || change.reason === 'removed';
    const outcome: ProposalOutcome | undefined =
      result?.proposal ??
      (trivial
        ? { reason: change.kind === 'exempt' ? 'exempt' : 'removed', status: 'proved', method: 'lock' }
        : undefined);
    return {
      key: change.key,
      file,
      name,
      line: result?.line ?? 0,
      kind: change.kind,
      reason: change.reason,
      fingerprint: change.fingerprint,
      ...(outcome === undefined ? {} : { outcome }),
      passes: outcome !== undefined && passingStatuses.has(outcome.status),
    };
  });
}

// ---- commands -----------------------------------------------------------------------------------------------------

export type Command = { verb: 'accept' | 'reject'; all: boolean; names: string[] };

/**
 * The `/tslaws accept ...` and `/tslaws reject ...` lines of a comment. Names are law names or `file::name` keys,
 * separated by spaces or commas; a name with spaces is written in backticks or quotes.
 */
export function parseCommands(body: string): Command[] {
  const commands: Command[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('>')) continue; // a quoted command is someone else's
    const match = /^\/tslaws\s+(accept|reject)\b(.*)$/i.exec(line);
    if (match === null) continue;
    const verb = match[1]!.toLowerCase() as Command['verb'];
    const rest = match[2]!.trim();
    const names: string[] = [];
    const token = /`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s,]+)/g;
    for (let m = token.exec(rest); m !== null; m = token.exec(rest)) names.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
    const all = names.length === 0 || names.some((n) => n.toLowerCase() === 'all');
    commands.push({ verb, all, names: all ? [] : names });
  }
  return commands;
}

/** The proposals a command names: by `file::name` key, or by law name when that name is unambiguous. */
export function resolveNames(
  proposals: Proposal[],
  command: Command,
): { matched: Proposal[]; unknown: string[]; ambiguous: string[] } {
  if (command.all) return { matched: proposals, unknown: [], ambiguous: [] };
  const matched = new Map<string, Proposal>();
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const name of command.names) {
    const byKey = proposals.filter((p) => p.key === name);
    const byName = byKey.length > 0 ? byKey : proposals.filter((p) => p.name === name);
    if (byName.length === 0) unknown.push(name);
    else if (byName.length > 1) ambiguous.push(name);
    else matched.set(byName[0]!.fingerprint, byName[0]!);
  }
  return { matched: [...matched.values()], unknown, ambiguous };
}

// ---- approval records -----------------------------------------------------------------------------------------------

export interface ApprovalRecord {
  verb: 'accept' | 'reject';
  by: string;
  /** The head commit the person saw. */
  sha: string;
  /** key and fingerprint of each proposal the record covers. */
  items: { key: string; fingerprint: string }[];
}

const markerStart = '<!-- tslaws-approval ';
const markerEnd = ' -->';
/** The first line of a record comment. A record counts only in a bot comment made of this line and markers alone. */
export const recordHeader = '<!-- tslaws-records -->';

export function approvalMarker(record: ApprovalRecord): string {
  // Keys come from the pull request. Escape every character that could end the HTML comment or open another one, so
  // the JSON can never close the marker early.
  const json = JSON.stringify(record).replace(/[<>&-]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${markerStart}${json}${markerEnd}`;
}

/** The body of a record comment: the header line, then one marker per line. Nothing from the pull request appears raw. */
export function recordComment(records: ApprovalRecord[]): string {
  return [recordHeader, ...records.map(approvalMarker)].join('\n');
}

/** Text from a pull request (law names, file paths, unknown words), made inert in a markdown comment. */
export function inert(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '@​');
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; type?: string };
  created_at: string;
}

/**
 * The approval records in record comments the bot wrote, oldest first. A comment counts only if it is the header line
 * followed by markers and nothing else. Records in anyone else's comment, or in a bot comment that also holds other
 * text (such as text a pull request put there), are ignored.
 */
export function readApprovals(comments: IssueComment[], bot: string): ApprovalRecord[] {
  const records: ApprovalRecord[] = [];
  const sorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  for (const comment of sorted) {
    if (comment.user.login !== bot) continue;
    const lines = comment.body.replace(/\r\n/g, '\n').trimEnd().split('\n');
    if (lines[0] !== recordHeader || lines.length < 2) continue;
    const found: ApprovalRecord[] = [];
    for (const line of lines.slice(1)) {
      if (!line.startsWith(markerStart) || !line.endsWith(markerEnd)) break;
      const json = line.slice(markerStart.length, -markerEnd.length);
      if (/[<>]|--/.test(json)) break;
      try {
        const record = JSON.parse(json) as ApprovalRecord;
        if (
          (record.verb === 'accept' || record.verb === 'reject') &&
          typeof record.by === 'string' &&
          Array.isArray(record.items) &&
          record.items.every((i) => typeof i?.key === 'string' && typeof i?.fingerprint === 'string')
        )
          found.push(record);
        else break;
      } catch {
        break;
      }
    }
    if (found.length === lines.length - 1) records.push(...found);
  }
  return records;
}

/**
 * The fingerprints accepted by the records, latest word wins: a later reject withdraws an earlier accept of the same
 * fingerprint. A fingerprint names one version of a law, so an edit after the accept leaves the new version unaccepted.
 */
export function acceptedFingerprints(records: ApprovalRecord[]): Map<string, string> {
  const accepted = new Map<string, string>();
  for (const record of records)
    for (const item of record.items) {
      if (record.verb === 'accept') accepted.set(item.fingerprint, record.by);
      else accepted.delete(item.fingerprint);
    }
  return accepted;
}

// ---- decisions ------------------------------------------------------------------------------------------------------

export interface Decision {
  /** Fingerprints to write to the lock. */
  accept: Set<string>;
  /** Proposals left as they are, with the reason. */
  held: { proposal: Proposal; why: string }[];
}

/** Which proposals the merge job accepts. */
export function decide(proposals: Proposal[], config: GithubConfig, approvals: Map<string, string>): Decision {
  const accept = new Set<string>();
  const held: Decision['held'] = [];
  for (const proposal of proposals) {
    if (config.requirePassing && !proposal.passes) {
      held.push({ proposal, why: proposal.outcome === undefined ? 'did not run' : `is ${proposal.outcome.status}` });
      continue;
    }
    if (config.accept === 'comment' && !approvals.has(proposal.fingerprint)) {
      held.push({ proposal, why: 'nobody with authority accepted this version' });
      continue;
    }
    accept.add(proposal.fingerprint);
  }
  return { accept, held };
}

/**
 * The pull request's verdict: it fails when a law that is already accepted fails, when a proposal fails (a failing
 * proposal is rejected outright), or in comment mode while a proposal waits for an accept.
 */
export function pullRequestVerdict(
  report: CheckReport,
  proposals: Proposal[],
  config: GithubConfig,
  approvals: Map<string, string>,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!report.compileOk) problems.push('the project does not compile');
  const proposed = new Set(proposals.map((p) => p.key));
  for (const result of report.results) {
    const key = `${result.file.replaceAll('\\', '/')}::${result.name}`;
    if (passingStatuses.has(result.status) || (result.status === 'tampered' && proposed.has(key))) continue;
    problems.push(
      `${result.status} ${inert(result.name)} (${inert(result.file)}:${result.line})${result.message ? `: ${inert(result.message)}` : ''}`,
    );
  }
  for (const p of proposals) {
    if (!p.passes)
      problems.push(
        `proposal ${inert(p.name)} (${inert(p.file)}) ${p.outcome === undefined ? 'did not run' : `is ${p.outcome.status}`}`,
      );
    else if (config.accept === 'comment' && !approvals.has(p.fingerprint))
      problems.push(`proposal ${inert(p.name)} (${inert(p.file)}) waits for \`/tslaws accept\``);
  }
  return { ok: problems.length === 0, problems };
}

// ---- rendering ------------------------------------------------------------------------------------------------------

export const stickyMarker = '<!-- tslaws-proposals -->';

const cell = (text: string): string => inert(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function outcomeText(p: Proposal): string {
  if (p.outcome === undefined) return '⚠️ did not run';
  const icon = p.passes ? '✅' : '❌';
  const extra = [
    p.outcome.counterexample && `counterexample \`${p.outcome.counterexample}\``,
    !p.passes && p.outcome.message,
  ]
    .filter(Boolean)
    .join('; ');
  return `${icon} ${p.outcome.status}${extra === '' ? '' : ` — ${extra}`}`;
}

const what = (p: Proposal): string =>
  p.kind === 'exempt' ? `exemption ${p.reason}` : p.reason === 'level' ? 'level changed' : `law ${p.reason}`;

/** The sticky pull request comment: every proposal, what it did, and whether it will be accepted on merge. */
export function renderSticky(
  proposals: Proposal[],
  config: GithubConfig,
  approvals: Map<string, string>,
  link: (p: Proposal) => string,
): string {
  const head = `${stickyMarker}\n### tslaws proposals\n\n`;
  if (proposals.length === 0) return `${head}No law, level or coverage exemption differs from \`tsc-laws.lock\`.\n`;
  const rows = proposals.map((p) => {
    const state =
      !p.passes && config.requirePassing
        ? '🚫 rejected while it fails'
        : config.accept === 'merge'
          ? '⏳ accepted on merge'
          : approvals.has(p.fingerprint)
            ? `👍 accepted by @${approvals.get(p.fingerprint)} (on merge)`
            : '✋ waiting for `/tslaws accept`';
    return `| ${cell(link(p))} | ${what(p)} | ${cell(outcomeText(p))} | ${state} |`;
  });
  const how =
    config.accept === 'merge'
      ? `Proposals that pass are written to \`tsc-laws.lock\` by the tslaws workflow when this pull request merges into \`${config.branch}\`. Failing proposals are never accepted.`
      : `Reply \`/tslaws accept <law>\` (or \`/tslaws accept all\`) to accept, \`/tslaws reject <law>\` to withdraw. An accept covers the version shown here; a later edit needs a new accept. Accepted proposals are written to \`tsc-laws.lock\` when this pull request merges into \`${config.branch}\`.`;
  return `${head}| Law | Change | If accepted | State |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n${how}\n`;
}
