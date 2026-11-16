// `solvers` in tslaws.json: validation, the cvc5 runner and the agreement rule, with a fake cvc5 (a Node script that
// TSLAWS_CVC5 points at; solvers.ts runs a .mjs path under the current Node, so it works on every platform).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { parseConfig } from '../dist/coverage.js';
import { writeLock } from '../dist/lock.js';
import { cvc5Text, runCvc5, secondOpinion, SolverUnavailable } from '../dist/solvers.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'tslaws-solvers-'));
const projects = mkdtempSync(join(here, '..', '.tmp-solvers-'));
const saved = process.env.TSLAWS_CVC5;

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

afterEach(() => {
  if (saved === undefined) delete process.env.TSLAWS_CVC5;
  else process.env.TSLAWS_CVC5 = saved;
});

let count = 0;

/** Writes a fake cvc5 that records its arguments and input beside itself, then behaves as `body` says. */
function fake(body: string): { path: string; args: () => string[]; input: () => string } {
  const dir = join(root, `fake${count++}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'cvc5.mjs');
  writeFileSync(
    path,
    [
      "import { writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const dir = dirname(fileURLToPath(import.meta.url));',
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => (input += chunk));",
      "process.stdin.on('end', () => {",
      "  writeFileSync(join(dir, 'args.json'), JSON.stringify(process.argv.slice(2)));",
      "  writeFileSync(join(dir, 'input.smt2'), input);",
      `  ${body}`,
      '});',
      '',
    ].join('\n'),
  );
  return {
    path,
    args: () => JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[],
    input: () => readFileSync(join(dir, 'input.smt2'), 'utf8'),
  };
}

const prints = (answer: string): string => `console.log(${JSON.stringify(answer)});`;
const query = '(set-option :timeout 5000)\n(declare-const x Int)\n(assert (> x x))\n(check-sat)';

describe('"solvers" in tslaws.json', () => {
  it('accepts z3 alone and z3 with cvc5, in either order, and no key at all', () => {
    assert.deepEqual(parseConfig({ solvers: ['z3'] }).solvers, ['z3']);
    assert.deepEqual(parseConfig({ solvers: ['z3', 'cvc5'] }).solvers, ['z3', 'cvc5']);
    assert.deepEqual(parseConfig({ solvers: ['cvc5', 'z3'] }).solvers, ['cvc5', 'z3']);
    assert.equal(parseConfig({}).solvers, undefined);
  });

  it('refuses anything else with a message that names the key', () => {
    const refused = (solvers: unknown, pattern: RegExp): void =>
      assert.throws(
        () => parseConfig({ solvers }),
        (error: Error) => error.message.startsWith('tslaws.json: "solvers"') && pattern.test(error.message),
      );
    refused(['cvc5'], /must include "z3"/);
    refused([], /array of solver names/);
    refused('z3', /array of solver names/);
    refused(['z3', 'yices'], /unknown solver "yices".*"z3" and "cvc5"/);
    refused(['z3', 3], /unknown solver 3/);
    refused(['z3', 'z3'], /"z3" more than once/);
  });
});

describe('cvc5Text', () => {
  it('drops the Z3 timeout and get-model, and adds a logic when the query has none', () => {
    const text = cvc5Text(`${query}\n(get-model)\n`);
    assert.equal(text, '(set-logic ALL)\n(declare-const x Int)\n(assert (> x x))\n(check-sat)\n');
  });

  it('keeps a logic the query already sets', () => {
    const text = cvc5Text('(set-logic QF_LIA)\n(check-sat)');
    assert.equal(text, '(set-logic QF_LIA)\n(check-sat)\n');
  });
});

describe('runCvc5 and the agreement rule', () => {
  it('passes the query on stdin with the arguments, and confirms on unsat', async () => {
    const cvc5 = fake(prints('unsat'));
    process.env.TSLAWS_CVC5 = cvc5.path;
    assert.deepEqual(await runCvc5(query, 1234), { kind: 'unsat' });
    assert.deepEqual(cvc5.args(), ['--lang', 'smt2', '--tlimit', '1234']);
    assert.equal(cvc5.input(), cvc5Text(query));
    assert.equal(await secondOpinion(['z3', 'cvc5'], query, 1000), undefined);
  });

  it('does not run cvc5 unless it is configured', async () => {
    process.env.TSLAWS_CVC5 = join(root, 'does-not-exist.mjs');
    assert.equal(await secondOpinion(['z3'], query, 1000), undefined);
    assert.equal(await secondOpinion([], query, 1000), undefined);
  });

  it('reports sat and unknown as not confirmed', async () => {
    process.env.TSLAWS_CVC5 = fake(prints('sat')).path;
    assert.equal(await secondOpinion(['z3', 'cvc5'], query, 1000), 'cvc5 did not confirm the proof (sat)');
    process.env.TSLAWS_CVC5 = fake(prints('unknown')).path;
    assert.equal(await secondOpinion(['z3', 'cvc5'], query, 1000), 'cvc5 did not confirm the proof (unknown)');
  });

  it('reports an error line and a non-zero exit as not confirmed', async () => {
    process.env.TSLAWS_CVC5 = fake(`${prints('(error "Parse Error: bad")')} process.exitCode = 1;`).path;
    assert.equal(
      await secondOpinion(['z3', 'cvc5'], query, 1000),
      'cvc5 did not confirm the proof (error: (error "Parse Error: bad"))',
    );
    process.env.TSLAWS_CVC5 = fake('process.exitCode = 3;').path;
    assert.equal(
      await secondOpinion(['z3', 'cvc5'], query, 1000),
      'cvc5 did not confirm the proof (error: exited with code 3)',
    );
    process.env.TSLAWS_CVC5 = fake(`${prints('unsat')} process.exitCode = 1;`).path;
    assert.match((await secondOpinion(['z3', 'cvc5'], query, 1000)) ?? '', /did not confirm/);
  });

  it('reports a solver that never answers as timed out', async () => {
    process.env.TSLAWS_CVC5 = fake('setInterval(() => undefined, 1000);').path;
    assert.deepEqual(await runCvc5(query, 1), { kind: 'timeout' });
  });

  it('refuses with install advice when the binary is missing', async () => {
    process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
    await assert.rejects(
      secondOpinion(['z3', 'cvc5'], query, 1000),
      (error: Error) =>
        error instanceof SolverUnavailable && /install cvc5/.test(error.message) && /TSLAWS_CVC5/.test(error.message),
    );
  });
});

function project(name: string, files: Record<string, string>): CheckOptions {
  const cwd = join(projects, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const options: CheckOptions = {
    files: ['src/f.laws.ts'],
    cwd,
    runs: 100,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 10000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return options;
}

const laws = 'export law commutes(a: boolean, b: boolean) { return (a && b) === (b && a); }\n';

async function run(name: string, solvers: string[] | undefined): Promise<LawResult> {
  const config = solvers === undefined ? {} : { solvers };
  const opts = project(name, { 'src/f.laws.ts': laws, 'tslaws.json': JSON.stringify(config) });
  const found = (await check(opts, true)).results.find((r) => r.name === 'commutes');
  assert.ok(found, `no result for commutes`);
  return found;
}

describe('cvc5 agreement in a check', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('stays proved when cvc5 also says unsat', async () => {
    process.env.TSLAWS_CVC5 = fake(prints('unsat')).path;
    assert.equal((await run('agree', ['z3', 'cvc5'])).status, 'proved');
  });

  it('is bounded, not proved, when cvc5 disagrees', async () => {
    const cvc5 = fake(prints('unknown'));
    process.env.TSLAWS_CVC5 = cvc5.path;
    const result = await run('disagree', ['z3', 'cvc5']);
    assert.equal(result.status, 'bounded');
    assert.match(result.message ?? '', /cvc5 did not confirm the proof \(unknown\)/);
    assert.match(cvc5.input(), /\(check-sat\)/);
  });

  it('is an error that says how to install cvc5 when the binary is missing', async () => {
    process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
    const result = await run('missing', ['z3', 'cvc5']);
    assert.equal(result.status, 'error');
    assert.match(result.message ?? '', /TSLAWS_CVC5/);
  });

  it('never runs cvc5 for the default solvers', async () => {
    process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
    assert.equal((await run('default', undefined)).status, 'proved');
    assert.equal((await run('z3only', ['z3'])).status, 'proved');
  });
});
