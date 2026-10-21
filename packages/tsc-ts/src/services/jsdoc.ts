// Documentation comments and JSDoc tags of symbols, as plain text.
import {
  BindingElement,
  ExpressionWithTypeArguments,
  getComment,
  getInitializer,
  getName,
  getParameters,
  getSymbol,
  getTagName,
  getText,
  Identifier,
  JSDoc,
  JSDocAugmentsTag,
  JSDocImplementsTag,
  JSDocLink,
  JSDocLinkCode,
  JSDocLinkPlain,
  JSDocNameReference,
  JSDocParameterOrPropertyTag,
  JSDocSatisfiesTag,
  JSDocSeeTag,
  JSDocTemplateTag,
  JSDocText,
  JSDocThrowsTag,
  JSDocTypeTag,
  type Node,
  NodeFlags,
  type NodeList,
  ParenthesizedExpression,
  PropertyAccessExpression,
  QualifiedName,
  VariableDeclarationList,
} from '../compiler/ast.js';
import { getTextOfNodeFromSourceText, isFunctionLike } from '../compiler/ast-utilities.js';
import {
  getSourceFileOfNode,
  hasStaticModifier,
  isClassLike,
  isFunctionExpressionOrArrowFunction,
} from '../compiler/binder-utilities.js';
import { type Checker } from '../compiler/checker.js';
import {
  getBaseConstructorTypeOfClass,
  getBaseTypes,
  getDeclaredTypeOfSymbol,
} from '../compiler/checker-declared-types.js';
import { getApparentType, getPropertyOfType } from '../compiler/checker-members.js';
import { getSymbolAtLocation, getTypeAtLocation } from '../compiler/checker-services.js';
import { resolveAlias } from '../compiler/checker-symbols.js';
import { InterfaceType } from '../compiler/checker-types.js';
import { getJSDoc } from '../compiler/parser.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { declarationCount, getDeclarations, type Symbol, SymbolFlags } from '../compiler/symbol.js';

export interface JSDocTagInfo {
  name: string;
  text: string;
}

/**
 * A symbol's documentation comment: the comments of its declarations, without tags, deduplicated
 * and joined by line breaks. Aliases are not resolved.
 */
export function getSymbolDocumentationComment(c: Checker, symbol: Symbol): string {
  const parts: string[] = [];
  const seen = new Set<Node>();
  for (const declaration of getDeclarations(symbol)) {
    if (seen.has(declaration)) continue;
    seen.add(declaration);
    const doc = getDocumentationFromDeclaration(c, declaration);
    if (doc !== '' && !parts.includes(doc)) parts.push(doc);
  }
  return parts.join('\n');
}

/** A symbol's JSDoc tags, with each tag's text as a plain string. */
export function getSymbolJSDocTags(symbol: Symbol): JSDocTagInfo[] {
  const infos: JSDocTagInfo[] = [];
  const seen = new Set<Node>();
  for (const declaration of getDeclarations(symbol)) {
    if (seen.has(declaration)) continue;
    seen.add(declaration);
    const tags = declarationJSDocTags(declaration);
    // Comments with @typedef or @callback belong to no declaration, unless they also document
    // parameters or a return value.
    let hasTypedef = false;
    let hasParamOrReturn = false;
    for (const tag of tags) {
      if (tag.kind === SyntaxKind.JSDocTypedefTag || tag.kind === SyntaxKind.JSDocCallbackTag) hasTypedef = true;
      if (tag.kind === SyntaxKind.JSDocParameterTag || tag.kind === SyntaxKind.JSDocReturnTag) hasParamOrReturn = true;
    }
    if (hasTypedef && !hasParamOrReturn) continue;
    for (const tag of tags) infos.push({ name: getText(getTagName(tag)!), text: getJSDocTagText(tag) });
  }
  return infos;
}

/** The tags of the last JSDoc comment of a declaration or of the statement it heads. */
function declarationJSDocTags(node: Node): readonly Node[] {
  if ((node.flags & NodeFlags.JSDoc) !== 0) return [];
  const file = getSourceFileOfNode(node);
  for (let current: Node | undefined = node; current !== undefined; current = getNextJSDocCommentLocation(current)) {
    const jsDocs = getJSDoc(file, current);
    if (jsDocs.length === 0) continue;
    const last = jsDocs[jsDocs.length - 1];
    if (last instanceof JSDoc && last.tags !== undefined) return last.tags.nodes;
  }
  return [];
}

export function getNextJSDocCommentLocation(node: Node): Node | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  switch (parent.kind) {
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.VariableStatement:
    case SyntaxKind.ExpressionStatement:
      return parent;
    case SyntaxKind.VariableDeclarationList:
      if (
        parent instanceof VariableDeclarationList &&
        parent.declarations.nodes.length > 0 &&
        parent.declarations.nodes[0] === node
      )
        return parent;
      return undefined;
  }
  return undefined;
}

function isJSDocLinkLike(node: Node): boolean {
  return (
    node.kind === SyntaxKind.JSDocLink ||
    node.kind === SyntaxKind.JSDocLinkCode ||
    node.kind === SyntaxKind.JSDocLinkPlain
  );
}

function textOfNode(node: Node): string {
  return getTextOfNodeFromSourceText(getSourceFileOfNode(node).text, node);
}

/** The plain text of a JSDoc comment, with links as written. */
export function getTextOfJSDocComment(comment: NodeList | undefined): string {
  if (comment === undefined) return '';
  let text = '';
  for (const node of comment.nodes) {
    if (node instanceof JSDocText) text += node.text;
    else if (isJSDocLinkLike(node)) text += textOfNode(node);
  }
  return text.trimEnd();
}

function getJSDocTagText(tag: Node): string {
  const comment = getTextOfJSDocComment(getComment(tag));
  const withComment = (s: string): string => (comment === '' ? s : s + ' ' + comment);
  if (tag instanceof JSDocThrowsTag)
    return tag.typeExpression !== undefined ? withComment(textOfNode(tag.typeExpression)) : comment;
  if (tag instanceof JSDocImplementsTag) return withComment(textOfNode(tag.className));
  if (tag instanceof JSDocAugmentsTag) return withComment(textOfNode(tag.className));
  if (tag instanceof JSDocTemplateTag) {
    let text = tag.constraint !== undefined ? textOfNode(tag.constraint) : '';
    const typeParameters = tag.typeParameters.nodes;
    for (let i = 0; i < typeParameters.length; i++) {
      if (i === 0 && text.length !== 0) text += ' ';
      if (i !== 0) text += ', ';
      text += textOfNode(typeParameters[i]);
    }
    if (comment !== '') {
      if (text.length !== 0) text += ' ';
      text += comment;
    }
    return text;
  }
  if (tag instanceof JSDocTypeTag)
    return tag.typeExpression !== undefined ? withComment(textOfNode(tag.typeExpression)) : withComment('');
  if (tag instanceof JSDocSatisfiesTag) return withComment(textOfNode(tag.typeExpression));
  if (tag instanceof JSDocSeeTag)
    return tag.nameExpression !== undefined ? withComment(textOfNode(tag.nameExpression)) : comment;
  if (tag instanceof JSDocParameterOrPropertyTag) return withComment(textOfNode(tag.name));
  return comment;
}

// ---- Documentation of a declaration

function getDocumentationFromDeclaration(c: Checker, declaration: Node): string {
  const jsDoc = getJSDocOrTag(c, declaration);
  if (jsDoc === undefined) return '';
  if ((declaration.flags & NodeFlags.Reparsed) === 0 && containsTypedefTag(jsDoc)) return '';
  const comments = jsDoc instanceof JSDoc ? jsDoc.comment : getComment(jsDoc);
  return comments === undefined ? '' : writeComments(c, comments);
}

function containsTypedefTag(jsDoc: Node): boolean {
  if (!(jsDoc instanceof JSDoc) || jsDoc.tags === undefined) return false;
  for (const tag of jsDoc.tags.nodes)
    if (tag.kind === SyntaxKind.JSDocTypedefTag || tag.kind === SyntaxKind.JSDocCallbackTag) return true;
  return false;
}

function getLastJSDoc(node: Node): Node | undefined {
  const jsDocs = getJSDoc(getSourceFileOfNode(node), node);
  return jsDocs.length === 0 ? undefined : jsDocs[jsDocs.length - 1];
}

/** The JSDoc comment documenting a declaration, or the `@param` or `@template` tag for it. */
function getJSDocOrTag(c: Checker, node: Node): Node | undefined {
  const jsDoc = getLastJSDoc(node);
  if (jsDoc !== undefined) return jsDoc;
  const parent = node.parent;
  switch (node.kind) {
    case SyntaxKind.Parameter: {
      const name = getName(node)!;
      if (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
        return getJSDocParameterTagByPosition(c, node);
      return getMatchingJSDocTag(c, parent!, getText(name), isMatchingParameterTag);
    }
    case SyntaxKind.TypeParameter:
      return getMatchingJSDocTag(c, parent!, getText(getName(node)!), isMatchingTemplateTag);
    case SyntaxKind.VariableDeclaration:
      if (
        parent instanceof VariableDeclarationList &&
        parent.declarations.nodes.length > 0 &&
        parent.declarations.nodes[0] === node
      )
        return getJSDocOrTag(c, parent.parent!);
      break;
    case SyntaxKind.BindingElement:
      if (node instanceof BindingElement && parent!.kind === SyntaxKind.ObjectBindingPattern) {
        const name = node.propertyName ?? node.name;
        if (name instanceof Identifier) {
          const prop = getPropertyOfType(c, getTypeAtLocation(c, parent!), name.text);
          if (prop !== undefined)
            for (const declaration of getDeclarations(prop)) {
              const doc = getLastJSDoc(declaration);
              if (doc !== undefined) return doc;
            }
        }
      }
      break;
  }
  if (
    (isFunctionExpressionOrArrowFunction(node) || node.kind === SyntaxKind.ClassExpression) &&
    parent !== undefined &&
    (parent.kind === SyntaxKind.VariableDeclaration ||
      parent.kind === SyntaxKind.PropertyDeclaration ||
      parent.kind === SyntaxKind.PropertyAssignment) &&
    getInitializer(parent) === node
  )
    return getJSDocOrTag(c, parent);
  const symbol = getSymbol(node);
  if (symbol === undefined || parent === undefined) return undefined;
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.Constructor:
    case SyntaxKind.ConstructSignature: {
      const first = getDeclarations(symbol).find((d) => isFunctionLike(d));
      if (first !== undefined && first !== node) {
        const doc = getJSDocOrTag(c, first);
        if (doc !== undefined) return doc;
      }
    }
  }
  if (isClassLike(parent) || parent.kind === SyntaxKind.InterfaceDeclaration) {
    const classType = getDeclaredTypeOfSymbol(c, getSymbol(parent)!);
    if (hasStaticModifier(node)) {
      if (!(classType instanceof InterfaceType)) return undefined;
      const staticBase = getApparentType(c, getBaseConstructorTypeOfClass(c, classType));
      const prop = getPropertyOfType(c, staticBase, symbol.name);
      if (prop !== undefined && prop.valueDeclaration !== undefined) {
        const doc = getJSDocOrTag(c, prop.valueDeclaration);
        if (doc !== undefined) return doc;
      }
    } else {
      for (const base of getBaseTypes(c, classType)) {
        const prop = getPropertyOfType(c, base, symbol.name);
        if (prop !== undefined && prop.valueDeclaration !== undefined) {
          const doc = getJSDocOrTag(c, prop.valueDeclaration);
          if (doc !== undefined) return doc;
        }
      }
    }
  }
  return undefined;
}

function getMatchingJSDocTag(
  c: Checker,
  node: Node,
  name: string,
  match: (tag: Node, name: string) => boolean,
): Node | undefined {
  const jsDoc = getJSDocOrTag(c, node);
  if (jsDoc instanceof JSDoc && jsDoc.tags !== undefined)
    for (const tag of jsDoc.tags.nodes) if (match(tag, name)) return tag;
  return undefined;
}

/** The `@param` tag at the index of a binding pattern parameter. */
function getJSDocParameterTagByPosition(c: Checker, param: Node): Node | undefined {
  const parent = param.parent;
  if (parent === undefined) return undefined;
  const params = getParameters(parent);
  if (params === undefined) return undefined;
  const index = params.nodes.indexOf(param);
  if (index < 0) return undefined;
  const jsDoc = getJSDocOrTag(c, parent);
  if (!(jsDoc instanceof JSDoc) || jsDoc.tags === undefined) return undefined;
  let tagIndex = 0;
  for (const tag of jsDoc.tags.nodes) {
    if (tag.kind !== SyntaxKind.JSDocParameterTag) continue;
    if (tagIndex === index) return tag;
    tagIndex++;
  }
  return undefined;
}

function isMatchingParameterTag(tag: Node, name: string): boolean {
  return tag.kind === SyntaxKind.JSDocParameterTag && isNodeWithName(tag, name);
}

function isMatchingTemplateTag(tag: Node, name: string): boolean {
  return tag instanceof JSDocTemplateTag && tag.typeParameters.nodes.some((tp) => isNodeWithName(tp, name));
}

function isNodeWithName(node: Node, name: string): boolean {
  const nodeName = getName(node);
  return nodeName instanceof Identifier && nodeName.text === name;
}

// ---- Comment text

function writeComments(c: Checker, comments: NodeList): string {
  let text = '';
  for (const comment of comments.nodes) {
    if (comment instanceof JSDocText) text += comment.text;
    else if (comment instanceof JSDocLink) text += linkText(c, comment.name, comment.text);
    else if (comment instanceof JSDocLinkPlain) text += linkText(c, comment.name, comment.text);
    else if (comment instanceof JSDocLinkCode) text += linkText(c, comment.name, comment.text);
  }
  return text;
}

function linkText(c: Checker, name: Node | undefined, rawText: string): string {
  const text = trimSpaces(rawText);
  if (name === undefined) return text;
  if (name instanceof Identifier && (name.text === 'http' || name.text === 'https') && text.startsWith('://')) {
    let linkText = name.text + text;
    let linkUri = linkText;
    const commentPos = firstIndexOfSpaceOrBar(linkText);
    if (commentPos >= 0) {
      linkUri = linkText.substring(0, commentPos);
      linkText = trimCommentPrefix(linkText.substring(commentPos));
      if (linkText === '') linkText = linkUri;
    }
    return linkText !== linkUri ? linkText + ' (' + linkUri + ')' : linkText;
  }
  if (hasDeclarations(c, name)) {
    const prefixLength = text.startsWith('()') ? 2 : 0;
    const linkText = trimCommentPrefix(text.substring(prefixLength));
    return linkText === '' ? getEntityNameString(name) + text.substring(0, prefixLength) : linkText;
  }
  return getEntityNameString(name) + (text.length !== 0 ? ' ' : '') + text;
}

/** Whether the name of a link resolves to declarations. */
function hasDeclarations(c: Checker, name: Node): boolean {
  let symbol = getSymbolAtLocation(c, name);
  if (symbol === undefined) return false;
  if ((symbol.flags & SymbolFlags.Alias) !== 0) symbol = resolveAlias(c, symbol);
  return declarationCount(symbol) > 0;
}

function firstIndexOfSpaceOrBar(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x20 || ch === 0x7c) return i;
  }
  return -1;
}

function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) === 0x20) end--;
  return text.substring(start, end);
}

function trimLeadingSpaces(text: string): string {
  let start = 0;
  while (start < text.length && text.charCodeAt(start) === 0x20) start++;
  return text.substring(start);
}

function trimCommentPrefix(text: string): string {
  let rest = trimLeadingSpaces(text);
  if (rest.startsWith('|')) rest = rest.substring(1);
  return trimLeadingSpaces(rest);
}

function getEntityNameString(name: Node): string {
  if (name instanceof Identifier) return name.text;
  if (name instanceof QualifiedName) return getEntityNameString(name.left) + '.' + getEntityNameString(name.right);
  if (name instanceof PropertyAccessExpression)
    return getEntityNameString(name.expression) + '.' + getEntityNameString(name.name);
  if (name instanceof ParenthesizedExpression) return getEntityNameString(name.expression);
  if (name instanceof ExpressionWithTypeArguments) return getEntityNameString(name.expression);
  if (name instanceof JSDocNameReference) return name.name === undefined ? '' : getEntityNameString(name.name);
  return '';
}
