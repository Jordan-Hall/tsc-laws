import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { CheckReport } from '../dist/check.js';
import { escapeGithubData, escapeGithubProperty, escapeXml, github, junit, reportAs } from '../dist/reporters.js';
import type { LawResult } from '../dist/types.js';

const root = mkdtempSync(join(tmpdir(), 'tslaws-reporters-'));
after(() => rmSync(root, { recursive: true, force: true }));

const result = (over: Partial<LawResult>): LawResult => ({
  file: 'src/a.laws.ts',
  name: 'law',
  line: 3,
  status: 'proved',
  method: 'smt',
  ...over,
});
const report = (results: LawResult[], over: Partial<CheckReport> = {}): CheckReport => ({
  results,
  compileDiagnostics: '',
  compileOk: true,
  lockMissing: false,
  ok: results.every((r) => ['proved', 'bounded', 'tested'].includes(r.status)),
  ...over,
});

/** A minimal well-formedness check: tags balance and attributes are quoted without raw < or &. */
function assertWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const stack: string[] = [];
  for (const m of body.matchAll(
    /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos|#\d+);[^"<&]*)*")*)\s*(\/?)>/g,
  )) {
    if (m[1] === '/') assert.equal(stack.pop(), m[2]);
    else if (m[4] !== '/') stack.push(m[2]!);
  }
  assert.deepEqual(stack, []);
  const text = body.replace(/<[^>]*>/g, '');
  assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+);)/.test(text), 'unescaped ampersand');
  assert.ok(
    [...xml].every((c) => c >= ' ' || '\n\r\t'.includes(c)),
    'control character',
  );
}

const mixed = report([
  result({ name: 'p1' }),
  result({ name: 'p2', status: 'bounded', message: 'within bound 4' }),
  result({ name: 'bad', status: 'failed', line: 9, method: 'property', counterexample: '<a & "b" \'c\'>', seed: 7 }),
  result({ file: 'src/b.laws.ts', name: 'o', status: 'open', message: 'unsupported\u0001 construct' }),
  result({ file: 'src/b.laws.ts', name: 't', status: 'tested', runs: 200 }),
]);

describe('junit', () => {
  it('is well formed with correct counts and one suite per file', () => {
    const xml = junit(mixed);
    assertWellFormed(xml);
    assert.match(xml, /<testsuites name="tslaws" tests="5" failures="2" errors="0">/);
    assert.equal([...xml.matchAll(/<testsuite /g)].length, 2);
    assert.match(xml, /<testsuite name="src\/a\.laws\.ts" tests="3" failures="1"/);
    assert.match(xml, /<testsuite name="src\/b\.laws\.ts" tests="2" failures="1"/);
    assert.equal([...xml.matchAll(/<failure /g)].length, 2);
    assert.equal([...xml.matchAll(/<testcase /g)].length, 5);
    assert.match(xml, /<testcase classname="src\/a\.laws\.ts" name="p1"\/>/);
  });

  it('escapes the counterexample and drops invalid control characters', () => {
    const xml = junit(mixed);
    assert.ok(xml.includes('counterexample &lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;'));
    assert.ok(!xml.includes('<a &'));
    assert.ok(xml.includes('unsupported construct'));
    assert.match(xml, /hint: /);
  });

  it('reports compile failures and a missing lock as a failing suite', () => {
    const xml = junit(
      report([result({})], {
        compileOk: false,
        compileDiagnostics: 'x.ts(1,1): error TS1 <bad>',
        lockMissing: true,
        ok: false,
      }),
    );
    assertWellFormed(xml);
    assert.match(xml, /tests="2" failures="1"/);
    assert.ok(xml.includes('&lt;bad&gt;'));
  });

  it('is valid for an empty report', () => {
    const xml = junit(report([]));
    assertWellFormed(xml);
    assert.match(xml, /tests="0" failures="0"/);
  });
});

describe('escaping', () => {
  it('escapes XML', () => {
    assert.equal(escapeXml('<&>"\'\u0000\u000B'), '&lt;&amp;&gt;&quot;&apos;');
  });
  it('escapes workflow command data and properties', () => {
    assert.equal(escapeGithubData('a%b\r\nc:d,e'), 'a%25b%0D%0Ac:d,e');
    assert.equal(escapeGithubProperty('a,b:c%\n'), 'a%2Cb%3Ac%25%0A');
  });
});

describe('github', () => {
  it('emits an error annotation per failure and a notice for bounded or tested', () => {
    const out = github(mixed);
    const lines = out.trimEnd().split('\n');
    assert.ok(lines.some((l) => l.startsWith('::error file=src/a.laws.ts,line=9,title=bad failed::')));
    assert.ok(lines.some((l) => l.startsWith('::error file=src/b.laws.ts,line=3,title=o open::')));
    assert.ok(lines.some((l) => l.startsWith('::notice file=src/a.laws.ts,line=3,title=p2 bounded::within bound 4')));
    assert.ok(lines.some((l) => l.startsWith('::notice file=src/b.laws.ts,line=3,title=t tested::')));
    assert.ok(!out.includes('title=p1'));
    assert.ok(out.includes('counterexample <a & "b" \'c\'>'));
    assert.equal(lines.at(-1), 'tslaws: 5 laws, 1 proved, 2 failing');
  });

  it('escapes newlines in the message and commas in the file path', () => {
    const out = github(
      report([
        result({
          file: 'dir,x/a.laws.ts',
          name: 'n:1',
          status: 'failed',
          message: '100%\nsecond\r\nthird',
          counterexample: '1',
        }),
      ]),
    );
    const line = out.split('\n').find((l) => l.startsWith('::error'))!;
    assert.ok(line.startsWith('::error file=dir%2Cx/a.laws.ts,line=3,title=n%3A1 failed::'));
    assert.ok(line.includes('100%25%0Asecond%0D%0Athird'));
    assert.ok(!line.includes('\n') && !line.includes('\r'));
  });

  it('omits the line of a result without one', () => {
    const out = github(report([result({ status: 'tampered', line: 0, message: 'removed' })]));
    assert.match(out, /^::error file=src\/a\.laws\.ts,title=law tampered::removed/);
  });

  it('appends a markdown table to GITHUB_STEP_SUMMARY when set', () => {
    const file = join(root, 'summary.md');
    const out = reportAs('github', mixed, { GITHUB_STEP_SUMMARY: file });
    assert.ok(out.startsWith('::'));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /### tslaws: failed/);
    assert.match(text, /\| Status \| Law \| Location \| Method \| Detail \|/);
    assert.equal(text.split('\n').filter((l) => l.startsWith('| failed |')).length, 1);
    reportAs('github', mixed, { GITHUB_STEP_SUMMARY: file });
    assert.equal(readFileSync(file, 'utf8').split('### tslaws').length, 3);
  });

  it('writes no file when GITHUB_STEP_SUMMARY is unset', () => {
    assert.doesNotThrow(() => reportAs('github', mixed, {}));
  });
});
