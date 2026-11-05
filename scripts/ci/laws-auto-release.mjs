// Decides and prepares an automatic tslaws release. Used by .github/workflows/laws-auto-release.yml.
//
//   node scripts/ci/laws-auto-release.mjs plan
//       Reads the commits since the latest `laws-v*` tag and writes `release`, `version`, `tag` and `reason` to
//       $GITHUB_OUTPUT (and stdout). Never changes the tree.
//   node scripts/ci/laws-auto-release.mjs apply <version>
//       Sets <version> in packages/tslaws and packages/vscode-tslaws (and the lockfile entries) and adds the section
//       for it to CHANGELOG-LAWS.md.
//
// The decision logic is in pure functions, tested by laws-auto-release.test.mjs.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RELEASE_SUBJECT = /^chore\(release\):/;
export const SKIP_MARKER = /\[skip release\]/i;

const CODE_PREFIXES = ['packages/tslaws/', 'packages/tsc-ts/', 'packages/vscode-tslaws/', 'scripts/'];
const CODE_FILES = new Set(['upstream.json', 'package.json', 'package-lock.json', '.github/workflows/laws.yml']);

/** True when a changed path is prose, not code. Checked before the code list, so a README inside a package is not code. */
export function isProse(path) {
  const p = path.replaceAll('\\', '/');
  const name = p.split('/').pop();
  return (
    /\.md$/i.test(p) ||
    p.startsWith('docs/') ||
    p.startsWith('examples/') ||
    name === 'LICENSE' ||
    /^CHANGELOG/i.test(name)
  );
}

/** True when a changed path is code that ships in a release. */
export function isCode(path) {
  const p = path.replaceAll('\\', '/');
  if (isProse(p)) return false;
  return CODE_FILES.has(p) || CODE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export function hasCodeChange(paths) {
  return paths.some(isCode);
}

/** The reason not to release for the head commit, or undefined. */
export function skipReason(head) {
  if (RELEASE_SUBJECT.test(head.subject)) return 'the head commit is a release commit';
  if (SKIP_MARKER.test(`${head.subject}\n${head.body ?? ''}`)) return 'the head commit says [skip release]';
  return undefined;
}

const BREAKING_SUBJECT = /^\w+(\([^)]*\))?!:/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

/** 'major', 'minor' or 'patch' from commits shaped { subject, body }. */
export function chooseBump(commits) {
  if (commits.some((c) => BREAKING_SUBJECT.test(c.subject) || BREAKING_FOOTER.test(c.body ?? ''))) return 'major';
  if (commits.some((c) => /^feat(\([^)]*\))?!?:/.test(c.subject))) return 'minor';
  return 'patch';
}

export function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`not a plain x.y.z version: ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The changelog section for a release, from commit subjects (release commits are left out). */
export function renderSection(version, commits) {
  const lines = commits
    .map((c) => c.subject.trim())
    .filter((s) => s && !RELEASE_SUBJECT.test(s))
    .map((s) => `- ${s}`);
  return `## ${version}\n\n${lines.length ? lines.join('\n') : '- Maintenance release.'}\n`;
}

/** Puts a section before the newest existing `## ` heading. */
export function insertSection(changelog, section) {
  const at = changelog.search(/^## /m);
  if (at === -1) return `${changelog.trimEnd()}\n\n${section}`;
  return `${changelog.slice(0, at)}${section}\n${changelog.slice(at)}`;
}

/** The whole decision, from plain data. */
export function plan({ currentVersion, head, commits, paths, tagExists }) {
  const skip = skipReason(head);
  if (skip) return { release: false, reason: `no release: ${skip}` };
  if (!hasCodeChange(paths)) {
    return {
      release: false,
      reason: 'no release: no code changed since the last release (docs, examples and other workflows do not release)',
    };
  }
  const bump = chooseBump(commits);
  const version = nextVersion(currentVersion, bump);
  if (tagExists(`laws-v${version}`)) return { release: false, reason: `no release: laws-v${version} already exists` };
  return { release: true, version, tag: `laws-v${version}`, bump, reason: `${bump} release ${version}` };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readCommits(...logArgs) {
  const raw = git('log', '--format=%an%x1f%s%x1f%b%x1e', ...logArgs);
  return raw
    .split('\x1e')
    .map((entry) => entry.replace(/^\n/, ''))
    .filter((entry) => entry.trim())
    .map((entry) => {
      const [author, subject, body] = entry.split('\x1f');
      return { author, subject, body: (body ?? '').trim() };
    });
}

function laterTags() {
  return git('tag', '--list', 'laws-v*', '--sort=-v:refname').split('\n').filter(Boolean);
}

function setJsonVersion(file, version) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  writeFileSync(file, next);
}

function setLockVersions(file, version) {
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['packages/tslaws', 'packages/vscode-tslaws']) {
    if (lock.packages?.[key]) lock.packages[key].version = version;
  }
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
}

function main(argv) {
  const [command, arg] = argv;
  if (command === 'plan') {
    const tags = laterTags();
    const last = tags[0];
    const commits = readCommits(last ? `${last}..HEAD` : 'HEAD');
    const head = readCommits('-1')[0] ?? { author: '', subject: '', body: '' };
    const base = last ?? git('hash-object', '-t', 'tree', '/dev/null');
    const paths = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
    const currentVersion = JSON.parse(readFileSync('packages/tslaws/package.json', 'utf8')).version;
    const result = plan({ currentVersion, head, commits, paths, tagExists: (tag) => tags.includes(tag) });
    const outputs = {
      release: result.release,
      version: result.version ?? '',
      tag: result.tag ?? '',
      reason: result.reason,
    };
    for (const [key, value] of Object.entries(outputs)) {
      console.log(`${key}=${value}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
    return;
  }
  if (command === 'apply') {
    if (!/^\d+\.\d+\.\d+$/.test(arg ?? '')) throw new Error('usage: laws-auto-release.mjs apply <x.y.z>');
    const last = laterTags()[0];
    const commits = readCommits(last ? `${last}..HEAD` : 'HEAD');
    setJsonVersion('packages/tslaws/package.json', arg);
    setJsonVersion('packages/vscode-tslaws/package.json', arg);
    setLockVersions('package-lock.json', arg);
    const changelog = readFileSync('CHANGELOG-LAWS.md', 'utf8');
    writeFileSync('CHANGELOG-LAWS.md', insertSection(changelog, renderSection(arg, commits)));
    return;
  }
  throw new Error('usage: laws-auto-release.mjs plan | apply <version>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
