// Compares API responses from two servers. Type, symbol and signature ids are
// opaque, so ids in the expected responses are mapped to the actual ones.
import { isDeepStrictEqual } from 'node:util';

// The kind of object each method returns.
const results = {
  getSymbolAtPosition: 'symbol',
  getSymbolsAtPositions: 'symbol',
  getSymbolAtLocation: 'symbol',
  getSymbolsAtLocations: 'symbol',
  resolveName: 'symbol',
  getParentOfSymbol: 'symbol',
  getMembersOfSymbol: 'symbol',
  getExportsOfSymbol: 'symbol',
  getExportSymbolOfSymbol: 'symbol',
  getSymbolOfType: 'symbol',
  getAliasSymbolOfType: 'symbol',
  getParametersOfSignature: 'symbol',
  getThisParameterOfSignature: 'symbol',
  getShorthandAssignmentValueSymbol: 'symbol',
  getPropertiesOfType: 'symbol',
  getPropertyOfType: 'symbol',
  getExportSpecifierLocalTargetSymbol: 'symbol',
  getAliasedSymbol: 'symbol',
  getImmediateAliasedSymbol: 'symbol',
  getExportsOfModule: 'symbol',
  getMemberInModuleExports: 'symbol',
  getSignaturesOfType: 'signature',
  getResolvedSignature: 'signature',
  getTargetOfSignature: 'signature',
  getSignatureFromDeclaration: 'signature',
  getIndexInfosOfType: 'indexInfo',
  getTypePredicateOfSignature: 'predicate',
  getWellKnownSymbols: 'wellKnown',
  getReferencedSymbolsForNode: 'referencedSymbols',
};

// Request fields that hold ids, by kind.
const typeParams = ['type', 'source', 'target'];
const symbolParams = ['symbol', 'symbols'];

function resultKind(method) {
  if (method in results) return results[method];
  if (/Type|Types|TypeArguments|TypeParameters/.test(method) && method.startsWith('get')) return 'type';
  return 'raw';
}

// The kind of object an `objectId` param names.
function objectKind(method) {
  if (method.endsWith('OfSymbol')) return 'symbol';
  if (method.endsWith('OfSignature')) return 'signature';
  return 'type';
}

export class IdMap {
  constructor() {
    this.maps = { type: new Map(), symbol: new Map(), signature: new Map() };
  }

  bind(kind, expected, actual, where) {
    if (expected === undefined && actual === undefined) return;
    if (typeof expected !== 'number' || typeof actual !== 'number') {
      throw new Error(`${where}: ${kind} id ${expected} vs ${actual}`);
    }
    const map = this.maps[kind];
    const known = map.get(expected);
    if (known === undefined) map.set(expected, actual);
    else if (known !== actual) throw new Error(`${where}: ${kind} id ${expected} maps to ${known}, received ${actual}`);
  }

  // Rewrites the ids in request params from expected-server ids.
  translate(method, params) {
    if (params === null || typeof params !== 'object') return params;
    const out = { ...params };
    const map = (kind, id) => this.maps[kind].get(id) ?? id;
    for (const key of typeParams) if (typeof out[key] === 'number') out[key] = map('type', out[key]);
    for (const key of symbolParams) {
      if (typeof out[key] === 'number') out[key] = map('symbol', out[key]);
      else if (Array.isArray(out[key])) out[key] = out[key].map((id) => map('symbol', id));
    }
    if (typeof out.signature === 'number') out.signature = map('signature', out.signature);
    if (typeof out.objectId === 'number') out.objectId = map(objectKind(method), out.objectId);
    return out;
  }

  // Throws if actual differs from expected beyond id numbering.
  compare(method, expected, actual) {
    if (method === 'getCompletionsAtPosition') compareCompletions(this, expected, actual, method);
    else walk(this, resultKind(method), expected, actual, method);
  }
}

const typeIdFields = [
  'target',
  'objectType',
  'indexType',
  'checkType',
  'extendsType',
  'baseType',
  'substConstraint',
  'freshType',
  'regularType',
];
const typeIdListFields = ['typeParameters', 'outerTypeParameters', 'localTypeParameters', 'aliasTypeArguments'];

function walk(ids, kind, expected, actual, where) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(`${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
    expected.forEach((e, i) => walk(ids, kind, e, actual[i], `${where}[${i}]`));
    return;
  }
  if (expected === null || typeof expected !== 'object' || kind === 'raw') {
    if (!isDeepStrictEqual(expected, actual)) {
      throw new Error(`${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (actual === null || typeof actual !== 'object') {
    throw new Error(`${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
  const keys = Object.keys(expected).join(',');
  if (keys !== Object.keys(actual).join(',')) {
    throw new Error(`${where}: expected keys ${keys}, received ${Object.keys(actual).join(',')}`);
  }
  const rest = { ...expected };
  const restActual = { ...actual };
  const take = (field, k) => {
    ids.bind(k, expected[field], actual[field], `${where}.${field}`);
    delete rest[field];
    delete restActual[field];
  };
  const takeList = (field, k) => {
    if (expected[field] === undefined) return;
    walk(ids, 'raw', expected[field].length, actual[field]?.length, `${where}.${field}.length`);
    expected[field].forEach((id, i) => ids.bind(k, id, actual[field][i], `${where}.${field}[${i}]`));
    delete rest[field];
    delete restActual[field];
  };
  switch (kind) {
    case 'type':
      take('id', 'type');
      for (const f of typeIdFields) if (f in expected) take(f, 'type');
      for (const f of typeIdListFields) takeList(f, 'type');
      if ('aliasSymbol' in expected) take('aliasSymbol', 'symbol');
      if ('symbol' in expected) take('symbol', 'symbol');
      break;
    case 'symbol': {
      take('id', 'symbol');
      // Properties named by unique symbols embed the symbol's id: __@iterator@12.
      const named = /^(__@.*@)(\d+)$/;
      const [, prefix, id] = named.exec(expected.name) ?? [];
      const [, actualPrefix, actualId] = named.exec(actual.name) ?? [];
      if (prefix !== undefined && prefix === actualPrefix) {
        ids.bind('symbol', Number(id), Number(actualId), `${where}.name`);
        delete rest.name;
        delete restActual.name;
      }
      if ('parent' in expected) take('parent', 'symbol');
      if ('exportSymbol' in expected) take('exportSymbol', 'symbol');
      break;
    }
    case 'signature':
      take('id', 'signature');
      takeList('typeParameters', 'type');
      takeList('parameters', 'symbol');
      if ('thisParameter' in expected) take('thisParameter', 'symbol');
      if ('target' in expected) take('target', 'signature');
      break;
    case 'indexInfo':
      walk(ids, 'type', expected.keyType, actual.keyType, `${where}.keyType`);
      walk(ids, 'type', expected.valueType, actual.valueType, `${where}.valueType`);
      delete rest.keyType;
      delete rest.valueType;
      delete restActual.keyType;
      delete restActual.valueType;
      break;
    case 'predicate':
      if (expected.type !== undefined) walk(ids, 'type', expected.type, actual.type, `${where}.type`);
      delete rest.type;
      delete restActual.type;
      break;
    case 'referencedSymbols':
      if (expected.symbol !== undefined) walk(ids, 'symbol', expected.symbol, actual.symbol, `${where}.symbol`);
      delete rest.symbol;
      delete restActual.symbol;
      break;
    case 'wellKnown':
      take('unknown', 'symbol');
      take('undefined', 'symbol');
      take('arguments', 'symbol');
      break;
  }
  if (!isDeepStrictEqual(rest, restActual)) {
    throw new Error(`${where}: expected ${JSON.stringify(rest)}, received ${JSON.stringify(restActual)}`);
  }
}

// Completion entries come in symbol table order, which tsgo doesn't fix; editors sort them
// by sortText and name anyway.
function compareCompletions(ids, expected, actual, where) {
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') {
    walk(ids, 'raw', expected, actual, where);
    return;
  }
  walk(ids, 'raw', expected.isIncomplete, actual.isIncomplete, `${where}.isIncomplete`);
  const key = (e) => [e.sortText ?? '', e.name, e.kind ?? 0, e.insertText ?? '', e.filterText ?? ''].join('\u0000');
  const sorted = (entries) => [...(entries ?? [])].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  const e = sorted(expected.entries);
  const a = sorted(actual.entries);
  if (e.length !== a.length) {
    const names = (list) => list.map((x) => x.name).join(',');
    throw new Error(`${where}: expected ${names(e)}, received ${names(a)}`);
  }
  e.forEach((entry, i) => {
    const { symbol, ...rest } = entry;
    const { symbol: actualSymbol, ...actualRest } = a[i];
    walk(ids, 'raw', rest, actualRest, `${where}.entries[${i}]`);
    if (symbol !== undefined || actualSymbol !== undefined)
      walk(ids, 'symbol', symbol, actualSymbol, `${where}.entries[${i}].symbol`);
  });
}

// Source file encodings must match except for the content hash (bytes 4-19).
export function compareSourceFile(expected, actual, where) {
  if (expected.length !== actual.length) throw new Error(`${where}: ${expected.length} bytes vs ${actual.length}`);
  for (let i = 0; i < expected.length; i++) {
    if (i >= 4 && i < 20) continue;
    if (expected[i] !== actual[i]) throw new Error(`${where}: bytes differ at offset ${i}`);
  }
}
