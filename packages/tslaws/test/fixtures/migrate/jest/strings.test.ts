import { describe, expect, it, jest } from '@jest/globals';
import { shout } from './strings';

describe('strings', () => {
  it('shouts', () => {
    expect(shout('hi')).toBe('HI!');
  });

  it('spies', () => {
    const spy = jest.fn(() => 1);
    spy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  xit('is disabled', () => {
    expect(shout('')).toBe('');
  });
});
