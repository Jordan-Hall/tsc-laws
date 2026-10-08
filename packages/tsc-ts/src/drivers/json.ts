// Reading oracle requests and writing results, shared by the drivers.
import type { JsonObject, JsonValue } from '../compiler/package-json.js';

const empty: JsonObject = { type: 'object', entries: new Map(), kind: 0 };

/** The value if it is an object, else an empty one. */
export function object(value: JsonValue | undefined): JsonObject {
  return value !== undefined && value.type === 'object' ? value : empty;
}

/** The array at `key`, or none. */
export function items(o: JsonObject, key: string): readonly JsonValue[] {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'array' ? v.items : [];
}

/** The string at `key`, or `''`. */
export function str(o: JsonObject, key: string): string {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'string' ? v.value : '';
}

/** The number at `key`, or `0`. */
export function num(o: JsonObject, key: string): number {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'number' ? v.value : 0;
}

export function bool(o: JsonObject, key: string): boolean | undefined {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'boolean' ? v.value : undefined;
}

/** The strings of the array at `key`, or `undefined` without one. */
export function strings(o: JsonObject, key: string): string[] | undefined {
  const v = o.entries.get(key);
  if (v === undefined || v.type !== 'array') return undefined;
  const result: string[] = [];
  for (const item of v.items) if (item.type === 'string') result.push(item.value);
  return result;
}

export function quote(s: string): string {
  return JSON.stringify(s);
}

export function quoteList(values: readonly string[]): string {
  return '[' + values.map(quote).join(',') + ']';
}
