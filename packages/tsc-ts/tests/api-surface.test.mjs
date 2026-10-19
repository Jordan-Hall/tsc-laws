// tsc-ts/api's types (src/library) against tsc-ts's own objects: the generated files are current, the
// public enums give tsc-ts's values for every member tsc-ts has, and tsc-ts's nodes have every child
// field TypeScript 7's AST names for their kind (scripts/generate-api.mjs), as lists of NodeList shape
// and with parents set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { nullable } from '../scripts/ast-nullable.mjs';

const root = resolve(import.meta.dirname, '..');
const upstream = resolve(root, '../../upstream/typescript-go');
const cases = resolve(root, '../../upstream/TypeScript/tests/cases');
const parserPath = join(root, 'dist/tsc-ts/src/compiler/parser.js');
const noUpstream = !existsSync(join(upstream, '_packages/native-preview/src/enums')) && 'run npm run fetch:upstream';

test('the generated API types are current', { skip: noUpstream }, () => {
  execFileSync(process.execPath, [join(root, 'scripts/generate-api.mjs'), '--check'], { stdio: 'pipe' });
});

/** Members of the public enums whose values differ from tsc-ts's, with the reason. */
const differingMembers = new Map([
  // TypeScript 7's API package writes Go's `1<<30 - 1` as `1 << 30 - 1`, which is 1 << 29 in TypeScript.
  // The public enum keeps TypeScript 7's value; no symbol carries it.
  ['SymbolFlags.All', 'TypeScript 7 API value'],
  // tsc-ts writes TypeScript 7's internal names with U+FFFE where TypeScript 7's API writes `__`.
  ...[
    'Call',
    'Constructor',
    'New',
    'Index',
    'ExportStar',
    'Global',
    'Missing',
    'Type',
    'Object',
    'JSXAttributes',
    'Class',
    'Function',
    'Computed',
    'AssignmentDeclaration',
    'InstantiationExpression',
    'ImportAttributes',
  ].map((name) => [`InternalSymbolName.${name}`, 'internal name prefix']),
]);

/** The values of the enums declared in `files`, by enum and member name. */
function enumValues(files) {
  const program = ts.createProgram(files, { noEmit: true, noResolve: true, target: ts.ScriptTarget.ESNext });
  const checker = program.getTypeChecker();
  const enums = new Map();
  for (const file of files)
    ts.forEachChild(program.getSourceFile(file), (node) => {
      if (!ts.isEnumDeclaration(node)) return;
      const members = enums.get(node.name.text) ?? new Map();
      enums.set(node.name.text, members);
      for (const member of node.members) members.set(member.name.getText(), checker.getConstantValue(member));
    });
  return enums;
}

test('the public enums number kinds and flags as tsc-ts does', () => {
  const compiler = ['syntax-kind', 'ast', 'types', 'symbol', 'checker-types', 'options', 'diagnostics'].map((name) =>
    join(root, `src/compiler/${name}.ts`),
  );
  const internal = enumValues(compiler);
  const exported = enumValues([join(root, 'src/library/enums.generated.ts')]);
  const failures = [];
  let compared = 0;
  for (const [name, members] of exported) {
    const own = internal.get(name);
    if (own === undefined) continue;
    for (const [member, value] of members) {
      if (!own.has(member) || differingMembers.has(`${name}.${member}`)) continue;
      compared++;
      if (own.get(member) !== value) failures.push(`${name}.${member}: tsc-ts ${own.get(member)}, API ${value}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(compared > 750, `${compared} members compared`);
});

test(
  'tsc-ts nodes have the fields of their API interfaces',
  { skip: noUpstream || (!existsSync(parserPath) && 'run npm run build') },
  async () => {
    const { api } = await import(pathToFileURL(join(upstream, '_scripts/schema.ts')).href);
    const { parseSourceFile } = await import(pathToFileURL(parserPath).href);
    const { SyntaxKind } = await import(pathToFileURL(join(root, 'dist/tsc-ts/src/library/enums.generated.js')).href);

    // The members of each kind, as ast.generated.ts declares them (with inherited ones).
    const membersOfKind = new Map();
    for (const node of api.nodes()) {
      if (node.handWritten) continue;
      const members = node.members
        .filter((m) => !m.isKindParam() && !m.noTS && m.rawType !== 'SyntaxKind')
        .map((m) => ({
          name: api.uncapitalize(m.name),
          optional: m.optional || nullable.has(`${node.name}.${m.name}`),
          primitive: m.type.kind === 'primitive',
          list: m.type.kind === 'list' ? m.listKind : undefined,
        }));
      for (const kind of node.allKinds()) membersOfKind.set(SyntaxKind[kind.name], members);
    }

    const failures = new Set();
    const seen = new Set();
    const check = (top) => {
      const stack = [top];
      while (stack.length > 0) {
        const node = stack.pop();
        seen.add(node.kind);
        const members = membersOfKind.get(node.kind);
        if (members === undefined) continue;
        for (const member of members) {
          const value = node[member.name];
          const where = `${SyntaxKind[node.kind]}.${member.name}`;
          if (value === undefined) {
            if (!member.optional && !member.primitive) failures.add(`${where}: undefined`);
          } else if (member.list !== undefined && member.list !== 'raw') {
            if (!Array.isArray(value.nodes) || typeof value.pos !== 'number') failures.add(`${where}: not a NodeList`);
            else if (member.list === 'ModifierList' && typeof value.modifierFlags !== 'number')
              failures.add(`${where}: not a ModifierList`);
            else
              for (const child of value.nodes) {
                if (child.parent !== node) failures.add(`${where}: child without parent`);
                stack.push(child);
              }
          } else if (typeof value === 'object' && value !== null && typeof value.kind === 'number') {
            if (value.parent !== node) failures.add(`${where}: child without parent`);
            stack.push(value);
          }
        }
      }
    };

    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) files.push(path);
      }
    };
    walk(cases);
    for (const path of files) {
      const file = parseSourceFile(path, readFileSync(path, 'utf8'));
      for (const statement of file.statements.nodes) check(statement);
      check(file.endOfFileToken);
      // JSDoc is kept by the file, by the id of the node it documents (parsed eagerly for JavaScript).
      if (file.jsDocs !== undefined) for (const docs of file.jsDocs.values()) for (const doc of docs) check(doc);
    }
    if (process.env.API_SURFACE_UNSEEN)
      console.log(
        [...membersOfKind.keys()]
          .filter((kind) => !seen.has(kind))
          .map((kind) => SyntaxKind[kind])
          .join(' '),
      );
    assert.deepEqual([...failures].sort(), []);
    assert.ok(seen.size > 250, `${seen.size} kinds seen`);
  },
);

test('symbolName gives the names TypeScript 7 API gives', async () => {
  const { symbolName, InternalSymbolName } = await import(
    pathToFileURL(join(root, 'dist/tsc-ts/src/library/index.js')).href
  );
  const { internalNamePrefix } = await import(pathToFileURL(join(root, 'dist/tsc-ts/src/library/symbols.js')).href);
  const { internalSymbolNamePrefix, Symbol } = await import(
    pathToFileURL(join(root, 'dist/tsc-ts/src/compiler/symbol.js')).href
  );
  assert.equal(internalNamePrefix, internalSymbolNamePrefix);
  const nameOf = (name) => symbolName(new Symbol(0, name));
  assert.equal(nameOf(internalSymbolNamePrefix + 'call'), InternalSymbolName.Call);
  assert.equal(nameOf(internalSymbolNamePrefix + 'object'), '__object');
  assert.equal(nameOf('export='), InternalSymbolName.ExportEquals);
  assert.equal(nameOf('default'), InternalSymbolName.Default);
  assert.equal(nameOf('__proto__'), '__proto__');
  assert.equal(nameOf('x'), 'x');
});
