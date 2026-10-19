// Prints tsc-ts/api's answers for a project, one line each: its files and diagnostics, and the symbol, types and
// signatures at every node of its files outside the default libraries. The same answers are expected from a Node
// build and a native build of this file. Usage: api-probe <tsconfig.json> <default library directory>
import {
  createProgramFromConfigFile,
  type Diagnostic,
  type Expression,
  InternalCompilerError,
  type Node,
  parseSourceFile,
  type Program,
  type Signature,
  SignatureKind,
  type SourceFile,
  type Symbol,
  SymbolFlags,
  symbolName,
  SyntaxKind,
  type Type,
  type TypeChecker,
  walkPreorder,
} from '../../src/library/index.js';

const print = (line: string): void => {
  console.log(line);
};

function sourceFileOf(node: Node): SourceFile {
  let current = node;
  while (current.parent !== undefined) current = current.parent;
  return current as SourceFile;
}

/** A node by file, kind and position, which identifies it in both builds. */
function nodeText(node: Node | undefined): string {
  if (node === undefined) return '-';
  const file = sourceFileOf(node);
  const name = file.fileName.substring(file.fileName.lastIndexOf('/') + 1);
  return `${name}:${node.kind}:${node.pos}-${node.end}`;
}

function symbolText(symbol: Symbol | undefined): string {
  if (symbol === undefined) return '-';
  const declarations = symbol.declarations.map(nodeText).join(',');
  return `${symbolName(symbol)} ${symbol.flags >>> 0} ${symbol.checkFlags >>> 0} [${declarations}] ${nodeText(symbol.valueDeclaration)}`;
}

function diagnosticText(d: Diagnostic): string {
  const file = d.fileName === undefined ? '-' : d.fileName.substring(d.fileName.lastIndexOf('/') + 1);
  return `${file}:${d.pos}-${d.end} TS${d.code} ${d.category} ${d.text}`;
}

function probe(program: Program, checker: TypeChecker): void {
  for (const name of program.getSourceFileNames()) print(`file ${name.substring(name.lastIndexOf('/') + 1)}`);
  for (const d of program.getSemanticDiagnostics()) print(`semantic ${diagnosticText(d)}`);
  for (const d of program.getSyntacticDiagnostics()) print(`syntactic ${diagnosticText(d)}`);
  for (const d of program.getGlobalDiagnostics()) print(`global ${diagnosticText(d)}`);

  const types: Type[] = [];
  const seen = new Set<Type>();
  const keep = (type: Type | undefined): string => {
    if (type === undefined) return '-';
    if (!seen.has(type)) {
      seen.add(type);
      types.push(type);
    }
    return `${type.flags >>> 0} ${checker.typeToString(type)}`;
  };

  const symbols: Symbol[] = [];
  for (const file of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(file)) continue;
    walkPreorder(file, (node) => {
      if (node === file) return;
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined) symbols.push(symbol);
      print(`node ${nodeText(node)} symbol ${symbolText(symbol)}`);
      print(`  type ${keep(checker.getTypeAtLocation(node))}`);
      print(`  contextual ${keep(checker.getContextualType(node as Expression))}`);
      if (node.kind === SyntaxKind.CallExpression || node.kind === SyntaxKind.NewExpression) {
        const signature = checker.getResolvedSignature(node);
        print(`  resolved ${signature === undefined ? '-' : nodeText(signature.declaration)}`);
      }
    });
  }
  for (const symbol of symbols.slice(0, 400)) {
    print(`symbol ${symbolText(symbol)}`);
    print(`  type ${keep(checker.getTypeOfSymbol(symbol))}`);
    print(`  declared ${keep(checker.getDeclaredTypeOfSymbol(symbol))}`);
    if ((symbol.flags & SymbolFlags.Alias) !== 0) print(`  aliased ${symbolText(checker.getAliasedSymbol(symbol))}`);
    print(`  parent ${symbolText(symbol.getParent())}`);
    print(`  members ${[...symbol.getMembers().keys()].sort().join(',')}`);
    print(`  exports ${[...symbol.getExports().keys()].sort().join(',')}`);
  }
  for (let i = 0; i < types.length && i < 300; i++) {
    const type = types[i]!;
    print(`type ${type.flags >>> 0} ${checker.typeToString(type)}`);
    print(`  symbol ${symbolText(type.getSymbol())} alias ${symbolText(type.getAliasSymbol())}`);
    print(`  properties ${checker.getPropertiesOfType(type).map(symbolName).join(',')}`);
    for (const kind of [SignatureKind.Call, SignatureKind.Construct])
      for (const signature of checker.getSignaturesOfType(type, kind))
        print(`  signature ${signatureText(checker, signature)}`);
    for (const info of checker.getIndexInfosOfType(type))
      print(`  index ${checker.typeToString(info.keyType)} ${checker.typeToString(info.type)} ${info.isReadonly}`);
    print(
      `  array ${checker.isArrayType(type)} tuple ${checker.isTupleType(type)} arrayLike ${checker.isArrayLikeType(type)}`,
    );
  }
}

function signatureText(checker: TypeChecker, signature: Signature): string {
  const parameters = signature.getParameters().map(symbolName).join(',');
  const returnType = checker.getReturnTypeOfSignature(signature);
  return `${signature.flags} ${nodeText(signature.declaration)} (${parameters}) ${returnType === undefined ? '-' : checker.typeToString(returnType)}`;
}

const args = process.argv.slice(2);
const configFileName = args[0]!;
const libDir = args[1]!;
const directory = configFileName.substring(0, configFileName.lastIndexOf('/'));
print('start');
const program = createProgramFromConfigFile(configFileName, {
  getCurrentDirectory: () => directory,
  useCaseSensitiveFileNames: () => true,
  getDefaultLibraryDirectory: () => libDir,
});
probe(program, program.getTypeChecker());
const parsed = parseSourceFile(directory + '/parsed.ts', 'export const parsed = 1;\n');
print(`parsed ${parsed.statements.nodes.length} ${parsed.statements.nodes[0]!.kind}`);
try {
  const checker = program.getTypeChecker();
  checker.getAliasedSymbol(checker.resolveName('Math', SymbolFlags.Value)!);
} catch (e) {
  print(`error ${e instanceof InternalCompilerError ? 'InternalCompilerError' : 'other'}`);
}
program.dispose();
