// Performance optimizations (Phases 1 & 2): proof cache, RARE DB cache, deferred derived flush, config cache,
// and DAG-preserving `(let ...)` sharing in CHC Horn clauses.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rareDeclarations } from '../dist/certificates.js';
import { check } from '../dist/check.js';
import { hornText, type HornSystem } from '../dist/chc.js';
import { readManifest } from '../dist/compile.js';
import { readConfig } from '../dist/coverage.js';
import { derivedStore } from '../dist/derived.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, ManifestLaw } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-opt-'));
const tempRoot = mkdtempSync(join(tmpdir(), 'tslaws-opt-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('proof & certificate caching', () => {
  it('writes .tslaws/proof-cache.json and invalidates when code changes', async () => {
    const cwd = join(root, 'proof-cache');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/math.ts'), 'export const add = (a: number, b: number): number => a + b;\n');
    writeFileSync(
      join(cwd, 'src/math.laws.ts'),
      [
        "import { law } from 'tslaws';",
        "import { add } from './math';",
        "law.proved('add commutes', (a: number, b: number) => add(a, b) === add(b, a));",
        '',
      ].join('\n'),
    );
    const opts: CheckOptions = {
      files: ['src/math.laws.ts'],
      cwd,
      runs: 60,
      compiler: 'builtin',
      lockFile: join(cwd, 'tsc-laws.lock'),
      noProve: false,
      bound: 4,
      proofTimeoutMs: 5000,
    };
    writeLock(opts.lockFile, readManifest('builtin', opts.files, cwd));
    const first = await check(opts, true);
    assert.equal(first.ok, true);
    assert.equal(first.results[0]?.status, 'proved');
    const cacheFile = join(cwd, '.tslaws', 'proof-cache.json');
    assert.ok(existsSync(cacheFile), 'proof cache was written');
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as { entries: Record<string, unknown> };
    assert.ok(Object.keys(cached.entries).length >= 1);

    // Second check reuses cached proof cleanly.
    const second = await check(opts, true);
    assert.equal(second.ok, true);
    assert.equal(second.results[0]?.status, 'proved');

    // Breaking the implementation invalidates the cache key and fails.
    writeFileSync(join(cwd, 'src/math.ts'), 'export const add = (a: number, b: number): number => a - b;\n');
    writeLock(opts.lockFile, readManifest('builtin', opts.files, cwd));
    const broken = await check(opts, true);
    assert.equal(broken.ok, false);
    assert.equal(broken.results[0]?.status, 'failed');
  });

  it('caches rareDeclarations per cvc5 binary instead of spawning cvc5 on every law', async () => {
    const dir = join(tempRoot, 'rare-cache');
    mkdirSync(dir, { recursive: true });
    const countFile = join(dir, 'count.txt');
    const fakeCvc5 = join(dir, 'cvc5.mjs');
    writeFileSync(
      fakeCvc5,
      [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        `const f = ${JSON.stringify(countFile)};`,
        'const n = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;',
        'writeFileSync(f, String(n + 1));',
        'console.log("(declare-rule eq-refl ((@T0 Type) (t1 @T0))\\n  :args (t1)\\n  :conclusion (= (= t1 t1) true)\\n)");',
        '',
      ].join('\n'),
    );
    const saved = process.env.TSLAWS_CVC5;
    process.env.TSLAWS_CVC5 = fakeCvc5;
    try {
      const a = await rareDeclarations(['eq-refl'], dir, 5000);
      const b = await rareDeclarations(['eq-refl'], dir, 5000);
      assert.ok('text' in a && 'text' in b);
      assert.equal(a.text, b.text);
      assert.equal(readFileSync(countFile, 'utf8'), '1', 'cvc5 -o rare-db should only run once per binary');
    } finally {
      if (saved === undefined) delete process.env.TSLAWS_CVC5;
      else process.env.TSLAWS_CVC5 = saved;
    }
  });
});

describe('deferred derived flush and config cache', () => {
  it('writes derived.json only when flush() is called', () => {
    const cwd = join(tempRoot, 'derived-flush');
    mkdirSync(cwd, { recursive: true });
    const store = derivedStore(cwd, 'build-key-1');
    const law: ManifestLaw = {
      file: 'a.laws.ts',
      name: 'id',
      exported: true,
      proved: false,
      line: 1,
      params: ['x'],
      body: 'true',
      text: 'law("id", (x: number) => true)',
      problems: [],
    };
    store.law(law, () => ({ generators: [], plans: [{ k: 'number' }], shapes: ['number'] }));
    assert.equal(existsSync(join(cwd, '.tslaws', 'derived.json')), false, 'not written before flush');
    store.flush();
    assert.equal(existsSync(join(cwd, '.tslaws', 'derived.json')), true, 'written after flush');
  });

  it('caches readConfig and invalidates immediately on edit', () => {
    const cwd = join(tempRoot, 'config-cache');
    mkdirSync(cwd, { recursive: true });
    assert.deepEqual(readConfig(cwd), {});
    writeFileSync(join(cwd, 'tslaws.json'), JSON.stringify({ runs: 77 }));
    assert.equal(readConfig(cwd).runs, 77);
    assert.equal(readConfig(cwd).runs, 77);
    writeFileSync(join(cwd, 'tslaws.json'), JSON.stringify({ runs: 88 }));
    assert.equal(readConfig(cwd).runs, 88);
  });
});

describe('CHC let-binding sharing', () => {
  it('emits topological (let ...) bindings instead of exponentially expanding shared terms', () => {
    const shared = new Map<string, string>();
    shared.set('_s0', '(+ x 1)');
    // Chain where textual expansion would double 25 times (2^25 copies -> OOM), while let stays linear.
    for (let i = 1; i <= 25; i += 1) shared.set(`_s${i}`, `(+ _s${i - 1} _s${i - 1})`);
    const system: HornSystem = {
      predicates: [{ name: 'Inv0', sorts: ['Int'], names: ['x'] }],
      constants: [{ name: 'x', sort: 'Int' }],
      clauses: ['(=> (>= x 0) (Inv0 _s25))'],
      shared,
    };
    const text = hornText(system);
    assert.ok(text.includes('(let ((_s0 (+ x 1)))'), 'binds _s0 via let');
    assert.ok(text.includes('(let ((_s25 (+ _s24 _s24)))'), 'binds _s25 via let');
    assert.ok(text.length < 4000, `clause size stays linear, got ${text.length}`);
  });
});
