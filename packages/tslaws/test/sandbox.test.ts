// The law sandbox (src/sandbox.ts): laws run in a child process under Node's permission model, behind a module guard.
// Each attack is a law that tries something a law has no business doing; with the sandbox on it must not get it, and with
// `sandbox: false` the same law does, which shows the sandbox is what stopped it.
// Needs the built compiler in TSC_LAWS_BIN and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import nodeModule from 'node:module';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { permissionFlag, readOutcome, sandboxFlags, useSandbox } from '../dist/sandbox.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  // Z3's worker threads keep the test process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

function options(cwd: string, lawFiles: string[], extra: Partial<CheckOptions> = {}): CheckOptions {
  return {
    files: lawFiles,
    cwd,
    runs: 20,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 20000,
    ...extra,
  };
}

async function run(
  name: string,
  files: Record<string, string>,
  extra: Partial<CheckOptions> = {},
): Promise<LawResult[]> {
  const cwd = project(name, files);
  return (await check(options(cwd, ['src/a.laws.ts'], extra), false)).results;
}

const only = (results: LawResult[]): LawResult => {
  assert.equal(results.length, 1, JSON.stringify(results));
  return results[0]!;
};

/** The law did not get what it tried: it failed, or could not load, and the reason is the sandbox's or the runtime's. */
function refused(result: LawResult, why: RegExp): void {
  assert.ok(result.status === 'error' || result.status === 'failed', `expected a refusal: ${JSON.stringify(result)}`);
  assert.match(result.message ?? '', why);
}

describe('the permission flag', () => {
  it('picks the name each Node version has', () => {
    assert.equal(permissionFlag('18.19.0'), undefined);
    assert.equal(permissionFlag('20.0.0'), '--experimental-permission');
    assert.equal(permissionFlag('22.0.0'), '--experimental-permission');
    assert.equal(permissionFlag('22.12.9'), '--experimental-permission');
    assert.equal(permissionFlag('22.13.0'), '--permission');
    assert.equal(permissionFlag('23.4.0'), '--experimental-permission');
    assert.equal(permissionFlag('23.5.0'), '--permission');
    assert.equal(permissionFlag('24.0.0'), '--permission');
  });

  it('fails closed on a Node without the permission model, and says how to opt out', () => {
    assert.throws(() => useSandbox({}, '18.19.0'), /Node 20 or later.*--no-sandbox/s);
    assert.equal(useSandbox({}, '24.0.0'), true);
  });

  it('prints a warning for --no-sandbox', () => {
    const write = process.stderr.write.bind(process.stderr);
    let seen = '';
    process.stderr.write = ((text: string) => ((seen += text), true)) as typeof process.stderr.write;
    try {
      assert.equal(useSandbox({ sandbox: false }), false);
    } finally {
      process.stderr.write = write;
    }
    assert.match(seen, /warning: --no-sandbox: laws run with full access/);
  });
});

describe('the permission model flags', () => {
  const flags = sandboxFlags(root);
  const script = (code: string) => spawnSync(process.execPath, [...flags, '-e', code], { encoding: 'utf8', cwd: root });

  it('allows reading the project and nothing outside it', () => {
    assert.equal(script(`require('node:fs').readdirSync(${JSON.stringify(root)})`).status, 0);
    const outside = script(`require('node:fs').readFileSync(${JSON.stringify(process.execPath)})`);
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /ERR_ACCESS_DENIED/);
  });

  it('refuses writes, child processes, workers and code from strings', () => {
    const target = join(root, 'written.txt');
    const write = script(`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x')`);
    assert.match(write.stderr, /ERR_ACCESS_DENIED/);
    assert.equal(existsSync(target), false);
    assert.match(script(`require('node:child_process').execSync('echo hi')`).stderr, /ERR_ACCESS_DENIED/);
    assert.match(
      script(`new (require('node:worker_threads').Worker)('1', { eval: true })`).stderr,
      /ERR_ACCESS_DENIED/,
    );
    assert.match(script(`eval('1')`).stderr, /Code generation from strings disallowed/);
    assert.match(script(`new Function('return 1')`).stderr, /Code generation from strings disallowed/);
  });
});

describe('readOutcome', () => {
  const good = { failed: true, numRuns: 3, seed: -5, counterexample: '[1]', message: 'm', stack: 's' };

  it('keeps the fields it checks and drops the rest', () => {
    assert.deepEqual(readOutcome({ ...good, extra: 'x', screenshot: '/etc/passwd' }), good);
  });

  it('turns away an answer that is not what the process may send', () => {
    for (const bad of [
      null,
      [],
      'text',
      { ...good, failed: 'yes' },
      { ...good, numRuns: -1 },
      { ...good, numRuns: 1.5 },
      { ...good, seed: Number.NaN },
      { ...good, counterexample: 5 },
      { ...good, message: 'x'.repeat(30_000) },
    ])
      assert.throws(() => readOutcome(bad), /not valid/);
  });

  it('does not keep a counterexample the corpus cannot read back', () => {
    assert.equal(readOutcome({ ...good, encoded: '{"not":"an example"' }).encoded, undefined);
  });
});

describe('laws in the sandbox', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('runs a normal law, with a helper and the allowed Node modules', async () => {
    const result = only(
      await run('normal', {
        'src/helper.ts':
          "import { join } from 'node:path';\nexport const twice = (n: number): number => n * 2;\nexport const joined = (a: string): string => join(a, 'x');\n",
        'src/a.laws.ts': [
          "import { twice, joined } from './helper';",
          "export law doubles(n: number) => twice(n) === n + n && joined('a').length > 1;",
          '',
        ].join('\n'),
      }),
    );
    assert.equal(result.status, 'tested', JSON.stringify(result));
    assert.equal(result.runs, 20);
  });

  it('proves a law that the prover can model, and replays a refutation in the sandbox', async () => {
    const results = await run(
      'prover',
      {
        'src/a.laws.ts': [
          'export law proves(a: number, b: number) => a + b === b + a;',
          'export law refuted(a: number) => a + 1 > a + 1;',
          '',
        ].join('\n'),
      },
      { noProve: false },
    );
    assert.equal(results.find((r) => r.name === 'proves')?.status, 'proved');
    assert.equal(results.find((r) => r.name === 'refuted')?.status, 'failed');
  });

  it('reports a counterexample from the sandbox', async () => {
    const result = only(
      await run('failing', { 'src/a.laws.ts': 'export law small(n: number) => n < 10 && n > -10;\n' }),
    );
    assert.equal(result.status, 'failed');
    assert.ok(result.counterexample !== undefined);
    assert.equal(typeof result.seed, 'number');
  });

  it('does not prove an async law', async () => {
    const result = only(
      await run(
        'async',
        { 'src/a.laws.ts': 'export law waits(n: number) => Promise.resolve(n).then((m) => m === n);\n' },
        { noProve: false },
      ),
    );
    assert.equal(result.status, 'tested', JSON.stringify(result));
  });

  it('gives up on a law that never ends, and goes on to the next one', async () => {
    const results = await run(
      'hang',
      {
        'src/a.laws.ts': [
          'export law spins(n: number) { while (true) {} }',
          'export law fine(n: number) => n === n;',
          '',
        ].join('\n'),
      },
      { propertyTimeoutMs: 1500 },
    );
    assert.match(results.find((r) => r.name === 'spins')?.message ?? '', /ran longer than/);
    assert.equal(results.find((r) => r.name === 'fine')?.status, 'tested');
  });
});

describe('what a hostile law cannot do', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('cannot write a file', async () => {
    const marker = join(root, 'wrote-it.txt');
    const files = {
      'src/a.laws.ts': [
        "import { writeFileSync } from 'node:fs';",
        `export law writes(n: number) { writeFileSync(${JSON.stringify(marker)}, 'x'); return true; }`,
        '',
      ].join('\n'),
    };
    refused(only(await run('write', files)), /"node:fs" is not a module a law may load/);
    assert.equal(existsSync(marker), false);
    // Without the sandbox the same law writes.
    const open = only(await run('write-open', files, { sandbox: false }));
    assert.equal(open.status, 'tested', JSON.stringify(open));
    assert.equal(existsSync(marker), true);
  });

  it('cannot start a process', async () => {
    refused(
      only(
        await run('spawn', {
          'src/a.laws.ts': [
            "import { execSync } from 'node:child_process';",
            "export law runs(n: number) { execSync('echo hi'); return true; }",
            '',
          ].join('\n'),
        }),
      ),
      /"node:child_process" is not a module a law may load/,
    );
  });

  it('cannot start a process through a helper the project imports', async () => {
    refused(
      only(
        await run('spawn-helper', {
          'src/helper.ts':
            "import { execSync } from 'node:child_process';\nexport const go = (): string => String(execSync('echo hi'));\n",
          'src/a.laws.ts': "import { go } from './helper';\nexport law runs(n: number) { go(); return true; }\n",
        }),
      ),
      /"node:child_process" is not a module a law may load/,
    );
  });

  it('cannot evaluate code from a string', async () => {
    refused(
      only(await run('eval', { 'src/a.laws.ts': "export law evals(n: number) => eval('1 + 1') === 2;\n" })),
      /Code generation from strings disallowed/,
    );
    refused(
      only(
        await run('function', {
          'src/a.laws.ts': "export law builds(n: number) => new Function('return 1')() === 1;\n",
        }),
      ),
      /Code generation from strings disallowed/,
    );
  });

  it('cannot reach the code constructors through a constructor chain', async () => {
    refused(
      only(
        await run('chain', {
          'src/a.laws.ts': [
            "const reach = (): unknown => ((() => 0) as any).constructor('return process')();",
            'export law chains(n: number) => reach() === undefined;',
            '',
          ].join('\n'),
        }),
      ),
      /Code generation from strings disallowed/,
    );
    refused(
      only(
        await run('chain-object', {
          'src/a.laws.ts':
            "export law chains(n: number) => (n as any).constructor.constructor('return process')() === undefined;\n",
        }),
      ),
      /Code generation from strings disallowed/,
    );
  });

  it('cannot load a file nobody reviewed', async () => {
    const files = {
      'src/evil.cjs': 'module.exports = { hello: 1 };\n',
      'src/a.laws.ts': [
        'declare const require: (id: string) => unknown;',
        "export law loads(n: number) { const name = ['./evi', 'l.cjs'].join(''); require(name); return true; }",
        '',
      ].join('\n'),
    };
    refused(only(await run('unreviewed', files)), /outside the reviewed set of files/);
    const open = only(await run('unreviewed-open', files, { sandbox: false }));
    assert.equal(open.status, 'tested', JSON.stringify(open));
  });

  it('cannot import a file nobody reviewed with import()', async () => {
    refused(
      only(
        await run('unreviewed-import', {
          'src/evil.cjs': 'module.exports = { hello: 1 };\n',
          'src/a.laws.ts':
            "export law loads(n: number) { const name = ['./evi', 'l.cjs'].join(''); return import(name).then(() => true); }\n",
        }),
      ),
      /outside the reviewed set of files/,
    );
  });

  it('cannot take the Node internals through process', async () => {
    refused(
      only(
        await run('binding', {
          'src/a.laws.ts': "export law binds(n: number) { (process as any).binding('fs'); return true; }\n",
        }),
      ),
      /process\.binding is not available/,
    );
    refused(
      only(
        await run('builtin', {
          'src/a.laws.ts':
            "export law gets(n: number) { (process as any).getBuiltinModule('child_process'); return true; }\n",
        }),
      ),
      /"child_process" is not a module a law may load/,
    );
    refused(
      only(
        await run('kill', {
          'src/a.laws.ts': 'export law kills(n: number) { process.kill(process.pid); return true; }\n',
        }),
      ),
      /process\.kill is not available/,
    );
  });

  it('cannot open a connection', async () => {
    refused(
      only(
        await run('fetch', {
          'src/a.laws.ts':
            "export law fetches(n: number) { (globalThis as any).fetch('http://127.0.0.1:1/'); return true; }\n",
        }),
      ),
      /fetch is not available/,
    );
    refused(
      only(
        await run('net', {
          'src/a.laws.ts':
            "import { connect } from 'node:net';\nexport law dials(n: number) { connect(1); return true; }\n",
        }),
      ),
      /"node:net" is not a module a law may load/,
    );
  });

  it('cannot answer in place of the host', async () => {
    refused(
      only(
        await run('send', {
          'src/a.laws.ts':
            'export law talks(n: number) { (process as any).send({ id: 1, holds: false }); return true; }\n',
        }),
      ),
      /(not a function|Cannot read|undefined)/,
    );
  });

  it(
    'cannot import an unreviewed ES module',
    { skip: typeof nodeModule.registerHooks === 'function' ? false : 'needs Node 22.15 or later' },
    async () => {
      refused(
        only(
          await run('esm', {
            'src/evil.mjs': 'export const hello = 1;\n',
            'src/a.laws.ts':
              "export law loads(n: number) { const name = './evil.mjs'; return import(name).then(() => true); }\n",
          }),
        ),
        /outside the reviewed set of files/,
      );
    },
  );
});
