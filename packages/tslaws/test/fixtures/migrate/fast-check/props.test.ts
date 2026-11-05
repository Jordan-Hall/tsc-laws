import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fc from 'fast-check';

describe('properties', () => {
  it('addition commutes', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        assert.equal(a + b, b + a);
      }),
    );
  });

  it('a natural number is not negative', () => {
    fc.assert(fc.property(fc.nat(), (n) => n >= 0));
  });

  it('bounded integers stay bounded', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10 }), (n) => n * 2 <= 20));
  });

  it('strings, booleans and arrays', () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), fc.array(fc.integer()), (s, flag, xs) => {
        assert.equal(typeof s, 'string');
        assert.equal(typeof flag, 'boolean');
        assert.equal(Array.isArray(xs), true);
      }),
    );
  });

  it('floats', () => {
    fc.assert(fc.property(fc.double({ noNaN: true }), (x) => x === x));
  });

  it('records have no tslaws type', () => {
    fc.assert(fc.property(fc.record({ a: fc.integer() }), (r) => typeof r.a === 'number'));
  });

  it('uses a precondition', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        fc.pre(n !== 0);
        return n * n > 0;
      }),
    );
  });
});
