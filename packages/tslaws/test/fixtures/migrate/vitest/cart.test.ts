import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import { total } from './cart';

const prices = [3, 4];

describe('cart', () => {
  let items: number[] = [];

  beforeEach(() => {
    items = [...prices];
  });

  afterEach(() => {
    items = [];
  });

  it('adds up the prices', () => {
    expect(total(items)).toBe(7);
  });

  describe('when empty', () => {
    beforeEach(() => {
      items = [];
    });

    it('is zero', async () => {
      await Promise.resolve();
      expect(total(items)).toBe(0);
    });

    it.skip('is negative on Tuesdays', () => {
      expect(total(items)).toBeLessThan(0);
    });

    it.todo('handles refunds');
  });

  it.only('keeps the focus note', () => {
    expect(items).toHaveLength(2);
  });
});

test.each([
  [1, 2, 3],
  [2, 2, 4],
])('adds %i and %i to give %i', (a, b, sum) => {
  expect(total([a, b])).toBe(sum);
});

test.each`
  a    | b    | sum
  ${1} | ${1} | ${2}
  ${2} | ${3} | ${5}
`('template $a + $b = $sum', ({ a, b, sum }) => {
  expect(total([a, b])).toBe(sum);
});

test('has a timeout', () => {
  expect(total([])).toBe(0);
}, 5000);

test('is plainly true', () => {
  expect(true).toBe(true);
});
