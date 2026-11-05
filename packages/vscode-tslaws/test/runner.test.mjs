import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const { startCheck, liveSupport, checkArguments } = createRequire(import.meta.url)('../src/runner.js');

/** A child process whose output and end the test controls. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', null));
  };
  return child;
}

const line = (o) => `${JSON.stringify(o)}\n`;
const result = { file: 'src/a.laws.ts', name: 'one', line: 1, status: 'proved', method: 'smt' };

test('streams events as the lines arrive, even when a chunk ends mid-line', async () => {
  const child = fakeChild();
  const events = [];
  const run = startCheck({
    spawn: () => child,
    command: 'node',
    args: [],
    cwd: '/w',
    streaming: true,
    onEvent: (e) => events.push(e.type),
  });
  const text =
    line({ type: 'plan', laws: [{ file: 'src/a.laws.ts', name: 'one', line: 1 }] }) +
    line({ type: 'start', file: 'src/a.laws.ts', name: 'one' });
  child.stdout.emit('data', text.slice(0, 20));
  assert.deepEqual(events, []);
  child.stdout.emit('data', text.slice(20) + line({ type: 'result', result }));
  assert.deepEqual(events, ['plan', 'start', 'result']);
  child.stdout.emit('data', line({ type: 'report', results: [result], ok: true }));
  child.emit('close', 0);
  const outcome = await run.done;
  assert.equal(outcome.code, 0);
  assert.equal(outcome.report.records[0].name, 'one');
  assert.equal(outcome.report.ok, true);
});

test('an older tslaws prints one JSON report, which is replayed as the same events', async () => {
  const child = fakeChild();
  const events = [];
  const run = startCheck({
    spawn: () => child,
    command: 'node',
    args: [],
    cwd: '/w',
    streaming: false,
    onEvent: (e) => events.push(e.type),
  });
  child.stdout.emit('data', `noise\n${JSON.stringify({ results: [result], ok: true })}`);
  child.emit('close', 0);
  const outcome = await run.done;
  assert.deepEqual(events, ['result', 'report']);
  assert.equal(outcome.report.records.length, 1);
});

test('cancel kills the process and reports a cancelled run without a report', async () => {
  const child = fakeChild();
  const run = startCheck({
    spawn: () => child,
    command: 'node',
    args: [],
    cwd: '/w',
    streaming: true,
    onEvent: () => {},
  });
  child.stdout.emit('data', line({ type: 'result', result }));
  run.cancel();
  run.cancel();
  const outcome = await run.done;
  assert.equal(child.killed, true);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.report, null);
});

test('a process that cannot start, or prints nothing, is an error with its reason', async () => {
  const a = fakeChild();
  const first = startCheck({
    spawn: () => a,
    command: 'node',
    args: [],
    cwd: '/w',
    streaming: true,
    onEvent: () => {},
  });
  a.emit('error', new Error('spawn node ENOENT'));
  assert.match((await first.done).error, /failed to start: spawn node ENOENT/);

  const b = fakeChild();
  const second = startCheck({
    spawn: () => b,
    command: 'node',
    args: [],
    cwd: '/w',
    streaming: true,
    onEvent: () => {},
  });
  b.stderr.emit('data', 'no tsc-laws compiler found');
  b.emit('close', 1);
  assert.match((await second.done).error, /no tsc-laws compiler found/);
});

test('the arguments depend on what the installed tslaws can do', () => {
  const modern = liveSupport('tslaws check [files...] [--reporter text|json|junit|github|ndjson] [--law NAME]');
  assert.deepEqual(modern, { streaming: true, lawFilter: true });
  const old = liveSupport('tslaws check [files...] [--reporter text|json|junit|github] [--json]');
  assert.deepEqual(old, { streaming: false, lawFilter: false });

  assert.deepEqual(checkArguments({ files: null }, modern), ['check', '--reporter', 'ndjson']);
  assert.deepEqual(checkArguments({ files: ['a.laws.ts'], laws: ['x', 'y'], args: ['--no-prove'] }, modern), [
    'check',
    '--reporter',
    'ndjson',
    '--law',
    'x,y',
    '--no-prove',
    'a.laws.ts',
  ]);
  assert.deepEqual(checkArguments({ files: ['a.laws.ts'], laws: ['x'] }, old), ['check', '--json', 'a.laws.ts']);
});
