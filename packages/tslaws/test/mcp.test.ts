// The MCP server, driven over stdio by a scripted client. Needs `npm run build` and TSC_LAWS_BIN.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { proposalName } from '../dist/proposals.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'tslaws.js');
const root = mkdtempSync(join(here, '..', '.tmp-mcp-'));

const lawsText = 'import { double } from "./f";\n\nexport law doubles(n: number) => double(n) === n + n;\n';
const proposal = 'import { double } from "./src/f";\n\nexport law doubleIsTwice(n: number) => double(n) === n * 2;\n';

let child: ChildProcessWithoutNullStreams;
const pending = new Map<number, (message: any) => void>();
let nextId = 1;

function request(method: string, params: unknown = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function callTool(name: string, args: unknown = {}): Promise<{ isError?: boolean; data: any; text: string }> {
  const reply = await request('tools/call', { name, arguments: args });
  assert.equal(reply.error, undefined);
  const text = reply.result.content[0].text as string;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // an error message
  }
  return { isError: reply.result.isError, data, text };
}

before(async () => {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'f.ts'), 'export const double = (n: number): number => n + n;\n');
  writeFileSync(join(root, 'src', 'f.laws.ts'), lawsText);
  child = spawn(process.execPath, [bin, 'mcp', ...(compiler === undefined ? [] : ['--compiler', compiler])], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line); // every stdout line must be a JSON-RPC message
    pending.get(message.id)?.(message);
  });
  child.stderr.resume();
});

after(async () => {
  if (child !== undefined && child.exitCode === null) {
    const closed = new Promise((done) => child.once('close', done));
    child.stdin.end();
    child.kill();
    await closed;
  }
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

describe('mcp server', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('initializes and answers ping', async () => {
    const reply = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    assert.equal(reply.result.protocolVersion, '2025-06-18');
    assert.deepEqual(reply.result.serverInfo.name, 'tslaws');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    assert.deepEqual((await request('ping')).result, {});
    assert.equal((await request('nope')).error.code, -32601);
  });

  it('lists the five tools and none that accepts or touches the lock', async () => {
    const names = ((await request('tools/list')).result.tools as { name: string }[]).map((t) => t.name);
    assert.deepEqual(names.sort(), [
      'tslaws_check',
      'tslaws_check_proposed',
      'tslaws_explain',
      'tslaws_list',
      'tslaws_propose',
    ]);
    assert.ok(!names.some((n) => /accept|lock|promote/.test(n)));
  });

  it('checks a tiny project with hints', async () => {
    const out = await callTool('tslaws_check', { files: ['src/f.laws.ts'] });
    assert.equal(out.isError, undefined);
    const doubles = out.data.results.find((r: { name: string }) => r.name === 'doubles');
    assert.ok(doubles);
    // No lock was accepted, so the law is tampered and the hint says who acts.
    assert.equal(out.data.lockMissing, true);
    assert.match(doubles.hint, /accept/);
    const summary = await callTool('tslaws_check', { summary: true });
    assert.match(summary.data.totals, /1 laws/);
  });

  it('proposes into .tslaws/proposals only, and checks it', async () => {
    const out = await callTool('tslaws_propose', { name: 'doubleIsTwice', source: proposal, file: 'f.ts' });
    assert.equal(out.isError, undefined, out.text);
    assert.equal(out.data.file, '.tslaws/proposals/f.ts');
    assert.equal(out.data.results.length, 1);
    assert.match(out.data.results[0].status, /proved|bounded|tested/);
    const stored = join(root, '.tslaws', 'proposals', 'f.ts');
    const written = readFileSync(stored, 'utf8');
    assert.ok(written.includes('export law doubleIsTwice'));
    // The import written from the project root is stored where the file resolves it.
    assert.ok(written.includes('"../../src/f"'), written);
    // Proposing again replaces rather than duplicates.
    await callTool('tslaws_propose', { name: 'doubleIsTwice', source: proposal, file: '.tslaws/proposals/f.ts' });
    assert.equal(readFileSync(stored, 'utf8').split('export law').length, 2);
    assert.equal(readFileSync(join(root, 'src', 'f.laws.ts'), 'utf8'), lawsText);
    const listed = await callTool('tslaws_check_proposed');
    assert.deepEqual(
      listed.data.results.map((r: { name: string }) => r.name),
      ['doubleIsTwice'],
    );
    // The tree gained no laws file, and the lock was never written.
    assert.ok(!existsSync(join(root, 'tsc-laws.lock')));
  });

  it('lists the laws files with their level and status, and the proposals', async () => {
    const out = await callTool('tslaws_list');
    assert.equal(out.isError, undefined, out.text);
    const byFile = new Map<string, { kind: string; status: string }>(out.data.files.map((f: any) => [f.file, f]));
    assert.deepEqual(byFile.get('src/f.laws.ts'), {
      file: 'src/f.laws.ts',
      kind: 'node',
      status: 'unaccepted',
      notices: [],
    });
    assert.equal(byFile.get('.tslaws/proposals/f.ts')?.status, 'proposed');
  });

  it('accepts the default proposal name and any plain .ts name', () => {
    for (const file of [
      'agent.ts',
      'shell-layout.browser.ts',
      '.tslaws/proposals/shop.e2e.ts',
      './.tslaws/proposals/x.mts',
    ]) {
      assert.match(proposalName(file), /^\.tslaws\/proposals\/[^/]+\.m?ts$/, file);
    }
  });

  it('refuses every other path, and the old in-tree names', async () => {
    for (const file of [
      '../x.ts',
      'src/f.laws.ts',
      'src/f.proposed.laws.ts',
      '.tslaws/out/x.ts',
      '.tslaws/proposals/sub/x.ts',
      '.tslaws/proposals/../../x.ts',
      'tsc-laws.lock',
      '/abs.ts',
      'C:/abs.ts',
      'x.js',
      '.hidden.ts',
    ]) {
      const out = await callTool('tslaws_propose', { name: 'doubleIsTwice', source: proposal, file });
      assert.equal(out.isError, true, file);
      assert.match(out.text, /not a proposal file/, file);
    }
    assert.equal(readFileSync(join(root, 'src', 'f.laws.ts'), 'utf8'), lawsText);
    assert.ok(!existsSync(join(root, 'tsc-laws.lock')));
    assert.ok(!existsSync(join(dirname(root), 'x.ts')));
    assert.ok(!existsSync(join(root, 'src', 'f.proposed.laws.ts')));
  });

  it('proposes a law with the helpers it needs, and checks it', async () => {
    const withHelpers = [
      'import { double } from "./src/f";',
      '',
      '/** Keeps the generated number small. */',
      'const small = (n: number): number => n % 1000;',
      '',
      '// What a pair holds.',
      'interface Pair { a: number }',
      'type Twice = Pair[];',
      '/** Builds a pair. */',
      'function pairOf(n: number): Pair { return { a: small(n) }; }',
      '',
      'export law smallDoubleIsTwice(n: number) => double(pairOf(n).a) === pairOf(n).a * 2;',
      '',
    ].join('\n');
    const held = await callTool('tslaws_propose', { name: 'smallDoubleIsTwice', source: withHelpers, file: 'h.ts' });
    assert.equal(held.isError, undefined, held.text);
    assert.equal(held.data.needsConfirmation, true);
    assert.equal(held.data.written, false);
    assert.deepEqual(
      held.data.helpers.map((h: { names: string[] }) => h.names),
      [['small'], ['Pair'], ['Twice'], ['pairOf']],
    );
    assert.ok(held.data.helpers[0].text.startsWith('/** Keeps the generated number small. */'));
    assert.deepEqual(held.data.imports, ['import { double } from "../../src/f";']);
    assert.ok(!existsSync(join(root, '.tslaws', 'proposals', 'h.ts')));
    const wrong = await callTool('tslaws_propose', {
      name: 'smallDoubleIsTwice',
      source: withHelpers,
      file: 'h.ts',
      confirmHelpers: 'yes',
    });
    assert.equal(wrong.data.needsConfirmation, true);
    assert.ok(!existsSync(join(root, '.tslaws', 'proposals', 'h.ts')));
    const out = await callTool('tslaws_propose', {
      name: 'smallDoubleIsTwice',
      source: withHelpers,
      file: 'h.ts',
      confirmHelpers: true,
    });
    assert.equal(out.isError, undefined, out.text);
    assert.equal(out.data.file, '.tslaws/proposals/h.ts');
    assert.equal(out.data.results.length, 1);
    assert.match(out.data.results[0].status, /proved|bounded|tested/, out.text);
    const stored = readFileSync(join(root, '.tslaws', 'proposals', 'h.ts'), 'utf8');
    assert.ok(stored.includes('/** Keeps the generated number small. */\nconst small ='), stored);
    assert.ok(stored.includes('// What a pair holds.\ninterface Pair'), stored);
    assert.ok(stored.includes('type Twice = Pair[];'));
    assert.ok(stored.includes('"../../src/f"'), stored);
    assert.ok(stored.indexOf('function pairOf') < stored.indexOf('export law smallDoubleIsTwice'));
    // Proposing it again keeps one copy of each helper.
    await callTool('tslaws_propose', {
      name: 'smallDoubleIsTwice',
      source: withHelpers,
      file: 'h.ts',
      confirmHelpers: true,
    });
    const again = readFileSync(join(root, '.tslaws', 'proposals', 'h.ts'), 'utf8');
    assert.equal(again.split('const small').length, 2);
    assert.equal(again.split('export law').length, 2);
  });

  it('refuses a proposal with a top-level statement that is not a helper, and writes nothing', async () => {
    const file = '.tslaws/proposals/s.ts';
    for (const stray of ["require('fs').rmSync('x');", 'let counter = 0;', 'export default 1;', 'go();']) {
      const out = await callTool('tslaws_propose', {
        name: 'doubleIsTwice',
        source: `${proposal}\nconst h = 1;\n${stray}\n`,
        file: 's.ts',
      });
      assert.equal(out.isError, true, stray);
      assert.match(out.text, /only imports, law declarations and top-level const, function, type and interface/, stray);
    }
    assert.ok(!existsSync(join(root, file)));
    assert.equal(readFileSync(join(root, 'src', 'f.laws.ts'), 'utf8'), lawsText);
  });

  it('writes a proposal with no helpers without confirmHelpers', async () => {
    const out = await callTool('tslaws_propose', { name: 'doubleIsTwice', source: proposal, file: 'plain.ts' });
    assert.equal(out.isError, undefined, out.text);
    assert.equal(out.data.needsConfirmation, undefined);
    assert.ok(existsSync(join(root, '.tslaws', 'proposals', 'plain.ts')));
  });

  it('refuses a helper that could run code, even with confirmHelpers, and writes nothing', async () => {
    for (const helper of [
      'const boot = start();',
      'const when = new Date();',
      'const q = sql`select 1`;',
      'const o = { get x() { return 1; } };',
      'class Maker {}',
    ]) {
      const out = await callTool('tslaws_propose', {
        name: 'doubleIsTwice',
        source: `${helper}
${proposal}`,
        file: 'bad.ts',
        confirmHelpers: true,
      });
      assert.equal(out.isError, true, helper);
      assert.match(out.text, /is refused|only imports, law declarations/, helper);
    }
    assert.ok(!existsSync(join(root, '.tslaws', 'proposals', 'bad.ts')));
  });

  it('explains a law with its source and last result', async () => {
    const out = await callTool('tslaws_explain', { law: 'doubles' });
    assert.match(out.data.declarations[0].source, /export law doubles/);
    assert.ok(out.data.lastResult);
    assert.equal(typeof out.data.nextAction, 'string');
    assert.equal((await callTool('tslaws_explain', { law: 'missing' })).isError, true);
  });
});
