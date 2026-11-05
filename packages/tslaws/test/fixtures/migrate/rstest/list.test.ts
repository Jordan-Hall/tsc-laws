import { beforeEach, describe, expect, test } from '@rstest/core';

describe('list', () => {
  let list: number[] = [];

  beforeEach(() => {
    list = [1, 2, 3];
  });

  test('has three items', () => {
    expect(list.length).toBe(3);
  });

  test('reverses', () => {
    expect([...list].reverse()).toEqual([3, 2, 1]);
  });
});
