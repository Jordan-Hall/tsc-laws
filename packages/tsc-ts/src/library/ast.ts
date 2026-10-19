// The hand-written node types of tsc-ts's public API; the node interfaces are generated in
// ast.generated.ts (scripts/generate-api.mjs). They describe tsc-ts's own nodes, which the API hands
// out as they are: every node has its kind, flags, position and parent, and its children in the fields
// TypeScript 7's AST names. Lists are NodeList objects.

import type {
  EndOfFile,
  EntityName,
  Identifier,
  KeywordSyntaxKind,
  ModifierSyntaxKind,
  PropertyAccessExpression,
  PunctuationSyntaxKind,
  Statement,
  ThisExpression,
  Token,
} from './ast.generated.js';
import type { LanguageVariant, ModifierFlags, NodeFlags, ScriptKind, SyntaxKind } from './enums.generated.js';

export interface TextRange {
  readonly pos: number;
  readonly end: number;
}

/**
 * A node. `pos` is where the node's leading trivia starts and `end` where the node ends, as UTF-16
 * offsets into the file's text; `tokenStartOfNode` gives the start of its first token. `parent` is the
 * enclosing node, and the source file for its statements; a source file's `parent` is undefined.
 */
export interface Node extends TextRange {
  readonly kind: SyntaxKind;
  readonly flags: NodeFlags;
  readonly parent: Node;
}

/** The children of a node in one list: `nodes`, and the range from the list's opening to its closing token. */
export interface NodeList<T extends Node = Node> extends TextRange {
  readonly nodes: readonly T[];
  /** Whether a comma follows the last node before the list's end. */
  hasTrailingComma(): boolean;
}

/** The modifiers of a declaration, with the flags of all of them. */
export interface ModifierList<T extends Node = Node> extends NodeList<T> {
  readonly modifierFlags: ModifierFlags;
}

/** A `/// <reference path>`, `types` or `lib` directive. */
export interface FileReference extends TextRange {
  readonly fileName: string;
  /** The `resolution-mode` attribute: ModuleKind.ESNext, ModuleKind.CommonJS, or ModuleKind.None without one. */
  readonly resolutionMode: number;
  readonly preserve: boolean;
}

export interface LineAndCharacter {
  /** 0-based line number. */
  readonly line: number;
  /** 0-based character offset, in UTF-16 code units, from the start of the line. */
  readonly character: number;
}

export interface SourceFile extends Node {
  readonly kind: SyntaxKind.SourceFile;
  readonly statements: NodeList<Statement>;
  readonly endOfFileToken: EndOfFile;
  readonly text: string;
  readonly fileName: string;
  /** The file's path: its absolute, normalized file name, lower-cased where file names are case-insensitive. */
  readonly path: string;
  readonly languageVariant: LanguageVariant;
  readonly scriptKind: ScriptKind;
  readonly isDeclarationFile: boolean;
  readonly referencedFiles: readonly FileReference[];
  readonly typeReferenceDirectives: readonly FileReference[];
  readonly libReferenceDirectives: readonly FileReference[];
  /** The module specifiers of the file's imports, exports, `require` calls and import types, in source order. */
  readonly imports: readonly Node[];
  readonly moduleAugmentations: readonly Node[];
  readonly ambientModuleNames: readonly string[];
  /** The first import or export that makes the file a module, or undefined for a script. */
  readonly externalModuleIndicator: Node | undefined;
}

export type PunctuationToken<TKind extends PunctuationSyntaxKind> = Token<TKind>;
export type KeywordToken<TKind extends KeywordSyntaxKind> = Token<TKind>;
export type ModifierToken<TKind extends ModifierSyntaxKind> = KeywordToken<TKind>;

export interface PropertyAccessEntityNameExpression extends PropertyAccessExpression {
  readonly expression: EntityNameExpression;
  readonly name: Identifier;
}

export type EntityNameExpression = Identifier | PropertyAccessEntityNameExpression;
export type EntityNameOrEntityNameExpression = EntityName | EntityNameExpression;

export interface JsxTagNamePropertyAccess extends PropertyAccessExpression {
  readonly expression: Identifier | ThisExpression | JsxTagNamePropertyAccess;
}

export * from './ast.generated.js';
