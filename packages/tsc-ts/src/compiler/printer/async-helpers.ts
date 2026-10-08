// Runtime helpers for lowering async functions, async generators and `for await`.
import { type CallExpression, FunctionExpression, type Node, type NodeList } from '../ast.js';
import { SyntaxKind } from '../syntax-kind.js';
import { EmitFlags } from './emit-flags.js';
import type { NodeFactory } from './factory.js';
import { EmitHelper, noPriority } from './helpers.js';

export const awaitHelper = new EmitHelper(
  'typescript:await',
  false,
  `var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }`,
  noPriority,
  [],
  '__await',
  '',
);

export const asyncGeneratorHelper = new EmitHelper(
  'typescript:asyncGenerator',
  false,
  `var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};`,
  noPriority,
  [awaitHelper],
  '__asyncGenerator',
  '',
);

export const asyncDelegatorHelper = new EmitHelper(
  'typescript:asyncDelegator',
  false,
  `var __asyncDelegator = (this && this.__asyncDelegator) || function (o) {
    var i, p;
    return i = {}, verb("next"), verb("throw", function (e) { throw e; }), verb("return"), i[Symbol.iterator] = function () { return this; }, i;
    function verb(n, f) { i[n] = o[n] ? function (v) { return (p = !p) ? { value: __await(o[n](v)), done: false } : f ? f(v) : v; } : f; }
};`,
  noPriority,
  [awaitHelper],
  '__asyncDelegator',
  '',
);

export const asyncValuesHelper = new EmitHelper(
  'typescript:asyncValues',
  false,
  `var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};`,
  noPriority,
  [],
  '__asyncValues',
  '',
);

export const awaiterHelper = new EmitHelper(
  'typescript:awaiter',
  false,
  `var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};`,
  5,
  [],
  '__awaiter',
  '',
);

/** Scoped: `const _superIndex = name => super[name];` */
export const asyncSuperHelper = new EmitHelper(
  'typescript:async-super',
  true,
  '\nconst {name} = name => super[name];',
  noPriority,
  [],
  '',
  '_superIndex',
);

/** Scoped: a `_superIndex` whose results can also be assigned to. */
export const advancedAsyncSuperHelper = new EmitHelper(
  'typescript:advanced-async-super',
  true,
  '\nconst {name} = (function (geti, seti) {\n' +
    '    const cache = Object.create(null);\n' +
    '    return name => cache[name] || (cache[name] = { get value() { return geti(name); }, set value(v) { seti(name, v); } });\n' +
    '})(name => super[name], (name, value) => super[name] = value);',
  noPriority,
  [],
  '',
  '_superIndex',
);

/** `__await(expression)` */
export function createAwaitHelper(factory: NodeFactory, expression: Node): CallExpression {
  factory.context.requestEmitHelper(awaitHelper);
  return factory.createCallExpression(factory.createUnscopedHelperName('__await'), [expression]);
}

/** `__asyncGenerator(this, arguments, generatorFunc)` */
export function createAsyncGeneratorHelper(
  factory: NodeFactory,
  generatorFunc: Node,
  hasLexicalThis: boolean,
): CallExpression {
  factory.context.requestEmitHelper(awaitHelper);
  factory.context.requestEmitHelper(asyncGeneratorHelper);
  factory.context.addEmitFlags(generatorFunc, EmitFlags.AsyncFunctionBody | EmitFlags.ReuseTempVariableScope);
  const thisArg = createThisArgument(factory, hasLexicalThis);
  return factory.createCallExpression(factory.createUnscopedHelperName('__asyncGenerator'), [
    thisArg,
    factory.createIdentifier('arguments'),
    generatorFunc,
  ]);
}

/** `__asyncDelegator(expression)` */
export function createAsyncDelegatorHelper(factory: NodeFactory, expression: Node): CallExpression {
  factory.context.requestEmitHelper(awaitHelper);
  factory.context.requestEmitHelper(asyncDelegatorHelper);
  return factory.createCallExpression(factory.createUnscopedHelperName('__asyncDelegator'), [expression]);
}

/** `__asyncValues(expression)` */
export function createAsyncValuesHelper(factory: NodeFactory, expression: Node): CallExpression {
  factory.context.requestEmitHelper(asyncValuesHelper);
  return factory.createCallExpression(factory.createUnscopedHelperName('__asyncValues'), [expression]);
}

/** `__awaiter(this, arguments, void 0, function* (parameters) { body })` */
export function createAwaiterHelper(
  factory: NodeFactory,
  hasLexicalThis: boolean,
  argumentsExpression: Node | undefined,
  parameters: NodeList | undefined,
  body: Node,
): CallExpression {
  factory.context.requestEmitHelper(awaiterHelper);
  const generatorFunc = factory.created(
    new FunctionExpression(
      undefined,
      factory.createToken(SyntaxKind.AsteriskToken),
      undefined,
      undefined,
      parameters !== undefined ? parameters : factory.createNodeList([]),
      undefined,
      undefined,
      body,
    ),
  );
  factory.context.addEmitFlags(generatorFunc, EmitFlags.AsyncFunctionBody | EmitFlags.ReuseTempVariableScope);
  const thisArg = createThisArgument(factory, hasLexicalThis);
  return factory.createCallExpression(factory.createUnscopedHelperName('__awaiter'), [
    thisArg,
    argumentsExpression !== undefined ? argumentsExpression : factory.createVoidZero(),
    factory.createVoidZero(),
    generatorFunc,
  ]);
}

/** `this` when the function has a lexical `this`, else `void 0`. */
function createThisArgument(factory: NodeFactory, hasLexicalThis: boolean): Node {
  if (hasLexicalThis) return factory.createKeywordExpression(SyntaxKind.ThisKeyword);
  return factory.createVoidZero();
}
