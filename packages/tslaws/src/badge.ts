// `tslaws badge`: the two shields.io endpoint badges of a project, "laws: N proved" and "certificates: N verified", as
// JSON files to commit, and the markdown that shows them. An endpoint badge reads its JSON from a URL, so a file in the
// repository served by raw.githubusercontent.com is enough: no GitHub Pages. See docs/certificates.md, "Badges".
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isCertified, lawKey } from './lock.ts';
import type { Lock } from './lock.ts';
import type { LawResult } from './types.ts';

/** The shields.io endpoint schema: https://shields.io/badges/endpoint-badge */
export interface Endpoint {
  schemaVersion: 1;
  label: string;
  message: string;
  color: 'brightgreen' | 'yellow';
}

/** What a badge counts of one law. */
export interface Standing {
  /** Z3 proved it (`proved`; a law that is only `bounded` or `tested` is not counted). */
  proved: boolean;
  /** A checker accepted a proof of it. */
  certified: boolean;
}

export interface Badges {
  laws: Endpoint;
  certificates: Endpoint;
}

/** The files `tslaws badge` writes, and the repository's own gallery keeps beside its certificates. */
export const badgeFiles = { laws: 'badge-laws.json', certificates: 'badge-certificates.json' } as const;

function endpoint(label: string, count: number, total: number, verb: string): Endpoint {
  const all = total > 0 && count === total;
  return {
    schemaVersion: 1,
    label,
    message: all ? `${count} ${verb}` : `${count} of ${total} ${verb}`,
    color: all ? 'brightgreen' : 'yellow',
  };
}

/** Green when every law is proved (or certified), yellow otherwise, and for a project with no laws. */
export function badgesOf(laws: readonly Standing[]): Badges {
  return {
    laws: endpoint('laws', laws.filter((law) => law.proved).length, laws.length, 'proved'),
    certificates: endpoint('certificates', laws.filter((law) => law.certified).length, laws.length, 'verified'),
  };
}

/**
 * The standing of each law of a check. A law is certified when this run checked a proof of it, or when the lock records
 * a certificate that is still for the law (`tslaws accept` verified it with Carcara before writing it).
 */
export function standingsOf(results: readonly LawResult[], lock?: Lock): Standing[] {
  return results.map((result) => ({
    proved: result.status === 'proved',
    certified: result.certificate?.status === 'certified' || isCertified(lock, lawKey(result.file, result.name)),
  }));
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
  /** Where both badges link; by default the project's lock, which records its certificates. */
  link?: string;
}

/** The markdown of both badges, ready to paste into a README. */
export function badgeMarkdown(options: MarkdownOptions): string {
  const repo = options.repo ?? 'OWNER/REPO';
  const dir = options.dir === '' || options.dir === '.' ? '' : `${options.dir.replace(/\/$/, '')}/`;
  const raw = (file: string): string =>
    `https://img.shields.io/endpoint?url=${encodeURIComponent(`https://raw.githubusercontent.com/${repo}/${options.branch}/${dir}${file}`)}`;
  const link = options.link ?? `https://github.com/${repo}/blob/${options.branch}/tsc-laws.lock`;
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
