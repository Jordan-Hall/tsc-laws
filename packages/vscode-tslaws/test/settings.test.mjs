import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { resolveRunMode, explicitValue, clampInt } = createRequire(import.meta.url)('../src/settings.js');

test('tslaws.run wins when set; otherwise the old runOnSave decides', () => {
  assert.equal(resolveRunMode({ explicitRun: 'onType', runOnSave: false }), 'onType');
  assert.equal(resolveRunMode({ explicitRun: 'manual', runOnSave: true }), 'manual');
  assert.equal(resolveRunMode({ explicitRun: undefined, runOnSave: false }), 'manual');
  assert.equal(resolveRunMode({ explicitRun: undefined, runOnSave: true }), 'onSave');
  assert.equal(resolveRunMode({}), 'onSave');
  assert.equal(resolveRunMode({ explicitRun: 'nonsense', runOnSave: true }), 'onSave');
});

test('an explicit value is the most specific one the user set, never the default', () => {
  assert.equal(explicitValue({ defaultValue: 'onSave' }), undefined);
  assert.equal(explicitValue({ globalValue: 'manual', workspaceValue: 'onType' }), 'onType');
  assert.equal(explicitValue(undefined), undefined);
});

test('numbers are clamped and a non-number falls back', () => {
  assert.equal(clampInt(5, 100, 200, 150), 100);
  assert.equal(clampInt(999, 100, 200, 150), 200);
  assert.equal(clampInt('x', 100, 200, 150), 150);
});
