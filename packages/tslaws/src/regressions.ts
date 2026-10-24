// The regression corpus: every counterexample a property test finds is kept under `.tslaws/regressions` and replayed
// before the random search on later runs, so a bug that was found once cannot silently come back.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The most examples kept per law. */
export const maxExamples = 20;

export const regressionMessage = 'regression: a previously found counterexample still fails';

type Json = null | boolean | string | number | Json[] | { [key: string]: Json };

/**
 * Turns an arbitrary JS value into JSON that `decodeValue` turns back into an equal value. Plain JSON values stay as
 * they are; everything JSON cannot say is a `{"$t": ...}` object, and plain objects are wrapped so a key named `$t`
 * cannot be mistaken for a tag.
 */
export function encodeValue(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === undefined) return { $t: 'undefined' };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $t: 'number', v: 'NaN' };
    if (value === Infinity) return { $t: 'number', v: 'Infinity' };
    if (value === -Infinity) return { $t: 'number', v: '-Infinity' };
    if (Object.is(value, -0)) return { $t: 'number', v: '-0' };
    return value;
  }
  if (typeof value === 'bigint') return { $t: 'bigint', v: value.toString() };
  if (value instanceof Date) return { $t: 'date', v: Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString() };
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, i) => encodeValue(value[i]));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('cannot store a non-plain object');
    const fields: { [key: string]: Json } = {};
    for (const key of Object.keys(value)) fields[key] = encodeValue((value as Record<string, unknown>)[key]);
    return { $t: 'object', v: fields };
  }
  throw new Error(`cannot store a ${typeof value}`);
}

export function decodeValue(json: Json): unknown {
  if (json === null || typeof json === 'string' || typeof json === 'boolean' || typeof json === 'number') return json;
  if (Array.isArray(json)) return json.map(decodeValue);
  const tagged = json as { $t?: string; v?: Json };
  switch (tagged.$t) {
    case 'undefined':
      return undefined;
    case 'number':
      return tagged.v === '-0' ? -0 : Number(tagged.v);
    case 'bigint':
      return BigInt(tagged.v as string);
    case 'date':
      return new Date(tagged.v === 'invalid' ? NaN : (tagged.v as string));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(tagged.v as { [key: string]: Json })) {
        Object.defineProperty(out, key, {
          value: decodeValue(value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    default:
      throw new Error(`unknown tag ${String(tagged.$t)} in the regression corpus`);
  }
}

/** One example (the arguments of a law) as text: the same text for equal arguments, so it also serves as identity. */
export function encodeExample(args: unknown[]): string {
  return JSON.stringify(encodeValue(args));
}

export function decodeExample(text: string): unknown[] {
  return decodeValue(JSON.parse(text) as Json) as unknown[];
}

const root = (cwd: string): string => join(cwd, '.tslaws', 'regressions');

/** `.tslaws/regressions/<law file with / as __>/<law>.json` */
export function regressionFile(cwd: string, file: string, name: string): string {
  return join(root(cwd), file.replace(/[\\/]/g, '__'), `${name}.json`);
}

interface Corpus {
  file: string;
  law: string;
  /** Encoded examples, newest first. */
  examples: Json[];
}

function readCorpus(path: string): Corpus | undefined {
  try {
    const corpus = JSON.parse(readFileSync(path, 'utf8')) as Corpus;
    return Array.isArray(corpus.examples) ? corpus : undefined;
  } catch {
    return undefined;
  }
}

/** The stored examples of a law as the texts `encodeExample` makes, newest first. */
export function loadExamples(cwd: string, file: string, name: string): string[] {
  const corpus = readCorpus(regressionFile(cwd, file, name));
  return corpus === undefined ? [] : corpus.examples.map((e) => JSON.stringify(e));
}

/** Stores `args` as the newest example; an equal older one moves to the front. Returns false when `args` cannot be stored. */
export function saveExample(cwd: string, file: string, name: string, args: unknown[]): boolean {
  let text: string;
  try {
    text = encodeExample(args);
  } catch {
    return false;
  }
  const path = regressionFile(cwd, file, name);
  const kept = loadExamples(cwd, file, name).filter((e) => e !== text);
  const examples = [text, ...kept].slice(0, maxExamples).map((e) => JSON.parse(e) as Json);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ file, law: name, examples }, null, 2)}\n`);
  return true;
}

export interface CorpusEntry {
  file: string;
  law: string;
  count: number;
}

export function listCorpus(cwd: string): CorpusEntry[] {
  const base = root(cwd);
  if (!existsSync(base)) return [];
  const out: CorpusEntry[] = [];
  for (const dir of readdirSync(base).sort()) {
    let names: string[];
    try {
      names = readdirSync(join(base, dir)).sort();
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.endsWith('.json')) continue;
      const corpus = readCorpus(join(base, dir, entry));
      if (corpus !== undefined)
        out.push({
          file: corpus.file ?? dir.replace(/__/g, '/'),
          law: corpus.law ?? entry.slice(0, -5),
          count: corpus.examples.length,
        });
    }
  }
  return out;
}

/** Deletes the whole corpus. Returns whether there was one. */
export function clearCorpus(cwd: string): boolean {
  const base = root(cwd);
  if (!existsSync(base)) return false;
  rmSync(base, { recursive: true, force: true });
  return true;
}
