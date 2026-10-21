// Declaration order: uses of block-scoped variables, classes, enums and class properties before
// their declarations or initialization.
import {
  type ExportAssignment,
  type Node,
  type PropertyDeclaration,
  NodeFlags,
  getExpression,
  getInitializer,
  getPostfixToken,
  getText,
  getName,
  getMembers,
} from './ast.js';
import {
  declarationNameToString,
  getContainingClass,
  getImmediatelyInvokedFunctionExpression,
  getNameOfDeclaration,
  getSourceFileOfNode,
  isAccessExpression,
  isBlockOrCatchScoped,
  isClassLike,
  isParameterPropertyDeclaration,
  isPartOfTypeQuery,
  isStatic,
} from './binder-utilities.js';
import { isFunctionLike } from './ast-utilities.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { type Diagnostic, Diagnostics } from './diagnostics.js';
import { ScriptTarget } from './options.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { isPropertyInitializedInStaticBlocks } from './checker-classes.js';
import { SyntaxKind } from './syntax-kind.js';
import { getExportSymbolOfValueSymbolIfExported } from './checker-symbols.js';
import { getBaseTypes, getDeclaredTypeOfSymbol } from './checker-declared-types.js';
import { getPropertyOfType } from './checker-members.js';
import { FunctionFlags, getFunctionFlags } from './checker-utilities.js';
import { getDeclarations, type Symbol, SymbolFlags } from './symbol.js';

/** Reports a block-scoped variable, class or enum resolved at `errorLocation` before its declaration. */
export function checkResolvedBlockScopedVariable(c: Checker, resolved: Symbol, errorLocation: Node): void {
  const result = getExportSymbolOfValueSymbolIfExported(c, resolved);
  if ((result.flags & (SymbolFlags.BlockScopedVariable | SymbolFlags.Class | SymbolFlags.Enum)) === 0) return;
  // Constructor functions aren't block scoped.
  if (
    (result.flags & (SymbolFlags.Function | SymbolFlags.FunctionScopedVariable | SymbolFlags.Assignment)) !== 0 &&
    (result.flags & SymbolFlags.Class) !== 0
  )
    return;
  let declaration: Node | undefined;
  for (const d of getDeclarations(result)) {
    if (isBlockOrCatchScoped(d) || isClassLike(d) || d.kind === SyntaxKind.EnumDeclaration) {
      declaration = d;
      break;
    }
  }
  if (
    declaration === undefined ||
    (declaration.flags & NodeFlags.Ambient) !== 0 ||
    isBlockScopedNameDeclaredBeforeUse(c, declaration, errorLocation)
  )
    return;
  const declarationName = declarationNameToString(getSourceFileOfNode(declaration), getNameOfDeclaration(declaration)!);
  let diagnostic: Diagnostic | undefined = undefined;
  if ((result.flags & SymbolFlags.BlockScopedVariable) !== 0)
    diagnostic = c.error(
      errorLocation,
      Diagnostics.Block_scoped_variable_0_used_before_its_declaration,
      declarationName,
    );
  else if ((result.flags & SymbolFlags.Class) !== 0)
    diagnostic = c.error(errorLocation, Diagnostics.Class_0_used_before_its_declaration, declarationName);
  else if ((result.flags & SymbolFlags.RegularEnum) !== 0 || c.isolatedModules)
    diagnostic = c.error(errorLocation, Diagnostics.Enum_0_used_before_its_declaration, declarationName);
  if (diagnostic !== undefined)
    diagnostic.addRelatedInfo(
      createDiagnosticForNode(declaration, Diagnostics.X_0_is_declared_here, [declarationName]),
    );
}

/** Reports a class property read in an initializer before it's initialized. */
export function checkPropertyNotUsedBeforeDeclaration(c: Checker, prop: Symbol, node: Node, right: Node): void {
  const valueDeclaration = prop.valueDeclaration;
  if (valueDeclaration === undefined || getSourceFileOfNode(node).isDeclarationFile) return;
  const declarationName = getText(right);
  let diagnostic: Diagnostic | undefined = undefined;
  if (
    isInPropertyInitializerOrClassStaticBlock(node, false) &&
    !isOptionalPropertyDeclaration(valueDeclaration) &&
    !(isAccessExpression(node) && isAccessExpression(getExpression(node)!)) &&
    !isBlockScopedNameDeclaredBeforeUse(c, valueDeclaration, right) &&
    !(valueDeclaration.kind === SyntaxKind.MethodDeclaration && isStatic(valueDeclaration)) &&
    (getUseDefineForClassFields(c) || !isPropertyDeclaredInAncestorClass(c, prop))
  )
    diagnostic = c.error(right, Diagnostics.Property_0_is_used_before_its_initialization, declarationName);
  else if (
    valueDeclaration.kind === SyntaxKind.ClassDeclaration &&
    node.parent!.kind !== SyntaxKind.TypeReference &&
    (valueDeclaration.flags & NodeFlags.Ambient) === 0 &&
    !isBlockScopedNameDeclaredBeforeUse(c, valueDeclaration, right)
  )
    diagnostic = c.error(right, Diagnostics.Class_0_used_before_its_declaration, declarationName);
  if (diagnostic !== undefined)
    diagnostic.addRelatedInfo(
      createDiagnosticForNode(valueDeclaration, Diagnostics.X_0_is_declared_here, [declarationName]),
    );
}

export function isInPropertyInitializerOrClassStaticBlock(node: Node, ignoreArrowFunctions: boolean): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
    switch (current.kind) {
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.ClassStaticBlockDeclaration:
        return true;
      case SyntaxKind.TypeQuery:
      case SyntaxKind.JsxClosingElement:
        return false;
      case SyntaxKind.ArrowFunction:
        if (!ignoreArrowFunctions) return false;
        break;
      case SyntaxKind.Block: {
        const parent = current.parent!;
        if (isFunctionLike(parent) && parent.kind !== SyntaxKind.ArrowFunction) return false;
      }
    }
  }
  return false;
}

function isOptionalPropertyDeclaration(node: Node): boolean {
  if (node.kind !== SyntaxKind.PropertyDeclaration) return false;
  const postfix = getPostfixToken(node);
  return postfix !== undefined && postfix.kind === SyntaxKind.QuestionToken;
}

function isPropertyDeclaredInAncestorClass(c: Checker, prop: Symbol): boolean {
  const parent = prop.parent;
  if (parent === undefined || (parent.flags & SymbolFlags.Class) === 0) return false;
  const baseTypes = getBaseTypes(c, getDeclaredTypeOfSymbol(c, parent));
  if (baseTypes.length === 0) return false;
  const superProperty = getPropertyOfType(c, baseTypes[0]!, prop.name);
  return superProperty !== undefined && superProperty.valueDeclaration !== undefined;
}

function getUseDefineForClassFields(c: Checker): boolean {
  return c.compilerOptions.useDefineForClassFields ?? c.languageVersion >= ScriptTarget.ES2022;
}

export function getEmitStandardClassFields(c: Checker): boolean {
  return c.compilerOptions.useDefineForClassFields !== false && c.languageVersion >= ScriptTarget.ES2022;
}

/** Whether a use of a block-scoped declaration is legal: after it, or deferred until it's initialized. */
export function isBlockScopedNameDeclaredBeforeUse(c: Checker, declaration: Node, usage: Node): boolean {
  if (getSourceFileOfNode(declaration) !== getSourceFileOfNode(usage)) return true;
  const declContainer = getEnclosingBlockScopeContainer(declaration);
  // Uses in type contexts are deferred.
  if ((usage.flags & NodeFlags.JSDoc) !== 0 || isPartOfTypeQuery(usage) || isInAmbientOrTypeNode(usage)) return true;
  if (
    declaration.pos <= usage.pos &&
    !(
      declaration.kind === SyntaxKind.PropertyDeclaration &&
      isThisProperty(usage.parent!) &&
      getInitializer(declaration) === undefined &&
      (declaration as PropertyDeclaration).postfixToken?.kind !== SyntaxKind.ExclamationToken
    )
  ) {
    if (declaration.kind === SyntaxKind.BindingElement) {
      // Binding elements may use earlier siblings only (`var [a = b, b = b] = ...` is an error).
      const errorBindingElement = findAncestorOfKind(usage, SyntaxKind.BindingElement);
      if (errorBindingElement !== undefined)
        return (
          findAncestorOfKind(errorBindingElement, SyntaxKind.BindingElement) !==
            findAncestorOfKind(declaration, SyntaxKind.BindingElement) || declaration.pos < errorBindingElement.pos
        );
      // `var [a] = a` uses the variable before its declaration.
      return isBlockScopedNameDeclaredBeforeUse(
        c,
        findAncestorOfKind(declaration, SyntaxKind.VariableDeclaration)!,
        usage,
      );
    }
    if (declaration.kind === SyntaxKind.VariableDeclaration)
      // `var a = a` uses the variable in its own initializer.
      return !isImmediatelyUsedInInitializerOfBlockScopedVariable(declaration, usage, declContainer);
    if (isClassLike(declaration)) return !isUsedInClassComputedNameOrDecorator(c, declaration, usage);
    if (declaration.kind === SyntaxKind.PropertyDeclaration)
      // A self-referencing property initializer, as in `x = this.x`.
      return !isPropertyImmediatelyReferencedWithinDeclaration(declaration, usage, false);
    if (isParameterPropertyDeclaration(declaration, declaration.parent!))
      // `foo = this.bar` with standard class fields, when bar is a parameter property.
      return !(
        getEmitStandardClassFields(c) &&
        getContainingClass(declaration) === getContainingClass(usage) &&
        isUsedInFunctionOrInstanceProperty(c, usage, declaration, declContainer)
      );
    return true;
  }
  // Uses after the declaration are legal when deferred: in export specifiers and `export =`,
  // functions, and instance property initializers referencing other members.
  const parent = usage.parent!;
  if (parent.kind === SyntaxKind.ExportSpecifier || isExportEquals(parent) || isExportEquals(usage)) return true;
  if (isUsedInFunctionOrInstanceProperty(c, usage, declaration, declContainer)) {
    if (
      getEmitStandardClassFields(c) &&
      getContainingClass(declaration) !== undefined &&
      (declaration.kind === SyntaxKind.PropertyDeclaration ||
        isParameterPropertyDeclaration(declaration, declaration.parent!))
    )
      return !isPropertyImmediatelyReferencedWithinDeclaration(declaration, usage, true);
    return true;
  }
  return false;
}

function isExportEquals(node: Node): boolean {
  return node.kind === SyntaxKind.ExportAssignment && (node as ExportAssignment).isExportEquals;
}

/**
 * Whether a use of a class within its own declaration happens before the class exists: in a
 * computed member name, or in a decorator outside a deferred function.
 */
function isUsedInClassComputedNameOrDecorator(c: Checker, declaration: Node, usage: Node): boolean {
  const legacyDecorators = c.compilerOptions.experimentalDecorators === true;
  let container: Node | undefined = usage;
  while (container !== undefined && container !== declaration) {
    if (container.kind === SyntaxKind.ComputedPropertyName && container.parent!.parent === declaration) break;
    if (!legacyDecorators && container.kind === SyntaxKind.Decorator) {
      const decorated = container.parent!;
      if (
        decorated === declaration ||
        ((decorated.kind === SyntaxKind.MethodDeclaration ||
          decorated.kind === SyntaxKind.GetAccessor ||
          decorated.kind === SyntaxKind.SetAccessor ||
          decorated.kind === SyntaxKind.PropertyDeclaration) &&
          decorated.parent === declaration) ||
        (decorated.kind === SyntaxKind.Parameter && decorated.parent!.parent === declaration)
      )
        break;
    }
    container = container.parent;
  }
  if (container === undefined || container === declaration) return false;
  if (!legacyDecorators && container.kind === SyntaxKind.Decorator) {
    let n: Node | undefined = usage;
    while (n !== undefined && n !== container) {
      if (isFunctionLike(n) && getImmediatelyInvokedFunctionExpression(n) === undefined) break;
      n = n.parent;
    }
    return !(n !== undefined && n !== container);
  }
  return true;
}

function isThisProperty(node: Node): boolean {
  return isAccessExpression(node) && getExpression(node)!.kind === SyntaxKind.ThisKeyword;
}

function findAncestorOfKind(node: Node, kind: SyntaxKind): Node | undefined {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (current.kind === kind) return current;
  return undefined;
}

function isInAmbientOrTypeNode(node: Node): boolean {
  if ((node.flags & NodeFlags.Ambient) !== 0) return true;
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (
      current.kind === SyntaxKind.InterfaceDeclaration ||
      current.kind === SyntaxKind.TypeAliasDeclaration ||
      current.kind === SyntaxKind.TypeLiteral
    )
      return true;
  return false;
}

export function getEnclosingBlockScopeContainer(node: Node): Node | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    switch (current.kind) {
      case SyntaxKind.SourceFile:
      case SyntaxKind.CaseBlock:
      case SyntaxKind.CatchClause:
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.Constructor:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.ClassStaticBlockDeclaration:
        return current;
      case SyntaxKind.Block: {
        // Function bodies aren't block scope containers of their own.
        const parent = current.parent!;
        if (!isFunctionLike(parent) && parent.kind !== SyntaxKind.ClassStaticBlockDeclaration) return current;
      }
    }
  }
  return undefined;
}

function isUsedInFunctionOrInstanceProperty(
  c: Checker,
  usage: Node,
  declaration: Node,
  declContainer: Node | undefined,
): boolean {
  for (let current: Node | undefined = usage; current !== undefined; current = current.parent) {
    if (current === declContainer) return false;
    if (isFunctionLike(current)) {
      if (getImmediatelyInvokedFunctionExpression(current) === undefined) return true;
      continue;
    }
    if (current.kind === SyntaxKind.ClassStaticBlockDeclaration) {
      if (declaration.pos < usage.pos) return true;
      continue;
    }
    const parent = current.parent;
    if (parent !== undefined && parent.kind === SyntaxKind.PropertyDeclaration && getInitializer(parent) === current) {
      if (isStatic(parent)) {
        if (declaration.kind === SyntaxKind.MethodDeclaration) return true;
        // A static property assigned in a static block before the initializer.
        if (
          declaration.kind === SyntaxKind.PropertyDeclaration &&
          getContainingClass(usage) === getContainingClass(declaration)
        ) {
          const propName = getName(declaration)!;
          if (propName.kind === SyntaxKind.Identifier || propName.kind === SyntaxKind.PrivateIdentifier) {
            const symbol = getSymbolOfDeclaration(c, declaration);
            const staticBlocks: Node[] = [];
            for (const m of getMembers(declaration.parent!)!.nodes)
              if (m.kind === SyntaxKind.ClassStaticBlockDeclaration) staticBlocks.push(m);
            if (
              symbol !== undefined &&
              isPropertyInitializedInStaticBlocks(
                c,
                propName,
                getTypeOfSymbol(c, symbol),
                staticBlocks,
                declaration.parent!.pos,
                current.pos,
              )
            )
              return true;
          }
        }
      } else {
        const isDeclarationInstanceProperty =
          declaration.kind === SyntaxKind.PropertyDeclaration && !isStatic(declaration);
        if (!isDeclarationInstanceProperty || getContainingClass(usage) !== getContainingClass(declaration))
          return true;
      }
    }
    if (parent !== undefined && parent.kind === SyntaxKind.Decorator && getExpression(parent) === current) {
      const decorated = parent.parent!;
      if (decorated.kind === SyntaxKind.Parameter)
        return isUsedInFunctionOrInstanceProperty(c, decorated.parent!.parent!, declaration, declContainer);
      if (decorated.kind === SyntaxKind.MethodDeclaration)
        return isUsedInFunctionOrInstanceProperty(c, decorated.parent!, declaration, declContainer);
    }
  }
  return false;
}

function isImmediatelyUsedInInitializerOfBlockScopedVariable(
  declaration: Node,
  usage: Node,
  declContainer: Node | undefined,
): boolean {
  const grandparent = declaration.parent!.parent!;
  switch (grandparent.kind) {
    case SyntaxKind.VariableStatement:
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForOfStatement:
      // The use is within the declaration: its initializer or a binding element.
      if (isSameScopeDescendentOf(usage, declaration, declContainer)) return true;
  }
  // In `for (... in/of expr)`, the use is within the expression.
  return (
    (grandparent.kind === SyntaxKind.ForInStatement || grandparent.kind === SyntaxKind.ForOfStatement) &&
    isSameScopeDescendentOf(usage, getExpression(grandparent), declContainer)
  );
}

/** Whether `initial` is within `parent` without crossing `stopAt` or a function that isn't an IIFE. */
function isSameScopeDescendentOf(initial: Node, parent: Node | undefined, stopAt: Node | undefined): boolean {
  if (parent === undefined) return false;
  for (let n: Node | undefined = initial; n !== undefined; n = n.parent) {
    if (n === parent) return true;
    if (
      n === stopAt ||
      (isFunctionLike(n) &&
        (getImmediatelyInvokedFunctionExpression(n) === undefined ||
          (getFunctionFlags(n) & FunctionFlags.AsyncGenerator) !== 0))
    )
      return false;
  }
  return false;
}

/** Whether a property initializer references the property immediately rather than in a deferred function. */
function isPropertyImmediatelyReferencedWithinDeclaration(
  declaration: Node,
  usage: Node,
  stopAtAnyPropertyDeclaration: boolean,
): boolean {
  if (usage.end > declaration.end) return false;
  for (let node: Node | undefined = usage; node !== undefined && node !== declaration; node = node.parent) {
    switch (node.kind) {
      case SyntaxKind.ArrowFunction:
        return false;
      case SyntaxKind.PropertyDeclaration:
        // Even when stopping at any property declaration, it must be in the same class.
        return (
          stopAtAnyPropertyDeclaration &&
          ((declaration.kind === SyntaxKind.PropertyDeclaration && node.parent === declaration.parent) ||
            (isParameterPropertyDeclaration(declaration, declaration.parent!) &&
              node.parent === declaration.parent!.parent))
        );
      case SyntaxKind.Block:
        switch (node.parent!.kind) {
          case SyntaxKind.MethodDeclaration:
          case SyntaxKind.GetAccessor:
          case SyntaxKind.SetAccessor:
            return false;
        }
    }
  }
  return true;
}
