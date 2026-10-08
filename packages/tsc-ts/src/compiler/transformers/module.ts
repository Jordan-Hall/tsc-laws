// `"use strict"` prologues and ECMAScript module output.
import {
  ExportAssignment,
  ExportDeclaration,
  ExpressionStatement,
  ImportEqualsDeclaration,
  ModifierFlags,
  NamedExports,
  type Node,
  NodeList,
  ScriptKind,
  SourceFile,
  StringLiteral,
} from '../ast.js';
import { isAnyImportOrReExport } from '../ast-utilities.js';
import { type CompilerOptions, ModuleKind, getEmitModuleKind, getIsolatedModules } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import { Transformer } from './transformer.js';
import { hasSyntacticModifier, isExternalModule } from './utilities.js';

/** Decides the module format each file is emitted in, from its extension and the nearest package.json. */
export abstract class ModuleFormatHost {
  abstract getEmitModuleFormat(fileName: string): ModuleKind;
}

export class UseStrictTransformer extends Transformer {
  readonly options: CompilerOptions;
  readonly formats: ModuleFormatHost;

  constructor(context: EmitContext, options: CompilerOptions, formats: ModuleFormatHost) {
    super(context);
    this.options = options;
    this.formats = formats;
  }

  visit(node: Node): Node | undefined {
    if (!(node instanceof SourceFile) || node.scriptKind === ScriptKind.JSON) return node;
    const moduleKind = getEmitModuleKind(this.options);
    if (
      isExternalModule(node) &&
      moduleKind >= ModuleKind.ES2015 &&
      (moduleKind === ModuleKind.Preserve || this.formats.getEmitModuleFormat(node.fileName) >= ModuleKind.ES2015)
    )
      return node;
    const statements = node.statements.nodes;
    const first = statements.length > 0 ? statements[0] : undefined;
    if (
      first instanceof ExpressionStatement &&
      first.expression instanceof StringLiteral &&
      first.expression.text === 'use strict'
    )
      return node;
    const factory = this.factory;
    const useStrict = factory.createExpressionStatement(factory.createStringLiteral('use strict', TokenFlags.None));
    return factory.updateSourceFile(
      node,
      new NodeList(node.statements.pos, node.statements.end, [useStrict as Node].concat(statements)),
      node.endOfFileToken,
    );
  }
}

/** ECMAScript module output: drops `import x = require()` and `export =` and keeps files modules. */
export class ESModuleTransformer extends Transformer {
  readonly options: CompilerOptions;

  constructor(context: EmitContext, options: CompilerOptions) {
    super(context);
    this.options = options;
  }

  visit(node: Node): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        if (node instanceof SourceFile) return this.visitSourceFile(node);
        break;
      case SyntaxKind.ImportEqualsDeclaration:
        if (node instanceof ImportEqualsDeclaration && getEmitModuleKind(this.options) < ModuleKind.Node16)
          return undefined;
        return node;
      case SyntaxKind.ExportAssignment:
        if (node instanceof ExportAssignment && node.isExportEquals) return undefined;
        return this.visitEachChild(node);
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.ExportDeclaration:
        return node;
    }
    return this.visitEachChild(node);
  }

  private visitSourceFile(node: SourceFile): Node {
    if (node.isDeclarationFile || !(isExternalModule(node) || getIsolatedModules(this.options))) return node;
    const result = this.visitEachChild(node);
    if (!(result instanceof SourceFile)) return result;
    const file = result as SourceFile;
    if (!isExternalModule(file) || getEmitModuleKind(this.options) === ModuleKind.Preserve) return file;
    const statements = file.statements.nodes;
    for (let i = 0; i < statements.length; i++) if (isExternalModuleIndicator(statements[i])) return file;
    const factory = this.factory;
    const emptyExport = factory.created(
      new ExportDeclaration(
        undefined,
        false,
        factory.created(new NamedExports(factory.createNodeList([]))),
        undefined,
        undefined,
      ),
    );
    const exportStatement: Node = emptyExport;
    return factory.updateSourceFile(
      file,
      new NodeList(file.statements.pos, file.statements.end, statements.concat([exportStatement])),
      node.endOfFileToken,
    );
  }
}

function isExternalModuleIndicator(node: Node): boolean {
  return (
    isAnyImportOrReExport(node) || node instanceof ExportAssignment || hasSyntacticModifier(node, ModifierFlags.Export)
  );
}
