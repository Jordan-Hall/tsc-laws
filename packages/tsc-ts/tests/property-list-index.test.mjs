// firstUnmatchedProperty reads the positions the source has and the property list index (checker-members.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-property-list-index-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { PropertyListIndex, firstUnmatchedProperty } = await load('compiler/checker-members.js');

const properties = ['a', 'b', 'c', 'd'].map((name) => ({ name, flags: 0, checkFlags: 0 }));
const positions = new Map(properties.map((p, i) => [p.name, i]));

function unmatched(found, staticPrivate, required, requireOptionalProperties) {
  const index = new PropertyListIndex(positions, staticPrivate, required);
  const checker = { propertyListIndexes: new Map([[properties, index]]) };
  return firstUnmatchedProperty(checker, properties, found, requireOptionalProperties);
}

test('a static private property the source has does not hide later static private properties', () => {
  // Position 1 is found and static private; position 3 is static private and absent.
  assert.equal(unmatched([0, 1, 2], [1, 3], [], true), undefined);
  assert.equal(unmatched([0, 1], [1, 3], [], true), properties[2]);
});

test('without requireOptionalProperties only required properties are reported', () => {
  assert.equal(unmatched([0, 2], [], [1, 3], false), properties[1]);
  assert.equal(unmatched([1, 3], [], [1, 3], false), undefined);
});
