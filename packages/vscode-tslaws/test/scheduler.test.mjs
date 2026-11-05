import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createScheduler, mergeRequests } = createRequire(import.meta.url)('../src/scheduler.js');

/** A clock that only moves when told to. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    tick(ms) {
      now += ms;
      for (const [id, t] of timers) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

/** Runs that finish when the test says so. */
function fakeRuns() {
  const runs = [];
  return {
    runs,
    start(request) {
      const run = { request, cancelled: false, finish: null };
      run.done = new Promise((resolve) => (run.finish = () => resolve(run.cancelled ? 'cancelled' : 'done')));
      run.cancel = () => {
        run.cancelled = true;
        run.finish();
      };
      runs.push(run);
      return run;
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test('a burst of changes makes one run, started after the last change plus the delay', async () => {
  const clock = fakeClock();
  const fake = fakeRuns();
  const s = createScheduler({ delayMs: 500, start: fake.start, ...clock });
  s.request({ files: ['a.laws.ts'] });
  clock.tick(300);
  s.request({ files: ['b.laws.ts'] });
  clock.tick(300);
  await settle();
  assert.equal(fake.runs.length, 0, 'the delay restarts with each change');
  clock.tick(200);
  await settle();
  assert.equal(fake.runs.length, 1);
  assert.deepEqual(fake.runs[0].request.files, ['a.laws.ts', 'b.laws.ts']);
});

test('a newer change stops the run that is going and its replacement starts after the delay', async () => {
  const clock = fakeClock();
  const fake = fakeRuns();
  const states = [];
  const s = createScheduler({ delayMs: 100, start: fake.start, onState: (x) => states.push(x), ...clock });
  s.request({ files: ['a.laws.ts'] });
  clock.tick(100);
  await settle();
  assert.equal(s.running, true);

  s.request({ files: ['a.laws.ts'] });
  assert.equal(fake.runs[0].cancelled, true, 'cancelled at once, not when the delay ends');
  clock.tick(100);
  await settle();
  assert.equal(fake.runs.length, 2);
  assert.equal(fake.runs[1].cancelled, false);
  fake.runs[1].finish();
  await settle();
  assert.equal(s.running, false);
  assert.equal(states.at(-1), 'idle');
});

test('two stale runs in a row never overlap', async () => {
  const clock = fakeClock();
  const fake = fakeRuns();
  const s = createScheduler({ delayMs: 10, start: fake.start, ...clock });
  for (let i = 0; i < 3; i++) {
    s.request({ files: [`${i}.laws.ts`] });
    clock.tick(10);
    await settle();
  }
  assert.equal(fake.runs.filter((r) => !r.cancelled).length, 1, 'only the latest is alive');
  assert.deepEqual(fake.runs.at(-1).request.files, ['2.laws.ts']);
});

test('cancel drops the pending request and stops the run', async () => {
  const clock = fakeClock();
  const fake = fakeRuns();
  const s = createScheduler({ delayMs: 50, start: fake.start, ...clock });
  s.request({ files: null });
  s.cancel();
  clock.tick(100);
  await settle();
  assert.equal(fake.runs.length, 0);
  s.request({ files: null });
  clock.tick(50);
  await settle();
  s.cancel();
  assert.equal(fake.runs[0].cancelled, true);
});

test('flush runs a pending request now', async () => {
  const clock = fakeClock();
  const fake = fakeRuns();
  const s = createScheduler({ delayMs: 10_000, start: fake.start, ...clock });
  s.request({ files: ['a.laws.ts'] });
  const p = s.flush();
  await settle();
  assert.equal(fake.runs.length, 1);
  fake.runs[0].finish();
  await p;
});

test('requests combine: all wins, files join, named laws survive only for the same single file', () => {
  assert.deepEqual(mergeRequests({ files: ['a'] }, { files: null }).files, null);
  assert.deepEqual(mergeRequests({ files: ['a'] }, { files: ['b'] }).files, ['a', 'b']);
  assert.deepEqual(mergeRequests({ files: ['a'], laws: ['x'] }, { files: ['a'], laws: ['y'] }).laws, ['x', 'y']);
  assert.equal(mergeRequests({ files: ['a'], laws: ['x'] }, { files: ['a'] }).laws, undefined);
  assert.equal(mergeRequests({ files: ['a'], laws: ['x'] }, { files: ['b'], laws: ['y'] }).laws, undefined);
  assert.deepEqual(mergeRequests({ files: ['a'], args: ['--no-prove'] }, { files: ['a'], args: [] }).args, []);
  assert.deepEqual(mergeRequests(null, { files: ['a'] }), { files: ['a'] });
});
