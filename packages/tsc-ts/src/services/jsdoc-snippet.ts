// The `/** */` completion that inserts a doc comment template, like tsgo's JSDoc snippet.
import {
  BinaryExpression,
  getExpression,
  getInitializer,
  JSDoc,
  type Node,
  ParseOptions,
  type SourceFile,
} from '../compiler/ast.js';
import { getStartOfNode, getTokenAtPosition } from '../compiler/astnav.js';
import { getAssignmentDeclarationKind } from '../compiler/binder-utilities.js';
import { getJSDoc, parseSourceFile } from '../compiler/parser.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { CompletionItemKind } from './symbol-kinds.js';
import { findAncestor, getLineEndOfPosition, getLineStartPositionForPosition } from './completion-utilities.js';
import type { CompletionList } from './completions.js';

export function getJSDocSnippetCompletion(file: SourceFile, position: number): CompletionList | undefined {
  if (!isPotentiallyValidJSDocSnippetCompletionPosition(file, position)) return undefined;
  if (!hasDocCommentTemplateAtPosition(file, position)) return undefined;
  return {
    isIncomplete: false,
    entries: [{ name: '/** */', kind: CompletionItemKind.Text, sortText: '\u0000', detail: 'JSDoc comment' }],
  };
}

export function isPotentiallyValidJSDocSnippetCompletionPosition(file: SourceFile, position: number): boolean {
  const text = file.text;
  const lineStart = getLineStartPositionForPosition(position, file);
  if (!isJSDocSnippetPrefix(text.substring(lineStart, position))) return false;
  const lineEnd = getLineEndOfPosition(file, position);
  return isJSDocSnippetSuffix(text.substring(position, lineEnd));
}

/** Whether a doc comment template applies at `position`; the template's text doesn't affect the item. */
function hasDocCommentTemplateAtPosition(file: SourceFile, position: number): boolean {
  let tokenAtPos = getTokenAtPosition(file, position);
  if (tokenAtPos === undefined) return false;
  const existingDocComment = findAncestor(tokenAtPos, (n) => n.kind === SyntaxKind.JSDoc);
  const commentEnd = getDocCommentEndAtPosition(file, position);
  const hasDocCommentAtPosition = commentEnd !== undefined;
  const isInEmptyDocComment = existingDocComment !== undefined || hasDocCommentAtPosition;
  if (isNonEmptyJSDoc(existingDocComment) && commentEnd !== undefined && !commentEnd.hasClosing) {
    // Close the comment and look again.
    const text = file.text.substring(0, position) + ' */' + file.text.substring(position);
    const options = new ParseOptions(file.path, file.scriptKind, file.externalModuleIndicatorOptions);
    return hasDocCommentTemplateAtPosition(parseSourceFile(file.fileName, text, options), position);
  }
  if (isNonEmptyJSDoc(existingDocComment)) return false;
  if (existingDocComment === undefined && commentEnd !== undefined) {
    tokenAtPos = getTokenAtPosition(file, skipWhitespace(file.text, commentEnd.end));
    if (tokenAtPos === undefined) return false;
  }
  const tokenStart = getStartOfNode(tokenAtPos, file, false);
  if (!isInEmptyDocComment && tokenStart < position) return false;
  const commentOwner = getCommentOwner(tokenAtPos);
  if (commentOwner === undefined) return false;
  const jsDocs = getJSDoc(file, commentOwner);
  const lastJSDoc = jsDocs.length > 0 ? jsDocs[jsDocs.length - 1] : undefined;
  if (
    getStartOfNode(commentOwner, file, false) < position ||
    (lastJSDoc !== undefined && existingDocComment !== undefined && lastJSDoc !== existingDocComment)
  )
    return false;
  return true;
}

interface DocCommentEnd {
  end: number;
  hasClosing: boolean;
}

function getDocCommentEndAtPosition(file: SourceFile, position: number): DocCommentEnd | undefined {
  const text = file.text;
  const lineStart = getLineStartPositionForPosition(position, file);
  const lineEnd = getLineEndOfPosition(file, position);
  if (!trimRightSingleLineWhitespace(text.substring(lineStart, position)).endsWith('/**')) return undefined;
  const suffix = text.substring(position, lineEnd);
  const suffixEnd = getJSDocSnippetSuffixEnd(suffix);
  return { end: position + (suffixEnd >= 0 ? suffixEnd : 0), hasClosing: suffixEnd >= 0 };
}

function skipWhitespace(text: string, positionIn: number): number {
  let position = positionIn;
  while (position < text.length && isWhiteSpaceLike(text.charCodeAt(position))) position++;
  return position;
}

function isWhiteSpaceLike(ch: number): boolean {
  return isWhiteSpaceSingleLine(ch) || ch === 0x0a || ch === 0x0d || ch === 0x2028 || ch === 0x2029;
}

function isWhiteSpaceSingleLine(ch: number): boolean {
  return (
    ch === 0x20 ||
    ch === 0x09 ||
    ch === 0x0b ||
    ch === 0x0c ||
    ch === 0xa0 ||
    ch === 0x85 ||
    ch === 0x1680 ||
    (ch >= 0x2000 && ch <= 0x200b) ||
    ch === 0x202f ||
    ch === 0x205f ||
    ch === 0x3000 ||
    ch === 0xfeff
  );
}

function getCommentOwner(tokenAtPos: Node): Node | undefined {
  for (let node: Node | undefined = tokenAtPos; node !== undefined; node = node.parent) {
    const result = getCommentOwnerWorker(node);
    if (result !== undefined) return result.owner;
    if (isQuitOwner(node)) return undefined;
  }
  return undefined;
}

interface CommentOwner {
  owner: Node | undefined;
}

function isQuitOwner(node: Node): boolean {
  if (node.kind === SyntaxKind.SourceFile) return true;
  if (node instanceof BinaryExpression) return getAssignmentDeclarationKind(node) === 0;
  if (node.kind === SyntaxKind.ExpressionStatement) {
    const expression = getExpression(node);
    return expression instanceof BinaryExpression && getAssignmentDeclarationKind(expression) === 0;
  }
  return false;
}

function getCommentOwnerWorker(commentOwner: Node | undefined): CommentOwner | undefined {
  if (commentOwner === undefined) return undefined;
  switch (commentOwner.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.EnumMember:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.VariableStatement:
      return { owner: commentOwner };
    case SyntaxKind.PropertyAssignment:
      return getCommentOwnerWorker(getInitializer(commentOwner));
    case SyntaxKind.ModuleDeclaration:
      if (commentOwner.parent!.kind === SyntaxKind.ModuleDeclaration) return undefined;
      return { owner: commentOwner };
    case SyntaxKind.ExpressionStatement:
      return getCommentOwnerWorker(getExpression(commentOwner));
    case SyntaxKind.BinaryExpression:
      if (getAssignmentDeclarationKind(commentOwner as BinaryExpression) === 0) return undefined;
      return { owner: commentOwner };
    case SyntaxKind.PropertyDeclaration: {
      const initializer = getInitializer(commentOwner);
      if (
        initializer !== undefined &&
        (initializer.kind === SyntaxKind.FunctionExpression || initializer.kind === SyntaxKind.ArrowFunction)
      )
        return { owner: commentOwner };
      return undefined;
    }
  }
  return undefined;
}

function isNonEmptyJSDoc(jsDoc: Node | undefined): boolean {
  if (!(jsDoc instanceof JSDoc)) return false;
  return jsDoc.comment.nodes.length > 0 || (jsDoc.tags !== undefined && jsDoc.tags.nodes.length > 0);
}

function isJSDocSnippetPrefix(prefix: string): boolean {
  const trimmed = trimRightSingleLineWhitespace(prefix);
  if (trimmed.endsWith('/**')) return true;
  const start = skipSingleLineWhitespace(prefix, 0);
  if (start >= trimmed.length || trimmed.charCodeAt(start) !== 0x2f) return false;
  if (start + 3 > trimmed.length) return false;
  for (let i = start + 1; i < trimmed.length; i++) if (trimmed.charCodeAt(i) !== 0x2a) return false;
  return trimmed.length - start >= 3;
}

function isJSDocSnippetSuffix(suffix: string): boolean {
  const trimmed = trimRightSingleLineWhitespace(suffix.substring(skipSingleLineWhitespace(suffix, 0)));
  if (trimmed === '') return true;
  if (!trimmed.endsWith('/')) return false;
  for (let i = 0; i < trimmed.length - 1; i++) if (trimmed.charCodeAt(i) !== 0x2a) return false;
  return true;
}

// The end of a comment terminator after leading whitespace, or -1.
function getJSDocSnippetSuffixEnd(suffix: string): number {
  let pos = skipSingleLineWhitespace(suffix, 0);
  while (pos < suffix.length && suffix.charCodeAt(pos) === 0x2a) pos++;
  if (pos < suffix.length && suffix.charCodeAt(pos) === 0x2f) return pos + 1;
  return -1;
}

function trimRightSingleLineWhitespace(text: string): string {
  let end = text.length;
  while (end > 0 && isWhiteSpaceSingleLine(text.charCodeAt(end - 1))) end--;
  return text.substring(0, end);
}

function skipSingleLineWhitespace(text: string, posIn: number): number {
  let pos = posIn;
  while (pos < text.length && isWhiteSpaceSingleLine(text.charCodeAt(pos))) pos++;
  return pos;
}
