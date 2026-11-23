// `tslaws badge`: the two shields.io endpoint badges of a project, "laws: 7 proved · 1 tested" and "certificates: 7
// certified · 1 not certifiable", as JSON files to commit, and the markdown that shows them. An endpoint badge reads its
// JSON from a URL, so a file in the repository served by raw.githubusercontent.com is enough: no GitHub Pages. See
// docs/certificates.md, "Badges".
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { certificateName, certificatesDir, noCertificate } from './certificates.ts';
import type { Certificate } from './certificates.ts';
import { isCertified, lawKey } from './lock.ts';
import type { Lock } from './lock.ts';
import type { LawResult, LawStatus } from './types.ts';

/** The shields.io endpoint schema: https://shields.io/badges/endpoint-badge */
export interface Endpoint {
  schemaVersion: 1;
  label: string;
  message: string;
  color: 'brightgreen' | 'yellow' | 'red';
}

/** What a check concluded of a law. `tampered`, `uncovered` and `error` are failures of the check and count as `failed`. */
export type Outcome = 'proved' | 'bounded' | 'tested' | 'open' | 'failed';

/**
 * Where a law stands with a certificate (a proof that a separate checker accepted).
 * - `certified`: a checker accepted a proof of it.
 * - `not-certifiable`: the proof format cannot check it. The law uses floating point or strings, which Alethe cannot
 *   express, or it was only tested or checked within a bound, so there is no proof to certify.
 * - `not-certified`: a proof could be certified, but none was (certificates were off, or a tool was missing).
 * - `rejected`: a certificate was tried and did not pass (cvc5 gave no proof, Carcara did not accept it, a timeout).
 */
export type Certification = 'certified' | 'not-certifiable' | 'not-certified' | 'rejected';

/** What a badge or the certificates page reports of one law. */
export interface Standing {
  outcome: Outcome;
  certification: Certification;
  /** For `not-certifiable`, `not-certified` and `rejected`: why, in the words of tslaws or of the tool. */
  reason?: string;
  /** For a tested or bounded law: how many random inputs ran. */
  runs?: number;
  /** For a tested, bounded or open law: what the prover said. */
  note?: string;
}

export interface Badges {
  laws: Endpoint;
  certificates: Endpoint;
}

/** The files `tslaws badge` writes, and the repository's own gallery keeps beside its certificates. */
export const badgeFiles = { laws: 'badge-laws.json', certificates: 'badge-certificates.json' } as const;

/** The reasons `uncertifiable` (certificates.ts) gives for floating point and strings both end "which Alethe proofs do not cover". */
const outsideAlethe = /Alethe proofs do not cover/;

function outcomeOf(status: LawStatus): Outcome {
  return status === 'proved' || status === 'bounded' || status === 'tested' || status === 'open' ? status : 'failed';
}

/** What a check shows of a law: its status, the certificate of its proof if there is one, and whether the lock vouches for it. */
export interface LawFacts {
  status: LawStatus;
  certificate?: Pick<Certificate, 'status' | 'reason'>;
  /** The lock records a certificate that is still for the law. */
  certified?: boolean;
  runs?: number;
  message?: string;
}

/** The standing of a law. Only a `proved` law is certifiable: a tested, bounded or open one has no proof to check. */
export function standingOf(law: LawFacts): Standing {
  const outcome = outcomeOf(law.status);
  const detail = {
    ...(law.runs === undefined ? {} : { runs: law.runs }),
    ...(law.message === undefined ? {} : { note: law.message }),
  };
  const { certificate } = law;
  if (law.certified === true || certificate?.status === 'certified')
    return { outcome, certification: 'certified', ...detail };
  if (outcome !== 'proved') return { outcome, certification: 'not-certifiable', ...detail };
  const reason = certificate?.reason === undefined ? {} : { reason: certificate.reason };
  if (
    certificate?.status === 'uncertified' &&
    certificate.reason !== undefined &&
    outsideAlethe.test(certificate.reason)
  )
    return { outcome, certification: 'not-certifiable', ...reason, ...detail };
  if (certificate?.status === 'uncertified' && certificate.reason !== noCertificate.reason)
    return { outcome, certification: 'rejected', ...reason, ...detail };
  return { outcome, certification: 'not-certified', ...reason, ...detail };
}

/** `3 proved · 1 tested`: the non-zero counts in order, or `no laws`. */
function breakdown(counts: readonly (readonly [number, string])[]): string {
  const parts = counts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`);
  return parts.length === 0 ? 'no laws' : parts.join(' · ');
}

/**
 * The two badges as a breakdown, never "N of M".
 *
 * Laws, such as `7 proved · 1 tested`: red when a law failed, yellow when one is open or there are no laws, else green.
 *
 * Certificates, such as `7 certified · 1 not certifiable`: red when a law failed. Yellow when a law that could be
 * certified has no certificate, or its certificate was rejected. Green otherwise: a law that cannot be certified does not
 * count against the project.
 */
export function badgesOf(laws: readonly Standing[]): Badges {
  const outcomes = (outcome: Outcome): number => laws.filter((law) => law.outcome === outcome).length;
  const certifications = (wanted: Certification): number =>
    laws.filter((law) => law.outcome !== 'failed' && law.certification === wanted).length;
  const failed = outcomes('failed');
  const open = outcomes('open');
  const missing = certifications('not-certified');
  const rejected = certifications('rejected');
  return {
    laws: {
      schemaVersion: 1,
      label: 'laws',
      message: breakdown([
        [outcomes('proved'), 'proved'],
        [outcomes('bounded'), 'bounded'],
        [outcomes('tested'), 'tested'],
        [open, 'open'],
        [failed, 'failed'],
      ]),
      color: failed > 0 ? 'red' : open > 0 || laws.length === 0 ? 'yellow' : 'brightgreen',
    },
    certificates: {
      schemaVersion: 1,
      label: 'certificates',
      message: breakdown([
        [certifications('certified'), 'certified'],
        [certifications('not-certifiable'), 'not certifiable'],
        [missing, 'not certified'],
        [rejected, 'certificate failed'],
        [failed, 'failed'],
      ]),
      color: failed > 0 ? 'red' : missing + rejected > 0 || laws.length === 0 ? 'yellow' : 'brightgreen',
    },
  };
}

/**
 * The standing of each law of a check. A law is certified when this run checked a proof of it, or when the lock records
 * a certificate that is still for the law (`tslaws accept` verified it with Carcara before writing it).
 */
export function standingsOf(results: readonly LawResult[], lock?: Lock): Standing[] {
  return results.map((result) =>
    standingOf({
      status: result.status,
      certificate: result.certificate,
      certified: isCertified(lock, lawKey(result.file, result.name)),
      runs: result.runs,
      message: result.message,
    }),
  );
}

const firstLine = (text: string): string => text.split('\n')[0]!.trim();

/** A reason a law cannot be certified, in plain words. Other reasons (a tool's own message) are shown as they are. */
export function plainReason(reason: string): string {
  const needsNumbers = 'the proof checker only handles whole numbers and true/false logic today.';
  if (/floating-point/.test(reason))
    return `uses decimal (floating-point) numbers; ${needsNumbers} Use \`int\` or \`bigint\` to get a certificate.`;
  if (/strings/.test(reason)) return `uses text (strings); ${needsNumbers}`;
  return reason;
}

/** The status of a law in a table, in words that need no knowledge of solvers. */
export function statusWords(standing: Standing): string {
  const base = {
    proved: 'Proved',
    bounded: 'Proved within a bound',
    tested: 'Tested, not proved',
    open: 'Not resolved',
    failed: 'Failed',
  }[standing.outcome];
  if (standing.certification === 'certified') return `${base}, independently checked`;
  if (standing.outcome !== 'proved') return base;
  return {
    'not-certifiable': `${base}, can't be certified`,
    'not-certified': `${base}, not yet checked`,
    rejected: `${base}, the check failed`,
    certified: base,
  }[standing.certification];
}

/** The section that opens a certificates page. */
export const whatIsACertificate: readonly string[] = [
  '## What is a certificate?',
  '',
  "tslaws proves a law with a solver. A certificate is the solver's proof written to a file, and a separate, independent checker ([Carcara](https://github.com/ufmg-smite/carcara)) re-checks every step of it. You don't have to trust tslaws or the solver: anyone can re-run the check. A law can only get a certificate if the proof format can express it. Today that means whole numbers and true/false logic, so a law about decimal numbers is proved but has no certificate.",
  '',
];

interface Group {
  title: string;
  intro: string;
  /** Shown even when empty, as "None.". */
  always: boolean;
  has: (standing: Standing) => boolean;
  line: (name: string, standing: Standing) => string;
}

const groups: readonly Group[] = [
  {
    title: 'Proved and independently checked',
    intro: 'A solver proved each of these laws, and Carcara re-checked every step of its proof.',
    always: true,
    has: (s) => s.certification === 'certified',
    line: (name) => `- **${name}**`,
  },
  {
    title: "Proved, but the proof can't be checked independently yet",
    intro:
      'A solver proved each of these laws, but no certificate that the checker accepted is on record. Run `tslaws check --certify` with cvc5 and Carcara installed to make them.',
    always: true,
    has: (s) => s.outcome === 'proved' && (s.certification === 'not-certified' || s.certification === 'rejected'),
    line: (name, s) =>
      `- **${name}**${s.reason === undefined ? '' : `: ${s.certification === 'rejected' ? `the check did not pass (${s.reason})` : s.reason}`}`,
  },
  {
    title: 'Tested, not proved',
    intro:
      'These laws were run on random inputs. Passing is evidence, not a proof that they hold for every input, so there is nothing to certify.',
    always: true,
    has: (s) => s.outcome === 'tested' && s.certification !== 'certified',
    line: (name, s) =>
      `- **${name}**: ${s.runs === undefined ? 'run on random inputs' : `run on ${s.runs} random inputs`} without finding a counterexample${s.note === undefined ? '' : `. The prover said: ${firstLine(s.note)}`}`,
  },
  {
    title: "Can't be certified, and why",
    intro: 'These laws are proved, but the proof format cannot express them, so the checker has nothing to check.',
    always: true,
    has: (s) => s.outcome === 'proved' && s.certification === 'not-certifiable',
    line: (name, s) => `- **${name}**: ${plainReason(s.reason ?? 'the proof format cannot express it')}`,
  },
  {
    title: 'Proved only within a bound',
    intro:
      'These laws hold for every input up to a bound (array length, loop passes, a range of numbers), not for all inputs.',
    always: false,
    has: (s) => s.outcome === 'bounded' && s.certification !== 'certified',
    line: (name, s) => `- **${name}**${s.note === undefined ? '' : `: ${firstLine(s.note)}`}`,
  },
  {
    title: 'Not resolved',
    intro:
      'The prover could not settle these laws and they are marked `proved`, so the check fails until they are fixed.',
    always: false,
    has: (s) => s.outcome === 'open',
    line: (name, s) => `- **${name}**${s.note === undefined ? '' : `: ${firstLine(s.note)}`}`,
  },
  {
    title: 'Failed',
    intro: 'These laws failed their check.',
    always: false,
    has: (s) => s.outcome === 'failed',
    line: (name) => `- **${name}**`,
  },
];

/** The summary of a certificates page: the laws grouped by what they can and cannot do. Deterministic for a given input. */
export function certificateSummary(laws: readonly { name: string; standing: Standing }[]): string[] {
  const out = ['## Summary', ''];
  for (const group of groups) {
    const members = laws.filter((law) => group.has(law.standing));
    if (members.length === 0 && !group.always) continue;
    out.push(`### ${group.title} (${members.length})`, '', group.intro, '');
    out.push(...(members.length === 0 ? ['None.'] : members.map((law) => group.line(law.name, law.standing))), '');
  }
  return out;
}

/** The text of the two files, one JSON object each. */
export function badgeTexts(badges: Badges): Record<string, string> {
  return {
    [badgeFiles.laws]: `${JSON.stringify(badges.laws, null, 2)}\n`,
    [badgeFiles.certificates]: `${JSON.stringify(badges.certificates, null, 2)}\n`,
  };
}

/** Writes the two files into `dir` (made if missing) and returns their paths. */
export function writeBadges(dir: string, badges: Badges): string[] {
  mkdirSync(dir, { recursive: true });
  return Object.entries(badgeTexts(badges)).map(([name, text]) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  });
}

/** `owner/name` of a GitHub remote URL (https, ssh or scp-style), or undefined for any other host. */
export function githubRepoOf(url: string): string | undefined {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

/** The repository's GitHub name and top directory, from git; undefined parts when there is no repository or remote. */
export function gitFacts(cwd: string): { repo?: string; top?: string } {
  const git = (...args: string[]): string | undefined => {
    const ran = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return ran.status === 0 ? ran.stdout.trim() : undefined;
  };
  const remote = git('remote', 'get-url', 'origin');
  const top = git('rev-parse', '--show-toplevel');
  return { repo: remote === undefined ? undefined : githubRepoOf(remote), top };
}

export interface MarkdownOptions {
  /** `owner/name`; the markdown names `OWNER/REPO` when it is not known. */
  repo?: string;
  branch: string;
  /** The directory of the two files, relative to the repository root, with `/` separators. */
  dir: string;
  /** Where both badges link; by default the certificates page in `dir` when `page` is set, else the project's lock. */
  link?: string;
  /** Whether `dir` holds a certificates page (see `writeCertificatesPage`). */
  page?: boolean;
}

/** The markdown of both badges, ready to paste into a README. */
export function badgeMarkdown(options: MarkdownOptions): string {
  const repo = options.repo ?? 'OWNER/REPO';
  const dir = options.dir === '' || options.dir === '.' ? '' : `${options.dir.replace(/\/$/, '')}/`;
  const raw = (file: string): string =>
    `https://img.shields.io/endpoint?url=${encodeURIComponent(`https://raw.githubusercontent.com/${repo}/${options.branch}/${dir}${file}`)}`;
  const link =
    options.link ??
    `https://github.com/${repo}/blob/${options.branch}/${options.page === true ? `${dir}README.md` : 'tsc-laws.lock'}`;
  return [
    `[![tslaws](${raw(badgeFiles.laws)})](${link})`,
    `[![certificates](${raw(badgeFiles.certificates)})](${link})`,
  ].join('\n');
}

/** `dir` as the repository root sees it (`/` separators), or as given when there is no repository. */
export function repoRelative(cwd: string, dir: string, top: string | undefined): string {
  const absolute = resolve(cwd, dir);
  return relative(top ?? cwd, absolute).replaceAll('\\', '/');
}

/** The files a certified law leaves in `.tslaws/certificates`: its problem and proof, and for a loop the clauses and invariants. */
const proofExtensions = ['smt2', 'alethe', 'horn', 'inv'] as const;

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

/**
 * The certificates page of `tslaws badge`: what a certificate is, the laws grouped by what they can and cannot do, and
 * every law with its status and, for a certified one, its proof files. They are copied from `.tslaws/certificates` into
 * `certificates/` beside the page, so the page links files the repository holds. Writes nothing and returns false when no
 * law is certified.
 */
export function writeCertificatesPage(cwd: string, dir: string, results: readonly LawResult[], lock?: Lock): boolean {
  const standings = standingsOf(results, lock);
  if (!standings.some((standing) => standing.certification === 'certified')) return false;
  const saved = certificatesDir(cwd);
  const rows = results.map((result, index) => {
    const standing = standings[index]!;
    const certified = standing.certification === 'certified';
    const name = certificateName(lawKey(result.file, result.name));
    const present = proofExtensions.filter((ext) => existsSync(join(saved, `${name}.${ext}`)));
    if (certified && present.length > 0) mkdirSync(join(dir, 'certificates'), { recursive: true });
    for (const ext of certified ? present : [])
      copyFileSync(join(saved, `${name}.${ext}`), join(dir, 'certificates', `${name}.${ext}`));
    const files = certified && present.length > 0 ? present.map((ext) => `[${ext}](certificates/${name}.${ext})`) : [];
    return `| ${cell(result.name)} | ${cell(`${result.file}:${result.line}`)} | ${statusWords(standing)} | ${files.length === 0 ? '-' : files.join(', ')} |`;
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'README.md'),
    [
      '# Certificates',
      '',
      ...whatIsACertificate,
      ...certificateSummary(results.map((result, index) => ({ name: result.name, standing: standings[index]! }))),
      '## Technical details',
      '',
      'For a certified law, cvc5 wrote an [Alethe](https://verit.loria.fr/documentation/alethe-spec.pdf) proof of its SMT-LIB problem and Carcara accepted it. A law the lock records a certificate for counts as certified, and its proof files are listed when this run saved them. Generated by `tslaws badge`; do not edit it by hand.',
      '',
      '| Law | Source | Status | Proof files |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
    ].join('\n'),
  );
  return true;
}
