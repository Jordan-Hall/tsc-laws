/**
 * @typedef {Object} Point
 * @property {number} x The x.
 * @property {number} y The y.
 */

/**
 * @callback Visitor
 * @param {Point} point
 * @returns {void}
 */

/**
 * Moves a point.
 * @param {Point} p The point.
 * @param {number} [dx] Horizontal.
 * @return {Point} The moved point.
 */
function move(p, dx = 0) {
  return { x: p.x + dx, y: p.y };
}

/** @type {Visitor} */
const visit = (point) => void point;

/**
 * @template T
 * @param {T} value
 */
function wrap(value) {
  return [value];
}

/** @implements {Iterable<number>} @augments Object */
class Bag {
  *[Symbol.iterator]() {
    yield 1;
  }
}

module.exports = { move, visit, wrap, Bag };
