/**
 * `--locale` validation: BCP 47 tags with known subtags, accepted exactly when tsgo's
 * `golang.org/x/text/language.Parse` accepts them.
 */
import { languages2, languages3, regions, scripts, variants } from './locale-data.js';

const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Legacy tags accepted as a whole. */
const grandfathered = new Set([
  'art-lojban',
  'i-ami',
  'i-bnn',
  'i-hak',
  'i-klingon',
  'i-lux',
  'i-navajo',
  'i-pwn',
  'i-tao',
  'i-tay',
  'i-tsu',
  'no-bok',
  'no-nyn',
  'sgn-be-fr',
  'sgn-be-nl',
  'sgn-ch-de',
  'zh-guoyu',
  'zh-hakka',
  'zh-min-nan',
  'zh-xiang',
  'cel-gaulish',
  'en-gb-oed',
  'i-default',
  'i-enochian',
  'i-mingo',
  'zh-min',
  'root',
  'en-us-posix',
]);

let registry: Registry | undefined;

class Registry {
  readonly languages2 = new Set(languages2.split(' '));
  readonly scripts = new Set(scripts.split(' '));
  readonly regions = new Set(regions.split(' '));
  readonly variants = new Set(variants.split(' '));

  isLanguage(subtag: string): boolean {
    if (!isAlpha(subtag)) return false;
    if (subtag.length === 2) return this.languages2.has(subtag);
    if (subtag.length !== 3) return false;
    const index = ((subtag.charCodeAt(0) - 97) * 26 + (subtag.charCodeAt(1) - 97)) * 26 + (subtag.charCodeAt(2) - 97);
    const bits = base64.indexOf(languages3[Math.floor(index / 6)]);
    return ((bits >> (index % 6)) & 1) === 1;
  }
}

function isLetter(ch: number): boolean {
  return ch >= 97 && ch <= 122;
}

function isAlpha(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (!isLetter(text.charCodeAt(i))) return false;
  return true;
}

/** Whether a subtag starts with a letter (subtags are alphanumeric). */
function startsAlpha(subtag: string): boolean {
  return subtag.charCodeAt(0) > 57;
}

function isSubtag(text: string): boolean {
  if (text.length < 1 || text.length > 8) return false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (!isLetter(ch) && !(ch >= 48 && ch <= 57)) return false;
  }
  return true;
}

/** ASCII lowercase with `_` as `-`; other characters are kept and later rejected. */
function canonicalize(tag: string): string {
  let result = '';
  for (let i = 0; i < tag.length; i++) {
    const ch = tag.charCodeAt(i);
    if (ch >= 65 && ch <= 90) result += String.fromCharCode(ch + 32);
    else if (ch === 95) result += '-';
    else result += tag.charAt(i);
  }
  return result;
}

export function isValidLocale(tag: string): boolean {
  if (tag === '') return false;
  const lower = canonicalize(tag);
  if (grandfathered.has(lower)) return true;
  const subtags = lower.split('-');
  for (const subtag of subtags) if (!isSubtag(subtag)) return false;
  registry ??= new Registry();
  const first = subtags[0];
  if (first.length === 1) return first === 'x' && validExtensions(registry, subtags, 0);
  if (first.length >= 4) return false;
  const end = languageTagEnd(registry, subtags, 0, true);
  if (end < 0) return false;
  if (end === subtags.length) return true;
  return subtags[end].length === 1 && validExtensions(registry, subtags, end);
}

/**
 * Validates language, extended languages, script, region and variants from `start`;
 * returns the index after them, or -1 for unknown subtags.
 */
function languageTagEnd(registry: Registry, subtags: readonly string[], start: number, checkExtlang: boolean): number {
  if (!registry.isLanguage(subtags[start])) return -1;
  let i = start + 1;
  while (i < subtags.length && subtags[i].length === 3 && startsAlpha(subtags[i])) {
    if (checkExtlang && !registry.isLanguage(subtags[i])) return -1;
    i++;
  }
  if (i < subtags.length && subtags[i].length === 4 && startsAlpha(subtags[i])) {
    if (!registry.scripts.has(subtags[i])) return -1;
    i++;
  }
  if (i < subtags.length && (subtags[i].length === 2 || subtags[i].length === 3)) {
    if (!registry.regions.has(subtags[i])) return -1;
    i++;
  }
  while (i < subtags.length && subtags[i].length >= 4) {
    if (!registry.variants.has(subtags[i])) return -1;
    i++;
  }
  return i;
}

/** Validates extensions starting at singleton `subtags[start]`. */
function validExtensions(registry: Registry, subtags: readonly string[], start: number): boolean {
  let i = start;
  while (i < subtags.length && subtags[i].length === 1) {
    const singleton = subtags[i];
    i++;
    const bodyStart = i;
    if (singleton === 'x') return i < subtags.length;
    if (singleton === 'u') {
      i = unicodeExtensionEnd(subtags, i);
      if (i < 0) return false;
    } else if (singleton === 't') {
      if (i < subtags.length && subtags[i].length >= 2 && subtags[i].length <= 3 && startsAlpha(subtags[i].slice(1))) {
        i = languageTagEnd(registry, subtags, i, false);
        if (i < 0) return false;
      }
      while (i < subtags.length && subtags[i].length === 2 && !startsAlpha(subtags[i].slice(1))) {
        i++;
        while (i < subtags.length && subtags[i].length >= 3) i++;
      }
    } else {
      while (i < subtags.length && subtags[i].length >= 2) i++;
    }
    if (i === bodyStart) return false;
  }
  return true;
}

/** Skips `-u-` attributes and keywords; returns -1 if a key repeats with a different value. */
function unicodeExtensionEnd(subtags: readonly string[], start: number): number {
  let i = start;
  while (i < subtags.length && subtags[i].length > 2) i++;
  const keys = new Map<string, string>();
  while (i < subtags.length && subtags[i].length === 2) {
    const key = subtags[i];
    i++;
    let value = '';
    while (i < subtags.length && subtags[i].length > 2) value += '-' + subtags[i++];
    const previous = keys.get(key);
    if (previous !== undefined && previous !== value) return -1;
    keys.set(key, value);
  }
  return i;
}
