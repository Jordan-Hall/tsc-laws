import { expect } from 'vitest';
import { fc, it } from '@fast-check/vitest';

it.prop([fc.integer(), fc.integer()])('multiplication commutes', (a, b) => {
  expect(a * b).toBe(b * a);
});

it.prop({ n: fc.nat() })('named arbitraries', ({ n }) => {
  expect(n >= 0).toBe(true);
});
