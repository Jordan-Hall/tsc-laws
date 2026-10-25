// Run settings in tslaws.json: validation, precedence (flag > tslaws.json > default) and their effect on check.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { parseConfig, readConfig } from '../dist/coverage.js';
import { checkDefaults, mutateDefaults, resolveSettings } from '../dist/settings.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-settings-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

describe('tslaws.json run settings', () => {
  it('accepts the four keys', () => {
    const config = parseConfig({ runs: 5, propertyTimeoutMs: 100, proofTimeoutMs: 200, bound: 3, $schema: 'x' });
    assert.equal(config.runs, 5);
    assert.equal(config.bound, 3);
  });

  it('rejects a wrong type, a value below 1 and a non-integer', () => {
    assert.throws(() => parseConfig({ runs: '5' }), /"runs" must be an integer of at least 1/);
    assert.throws(() => parseConfig({ bound: 0 }), /"bound" must be an integer of at least 1/);
    assert.throws(() => parseConfig({ proofTimeoutMs: -1 }), /"proofTimeoutMs"/);
    assert.throws(() => parseConfig({ propertyTimeoutMs: 1.5 }), /"propertyTimeoutMs"/);
  });

  it('rejects unknown keys and a non-object', () => {
    assert.throws(() => parseConfig({ run: 5 }), /unknown option "run".*supported options are cover/);
    assert.throws(() => parseConfig([]), /must be a JSON object/);
  });

  it('readConfig reports the file name in its errors', () => {
    const dir = join(root, 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tslaws.json'), JSON.stringify({ runs: 0 }));
    assert.throws(() => readConfig(dir), /tslaws\.json: "runs"/);
  });
});

describe('precedence', () => {
  const flags = (entries: Record<string, string | true>): Map<string, string | true> =>
    new Map(Object.entries(entries));
  const config = { runs: 7, bound: 2, proofTimeoutMs: 11, propertyTimeoutMs: 22 };

  it('uses the built-in default when neither is given', () => {
    const s = resolveSettings(flags({}), {});
    assert.deepEqual([s.runs, s.bound, s.proofTimeoutMs, s.propertyTimeoutMs], [200, 4, 5000, 30000]);
    assert.deepEqual(s.explicit, []);
  });

  it('uses the mutate defaults on request', () => {
    const s = resolveSettings(flags({}), {}, mutateDefaults);
    assert.equal(s.runs, 30);
    assert.equal(s.proofTimeoutMs, checkDefaults.proofTimeoutMs);
    assert.equal(s.propertyTimeoutMs, checkDefaults.propertyTimeoutMs);
  });

  it('lets tslaws.json beat the default, including the mutate default', () => {
    for (const defaults of [checkDefaults, mutateDefaults]) {
      const s = resolveSettings(flags({}), config, defaults);
      assert.deepEqual([s.runs, s.bound, s.proofTimeoutMs, s.propertyTimeoutMs], [7, 2, 11, 22]);
      assert.deepEqual(s.explicit, []);
    }
  });

  it('lets a flag beat tslaws.json', () => {
    const s = resolveSettings(
      flags({ runs: '9', bound: '6', 'proof-timeout': '33', 'property-timeout': '44' }),
      config,
    );
    assert.deepEqual([s.runs, s.bound, s.proofTimeoutMs, s.propertyTimeoutMs], [9, 6, 33, 44]);
    assert.deepEqual(s.explicit, ['runs', 'property-timeout']);
  });
});

describe('check with tslaws.json settings', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('runs a tested law exactly `runs` times', async () => {
    const cwd = join(root, 'runs');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'tslaws.json'), JSON.stringify({ runs: 5 }));
    writeFileSync(
      join(cwd, 'src/a.laws.ts'),
      'export law sorted(xs: number[]) => [...xs].sort((a, b) => a - b).length === xs.length;\n',
    );
    const settings = resolveSettings(new Map(), readConfig(cwd));
    const report = await check(
      {
        files: ['src/a.laws.ts'],
        cwd,
        runs: settings.runs,
        compiler: compiler!,
        lockFile: join(cwd, 'tsc-laws.lock'),
        noProve: true,
        bound: settings.bound,
        proofTimeoutMs: settings.proofTimeoutMs,
        propertyTimeoutMs: settings.propertyTimeoutMs,
        explicit: settings.explicit,
      },
      false,
    );
    const result = report.results.find((r) => r.name === 'sorted');
    assert.equal(result?.status, 'tested', JSON.stringify(report.results));
    assert.equal(result.runs, 5);
  });
});
