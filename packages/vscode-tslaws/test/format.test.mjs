import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const f = createRequire(import.meta.url)('../src/format.js');

test('splits the arguments of a counterexample at the top level only', () => {
  assert.deepEqual(f.splitArguments('[0,1]'), ['0', '1']);
  assert.deepEqual(f.splitArguments('[[1,2],{"a":[3,4]},"x,y"]'), ['[1,2]', '{"a":[3,4]}', '"x,y"']);
  assert.deepEqual(f.splitArguments('[[1.7976931348623141e+308,1.7976931348623141e+308]]'), [
    '[1.7976931348623141e+308,1.7976931348623141e+308]',
  ]);
  assert.equal(f.splitArguments('not a list'), null);
});

test('names the shrunk inputs after the law parameters, and keeps the raw text when they do not fit', () => {
  assert.equal(f.inputsText('[0,1]', ['price', 'coupon']), 'price = 0, coupon = 1');
  assert.equal(f.inputsText('[[5,5]]', ['xs']), 'xs = [5,5]');
  assert.equal(f.inputsText('[0,1]', ['only']), '[0,1]');
  assert.equal(f.inputsText('[0,1]', []), '[0,1]');
  assert.equal(f.inputsText(undefined, ['a']), undefined);
});

test('the reproduce command names the file, the law and the seed of a failure', () => {
  const r = { file: 'src/a.laws.ts', name: 'noNeg', status: 'failed', seed: -42 };
  assert.equal(f.reproduceCommand(r), 'npx tslaws check src/a.laws.ts --law noNeg --seed -42');
  assert.equal(f.reproduceCommand({ ...r, status: 'open' }), 'npx tslaws check src/a.laws.ts --law noNeg');
  assert.equal(
    f.reproduceCommand({ ...r, file: 'my dir/a.laws.ts' }),
    'npx tslaws check "my dir/a.laws.ts" --law noNeg --seed -42',
  );
});

test('messages carry the status, the inputs and how to reproduce', () => {
  const r = {
    file: 'src/a.laws.ts',
    name: 'noNeg',
    status: 'failed',
    method: 'property',
    runs: 15,
    seed: 7,
    counterexample: '[0,1]',
    message: 'returned false',
  };
  assert.equal(
    f.lawMessage(r, ['price', 'coupon']),
    'Law noNeg failed (property, 15 runs, seed 7): returned false\nShrunk counterexample: price = 0, coupon = 1\nReproduce: npx tslaws check src/a.laws.ts --law noNeg --seed 7',
  );
  const ex = { name: 'total' };
  assert.match(
    f.sourceMessage(r, ex, true, ['price', 'coupon']),
    /^Law noNeg fails on total\.\nShrunk counterexample: price = 0, coupon = 1/,
  );
  assert.match(f.sourceMessage(r, ex, false), /this may be where/);
  assert.equal(f.inlineText(r, ['price', 'coupon']), '  failed: counterexample price = 0, coupon = 1');
  assert.equal(
    f.inlineText(r, ['price', 'coupon'], 'source'),
    '  fails law noNeg: counterexample price = 0, coupon = 1',
  );
  assert.match(f.lawMessage({ ...r, status: 'open', hint: 'Make it provable.' }), /Next: Make it provable\./);
});

test('lens titles say the state, the counts, the time and what covers a function', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(f.clock(at), '03:04:05');
  assert.equal(
    f.lawLensTitle({ status: 'proved', method: 'smt', runs: 200 }, at),
    '$(check) proved · smt, 200 runs · 03:04:05',
  );
  assert.equal(
    f.lawLensTitle({ status: 'failed', method: 'property', runs: 15, seed: 3 }, at),
    '$(error) failed · property, 15 runs, seed 3 · 03:04:05',
  );
  assert.equal(
    f.lawLensTitle({ status: 'tested', method: 'property', runs: 200 }, undefined),
    '$(check) tested · property, 200 runs',
  );
  assert.equal(f.lawLensTitle(undefined), '$(circle-outline) not run');
  assert.equal(
    f.fileLensTitle([{ status: 'proved' }, { status: 'failed' }, { status: 'proved' }]),
    '$(error) 2 proved, 1 failed',
  );
  assert.equal(f.fileLensTitle([]), '$(circle-outline) laws not run');
  assert.equal(f.sourceLensTitle([{ failing: false }, { failing: true }]), '$(error) covered by 2 laws, 1 failing');
  assert.equal(f.sourceLensTitle([{ failing: false }]), '$(shield) covered by 1 law, 0 failing');
});
