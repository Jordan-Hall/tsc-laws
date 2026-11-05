// A person's time-limited delegation of `tslaws accept` to an agent. The grant lives in the person's home
// directory, outside every project, so nothing an agent can edit in a repository can create one.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';

export interface Grant {
  root: string;
  expires: string;
  note?: string;
}

export const defaultDuration = '8h';
const hour = 3_600_000;
const durations: Record<string, number> = { '1h': hour, '8h': 8 * hour, '1d': 24 * hour, '7d': 168 * hour };

const regrant = 'run `tslaws delegate grant` at a terminal to lend accept for a limited time';

/**
 * The person's home directory from the operating system's user record (getpwuid on POSIX, the profile directory of the
 * user token on Windows). HOME and USERPROFILE are ignored on purpose. An empty string means it cannot be found.
 */
export function userHome(): string {
  try {
    return userInfo().homedir;
  } catch {
    return '';
  }
}

/** The grants file under a home directory: the real one by default, a temp directory in unit tests. */
export function delegationFile(home: string = userHome()): string {
  return join(home, '.tslaws', 'delegation.json');
}

export function parseDuration(text: string): number | undefined {
  return Object.hasOwn(durations, text) ? durations[text] : undefined;
}

/** The real path of a directory; undefined when it is missing. */
export function realRoot(dir: string): string | undefined {
  try {
    return realpathSync.native(resolve(dir));
  } catch {
    return undefined;
  }
}

function same(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The grants directory must resolve inside the real home directory, not through a symlink elsewhere. */
function grantsDirProblem(home: string): string | undefined {
  if (home === '') return 'the home directory is unknown (the user database gave none)';
  const dir = join(home, '.tslaws');
  if (!existsSync(dir)) return undefined;
  const base = realRoot(home);
  const real = realRoot(dir);
  if (base === undefined || real === undefined) return `${dir} cannot be resolved`;
  const inside = real.length > base.length && same(real.slice(0, base.length), base) && real[base.length] === sep;
  return inside ? undefined : `${dir} resolves outside the home directory (${real})`;
}

/** A home directory that is the project root, or inside it, is project-controlled and never a trust root. */
function homeInsideRoot(home: string, root: string): string | undefined {
  const h = home === '' ? undefined : realRoot(home);
  if (h === undefined) return undefined;
  const inside =
    same(h, root) || (h.length > root.length && same(h.slice(0, root.length), root) && h[root.length] === sep);
  return inside ? `the home directory ${h} is inside the project root` : undefined;
}

export type Grants = { ok: true; grants: Grant[] } | { ok: false; reason: string };

function isGrant(value: unknown): value is Grant {
  if (typeof value !== 'object' || value === null) return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.root === 'string' &&
    typeof g.expires === 'string' &&
    Number.isFinite(Date.parse(g.expires)) &&
    (g.note === undefined || typeof g.note === 'string')
  );
}

/** Reads the grants. A missing file is an empty list; an unsafe or malformed one is an error. */
export function readGrants(home: string = userHome()): Grants {
  const file = delegationFile(home);
  const place = grantsDirProblem(home);
  if (place !== undefined) return { ok: false, reason: place };
  if (!existsSync(file)) return { ok: true, grants: [] };
  try {
    const info = statSync(file);
    if (process.platform !== 'win32') {
      if ((info.mode & 0o022) !== 0)
        return { ok: false, reason: `${file} is writable by its group or others; run chmod 600 on it` };
      if (typeof process.getuid === 'function' && info.uid !== process.getuid())
        return { ok: false, reason: `${file} is owned by another user` };
    }
    const data = JSON.parse(readFileSync(file, 'utf8')) as { grants?: unknown };
    if (!Array.isArray(data.grants) || !data.grants.every(isGrant))
      return { ok: false, reason: `${file} is malformed` };
    return { ok: true, grants: data.grants };
  } catch {
    return { ok: false, reason: `${file} cannot be read as delegation JSON` };
  }
}

function writeGrants(grants: Grant[], home: string): string | undefined {
  const file = delegationFile(home);
  const unknown = grantsDirProblem(home);
  if (unknown !== undefined) return unknown;
  mkdirSync(join(home, '.tslaws'), { recursive: true, mode: 0o700 });
  const place = grantsDirProblem(home);
  if (place !== undefined) return place;
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ grants }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return undefined;
}

export type Verdict = { ok: true; grant: Grant } | { ok: false; reason: string };

/** The live grant for a project root. Real paths are compared, and a grant naming a symlink never matches. */
export function findGrant(root: string, now: Date, home: string = userHome()): Verdict {
  const real = realRoot(root);
  if (real === undefined) return { ok: false, reason: 'the project root does not exist' };
  const inside = homeInsideRoot(home, real);
  if (inside !== undefined) return { ok: false, reason: inside };
  const read = readGrants(home);
  if (!read.ok) return { ok: false, reason: read.reason };
  const named = read.grants.filter((g) => same(g.root, real) && realRoot(g.root) !== undefined);
  if (named.length === 0) return { ok: false, reason: 'no delegation covers this project' };
  const live = named
    .filter((g) => Date.parse(g.expires) > now.getTime())
    .sort((a, b) => Date.parse(b.expires) - Date.parse(a.expires))[0];
  return live === undefined ? { ok: false, reason: 'the delegation has expired' } : { ok: true, grant: live };
}

export interface GateInput {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  root: string;
  now?: Date;
  /** Home directory holding the grants; unit tests pass a temp directory. */
  home?: string;
}

export type Gate =
  | { ok: true; delegated: false }
  | { ok: true; delegated: true; grant: Grant }
  | { ok: false; message: string };

/** Decides whether `accept` may run: a person at a terminal, else a live grant. CI never. */
export function acceptGate(input: GateInput): Gate {
  const { env } = input;
  if (env.CI !== undefined)
    return { ok: false, message: 'accept records laws as correct and never runs under CI, even with a delegation' };
  if (input.isTTY && env.TSLAWS_AGENT === undefined) return { ok: true, delegated: false };
  const verdict = findGrant(input.root, input.now ?? new Date(), input.home);
  if (verdict.ok) return { ok: true, delegated: true, grant: verdict.grant };
  return {
    ok: false,
    message: `accept records laws as correct and needs a person at a terminal or a live delegation (${verdict.reason}); ${regrant}`,
  };
}

/** The gate for acts only a person may do: a terminal, no agent marker, no CI. */
export function personOnly(input: { isTTY: boolean; env: NodeJS.ProcessEnv }): boolean {
  return input.isTTY && input.env.TSLAWS_AGENT === undefined && input.env.CI === undefined;
}

/** Records a grant for a project; returns it, or the reason it was refused. */
export function grantFor(root: string, ms: number, now: Date, home: string = userHome()): Grant | string {
  const real = realRoot(root);
  if (real === undefined) return `${root} does not exist`;
  if (!same(resolve(root), real)) return `${root} is a symlink to ${real}; name the real directory`;
  const inside = homeInsideRoot(home, real);
  if (inside !== undefined) return inside;
  const read = readGrants(home);
  if (!read.ok) return read.reason;
  const grant: Grant = { root: real, expires: new Date(now.getTime() + ms).toISOString() };
  const problem = writeGrants([...read.grants.filter((g) => !same(g.root, real)), grant], home);
  return problem ?? grant;
}

/** Removes the grants for a project; returns how many, or the reason it was refused. */
export function revokeFor(root: string, home: string = userHome()): number | string {
  const real = realRoot(root);
  if (real === undefined) return `${root} does not exist`;
  const read = readGrants(home);
  if (!read.ok) return read.reason;
  const kept = read.grants.filter((g) => !same(g.root, real));
  if (kept.length !== read.grants.length) {
    const problem = writeGrants(kept, home);
    if (problem !== undefined) return problem;
  }
  return read.grants.length - kept.length;
}

export function describeGrants(now: Date, home: string = userHome()): string[] {
  const read = readGrants(home);
  if (!read.ok) return [`delegation unusable: ${read.reason}`];
  if (read.grants.length === 0) return ['no delegations'];
  return read.grants.map(
    (g) =>
      `${Date.parse(g.expires) > now.getTime() ? 'live' : 'expired'} ${g.root} until ${g.expires}${g.note ? ` (${g.note})` : ''}`,
  );
}

export function fileHash(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'none';
}

/** Appends the audit line for a delegated accept to `<project>/.tslaws/accept.log`. */
export function logDelegatedAccept(root: string, grant: Grant, before: string, after: string, now: Date): void {
  const dir = join(root, '.tslaws');
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, 'accept.log'),
    `${now.toISOString()} delegated expires=${grant.expires} lock-before=${before} lock-after=${after}\n`,
  );
}
