// `tslaws badge`: the endpoint badges, their colours, the markdown and the command that writes them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { badgeMarkdown, badgesOf, githubRepoOf, standingsOf } from '../dist/badge.js';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'tslaws.js');
const root = mkdtempSync(join(tmpdir(), 'tslaws-badge-'));
after(() => rmSync(root, { recursive: true, force: true }));

const proved = { proved: true, certified: true };

describe('badgesOf', () => {
  it('is green when every law is proved and certified', () => {
    const badges = badgesOf([proved, proved]);
    assert.deepEqual(badges.laws, { schemaVersion: 1, label: 'laws', message: '2 proved', color: 'brightgreen' });
    assert.deepEqual(badges.certificates, {
      schemaVersion: 1,
      label: 'certificates',
      message: '2 verified',
      color: 'brightgreen',
    });
  });

  it('is yellow, with the total, when a law is not proved or not certified, and for no laws at all', () => {
    const badges = badgesOf([proved, { proved: true, certified: false }, { proved: false, certified: false }]);
    assert.equal(badges.laws.message, '2 of 3 proved');
    assert.equal(badges.laws.color, 'yellow');
    assert.equal(badges.certificates.message, '1 of 3 verified');
    assert.equal(badges.certificates.color, 'yellow');
    assert.equal(badgesOf([]).laws.color, 'yellow');
  });

  it('counts a law as certified from this run or from a current lock record', () => {
    const lock = {
      laws: { 'a.laws.ts::one': 'h1', 'a.laws.ts::two': 'h2' },
      exempt: [],
      certificates: { 'a.laws.ts::one': { law: 'h1' }, 'a.laws.ts::two': { law: 'old' } },
    };
    const result = (name: string, certified = false) => ({
      file: 'a.laws.ts',
      name,
      line: 1,
      status: 'proved' as const,
      method: 'smt',
      ...(certified ? { certificate: { status: 'certified' as const } } : {}),
    });
    const standings = standingsOf([result('one'), result('two'), result('three', true)], lock as never);
    assert.deepEqual(
      standings.map((s) => s.certified),
      [true, false, true],
    );
  });
});

describe('githubRepoOf and badgeMarkdown', () => {
  it('reads the repository from https, ssh and scp-style remotes and ignores other hosts', () => {
    for (const url of [
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
    ])
      assert.equal(githubRepoOf(url), 'acme/widgets', url);
    assert.equal(githubRepoOf('https://example.com/acme/widgets.git'), undefined);
  });

  it('points the endpoint badges at the raw file on the branch and links the lock, or names a placeholder', () => {
    const markdown = badgeMarkdown({ repo: 'acme/widgets', branch: 'main', dir: 'badges' });
    const raw = encodeURIComponent('https://raw.githubusercontent.com/acme/widgets/main/badges/badge-laws.json');
    assert.ok(markdown.includes(`https://img.shields.io/endpoint?url=${raw}`));
    assert.ok(markdown.includes('(https://github.com/acme/widgets/blob/main/tsc-laws.lock)'));
    assert.ok(badgeMarkdown({ branch: 'main', dir: '' }).includes('OWNER%2FREPO%2Fmain%2Fbadge-certificates.json'));
  });
});

describe('tslaws badge', () => {
  it('writes both files into --out from a check report and prints the markdown', () => {
    const cwd = mkdtempSync(join(root, 'p-'));
    const result = (name: string, status: string, certified: boolean) => ({
      file: 'a.laws.ts',
      line: 1,
      name,
      status,
      method: 'smt',
      certificate: { status: certified ? 'certified' : 'uncertified' },
    });
    writeFileSync(
      join(cwd, 'report.json'),
      JSON.stringify({ results: [result('one', 'proved', true), result('two', 'tested', false)] }),
    );
    const ran = spawnSync(
      process.execPath,
      [bin, 'badge', '--report', 'report.json', '--out', 'out', '--repo', 'acme/widgets'],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(ran.status, 0, ran.stderr);
    const laws = JSON.parse(readFileSync(join(cwd, 'out', 'badge-laws.json'), 'utf8'));
    const certificates = JSON.parse(readFileSync(join(cwd, 'out', 'badge-certificates.json'), 'utf8'));
    assert.equal(laws.message, '1 of 2 proved');
    assert.equal(certificates.message, '1 of 2 verified');
    assert.ok(ran.stdout.includes('raw.githubusercontent.com%2Facme%2Fwidgets%2Fmain'), ran.stdout);
  });

  it('refuses a report that is not one project check', () => {
    const cwd = mkdtempSync(join(root, 'p-'));
    writeFileSync(join(cwd, 'report.json'), JSON.stringify({ '.': {} }));
    const ran = spawnSync(process.execPath, [bin, 'badge', '--report', 'report.json'], { cwd, encoding: 'utf8' });
    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /no results/);
  });
});
