const legacy = require('./legacy.js');
const { move, wrap } = require('./legacy.js');

/** Counts. */
exports.count = 1;
exports.moved = move({ x: 1, y: 2 }, 1);
module.exports.wrapped = wrap(legacy.visit);
