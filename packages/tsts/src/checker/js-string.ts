// Go JS strings are UTF-8 with WTF-8 sentinels for lone surrogates. Work in
// ASCII hex byte space: scriptc's host string indexing cannot split a sentinel.
const hexDigits = '0123456789abcdef';
const base64Digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function validEncoding(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let padding = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch === '=') {
      if (i < value.length - 2) return false;
      padding = true;
    } else if (padding || base64Digits.indexOf(ch) < 0) return false;
  }
  return true;
}

export function hexByte(value: number): string {
  return hexDigits[(value >> 4) & 15] + hexDigits[value & 15];
}

export function byteAt(value: string, pos: number): number {
  return Number(
    hexDigits.indexOf(String(value).charAt(Number(pos))) * 16 +
      hexDigits.indexOf(String(value).charAt(Number(pos + 1))),
  );
}

export function decodeBytes(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 4) {
    const a = base64Digits.indexOf(String(value).charAt(Number(i)));
    const b = base64Digits.indexOf(String(value).charAt(Number(i + 1)));
    const c =
      String(value).charAt(Number(i + 2)) === '=' ? 0 : base64Digits.indexOf(String(value).charAt(Number(i + 2)));
    const d =
      String(value).charAt(Number(i + 3)) === '=' ? 0 : base64Digits.indexOf(String(value).charAt(Number(i + 3)));
    result += hexByte((a << 2) | (b >> 4));
    if (String(value).charAt(Number(i + 2)) !== '=') result += hexByte(((b & 15) << 4) | (c >> 2));
    if (String(value).charAt(Number(i + 3)) !== '=') result += hexByte(((c & 3) << 6) | d);
  }
  return result;
}

export function encodeBytes(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 6) {
    const a = byteAt(value, Number(i));
    const b = i + 2 < value.length ? byteAt(value, Number(i + 2)) : 0;
    const c = i + 4 < value.length ? byteAt(value, Number(i + 4)) : 0;
    result +=
      base64Digits[a >> 2] +
      base64Digits[((a & 3) << 4) | (b >> 4)] +
      (i + 2 < value.length ? base64Digits[((b & 15) << 2) | (c >> 6)] : '=') +
      (i + 4 < value.length ? base64Digits[c & 63] : '=');
  }
  return result;
}

export function asciiBytes(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) result += hexByte(value.charCodeAt(i));
  return result;
}

export function runeSize(value: string, pos: number): number {
  const lead = byteAt(value, Number(pos));
  return Number(lead < 128 ? 2 : lead < 224 ? 4 : lead < 240 ? 6 : 8);
}

export function runeAt(value: string, pos: number): number {
  const lead = byteAt(value, Number(pos));
  if (lead < 128) return Number(lead);
  let cp = lead & (lead < 224 ? 31 : lead < 240 ? 15 : 7);
  const end = pos + runeSize(value, Number(pos));
  for (let i = pos + 2; i < end; i += 2) cp = (cp << 6) | (byteAt(value, Number(i)) & 63);
  return Number(cp);
}

export function normalizeBytes(value: string): string {
  if (!value.includes('ed')) return value;
  let result = '';
  for (let i = 0; i < value.length;) {
    const cp = runeAt(value, Number(i));
    const size = runeSize(value, Number(i));
    if (cp >= 0xd800 && cp <= 0xdbff && i + size < value.length) {
      const low = runeAt(value, Number(i + size));
      if (low >= 0xdc00 && low <= 0xdfff) {
        const scalar = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
        result +=
          hexByte(240 | (scalar >> 18)) +
          hexByte(128 | ((scalar >> 12) & 63)) +
          hexByte(128 | ((scalar >> 6) & 63)) +
          hexByte(128 | (scalar & 63));
        i += size + runeSize(value, Number(i + size));
        continue;
      }
    }
    result += value.slice(i, i + size);
    i += size;
  }
  return result;
}

// Number accepts ECMAScript whitespace; other non-ASCII characters cannot be
// numeric spellings. Preserve ASCII bytes and normalize only that whitespace.
export function numericText(value: string): string {
  let result = '';
  for (let i = 0; i < value.length;) {
    const cp = runeAt(value, Number(i));
    if (cp < 128) result += String.fromCharCode(cp);
    else if (
      cp === 160 ||
      cp === 0x1680 ||
      (cp >= 0x2000 && cp <= 0x200a) ||
      cp === 0x2028 ||
      cp === 0x2029 ||
      cp === 0x202f ||
      cp === 0x205f ||
      cp === 0x3000 ||
      cp === 0xfeff
    )
      result += ' ';
    else return '';
    i += runeSize(value, Number(i));
  }
  return result;
}

export function validNumber(value: string, roundTrip: boolean): boolean {
  const text = numericText(value);
  if (text === '') return false;
  const number = Number(text);
  return Number.isFinite(number) && (!roundTrip || asciiBytes(String(number)) === value);
}

// Parse scanner-valid bigint spellings without a runtime BigInt dependency.
// Decimal accumulation retains arbitrary precision for constrained inference.
export function bigintValue(value: string): string {
  const text = numericText(value);
  let start = text.startsWith('-') ? 1 : 0;
  let base = 10;
  if (text.slice(start, start + 2).toLowerCase() === '0x') {
    base = 16;
    start += 2;
  } else if (text.slice(start, start + 2).toLowerCase() === '0o') {
    base = 8;
    start += 2;
  } else if (text.slice(start, start + 2).toLowerCase() === '0b') {
    base = 2;
    start += 2;
  }
  if (start === text.length || (base === 10 && text.length - start > 1 && text[start] === '0')) return '';
  let result = '0';
  for (let i = start; i < text.length; i++) {
    const digit = hexDigits.indexOf(text[i].toLowerCase());
    if (digit < 0 || digit >= base) return '';
    let carry = digit;
    let next = '';
    for (let j = result.length - 1; j >= 0; j--) {
      const total = Number(result[j]) * base + carry;
      next = String(total % 10) + next;
      carry = Math.floor(total / 10);
    }
    while (carry > 0) {
      next = String(carry % 10) + next;
      carry = Math.floor(carry / 10);
    }
    result = next;
  }
  return text.startsWith('-') && result !== '0' ? '-' + result : result;
}

export function validBigint(value: string, roundTrip: boolean): boolean {
  const parsed = bigintValue(value);
  return parsed !== '' && (!roundTrip || asciiBytes(parsed) === value);
}
