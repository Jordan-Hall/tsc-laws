import { assume, type int } from 'tslaws';
import { METRES_PER, clampDigits, convert, formatValue, metresToCentimetres, type Unit } from './convert.js';

// Converting there and back lands where it started, within floating-point error.
export law roundTrip(value: number, from: Unit, to: Unit) {
  assume(Math.abs(value) < 1e9);
  const back = convert(convert(value, from, to), to, from);
  return Math.abs(back - value) <= 1e-6 * Math.max(1, Math.abs(value));
}

export law sameUnitIsIdentity(value: number, unit: Unit) {
  assume(Math.abs(value) < 1e9);
  return Math.abs(convert(value, unit, unit) - value) <= 1e-9 * Math.max(1, Math.abs(value));
}

export law conversionKeepsSign(value: number, from: Unit, to: Unit) {
  assume(Math.abs(value) < 1e9 && (value === 0 || Math.abs(value) > 1e-6));
  return Math.sign(convert(value, from, to)) === Math.sign(value);
}

export law everyUnitHasPositiveSize(unit: Unit) => METRES_PER[unit] > 0;

export law proved centimetresAreHundredPerMetre(metres: int) {
  assume(metres >= 0 && metres <= 1_000_000);
  return metresToCentimetres(metres) === metres * 100;
}

export law proved digitsStayInRange(digits: int) {
  const clamped = clampDigits(digits);
  return clamped >= 0 && clamped <= 6;
}

export law formattedNumberParsesBack(value: number, digits: int) {
  assume(Math.abs(value) < 1e9);
  const places = clampDigits(digits);
  const text = formatValue(value, digits);
  return Math.abs(Number(text) - value) <= 0.5 * 10 ** -places + 1e-9 && !text.endsWith('.');
}
