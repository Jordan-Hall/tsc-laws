// `tslaws badge`: the endpoint badges, their colours, the markdown and the command that writes them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { certificateName, noCertificate, uncertifiable } from '../dist/certificates.js';
import { lawKey } from '../dist/lock.js';
import type { Certification, Outcome, Standing } from '../dist/badge.js';
import { badgeMarkdown, badgesOf, certificateSummary, githubRepoOf, standingOf, standingsOf } from '../dist/badge.js';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'tslaws.js');
const root = mkdtempSync(join(tmpdir(), 'tslaws-badge-'));
after(() => rmSync(root, { recursive: true, force: true }));

const standing = (outcome: Outcome, certification: Certification, extra: Partial<Standing> = {}): Standing => ({
  outcome,
  certification,
  ...extra,
});
const certified = standing('proved', 'certified');
const notCertifiable = standing('proved', 'not-certifiable', {
  reason: 'the law uses floating-point numbers, which Alethe proofs do not cover (use int or bigint)',
});

describe('badgesOf', () => {
  it('breaks the laws and certificates down by category and is green when nothing is missing', () => {
    const badges = badgesOf([certified, certified]);
    assert.deepEqual(badges.laws, { schemaVersion: 1, label: 'laws', message: '2 proved', color: 'brightgreen' });
    assert.deepEqual(badges.certificates, {
      schemaVersion: 1,
      label: 'certificates',
      message: '2 certified',
      color: 'brightgreen',
    });
  });

  it('shows a law that cannot be certified as its own category and stays green', () => {
    const badges = badgesOf([...Array.from({ length: 7 }, () => certified), notCertifiable]);
    assert.equal(badges.laws.message, '8 proved');
    assert.equal(badges.laws.color, 'brightgreen');
    assert.equal(badges.certificates.message, '7 certified · 1 not certifiable');
    assert.equal(badges.certificates.color, 'brightgreen');
  });

  it('counts tested laws apart from proved ones, and a tested law is not certifiable', () => {
    const badges = badgesOf([...Array.from({ length: 7 }, () => certified), standing('tested', 'not-certifiable')]);
    assert.equal(badges.laws.message, '7 proved · 1 tested');
    assert.equal(badges.laws.color, 'brightgreen');
    assert.equal(badges.certificates.message, '7 certified · 1 not certifiable');
  });

  it('is yellow only when a law that could be certified has no certificate or a rejected one', () => {
    const missing = badgesOf([certified, standing('proved', 'not-certified')]);
    assert.equal(missing.certificates.message, '1 certified · 1 not certified');
    assert.equal(missing.certificates.color, 'yellow');
    assert.equal(missing.laws.color, 'brightgreen');
    const rejected = badgesOf([
      certified,
      standing('proved', 'rejected', { reason: 'Carcara did not accept the proof' }),
    ]);
    assert.equal(rejected.certificates.message, '1 certified · 1 certificate failed');
    assert.equal(rejected.certificates.color, 'yellow');
  });

  it('lists every category in order, and is red for a failed law and yellow for an open one', () => {
    const laws = [
      certified,
      standing('bounded', 'not-certifiable'),
      standing('tested', 'not-certifiable'),
      standing('open', 'not-certifiable'),
      standing('failed', 'not-certifiable'),
    ];
    const badges = badgesOf(laws);
    assert.equal(badges.laws.message, '1 proved · 1 bounded · 1 tested · 1 open · 1 failed');
    assert.equal(badges.laws.color, 'red');
    assert.equal(badges.certificates.message, '1 certified · 3 not certifiable · 1 failed');
    assert.equal(badges.certificates.color, 'red');
    const open = badgesOf([certified, standing('open', 'not-certifiable')]);
    assert.equal(open.laws.message, '1 proved · 1 open');
    assert.equal(open.laws.color, 'yellow');
  });

  it('has no "N of M" form, and is yellow with a plain message for no laws', () => {
    const badges = badgesOf([]);
    assert.equal(badges.laws.message, 'no laws');
    assert.equal(badges.laws.color, 'yellow');
    assert.equal(badges.certificates.color, 'yellow');
    assert.doesNotMatch(badgesOf([certified, notCertifiable]).certificates.message, / of /);
  });
});

describe('standingOf', () => {
  it('tells what cannot be certified from what was not or failed, using the reasons certify gives', () => {
    const floating = uncertifiable('(declare-const a (_ FloatingPoint 11 53))');
    const strings = uncertifiable('(declare-const s String)');
    assert.ok(floating !== undefined && strings !== undefined);
    for (const reason of [floating, strings])
      assert.equal(
        standingOf({ status: 'proved', certificate: { status: 'uncertified', reason } }).certification,
        'not-certifiable',
        reason,
      );
    const of = (certificate?: { status: 'uncertified' | 'unavailable'; reason?: string }) =>
      standingOf({ status: 'proved', certificate }).certification;
    assert.equal(of(), 'not-certified');
    assert.equal(of({ status: 'unavailable', reason: 'cvc5 is not installed' }), 'not-certified');
    assert.equal(of({ status: 'uncertified', reason: noCertificate.reason }), 'not-certified');
    assert.equal(of({ status: 'uncertified', reason: 'Carcara did not accept the proof (invalid)' }), 'rejected');
  });

  it('counts tampered, uncovered and error as failed, and only a proved law as certifiable', () => {
    for (const status of ['failed', 'tampered', 'uncovered', 'error'] as const)
      assert.equal(standingOf({ status }).outcome, 'failed', status);
    assert.equal(standingOf({ status: 'tested', runs: 100, message: 'x' }).certification, 'not-certifiable');
    assert.deepEqual(standingOf({ status: 'tested', runs: 100, message: 'x' }), {
      outcome: 'tested',
      certification: 'not-certifiable',
      runs: 100,
      note: 'x',
    });
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
      standings.map((s) => s.certification),
      ['certified', 'not-certified', 'certified'],
    );
  });
});

describe('certificateSummary', () => {
  const laws = [
    { name: 'addition commutes', standing: certified },
    { name: 'the average sits between', standing: notCertifiable },
    { name: 'sorting is stable', standing: standing('tested', 'not-certifiable', { runs: 100 }) },
  ];

  it('groups the laws in plain words, with the reason a law cannot be certified', () => {
    const text = certificateSummary(laws).join('\n');
    assert.match(text, /### Proved and independently checked \(1\)\n\n.*\n\n- \*\*addition commutes\*\*/);
    assert.match(text, /### Proved, but the proof can't be checked independently yet \(0\)\n\n.*\n\nNone\./);
    assert.match(text, /- \*\*sorting is stable\*\*: run on 100 random inputs without finding a counterexample/);
    assert.match(text, /### Can't be certified, and why \(1\)/);
    assert.ok(text.includes('uses decimal (floating-point) numbers; the proof checker only handles whole numbers'));
    assert.ok(text.includes('Use `int` or `bigint` to get a certificate.'));
  });

  it('is the same text for the same laws', () => {
    assert.equal(certificateSummary(laws).join('\n'), certificateSummary([...laws]).join('\n'));
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
    assert.ok(
      badgeMarkdown({ repo: 'acme/widgets', branch: 'main', dir: 'badges', page: true }).includes(
        '(https://github.com/acme/widgets/blob/main/badges/README.md)',
      ),
    );
    assert.ok(badgeMarkdown({ branch: 'main', dir: '' }).includes('OWNER%2FREPO%2Fmain%2Fbadge-certificates.json'));
  });
});

const result = (name: string, status: string, certified: boolean) => ({
  file: 'a.laws.ts',
  line: 1,
  name,
  status,
  method: 'smt',
  certificate: { status: certified ? 'certified' : 'uncertified' },
});

/** A project directory holding a report of these results. */
function project(results: unknown[]): string {
  const cwd = mkdtempSync(join(root, 'p-'));
  writeFileSync(join(cwd, 'report.json'), JSON.stringify({ results }));
  return cwd;
}

describe('tslaws badge', () => {
  it('writes both files into --out from a check report and prints the markdown', () => {
    const cwd = project([result('one', 'proved', true), result('two', 'tested', false)]);
    const ran = spawnSync(
      process.execPath,
      [bin, 'badge', '--report', 'report.json', '--out', 'out', '--repo', 'acme/widgets'],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(ran.status, 0, ran.stderr);
    const laws = JSON.parse(readFileSync(join(cwd, 'out', 'badge-laws.json'), 'utf8'));
    const certificates = JSON.parse(readFileSync(join(cwd, 'out', 'badge-certificates.json'), 'utf8'));
    assert.equal(laws.message, '1 proved · 1 tested');
    assert.equal(laws.color, 'brightgreen');
    assert.equal(certificates.message, '1 certified · 1 not certifiable');
    assert.equal(certificates.color, 'brightgreen');
    assert.ok(ran.stdout.includes('raw.githubusercontent.com%2Facme%2Fwidgets%2Fmain'), ran.stdout);
  });

  it('defaults to badges/, a directory a repository commits, and links the lock when nothing is certified', () => {
    const cwd = project([result('one', 'proved', false)]);
    const ran = spawnSync(process.execPath, [bin, 'badge', '--report', 'report.json', '--repo', 'acme/widgets'], {
      cwd,
      encoding: 'utf8',
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.ok(existsSync(join(cwd, 'badges', 'badge-laws.json')));
    assert.ok(!existsSync(join(cwd, 'badges', 'README.md')));
    assert.ok(ran.stdout.includes('raw.githubusercontent.com%2Facme%2Fwidgets%2Fmain%2Fbadges%2Fbadge-laws.json'));
    assert.ok(ran.stdout.includes('(https://github.com/acme/widgets/blob/main/tsc-laws.lock)'));
  });

  it('writes a certificates page with the proof files and links both badges to it, unless --link says otherwise', () => {
    const cwd = project([result('one', 'proved', true), result('two', 'tested', false)]);
    const name = certificateName(lawKey('a.laws.ts', 'one'));
    mkdirSync(join(cwd, '.tslaws', 'certificates'), { recursive: true });
    writeFileSync(join(cwd, '.tslaws', 'certificates', `${name}.smt2`), '(check-sat)\n');
    writeFileSync(join(cwd, '.tslaws', 'certificates', `${name}.alethe`), '(assume a0 true)\n');
    const args = [bin, 'badge', '--report', 'report.json', '--repo', 'acme/widgets'];
    const ran = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    const page = readFileSync(join(cwd, 'badges', 'README.md'), 'utf8');
    assert.ok(page.includes('## What is a certificate?'));
    assert.ok(page.includes('### Proved and independently checked (1)'));
    assert.ok(page.includes('### Tested, not proved (1)'));
    assert.ok(page.includes('- **two**: run on random inputs without finding a counterexample'));
    assert.ok(page.indexOf('## Technical details') > page.indexOf('## Summary'));
    assert.ok(
      page.includes(
        `| one | a.laws.ts:1 | Proved, independently checked | [smt2](certificates/${name}.smt2), [alethe](certificates/${name}.alethe) |`,
      ),
    );
    assert.ok(page.includes('| two | a.laws.ts:1 | Tested, not proved | - |'));
    assert.equal(readFileSync(join(cwd, 'badges', 'certificates', `${name}.alethe`), 'utf8'), '(assume a0 true)\n');
    assert.ok(ran.stdout.includes('(https://github.com/acme/widgets/blob/main/badges/README.md)'), ran.stdout);
    const linked = spawnSync(process.execPath, [...args, '--link', 'https://example.org/proofs'], {
      cwd,
      encoding: 'utf8',
    });
    assert.ok(linked.stdout.includes('(https://example.org/proofs)'));
    assert.ok(!linked.stdout.includes('badges/README.md)'));
  });

  it('refuses a report that is not one project check', () => {
    const cwd = mkdtempSync(join(root, 'p-'));
    writeFileSync(join(cwd, 'report.json'), JSON.stringify({ '.': {} }));
    const ran = spawnSync(process.execPath, [bin, 'badge', '--report', 'report.json'], { cwd, encoding: 'utf8' });
    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /no results/);
  });
});
