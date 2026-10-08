/**
 * `--locale` values, read as tsgo reads them with golang.org/x/text/language:
 *
 * - `isValidLocale`: whether `language.Parse` accepts the tag, which is when tsgo accepts the option.
 * - `parseLocale`: the bundled translation x/text's matcher picks for the tag at Low confidence or
 *   better, falling back to English. Tags with the Zmth (mathematical notation) script are the
 *   exception: x/text's answers for them do not follow its data.
 */
import { isDigit } from './character-codes.js';
import { Locale } from './diagnostic-locales.js';
import {
  bibliographicAliases,
  deprecatedRegions,
  exceptions,
  languageAliases,
  languages2,
  languages3,
  likelyScripts,
  regions,
  regionScripts,
  scriptMatches,
  scripts,
  undRegions,
  undScripts,
  variants,
} from './locale-data.js';

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

/** The locale tables, split on first use. */
class Tables {
  readonly languages2 = new Set(languages2.split(' '));
  readonly scripts = new Set(scripts.split(' '));
  readonly regions = new Set(regions.split(' '));
  readonly variants = new Set(variants.split(' '));
  readonly aliases = pairs(languageAliases);
  readonly bibliographic = pairs(bibliographicAliases);
  readonly matches = pairs(scriptMatches);
  readonly likely = pairs(likelyScripts);
  readonly regionScripts = pairs(regionScripts);
  readonly undRegions = pairs(undRegions);
  readonly undScripts = pairs(undScripts);
  readonly exceptions = pairs(exceptions);
  readonly deprecatedRegions = new Set(deprecatedRegions.split(' '));

  /** Whether `subtag` (lowercase) is a known two- or three-letter language. */
  isLanguage(subtag: string): boolean {
    if (!isLowercaseAlpha(subtag)) return false;
    if (subtag.length === 2) return this.languages2.has(subtag);
    if (subtag.length !== 3) return false;
    const index = ((subtag.charCodeAt(0) - 97) * 26 + (subtag.charCodeAt(1) - 97)) * 26 + (subtag.charCodeAt(2) - 97);
    const bits = base64.indexOf(languages3[Math.floor(index / 6)]);
    return ((bits >> (index % 6)) & 1) === 1;
  }
}

let tables: Tables | undefined;

function getTables(): Tables {
  tables ??= new Tables();
  return tables;
}

function pairs(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of text.trim().split(/\s+/)) {
    const equals = entry.indexOf('=');
    map.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  return map;
}

function isLowercaseLetter(ch: number): boolean {
  return ch >= 97 && ch <= 122;
}

function isLowercaseAlpha(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (!isLowercaseLetter(text.charCodeAt(i))) return false;
  return true;
}

/** Whether a subtag starts with a letter (subtags are alphanumeric). */
function startsAlpha(subtag: string): boolean {
  return subtag.charCodeAt(0) > 57;
}

/** One to eight lowercase letters or digits. */
function isSubtag(text: string): boolean {
  if (text.length < 1 || text.length > 8) return false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (!isLowercaseLetter(ch) && !isDigit(ch)) return false;
  }
  return true;
}

/** ASCII lowercase with `_` as `-`; other characters are kept and later rejected. */
function normalize(tag: string): string {
  let result = '';
  for (let i = 0; i < tag.length; i++) {
    const ch = tag.charCodeAt(i);
    if (ch >= 65 && ch <= 90) result += String.fromCharCode(ch + 32);
    else if (ch === 95) result += '-';
    else result += tag.charAt(i);
  }
  return result;
}

//// Validation

export function isValidLocale(tag: string): boolean {
  if (tag === '') return false;
  const lower = normalize(tag);
  if (grandfathered.has(lower)) return true;
  const subtags = lower.split('-');
  for (const subtag of subtags) if (!isSubtag(subtag)) return false;
  const t = getTables();
  const first = subtags[0]!;
  if (first.length === 1) return first === 'x' && validExtensions(t, subtags, 0);
  if (first.length >= 4) return false;
  const end = languageTagEnd(t, subtags, 0, true);
  if (end < 0) return false;
  if (end === subtags.length) return true;
  return subtags[end].length === 1 && validExtensions(t, subtags, end);
}

/**
 * Validates language, extended languages, script, region and variants from `start`;
 * returns the index after them, or -1 for unknown subtags.
 */
function languageTagEnd(t: Tables, subtags: readonly string[], start: number, checkExtlang: boolean): number {
  if (!t.isLanguage(subtags[start]!)) return -1;
  let i = start + 1;
  while (i < subtags.length && subtags[i].length === 3 && startsAlpha(subtags[i]!)) {
    if (checkExtlang && !t.isLanguage(subtags[i]!)) return -1;
    i++;
  }
  if (i < subtags.length && subtags[i].length === 4 && startsAlpha(subtags[i]!)) {
    if (!t.scripts.has(subtags[i]!)) return -1;
    i++;
  }
  if (i < subtags.length && (subtags[i].length === 2 || subtags[i].length === 3)) {
    if (!t.regions.has(subtags[i]!)) return -1;
    i++;
  }
  while (i < subtags.length && subtags[i].length >= 4) {
    if (!t.variants.has(subtags[i]!)) return -1;
    i++;
  }
  return i;
}

/** Validates extensions starting at singleton `subtags[start]`. */
function validExtensions(t: Tables, subtags: readonly string[], start: number): boolean {
  let i = start;
  while (i < subtags.length && subtags[i].length === 1) {
    const singleton = subtags[i]!;
    i++;
    const bodyStart = i;
    if (singleton === 'x') return i < subtags.length;
    if (singleton === 'u') {
      i = unicodeExtensionEnd(subtags, i);
      if (i < 0) return false;
    } else if (singleton === 't') {
      if (i < subtags.length && subtags[i].length >= 2 && subtags[i].length <= 3 && startsAlpha(subtags[i].slice(1))) {
        i = languageTagEnd(t, subtags, i, false);
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
    const key = subtags[i]!;
    i++;
    let value = '';
    while (i < subtags.length && subtags[i].length > 2) value += '-' + subtags[i++]!;
    const previous = keys.get(key);
    if (previous !== undefined && previous !== value) return -1;
    keys.set(key, value);
  }
  return i;
}

//// Matching

/** Whether `code`, a lowercase two-letter or three-digit subtag, is a known region. */
function isMatchableRegion(t: Tables, code: string): boolean {
  return t.regions.has(code) && (code.length === 2 || isDigit(code.charCodeAt(0)));
}

function toLocale(value: string | undefined): Locale {
  return value === undefined ? Locale.Default : (Number(value) as Locale);
}

/** The translation `tsc --locale tag` uses: `Locale.Default` (English) unless a bundled one matches. */
export function parseLocale(tag: string): Locale {
  const t = getTables();
  const normalized = normalize(tag);
  // Grandfathered tags whose replacement differs from what their subtags would parse to.
  if (tag.length <= 11) {
    if (normalized === 'i-lux') return Locale.DeDE;
    if (normalized === 'zh-hakka' || normalized === 'zh-xiang') return Locale.Default;
  }
  // Malformed subtags are dropped and make the tag an error.
  let error = false;
  const subtags: string[] = [];
  for (const subtag of normalized.split('-')) {
    if (isSubtag(subtag)) subtags.push(subtag);
    else error = true;
  }
  if (subtags.length === 0 || subtags[0].length < 2 || subtags[0].length > 3) return Locale.Default;

  // An unknown language parses as `und`.
  let language = 'und';
  if (t.isLanguage(subtags[0]!)) language = subtags[0]!;
  else error = true;
  let i = 1;
  // Extended language subtags replace the language.
  for (; i < subtags.length && subtags[i].length === 3 && !isDigit(subtags[i].charCodeAt(0)); i++) {
    if (t.isLanguage(subtags[i]!)) language = subtags[i]!;
    else error = true;
  }
  // Unknown scripts and regions are dropped.
  let script = '';
  if (i < subtags.length && subtags[i].length === 4 && !isDigit(subtags[i].charCodeAt(0))) {
    if (t.scripts.has(subtags[i]!)) script = subtags[i].slice(0, 1).toUpperCase() + subtags[i].slice(1);
    else error = true;
    i++;
  }
  let region = '';
  if (i < subtags.length && (subtags[i].length === 2 || subtags[i].length === 3)) {
    if (isMatchableRegion(t, subtags[i]!)) region = subtags[i].toUpperCase();
    else error = true;
  }

  language = t.aliases.get(language) ?? language;
  if (!error) language = t.bibliographic.get(language) ?? language;
  else if (language === 'und' && t.deprecatedRegions.has(region)) region = '';
  return matchSubtags(t, language, script, region);
}

function matchSubtags(t: Tables, language: string, script: string, region: string): Locale {
  const hasScript = script.length > 0;
  const hasRegion = region.length > 0;
  const tag = language + (hasScript ? '-' + script : '') + (hasRegion ? '-' + region : '');
  const exception = t.exceptions.get(tag);
  if (exception !== undefined) return toLocale(exception);

  if (language === 'und') {
    const usual = hasRegion ? t.undRegions.get(region) : undefined;
    if (usual !== undefined) {
      const colon = usual.indexOf(':');
      if (!hasScript || usual.slice(0, colon) === script) return toLocale(usual.slice(colon + 1));
    }
    return hasScript ? toLocale(t.undScripts.get(script)) : Locale.Default;
  }
  const usualScript = hasScript
    ? script
    : (t.regionScripts.get(language + '-' + region) ?? t.likely.get(language) ?? '');
  return toLocale(t.matches.get(language + '-' + usualScript));
}
