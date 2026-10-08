// Flags transforms set on nodes to customize how the printer emits them.

export const enum EmitFlags {
  None = 0,
  /** Emit the node's contents on a single line. */
  SingleLine = 1 << 0,
  /** Emit the node's contents on multiple lines. */
  MultiLine = 1 << 1,
  NoLeadingSourceMap = 1 << 2,
  NoTrailingSourceMap = 1 << 3,
  /** No source map locations for children. */
  NoNestedSourceMaps = 1 << 4,
  NoTokenLeadingSourceMaps = 1 << 5,
  NoTokenTrailingSourceMaps = 1 << 6,
  NoLeadingComments = 1 << 7,
  NoTrailingComments = 1 << 8,
  /** No comments for children. */
  NoNestedComments = 1 << 9,
  /** The identifier names an unscoped emit helper. */
  HelperName = 1 << 10,
  /** Prefix the identifier with its export (for exported declarations with a local name). */
  ExportName = 1 << 11,
  /** Don't prefix the identifier with its export. */
  LocalName = 1 << 12,
  /** Indent class and function bodies one more level. */
  Indented = 1 << 13,
  NoIndentation = 1 << 14,
  ReuseTempVariableScope = 1 << 15,
  /** Treat the statement as a prologue directive. */
  CustomPrologue = 1 << 16,
  /** Escape non-ASCII characters of a synthesized literal. */
  NoAsciiEscaping = 1 << 17,
  ExternalHelpers = 1 << 18,
  StartOnNewLine = 1 << 19,
  /** Emit a call as `(0, f)()`. */
  IndirectCall = 1 << 20,
  AsyncFunctionBody = 1 << 21,
  NoLexicalArguments = 1 << 22,
  TransformPrivateStaticElements = 1 << 23,
  NoLexicalThis = 1 << 24,

  NoSourceMap = NoLeadingSourceMap | NoTrailingSourceMap,
  NoTokenSourceMaps = NoTokenLeadingSourceMaps | NoTokenTrailingSourceMaps,
  NoComments = NoLeadingComments | NoTrailingComments,
}

export const enum GeneratedIdentifierFlags {
  None = 0,
  /** A temporary variable such as `_a`. */
  Auto = 1,
  /** A loop variable, preferring `_i`. */
  Loop = 2,
  /** A unique name based on the identifier's text. */
  Unique = 3,
  /** A unique name based on another node. */
  Node = 4,
  KindMask = 7,
  ReservedInNestedScopes = 1 << 3,
  /** The first instance doesn't get a `_1` suffix if there's no conflict. */
  Optimistic = 1 << 4,
  /** Check conflicts only against the file's identifiers. */
  FileLevel = 1 << 5,
  AllowNameSubstitution = 1 << 6,
}
