// Pure unit conversion. Plain JavaScript with JSDoc types: the laws (in TypeScript) read the declarations the
// compiler emits for this file, so `@param` and `@returns` are what give them typed generators.

/** A whole number the prover treats exactly. @typedef {import('tslaws').int} Int */

/** @typedef {'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft' | 'mi'} Unit */

/** How many metres each unit is. */
export const METRES_PER = /** @type {const} */ ({
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  mi: 1609.344,
});

/** Every unit, in the order the widget lists them. @type {Unit[]} */
export const UNITS = ['mm', 'cm', 'm', 'km', 'in', 'ft', 'mi'];

/**
 * Converts a length between units.
 * @param {number} value
 * @param {Unit} from
 * @param {Unit} to
 * @returns {number}
 */
export function convert(value, from, to) {
  return (value * METRES_PER[from]) / METRES_PER[to];
}

/**
 * Whole centimetres in a whole number of metres (exact integer arithmetic, so the prover can reason about it).
 * @param {Int} metres
 * @returns {Int}
 */
export function metresToCentimetres(metres) {
  return /** @type {Int} */ (metres * 100);
}

/**
 * Keeps a decimal-places setting between 0 and 6.
 * @param {Int} digits
 * @returns {Int}
 */
export function clampDigits(digits) {
  if (digits < 0) return /** @type {Int} */ (0);
  if (digits > 6) return /** @type {Int} */ (6);
  return digits;
}

/** Decimals the widget shows. @type {Int} */
export const DISPLAY_DIGITS = /** @type {Int} */ (4);

/**
 * Formats a number for display with at most `digits` decimals and no trailing zeros.
 * @param {number} value
 * @param {Int} digits
 * @returns {string}
 */
export function formatValue(value, digits) {
  return String(Number(value.toFixed(clampDigits(digits))));
}
