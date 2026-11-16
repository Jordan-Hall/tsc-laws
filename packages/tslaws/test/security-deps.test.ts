// `tslaws security deps`: lockfiles, OSV through a mocked fetch, severity, cache, offline mode and exit codes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseConfig } from '../dist/coverage.js';
import { securityCommand } from '../dist/security/cli.js';
import { parseSecurityConfig } from '../dist/security/deps/config.js';
import { packageOf } from '../dist/security/deps/imports.js';
import { parseBunLock, parseNpmLock, parsePnpmLock, parseYarnLock } from '../dist/security/deps/lockfiles.js';
import { compareVersions, fixedVersions } from '../dist/security/deps/osv.js';
import { checkDeps, renderDeps } from '../dist/security/deps/run.js';
import { cvssScore, severityOf } from '../dist/security/deps/severity.js';

const root = mkdtempSync(join(tmpdir(), 'tslaws-sec-'));
after(() => rmSync(root, { recursive: true, force: true }));

type Init = { method: string; headers: Record<string, string>; body?: string };
interface Call {
  url: string;
  init: Init;
}

const records: Record<string, unknown> = {
  'GHSA-aaaa-bbbb-cccc': {
    id: 'GHSA-aaaa-bbbb-cccc',
    aliases: ['CVE-2021-23337'],
    summary: 'Command injection in lodash',
    database_specific: { severity: 'HIGH' },
    affected: [
      {
        package: { name: 'lodash', ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
      },
    ],
  },
  'GHSA-dddd-eeee-ffff': {
    id: 'GHSA-dddd-eeee-ffff',
    aliases: ['CVE-2022-0001'],
    summary: 'Minor leak in left-pad',
    database_specific: { severity: 'LOW' },
    affected: [
      {
        package: { name: 'left-pad', ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.3.1' }] }],
      },
    ],
  },
};

/** A fetch that answers like OSV and records every call. */
function osv(
  vulnerable: Record<string, string[]> = {
    'lodash@4.17.20': ['GHSA-aaaa-bbbb-cccc'],
    'left-pad@1.3.0': ['GHSA-dddd-eeee-ffff'],
  },
) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: Init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/querybatch')) {
      const { queries } = JSON.parse(init.body!) as { queries: { package: { name: string }; version: string }[] };
      const results = queries.map((q) => {
        const ids = vulnerable[`${q.package.name}@${q.version}`] ?? [];
        return ids.length === 0 ? {} : { vulns: ids.map((id) => ({ id, modified: '2024-01-01T00:00:00Z' })) };
      });
      return { ok: true, status: 200, json: async () => ({ results }) };
    }
    const id = decodeURIComponent(url.split('/v1/vulns/')[1]!);
    const record = records[id];
    return record === undefined
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => record };
  };
  return { fetch, calls };
}

function project(name: string, files: Record<string, string>): string {
  const cwd = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  return cwd;
}

const npmLock = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'secret-repo-name' },
    'node_modules/lodash': { version: '4.17.20' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/@scope/pkg': { version: '2.0.0' },
    'node_modules/unused': { version: '9.9.9' },
    'node_modules/mylib': { resolved: 'packages/mylib', link: true },
    'node_modules/foo/node_modules/lodash': { version: '3.0.0' },
  },
});

const sources = {
  'src/app.ts': [
    "import _ from 'lodash';",
    "import pad from 'left-pad/index';",
    "import { x } from '@scope/pkg/sub';",
    "import { y } from 'mylib';",
    "import type { T } from 'types-only';",
    "import fs from 'node:fs';",
    "import path from 'path';",
    "import { z } from './local';",
    'export const secretFunction = () => _.get(pad, x, y);',
    '',
  ].join('\n'),
};

describe('imports and lockfiles', () => {
  it('names the package behind an import specifier', () => {
    assert.equal(packageOf('lodash/fp'), 'lodash');
    assert.equal(packageOf('@scope/pkg/sub'), '@scope/pkg');
    assert.equal(packageOf('./local'), undefined);
    assert.equal(packageOf('node:fs'), undefined);
    assert.equal(packageOf('fs'), undefined);
    assert.equal(packageOf('https://example.com/x.js'), undefined);
  });
  it('reads npm lockfiles of every version', () => {
    const v3 = parseNpmLock(npmLock);
    assert.deepEqual(v3.versions.get('lodash'), ['4.17.20', '3.0.0']);
    assert.ok(v3.links.has('mylib'));
    const v1 = parseNpmLock(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } },
      }),
    );
    assert.deepEqual([...v1.versions.keys()].sort(), ['a', 'b']);
  });
  it('reads pnpm lockfiles in the v5, v6 and v9 key forms', () => {
    const text = [
      'lockfileVersion: 9.0',
      'importers:',
      '  .:',
      '    dependencies:',
      '      lodash:',
      '        version: 4.17.20',
      'packages:',
      '  lodash@4.17.20:',
      '    resolution: {integrity: sha512-x}',
      "  '@scope/pkg@2.0.0(peer@1.0.0)':",
      '    resolution: {integrity: sha512-y}',
      '  /left-pad@1.3.0:',
      '    resolution: {integrity: sha512-z}',
      '  /old/1.2.3:',
      '    resolution: {integrity: sha512-z}',
      '  /@legacy/pkg/3.0.0_react@18.0.0:',
      '    resolution: {integrity: sha512-z}',
      'snapshots:',
      '  ignored@9.9.9:',
      '',
    ].join('\n');
    const { versions } = parsePnpmLock(text);
    assert.deepEqual(versions.get('lodash'), ['4.17.20']);
    assert.deepEqual(versions.get('@scope/pkg'), ['2.0.0']);
    assert.deepEqual(versions.get('left-pad'), ['1.3.0']);
    assert.deepEqual(versions.get('old'), ['1.2.3']);
    assert.deepEqual(versions.get('@legacy/pkg'), ['3.0.0']);
    assert.equal(versions.has('ignored'), false);
  });
  it('reads yarn classic and berry lockfiles, skipping workspaces', () => {
    const classic = [
      '# yarn lockfile v1',
      '',
      'lodash@^4.17.0, lodash@^4.17.20:',
      '  version "4.17.20"',
      '  resolved "x"',
      '',
      '"@scope/pkg@^2.0.0":',
      '  version "2.0.0"',
      '',
    ].join('\n');
    assert.deepEqual(parseYarnLock(classic).versions.get('lodash'), ['4.17.20']);
    assert.deepEqual(parseYarnLock(classic).versions.get('@scope/pkg'), ['2.0.0']);
    const berry = [
      '__metadata:',
      '  version: 6',
      '',
      '"left-pad@npm:^1.3.0":',
      '  version: 1.3.0',
      '  resolution: "left-pad@npm:1.3.0"',
      '',
      '"mylib@workspace:packages/mylib":',
      '  version: 0.0.0-use.local',
      '',
    ].join('\n');
    const parsed = parseYarnLock(berry).versions;
    assert.deepEqual(parsed.get('left-pad'), ['1.3.0']);
    assert.equal(parsed.has('mylib'), false);
  });
  it('reads bun.lock with comments and trailing commas', () => {
    const text = `{
  "lockfileVersion": 1,
  "packages": {
    "lodash": ["lodash@4.17.20", "", {}, "sha512-x"],
    "@scope/pkg": ["@scope/pkg@2.0.0", "", {}, "sha512-y"],
    "mylib": ["mylib@workspace:packages/mylib"],
  },
}`;
    const { versions } = parseBunLock(text);
    assert.deepEqual(versions.get('lodash'), ['4.17.20']);
    assert.deepEqual(versions.get('@scope/pkg'), ['2.0.0']);
    assert.equal(versions.has('mylib'), false);
  });
});

describe('severity and versions', () => {
  it('scores CVSS v3 vectors and maps score to severity', () => {
    assert.equal(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
    assert.equal(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N'), 7.2);
    assert.equal(cvssScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'), undefined);
    assert.equal(
      severityOf({ id: 'x', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }),
      'critical',
    );
    assert.equal(severityOf({ id: 'x', database_specific: { severity: 'MODERATE' } }), 'moderate');
    assert.equal(severityOf({ id: 'x', database_specific: { severity: 'medium' } }), 'moderate');
    assert.equal(severityOf({ id: 'MAL-2024-1' }), 'critical');
    assert.equal(severityOf({ id: 'GHSA-none' }), 'unknown');
  });
  it('orders versions and picks the fix for the installed range', () => {
    assert.ok(compareVersions('1.2.3', '1.10.0') < 0);
    assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
    const vuln = {
      id: 'GHSA-x',
      affected: [
        {
          package: { name: 'p', ecosystem: 'npm' },
          ranges: [
            {
              type: 'SEMVER',
              events: [{ introduced: '0' }, { fixed: '1.5.0' }, { introduced: '2.0.0' }, { fixed: '2.3.0' }],
            },
          ],
        },
      ],
    };
    assert.deepEqual(fixedVersions(vuln, 'p', '1.2.0'), ['1.5.0']);
    assert.deepEqual(fixedVersions(vuln, 'p', '2.1.0'), ['2.3.0']);
    assert.deepEqual(fixedVersions(vuln, 'other', '1.2.0'), []);
  });
  it('validates the security section of tslaws.json', () => {
    assert.deepEqual(parseSecurityConfig(undefined).failOn, 'high');
    assert.equal(parseSecurityConfig({ failOn: 'medium' }).failOn, 'moderate');
    assert.throws(() => parseSecurityConfig({ failOn: 'severe' }), /failOn/);
    assert.throws(() => parseSecurityConfig({ nope: 1 }), /unknown option "nope"/);
    assert.throws(() => parseSecurityConfig({ ignore: [1] }), /ignore/);
    assert.deepEqual(parseConfig({ security: { failOn: 'critical' } }).security, { failOn: 'critical' });
  });
});

describe('checkDeps', () => {
  it('reports advisories with CVE and GHSA ids and fixed versions, and fails at high', async () => {
    const cwd = project('basic', {
      'package-lock.json': npmLock,
      'package.json': '{"name":"secret-repo-name"}',
      'tslaws.json': '{"cover":["src/**/*.ts"]}',
      ...sources,
    });
    const { fetch, calls } = osv();
    const report = await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch, noCache: true });
    assert.deepEqual(report.packages.map((p) => `${p.name}@${p.version}`).sort(), [
      '@scope/pkg@2.0.0',
      'left-pad@1.3.0',
      'lodash@3.0.0',
      'lodash@4.17.20',
    ]);
    assert.equal(report.source, 'package-lock.json');
    const lodash = report.findings.find((f) => f.name === 'lodash')!;
    assert.deepEqual(lodash.cve, ['CVE-2021-23337']);
    assert.deepEqual(lodash.ghsa, ['GHSA-aaaa-bbbb-cccc']);
    assert.deepEqual(lodash.fixed, ['4.17.21']);
    assert.equal(lodash.severity, 'high');
    assert.equal(report.failed, true);
    const text = renderDeps(report);
    assert.match(text, /FAIL\s+high\s+lodash@4\.17\.20\s+GHSA-aaaa-bbbb-cccc CVE-2021-23337\s+fixed in 4\.17\.21/);
    assert.match(text, /warn\s+low\s+left-pad@1\.3\.0/);
    assert.match(text, /1 advisory at or above high: failed/);
    assert.ok(calls.length >= 2);
  });

  it('passes below the threshold and fails when the threshold is lowered', async () => {
    const cwd = project('threshold', { 'package-lock.json': npmLock, ...sources });
    const lowOnly = osv({ 'left-pad@1.3.0': ['GHSA-dddd-eeee-ffff'] });
    assert.equal((await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch: lowOnly.fetch, noCache: true })).failed, false);
    assert.equal(
      (await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch: lowOnly.fetch, noCache: true, failOn: 'low' })).failed,
      true,
    );
    const config = parseSecurityConfig({ failOn: 'low' });
    assert.equal(
      (await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch: lowOnly.fetch, noCache: true, config })).failed,
      true,
    );
  });

  it('never sends source code, file names or the project name, and skips workspace links', async () => {
    const cwd = project('privacy', {
      'package-lock.json': npmLock,
      'package.json': '{"name":"secret-repo-name"}',
      ...sources,
    });
    const { fetch, calls } = osv();
    await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch, noCache: true });
    const sent = calls.map((c) => `${c.url}\n${c.init.body ?? ''}`).join('\n');
    for (const secret of ['secret-repo-name', 'secretFunction', 'src/app', 'mylib', 'types-only', cwd, 'import '])
      assert.equal(sent.includes(secret), false, `sent ${secret}`);
    const batch = calls.find((c) => c.url.endsWith('/v1/querybatch'))!;
    const body = JSON.parse(batch.init.body!) as { queries: Record<string, unknown>[] };
    for (const query of body.queries) assert.deepEqual(Object.keys(query).sort(), ['package', 'version']);
    for (const query of body.queries)
      assert.deepEqual(Object.keys(query.package as object).sort(), ['ecosystem', 'name']);
    assert.ok(calls.every((c) => c.url.startsWith('https://api.osv.dev/v1/')));
    assert.ok(calls.every((c) => Object.keys(c.init.headers).every((h) => ['content-type', 'accept'].includes(h))));
  });

  it('ignores reviewed advisories and keeps them in the report', async () => {
    const cwd = project('ignore', { 'package-lock.json': npmLock, ...sources });
    const { fetch } = osv();
    const config = parseSecurityConfig({ ignore: ['CVE-2021-23337'] });
    const report = await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch, noCache: true, config });
    assert.equal(report.failed, false);
    assert.equal(report.findings.find((f) => f.name === 'lodash')!.ignored, true);
  });

  it('falls back to node_modules when there is no lockfile, and lists packages with no version', async () => {
    const cwd = project('modules', {
      'node_modules/lodash/package.json': '{"name":"lodash","version":"4.17.20"}',
      'src/app.ts': "import _ from 'lodash';\nimport a from 'missing-pkg';\nexport const x = [_, a];\n",
    });
    const { fetch } = osv();
    const report = await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch, noCache: true });
    assert.equal(report.source, 'node_modules');
    assert.deepEqual(
      report.packages.map((p) => p.name),
      ['lodash'],
    );
    assert.deepEqual(report.unresolved, ['missing-pkg']);
    assert.equal(report.failed, true);
  });

  it('keeps answers in the cache and uses it offline', async () => {
    const cwd = project('cache', { 'package-lock.json': npmLock, ...sources });
    const online = osv();
    await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch: online.fetch });
    assert.ok(existsSync(join(cwd, '.tslaws', 'osv-cache.json')));
    const calls = online.calls.length;
    const again = osv();
    const cached = await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch: again.fetch });
    assert.equal(again.calls.length, 0, 'a fresh cache needs no request');
    assert.equal(cached.failed, true);
    const refused = async (): Promise<never> => {
      throw new Error('network used offline');
    };
    const offline = await checkDeps({
      cwd,
      cover: ['src/**/*.ts'],
      offline: true,
      fetch: refused as never,
      now: () => Date.now() + 1000 * 3600 * 24 * 30,
    });
    assert.equal(offline.offline, true);
    assert.equal(offline.failed, true, 'offline answers from an expired cache');
    assert.ok(calls > 0);
    // Past the TTL, an online run asks again.
    const stale = osv();
    await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch: stale.fetch, now: () => Date.now() + 1000 * 3600 * 48 });
    assert.ok(stale.calls.length > 0);
  });

  it('offline with an empty cache lists what it could not check and does not fail', async () => {
    const cwd = project('empty-cache', { 'package-lock.json': npmLock, ...sources });
    const report = await checkDeps({
      cwd,
      cover: ['src/**/*.ts'],
      offline: true,
      fetch: (() => assert.fail('network')) as never,
    });
    assert.equal(report.failed, false);
    assert.deepEqual(report.unchecked.sort(), ['@scope/pkg@2.0.0', 'left-pad@1.3.0', 'lodash@3.0.0', 'lodash@4.17.20']);
    assert.match(renderDeps(report), /not in the cache \(offline\)/);
  });

  it('reports an OSV failure as an error', async () => {
    const cwd = project('osv-down', { 'package-lock.json': npmLock, ...sources });
    const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(checkDeps({ cwd, cover: ['src/**/*.ts'], fetch: down, noCache: true }), /OSV answered 503/);
  });

  it('follows next_page_token', async () => {
    const cwd = project('pages', {
      'package-lock.json': npmLock,
      'src/app.ts': "import _ from 'lodash';\nexport const x = _;\n",
    });
    let page = 0;
    const calls: string[] = [];
    const fetch = async (url: string, init: Init) => {
      if (url.endsWith('/v1/querybatch')) {
        calls.push(init.body!);
        page += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: JSON.parse(init.body!).queries.map((_: unknown, i: number) =>
              i > 0
                ? {}
                : page === 1
                  ? { vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }], next_page_token: 'tok' }
                  : { vulns: [{ id: 'GHSA-dddd-eeee-ffff' }] },
            ),
          }),
        };
      }
      return { ok: true, status: 200, json: async () => records[decodeURIComponent(url.split('/v1/vulns/')[1]!)] };
    };
    const report = await checkDeps({ cwd, cover: ['src/**/*.ts'], fetch, noCache: true });
    assert.equal(report.findings.length, 2);
    assert.match(calls[1]!, /"page_token":"tok"/);
  });
});

describe('tslaws security deps', () => {
  const run = async (cwd: string, args: string[], flags: [string, string | true][], fetch?: never) => {
    let out = '';
    const code = await securityCommand(cwd, args, new Map(flags), (t) => (out += t), fetch);
    return { code, out };
  };
  const files = { 'package-lock.json': npmLock, ...sources, 'tslaws.json': '{"cover":["src/**/*.ts"]}' };

  it('exits 1 on a finding at or above security.failOn', async () => {
    const cwd = project('cli-fail', files);
    const { code, out } = await run(cwd, ['deps'], [['no-cache', true]], osv().fetch as never);
    assert.equal(code, 1);
    assert.match(out, /lodash@4\.17\.20/);
  });
  it('exits 0 with --fail-on critical, and takes the level from tslaws.json', async () => {
    const cwd = project('cli-pass', files);
    assert.equal(
      (
        await run(
          cwd,
          ['deps'],
          [
            ['no-cache', true],
            ['fail-on', 'critical'],
          ],
          osv().fetch as never,
        )
      ).code,
      0,
    );
    const configured = project('cli-config', {
      ...files,
      'tslaws.json': '{"cover":["src/**/*.ts"],"security":{"failOn":"critical"}}',
    });
    assert.equal((await run(configured, ['deps'], [['no-cache', true]], osv().fetch as never)).code, 0);
  });
  it('prints JSON with --json', async () => {
    const cwd = project('cli-json', files);
    const { out } = await run(
      cwd,
      ['deps'],
      [
        ['no-cache', true],
        ['json', true],
      ],
      osv().fetch as never,
    );
    const report = JSON.parse(out) as { failed: boolean; findings: { id: string }[] };
    assert.equal(report.failed, true);
    assert.ok(report.findings.some((f) => f.id === 'GHSA-aaaa-bbbb-cccc'));
  });
  it('exits 2 when the check cannot run, and on a bad level or subcommand', async () => {
    const cwd = project('cli-error', files);
    const down = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const failed = await run(cwd, ['deps'], [['no-cache', true]], down as never);
    assert.equal(failed.code, 2);
    assert.match(failed.out, /--offline/);
    assert.equal((await run(cwd, ['deps'], [['fail-on', 'severe']])).code, 2);
    assert.equal((await run(cwd, ['list'], [])).code, 2);
  });
  it('--offline reads the cache only', async () => {
    const cwd = project('cli-offline', files);
    await run(cwd, ['deps'], [], osv().fetch as never);
    const refused = (async () => assert.fail('network')) as never;
    const { code, out } = await run(cwd, ['deps'], [['offline', true]], refused);
    assert.equal(code, 1);
    assert.match(out, /offline \(cache only\)/);
  });
});
