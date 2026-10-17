// Print the current release's changelog entry for CI and GitHub Releases.
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('packages/tsc-ts/package.json', 'utf8'));
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const start = '<!-- release:start -->';
const end = '<!-- release:end -->';
if (changelog.split(start).length !== 2 || changelog.split(end).length !== 2) {
  throw new Error('CHANGELOG.md must contain exactly one release:start and release:end marker');
}
const startAt = changelog.indexOf(start) + start.length;
const endAt = changelog.indexOf(end);
if (endAt < startAt) throw new Error('CHANGELOG.md release:end must follow release:start');

const notes = changelog.slice(startAt, endAt).trim();
const [heading, ...lines] = notes.split('\n');
if (heading !== `## ${version}`) {
  throw new Error(`CHANGELOG.md release entry must start with "## ${version}"`);
}
if (!lines.join('\n').trim() || lines.some((line) => line.startsWith('## '))) {
  throw new Error('CHANGELOG.md release entry must contain notes for exactly one version');
}
process.stdout.write(notes + '\n');
