// @ts-check
const counter = { count: 0, step: 1 };
counter.count;

/**
 * @param {number} value
 * @param
 */
function scale(value, factor = 2, { x, y }) {
  return value * factor + x + y;
}

/** @type {import('./shapes.ts').Options} */
const opts = { size: 1, mode: 0 };
opts.size;
scale(1, 2, { x: 1, y: 2 });
