// The law sandbox (src/sandbox.ts): laws run in a child process under Node's permission model, behind a module guard.
// Each attack is a law that tries something a law has no business doing; with the sandbox on it must not get it, and with
// `sandbox: false` the same law does, which shows the sandbox is what stopped it.
// Needs the built compiler in TSC_LAWS_BIN and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import nodeModule from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { grantOutside, hostConfig, permissionFlag, readOutcome, sandboxFlags, useSandbox } from '../dist/sandbox.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-'));
// Projects with files outside them sit beside each other in a directory that no workspace of this repository contains, so
// that what the sandbox may read there is decided by what the project names and not by the repository's own layout.
const apart = mkdtempSync(join(tmpdir(), 'tslaws-apart-'));
let base = root;

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(apart, { recursive: true, force: true });
  // Z3's worker threads keep the test process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function project(name: string, files: Record<string, string>): string {
  const dir = join(base, name);
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
    assert.throws(() => useSandbox({}, '18.19.0'), /Node 22.15, 23.5 or later.*--no-sandbox/s);
    assert.throws(() => useSandbox({}, '22.14.0'), /loader hooks/);
    assert.equal(useSandbox({}, '22.15.0'), true);
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

describe('the configuration of a law process', () => {
  it('differs when the source of a transformed file does, so a process is not reused for an old revision', () => {
    const cwd = project('config-key', { 'src/x.ts': 'export const x: number = 1;\n' });
    const outDir = join(cwd, '.tslaws', 'out');
    const before = hostConfig(cwd, ['src/x.ts'], outDir, []);
    assert.ok(
      Object.keys(before.transforms).some((key) => key.startsWith('ts:')),
      'the file is transformed at load',
    );
    assert.equal(hostConfig(cwd, ['src/x.ts'], outDir, []).key, before.key, 'unchanged source, same key');
    writeFileSync(join(cwd, 'src', 'x.ts'), 'export const x: number = 2;\n');
    assert.notEqual(hostConfig(cwd, ['src/x.ts'], outDir, []).key, before.key);
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

  it('does not let a process learn what it runs on from /proc and /run', { skip: process.platform === 'win32' }, () => {
    for (const path of ['/proc/version', '/proc/sys/fs/binfmt_misc/WSLInterop', '/run/WSL'])
      assert.match(script(`require('node:fs').existsSync(${JSON.stringify(path)})`).stderr, /ERR_ACCESS_DENIED/);
  });

  it('does not load playwright-core, which probes for WSL, with the code a law process runs', () => {
    const browser = new URL('../dist/browser.js', import.meta.url).href;
    const probe = spawnSync(
      process.execPath,
      [
        ...sandboxFlags(root, [fileURLToPath(new URL('..', import.meta.url))]),
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(browser)}); const { createRequire } = await import('node:module');
         const loaded = Object.keys(createRequire(${JSON.stringify(browser)}).cache).filter((file) => file.includes('playwright-core'));
         if (loaded.length > 0) throw new Error('loaded ' + loaded[0]);`,
      ],
      { encoding: 'utf8', cwd: root },
    );
    assert.equal(probe.status, 0, probe.stderr);
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
      { propertyTimeoutMs: 5000 },
    );
    assert.match(results.find((r) => r.name === 'spins')?.message ?? '', /ran longer than/);
    assert.equal(results.find((r) => r.name === 'fine')?.status, 'tested');
  });

  it('ends the process of a law that ignores SIGTERM and spins, when it times out', async () => {
    const cwd = project('sigterm', {
      'src/a.laws.ts': [
        'export law spins(n: number) {',
        "  process.on('SIGTERM', () => {});",
        "  process.stderr.write('law-pid=' + process.pid + '\\n');",
        '  while (true) {}',
        '}',
        '',
      ].join('\n'),
    });
    const script = join(cwd, 'run.mjs');
    writeFileSync(
      script,
      `import { check } from ${JSON.stringify(new URL('../dist/check.js', import.meta.url).href)};\n` +
        `const report = await check(JSON.parse(process.argv[2]), false);\n` +
        `process.stdout.write(JSON.stringify(report.results.map((r) => r.message)));\n`,
    );
    const ran = spawnSync(
      process.execPath,
      [script, JSON.stringify(options(cwd, ['src/a.laws.ts'], { propertyTimeoutMs: 6000 }))],
      { encoding: 'utf8', timeout: 60000 },
    );
    const pid = Number(/law-pid=(\d+)/.exec(ran.stderr)?.[1]);
    try {
      assert.ok(pid > 0, `the law did not report its process: ${ran.stderr}`);
      assert.equal(ran.status, 0, ran.stderr);
      assert.match(ran.stdout, /ran longer than/);
      // The signal could not be handled while the loop ran, so only a kill that cannot be caught has ended it.
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone already
      }
    }
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

  it('refuses an end-to-end law unless the person allows it, and never runs it by itself', async () => {
    const cwd = project('e2e-refused', {
      'src/a.e2e.laws.ts': 'export law reaches(n: number) { return n === n; }\n',
    });
    const asked = (await check(options(cwd, ['src/a.e2e.laws.ts']), false)).results;
    refused(only(asked), /end-to-end laws run outside the sandbox.*--allow-e2e/s);
    // Leaving the option out is the sandbox on, not off.
    const unset = (await check({ ...options(cwd, ['src/a.e2e.laws.ts']), sandbox: undefined }, false)).results;
    refused(only(unset), /--allow-e2e/);
  });

  it('decides what a law may load from the file that asks, not from a parent it names', async () => {
    const trusted = "process.cwd() + '/node_modules/typescript/lib/typescript.js'";
    refused(
      only(
        await run('forged-parent', {
          'src/a.laws.ts': [
            'declare const module: any;',
            `export law forges(n: number) { module.constructor._load('node:fs', { filename: ${trusted} }, false); return true; }`,
            '',
          ].join('\n'),
        }),
      ),
      /"node:fs" is not a module a law may load/,
    );
    refused(
      only(
        await run('forged-require', {
          'src/a.laws.ts': [
            'declare const module: any;',
            `export law forges(n: number) { module.constructor.prototype.require.call({ filename: ${trusted} }, 'fs'); return true; }`,
            '',
          ].join('\n'),
        }),
      ),
      /"fs" is not a module a law may load/,
    );
  });

  it('cannot take the module loader out or put a hook of its own in front of it', async () => {
    const attempt = (name: string, body: string) =>
      run(name, {
        'src/a.laws.ts': [
          'declare const module: any;',
          `export law tampers(n: number) { const Module = module.constructor; ${body}; return true; }`,
          '',
        ].join('\n'),
      });
    refused(
      only(
        await attempt('hooks', 'Module.registerHooks({ resolve: (s: string, c: unknown, next: any) => next(s, c) })'),
      ),
      /module\.registerHooks is not available/,
    );
    // The loader's functions and tables are read-only: the assignment fails (compiled laws are strict).
    for (const target of ['_load', '_resolveFilename', '_extensions', '_cache', 'createRequire']) {
      const result = only(await attempt(`replace-${target}`, `Module.${target} = () => 'x'`));
      refused(result, /read only|read-only|Cannot assign/);
    }
    // With the loader's own functions at hand, what is outside the set stays out.
    refused(
      only(await attempt('private-load', "Module._load('node:child_process', null, false)")),
      /"node:child_process" is not a module a law may load/,
    );
  });

  it("cannot forge a message to the host, or listen for the host's", async () => {
    const attempt = (name: string, body: string) =>
      run(name, {
        'src/a.laws.ts': `declare const require: any;\nexport law talks(n: number) { ${body}; return true; }\n`,
      });
    // A second `configure` that would widen the reviewed set changes nothing: the process takes the first one only.
    const forged = only(
      await attempt(
        'forge-configure',
        "(process as any).emit('message', { type: 'configure', token: 'x'.repeat(32), guard: { trees: ['/'], files: [], packages: [], modules: [] }, transforms: {} }); require('fs')",
      ),
    );
    refused(forged, /"fs" is not a module a law may load/);
    const run1 = only(
      await attempt('forge-run', "(process as any).emit('message', { type: 'run', id: 1 }); require('fs')"),
    );
    refused(run1, /"fs" is not a module a law may load/);
    for (const name of ['send', '_send', 'channel', '_channel']) {
      const result = only(
        await attempt(
          `hidden-${name}`,
          `if ((process as any).${name} !== undefined) throw new Error('the ${name} of the process is visible')`,
        ),
      );
      assert.equal(result.status, 'tested', JSON.stringify(result));
    }
    const listen = only(
      await attempt(
        'listen',
        "process.on('message', () => undefined); if ((process as any).listeners('message').length !== 0) throw new Error('listening')",
      ),
    );
    assert.equal(listen.status, 'tested', JSON.stringify(listen));
  });

  it('does not hand the credentials of the environment to a law', async () => {
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, NPM_TOKEN: process.env.NPM_TOKEN };
    process.env.GITHUB_TOKEN = 'ghp_secret_value';
    process.env.NPM_TOKEN = 'npm_secret_value';
    try {
      const law =
        "export law leaks(n: number) { const e = process.env; if (e.GITHUB_TOKEN !== undefined || e.NPM_TOKEN !== undefined) throw new Error('leaked'); return true; }\n";
      const result = only(await run('env', { 'src/a.laws.ts': law }));
      assert.equal(result.status, 'tested', JSON.stringify(result));
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });

  it('trusts only the packages that are declared, and gives none the process or module internals', async () => {
    const pkg = (name: string, body: string): Record<string, string> => ({
      [`node_modules/${name}/package.json`]: JSON.stringify({ name, main: 'index.js' }),
      [`node_modules/${name}/index.js`]: body,
    });
    const files = (declared: string[]): Record<string, string> => ({
      'package.json': JSON.stringify({
        name: 'p',
        dependencies: Object.fromEntries(declared.map((d) => [d, '1.0.0'])),
      }),
      ...pkg('declared', "exports.read = () => typeof require('node:path').join;\n"),
      ...pkg('stranger', "exports.read = () => typeof require('node:path').join;\n"),
      ...pkg('meddler', "exports.read = () => typeof require('node:module').createRequire;\n"),
    });
    const use = (name: string, declared: string[], from: string) =>
      run(name, {
        ...files(declared),
        'src/a.laws.ts': `import * as pkg from '${from}';\nexport law uses(n: number) { return (pkg as any).read() === 'function'; }\n`,
      });
    const declared = only(await use('pkg-declared', ['declared'], 'declared'));
    assert.equal(declared.status, 'tested', JSON.stringify(declared));
    refused(only(await use('pkg-stranger', ['declared'], 'stranger')), /outside the reviewed set of files/);
    // A trusted package still gets neither `module` nor `process`.
    refused(only(await use('pkg-meddler', ['meddler'], 'meddler')), /"node:module" is not a module a law may load/);
    // And the law itself gets no `fs`, whatever packages are around.
    refused(
      only(
        await run('law-fs', {
          ...files(['declared']),
          'src/a.laws.ts':
            "import { readFileSync } from 'node:fs';\nexport law reads(n: number) { return typeof readFileSync === 'function'; }\n",
        }),
      ),
      /"node:fs" is not a module a law may load/,
    );
  });

  it('does not let a trusted package load a Node module for a law that is on the stack', async () => {
    const helper = [
      'exports.load = (name) => require(name);',
      'exports.builtin = (name) => process.getBuiltinModule(name);',
      "exports.spawn = () => require('node:child_process').spawnSync;",
      "exports.read = () => require('node:fs').readFileSync;",
      '',
    ].join('\n');
    const files = (call: string): Record<string, string> => ({
      'package.json': JSON.stringify({ name: 'p', dependencies: { helper: '1.0.0' } }),
      'node_modules/helper/package.json': JSON.stringify({ name: 'helper', main: 'index.js' }),
      'node_modules/helper/index.js': helper,
      'src/a.laws.ts': `import * as h from 'helper';
export law asks(n: number) { return typeof (h as any).${call} === 'function'; }
`,
    });
    // The helper asks for child_process itself, with a law up the stack.
    refused(only(await run('stack-spawn', files('spawn()'))), /"node:child_process" is not a module a law may load/);
    // The law names the module; the helper only passes the name on.
    refused(
      only(await run('stack-load', files("load('node:child_process').spawnSync"))),
      /"node:child_process" is not a module/,
    );
    refused(
      only(await run('stack-fs', files("load('node:fs').readFileSync"))),
      /"node:fs" is not a module a law may load/,
    );
    // `process.getBuiltinModule` obeys the same rule.
    refused(
      only(await run('stack-getbuiltin', files("builtin('node:fs').readFileSync"))),
      /"node:fs" is not a module a law may load/,
    );
    refused(only(await run('stack-fs-direct', files('read()'))), /"node:fs" is not a module a law may load/);
  });

  it(
    'lets the loader link the imports of an ES module package a law loads, but not an import() it makes for the law',
    { skip: typeof nodeModule.registerHooks === 'function' ? false : 'needs Node 22.15 or later' },
    async () => {
      const files = (body: string): Record<string, string> => ({
        'package.json': JSON.stringify({ name: 'p', dependencies: { esmhelper: '1.0.0' } }),
        'node_modules/esmhelper/package.json': JSON.stringify({
          name: 'esmhelper',
          type: 'module',
          exports: './index.js',
        }),
        'node_modules/esmhelper/index.js': [
          "import { readFileSync } from 'node:fs';",
          'export const linked = typeof readFileSync === "function";',
          'export const dyn = (name) => import(name);',
          '',
        ].join('\n'),
        'src/a.laws.ts': `import * as h from 'esmhelper';\nexport law asks(n: number) { ${body} }\n`,
      });
      // The package's own `import ... from 'node:fs'` is linked on the law's behalf.
      assert.equal(only(await run('link-esm', files('return (h as any).linked === true;'))).status, 'tested');
      // A function of the package that imports what the law names is the law's request.
      refused(
        only(await run('link-esm-dyn', files("return (h as any).dyn('node:child_process').then(() => true);"))),
        /"node:child_process" is not a module a law may load/,
      );
    },
  );

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

describe('reads outside the project', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  before(() => {
    base = apart;
  });
  after(() => {
    base = root;
  });

  const double = 'export const double = (n: number): number => n * 2;\n';
  const law = "import { double } from '@lib/x';\nexport law doubles(n: number) { return double(n) === n + n; }\n";
  const config = (name: string) => JSON.stringify({ compilerOptions: { paths: { '@lib/*': [`../${name}-lib/*`] } } });

  /** What the run printed to stderr, with its result. */
  async function told(name: string, files: Record<string, string>): Promise<{ result: LawResult; said: string }> {
    const write = process.stderr.write.bind(process.stderr);
    let said = '';
    process.stderr.write = ((text: string) => ((said += text), true)) as typeof process.stderr.write;
    try {
      return { result: only(await run(name, files)), said };
    } finally {
      process.stderr.write = write;
    }
  }

  /** A law over `@lib/x`, which `paths` names, and `x` re-exports `double` from a directory nothing else names. */
  const files = (name: string, extra: Record<string, string>, other = `${name}-other/y.ts`) => ({
    'package.json': '{"name":"app"}',
    'tsconfig.json': config(name),
    [`../${name}-lib/x.ts`]: `export { double } from '../${other.split('/')[0]}/y';\n`,
    [`../${other}`]: double,
    'src/a.laws.ts': law,
    ...extra,
  });

  it('does not grant a directory that nothing names, and says how to allow it', async () => {
    const { result, said } = await told('reads-unnamed', files('reads-unnamed', {}));
    // The compiled output is what loads, so the law still runs; the source is not readable.
    assert.equal(result.status, 'tested', JSON.stringify(result));
    assert.match(said, /the law sandbox may not read .*reads-unnamed-other.*"sandboxReads" in tslaws\.json/s);
  });

  it('grants the directory the person names under sandboxReads, and prints it', async () => {
    const { result, said } = await told(
      'reads-named',
      files('reads-named', { 'tslaws.json': JSON.stringify({ sandboxReads: ['../reads-named-other'] }) }),
    );
    assert.equal(result.status, 'tested', JSON.stringify(result));
    assert.match(said, /the law sandbox may read .*reads-named-other.*"sandboxReads" in tslaws\.json/s);
    assert.match(said, /the law sandbox may read .*reads-named-lib.*a target of the tsconfig/s);
  });

  it('refuses a dotfile even under a directory that is named', () => {
    const cwd = project('reads-dot/app', { 'tslaws.json': JSON.stringify({ sandboxReads: ['../shared'] }) });
    const fine = join(base, 'reads-dot', 'shared', 'src', 'y.ts');
    const hidden = join(base, 'reads-dot', 'shared', 'src', '.secret', 'y.ts');
    const write = process.stderr.write.bind(process.stderr);
    let said = '';
    process.stderr.write = ((text: string) => ((said += text), true)) as typeof process.stderr.write;
    try {
      const { granted, refused } = grantOutside(cwd, [fine, hidden]);
      assert.deepEqual([granted, refused], [[fine], [hidden]]);
    } finally {
      process.stderr.write = write;
    }
    assert.match(said, /may read .*src.*"sandboxReads"/s);
    assert.match(said, /may not read .*\.secret.*holds \.secret, a dotfile/s);
  });

  it('refuses the home directory, what is above it and a file system root, even when named', () => {
    const cwd = project('reads-home', {
      'tslaws.json': JSON.stringify({ sandboxReads: [homedir(), dirname(homedir()), parse(homedir()).root] }),
    });
    const inside = join(homedir(), 'project', 'x.ts');
    const write = process.stderr.write.bind(process.stderr);
    let said = '';
    process.stderr.write = ((text: string) => ((said += text), true)) as typeof process.stderr.write;
    try {
      const { granted, refused } = grantOutside(cwd, [inside]);
      assert.deepEqual([granted, refused], [[], [inside]]);
    } finally {
      process.stderr.write = write;
    }
    assert.match(said, /may not read .*(home directory|root of a file system)/);
  });

  // Every grant check below runs `grantOutside` with its messages collected, since a person reads them.
  const grant = (cwd: string, files: string[]) => {
    const write = process.stderr.write.bind(process.stderr);
    let said = '';
    process.stderr.write = ((text: string) => ((said += text), true)) as typeof process.stderr.write;
    try {
      return { ...grantOutside(cwd, files), said };
    } finally {
      process.stderr.write = write;
    }
  };

  it(
    'finds the home directory whatever the case of its name, where the file system ignores case',
    { skip: process.platform === 'linux' ? 'case matters on this file system' : false },
    () => {
      const home = homedir();
      const cwd = project('reads-case', { 'tslaws.json': JSON.stringify({ sandboxReads: [home.toLowerCase()] }) });
      const inside = join(home.toUpperCase(), 'case-check', 'x.ts');
      const { granted, refused, said } = grant(cwd, [inside]);
      assert.deepEqual([granted, refused], [[], [inside]]);
      assert.match(said, /home directory/);
    },
  );

  it('refuses a root under a dot directory, wherever in its path the dot is', () => {
    const cwd = project('reads-dotparent/app', {
      'tslaws.json': JSON.stringify({ sandboxReads: ['../.hid/lib'] }),
      '../.hid/lib/sub/x.ts': double,
    });
    const file = join(base, 'reads-dotparent', '.hid', 'lib', 'sub', 'x.ts');
    const { granted, refused, said } = grant(cwd, [file]);
    assert.deepEqual([granted, refused], [[], [file]]);
    assert.match(said, /may not read .*x\.ts.*sits in \.hid, a dotfile/s);
  });

  it('judges a file beside a project in a dot directory by that directory too', () => {
    // The project sits at <dir>/.work/proj; what it shares with <dir>/.work/secret is no reason to read it.
    const cwd = project('reads-dotshared/.work/proj', {
      'tslaws.json': JSON.stringify({ sandboxReads: ['../secret'] }),
      '../secret/key.ts': double,
    });
    const file = join(base, 'reads-dotshared', '.work', 'secret', 'key.ts');
    const { granted, refused, said } = grant(cwd, [file]);
    assert.deepEqual([granted, refused], [[], [file]]);
    assert.match(said, /may not read .*key\.ts.*sits in \.work, a dotfile/s);
  });

  it('does not follow a link from a named directory to a dotted place', () => {
    const cwd = project('reads-link/app', {
      'tslaws.json': JSON.stringify({ sandboxReads: ['../lib'] }),
      '../lib/ok.ts': double,
      '../.hid/real.ts': double,
    });
    const lib = join(base, 'reads-link', 'lib');
    try {
      symlinkSync(join(base, 'reads-link', '.hid'), join(lib, 'sub'), 'junction');
    } catch {
      return; // links are not allowed here
    }
    const ok = join(lib, 'ok.ts');
    const linked = join(lib, 'sub', 'real.ts');
    const { granted, refused } = grant(cwd, [ok, linked]);
    assert.deepEqual([granted, refused], [[ok], [linked]]);
  });
});
