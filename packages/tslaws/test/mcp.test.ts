// The MCP server, driven over stdio by a scripted client. Needs `npm run build` and TSC_LAWS_BIN.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'tslaws.js');
const root = mkdtempSync(join(here, '..', '.tmp-mcp-'));

const lawsText = 'import { double } from "./f";\n\nexport law doubles(n: number) => double(n) === n + n;\n';
const proposal = 'import { double } from "./f";\n\nexport law doubleIsTwice(n: number) => double(n) === n * 2;\n';

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

  it('lists the four tools and none that accepts or touches the lock', async () => {
    const names = ((await request('tools/list')).result.tools as { name: string }[]).map((t) => t.name);
    assert.deepEqual(names.sort(), ['tslaws_check', 'tslaws_check_proposed', 'tslaws_explain', 'tslaws_propose']);
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

  it('proposes into a proposed file only, and checks it', async () => {
    const out = await callTool('tslaws_propose', {
      name: 'doubleIsTwice',
      source: proposal,
      file: 'src/f.proposed.laws.ts',
    });
    assert.equal(out.isError, undefined);
    assert.equal(out.data.file, 'src/f.proposed.laws.ts');
    assert.equal(out.data.results.length, 1);
    assert.match(out.data.results[0].status, /proved|bounded|tested/);
    const written = readFileSync(join(root, 'src', 'f.proposed.laws.ts'), 'utf8');
    assert.ok(written.includes('export law doubleIsTwice'));
    // Proposing again replaces rather than duplicates.
    await callTool('tslaws_propose', { name: 'doubleIsTwice', source: proposal, file: 'src/f.proposed.laws.ts' });
    assert.equal(readFileSync(join(root, 'src', 'f.proposed.laws.ts'), 'utf8').split('export law').length, 2);
    assert.equal(readFileSync(join(root, 'src', 'f.laws.ts'), 'utf8'), lawsText);
    const listed = await callTool('tslaws_check_proposed');
    assert.deepEqual(
      listed.data.results.map((r: { name: string }) => r.name),
      ['doubleIsTwice'],
    );
  });

  it('refuses every other path', async () => {
    for (const file of [
      '../x.laws.ts',
      'src/f.laws.ts',
      '../x.proposed.laws.ts',
      'tsc-laws.lock',
      '/abs.proposed.laws.ts',
    ]) {
      const out = await callTool('tslaws_propose', { name: 'doubleIsTwice', source: proposal, file });
      assert.equal(out.isError, true, file);
    }
    assert.equal(readFileSync(join(root, 'src', 'f.laws.ts'), 'utf8'), lawsText);
    assert.ok(!existsSync(join(root, 'tsc-laws.lock')));
    assert.ok(!existsSync(join(dirname(root), 'x.laws.ts')));
    assert.ok(!existsSync(join(dirname(root), 'x.proposed.laws.ts')));
  });

  it('explains a law with its source and last result', async () => {
    const out = await callTool('tslaws_explain', { law: 'doubles' });
    assert.match(out.data.declarations[0].source, /export law doubles/);
    assert.ok(out.data.lastResult);
    assert.equal(typeof out.data.nextAction, 'string');
    assert.equal((await callTool('tslaws_explain', { law: 'missing' })).isError, true);
  });
});
