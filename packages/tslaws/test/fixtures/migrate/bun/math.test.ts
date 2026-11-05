import { describe, expect, test } from 'bun:test';

describe('math', () => {
  test('adds', () => {
    expect(1 + 1).toBe(2);
  });

  test.todo('divides by zero');

  test.skip('multiplies', () => {
    expect(2 * 2).toBe(5);
  });
});
