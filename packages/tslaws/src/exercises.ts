// Which project functions a law exercises, and where they are: the declaration of each (its name) and, for a function the
// law names itself, the reference in the law. An editor shows a failing law on both ends with this. It is a syntactic
// walk over the sources, the same reach the coverage rule uses: calls and references to functions declared at the top of
// a project module, followed through imports and re-exports, and through the functions those functions use.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { ManifestLaw } from './types.ts';

/** A range in a project file: lines and columns are 1-based, the end is exclusive. `file` is relative to the project. */
export interface SourceSpan {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface Exercised {
  name: string;
  /** The function's name where it is declared. */
  declaration: SourceSpan;
  /** The first reference to it in the law itself; absent for a function the law reaches only through others. */
  call?: SourceSpan;
  /** The failure came from this function: the stack of the error the law threw names it. */
  failing?: true;
}

interface Binding {
  /** The module the local name comes from, and the name it has there (`*` for a namespace import). */
  module: string;
  imported: string;
}

interface Declared {
  name: string;
  nameNode: ts.Node;
  body: ts.Node;
}

interface Module {
  file: string;
  text: string;
  source: ts.SourceFile;
  nodes: Map<string, Declared>;
  imports: Map<string, Binding>;
  /** `export { local as exported }` of this module and `export { a as b } from './m'`. */
  exports: Map<string, Binding | string>;
  stars: string[];
}

const resolution: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  allowImportingTsExtensions: true,
  allowJs: false,
};
const ownSource = /\.(ts|tsx|mts|cts)$/;

/** Reads and indexes project modules once per check. */
export class Sources {
  private readonly modules = new Map<string, Module | undefined>();
  readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** The module at project-relative `file`, or undefined when it is not a readable TypeScript source. */
  module(file: string): Module | undefined {
    if (this.modules.has(file)) return this.modules.get(file);
    const full = resolve(this.cwd, file);
    let module: Module | undefined;
    if (ownSource.test(file) && !file.endsWith('.d.ts') && existsSync(full)) {
      const text = readFileSync(full, 'utf8');
      module = this.index(file, text);
    }
    this.modules.set(file, module);
    return module;
  }

  /** The project file a specifier names, or undefined for a package, a declaration file or a path outside the project. */
  private resolveImport(specifier: string, from: string): string | undefined {
    const found = ts.resolveModuleName(specifier, resolve(this.cwd, from), resolution, ts.sys).resolvedModule;
    if (found === undefined || found.isExternalLibraryImport === true) return undefined;
    const file = relative(this.cwd, found.resolvedFileName).split(sep).join('/');
    if (file.startsWith('..') || file.split('/').includes('node_modules')) return undefined;
    return ownSource.test(file) && !file.endsWith('.d.ts') ? file : undefined;
  }

  private index(file: string, text: string): Module {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const module: Module = { file, text, source, nodes: new Map(), imports: new Map(), exports: new Map(), stars: [] };
    const declare = (name: string, nameNode: ts.Node, body: ts.Node): void => {
      module.nodes.set(name, { name, nameNode, body });
    };
    const isDefault = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = this.resolveImport(statement.moduleSpecifier.text, file);
        const clause = statement.importClause;
        if (target === undefined || clause === undefined) continue;
        if (clause.name !== undefined) module.imports.set(clause.name.text, { module: target, imported: 'default' });
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          module.imports.set(bindings.name.text, { module: target, imported: '*' });
        else if (bindings !== undefined)
          for (const element of bindings.elements)
            module.imports.set(element.name.text, {
              module: target,
              imported: (element.propertyName ?? element.name).text,
            });
      } else if (ts.isExportDeclaration(statement)) {
        const target =
          statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
            ? this.resolveImport(statement.moduleSpecifier.text, file)
            : undefined;
        const clause = statement.exportClause;
        if (clause === undefined || ts.isNamespaceExport(clause)) {
          if (target !== undefined && clause === undefined) module.stars.push(target);
        } else
          for (const element of clause.elements)
            module.exports.set(
              element.name.text,
              target === undefined
                ? (element.propertyName ?? element.name).text
                : { module: target, imported: (element.propertyName ?? element.name).text },
            );
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        if (statement.name !== undefined) declare(statement.name.text, statement.name, statement);
        if (isDefault(statement)) declare('default', statement.name ?? statement, statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const init = declaration.initializer;
          if (
            ts.isIdentifier(declaration.name) &&
            init !== undefined &&
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init))
          )
            declare(declaration.name.text, declaration.name, init);
        }
      }
    }
    return module;
  }

  /** The declaration `name` exports from `file`, following re-exports. */
  find(file: string, name: string, depth = 0): { module: Module; node: Declared } | undefined {
    const module = this.module(file);
    if (module === undefined || depth > 8) return undefined;
    const direct = module.nodes.get(name);
    if (direct !== undefined) return { module, node: direct };
    const exported = module.exports.get(name);
    if (typeof exported === 'string') return this.find(file, exported, depth + 1);
    if (exported !== undefined) return this.find(exported.module, exported.imported, depth + 1);
    for (const star of module.stars) {
      const hit = this.find(star, name, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
}

function spanOf(module: Module, node: ts.Node, start = node.getStart(module.source), end = node.getEnd()): SourceSpan {
  const from = module.source.getLineAndCharacterOfPosition(start);
  const to = module.source.getLineAndCharacterOfPosition(end);
  return {
    file: module.file,
    line: from.line + 1,
    column: from.character + 1,
    endLine: to.line + 1,
    endColumn: to.character + 1,
  };
}

/** The law's own text parsed as TypeScript, with a way back from positions in it to the law's file. */
function parseLaw(
  law: ManifestLaw,
  module: Module,
): { source: ts.SourceFile; offset: (pos: number) => number } | undefined {
  // A law is `name(params) { ... }` or `name(params) => expression;`: the first is a function, the second an arrow.
  const arrow = law.body.startsWith('=>');
  const prefix = arrow ? `const ${law.name} = ` : 'function ';
  const wrapped = arrow ? `${prefix}${law.text.slice(law.name.length)}` : `${prefix}${law.text}`;
  // The law's text is exact in its file; the declaration line says which copy when a text repeats.
  let lineStart = 0;
  for (let line = 1; line < law.line; line += 1) {
    const next = module.text.indexOf('\n', lineStart);
    if (next < 0) break;
    lineStart = next + 1;
  }
  const at = module.text.indexOf(law.text, lineStart);
  const found = at >= 0 ? at : module.text.indexOf(law.text);
  if (found < 0) return undefined;
  const shift = arrow ? prefix.length - law.name.length : prefix.length;
  return {
    source: ts.createSourceFile(law.file, wrapped, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS),
    offset: (pos) => found + pos - shift,
  };
}

/** The functions `law` reaches: the ones it names first, in the order it names them, then those they use. */
export function exercisesOf(sources: Sources, law: ManifestLaw): Exercised[] {
  const lawModule = sources.module(law.file);
  if (lawModule === undefined) return [];
  const parsed = parseLaw(law, lawModule);
  if (parsed === undefined) return [];
  const lawParams = new Set(law.params);
  const out: Exercised[] = [];
  const seen = new Set<string>();
  const queue: { module: Module; node: Declared }[] = [];

  const reach = (hit: { module: Module; node: Declared }, call?: SourceSpan): void => {
    const id = `${hit.module.file}::${hit.node.name}`;
    if (seen.has(id)) return;
    seen.add(id);
    const name =
      hit.node.name === 'default' && ts.isIdentifier(hit.node.nameNode) ? hit.node.nameNode.text : hit.node.name;
    out.push({ name, declaration: spanOf(hit.module, hit.node.nameNode), ...(call === undefined ? {} : { call }) });
    queue.push(hit);
  };

  /** The function an identifier (or `namespace.name`) in `module` stands for. */
  const resolveName = (module: Module, node: ts.Node): { module: Module; node: Declared } | undefined => {
    if (ts.isIdentifier(node)) {
      const local = module.nodes.get(node.text);
      if (local !== undefined) return { module, node: local };
      const binding = module.imports.get(node.text);
      return binding === undefined || binding.imported === '*'
        ? undefined
        : sources.find(binding.module, binding.imported);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = module.imports.get(node.expression.text);
      return binding?.imported === '*' ? sources.find(binding.module, node.name.text) : undefined;
    }
    return undefined;
  };

  const walk = (module: Module, root: ts.Node, own: Declared | undefined, inLaw: boolean): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        const parent = node.parent;
        const isMember = parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node;
        const isBinding =
          parent !== undefined &&
          ((ts.isParameter(parent) && parent.name === node) ||
            (ts.isVariableDeclaration(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node));
        const wholeName = ts.isIdentifier(node) ? node.text : undefined;
        if (!isMember && !isBinding && !(inLaw && wholeName !== undefined && lawParams.has(wholeName))) {
          const hit = resolveName(module, node);
          if (hit !== undefined && hit.node !== own) {
            const call =
              inLaw && parsed !== undefined
                ? spanOfLaw(lawModule, parsed.offset(node.getStart(root.getSourceFile())), parsed.offset(node.getEnd()))
                : undefined;
            reach(hit, call);
            if (ts.isPropertyAccessExpression(node)) return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };

  walk(lawModule, parsed.source, undefined, true);
  for (let i = 0; i < queue.length && queue.length < 400; i += 1) {
    const { module, node } = queue[i]!;
    walk(module, node.body, node, false);
  }
  return out;
}

function spanOfLaw(module: Module, start: number, end: number): SourceSpan {
  return spanOf(module, module.source, start, end);
}

/** The stack frames of `stack` that run project code: `[function, ...]` innermost first. */
export function frameFunctions(stack: string, outDir: string): string[] {
  const dir = outDir.split(sep).join('/').toLowerCase();
  const names: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = /^\s*at (?:async )?(?:(\S+) )?\(?(.+?):\d+:\d+\)?\s*$/.exec(line);
    if (frame === null || frame[1] === undefined) continue;
    const file = frame[2]!
      .replaceAll('\\', '/')
      .replace(/^file:\/\/\/?/, '')
      .toLowerCase();
    if (file.includes(dir)) names.push(frame[1].split('.').pop()!);
  }
  return names;
}

/** Marks the function an error's stack names: the innermost project frame that is one of the law's functions. */
export function markFailing(exercised: Exercised[], stack: string | undefined, outDir: string): Exercised[] {
  if (stack === undefined) return exercised;
  const names = frameFunctions(stack, outDir);
  const hit = names.map((n) => exercised.find((e) => e.name === n)).find((e) => e !== undefined);
  return hit === undefined ? exercised : exercised.map((e) => (e === hit ? { ...e, failing: true as const } : e));
}

/** The declaration of `name` in project `file`, for a result that names a function but not where it is. */
export function declarationOf(sources: Sources, file: string, name: string): SourceSpan | undefined {
  const hit = sources.find(file, name);
  return hit === undefined ? undefined : spanOf(hit.module, hit.node.nameNode);
}
