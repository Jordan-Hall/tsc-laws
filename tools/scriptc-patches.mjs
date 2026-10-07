// Edits to generated code that work around scriptc 0.2.5 rejecting it.
// Each `from` must match exactly `count` times (default 1), inside the
// declaration starting with `within` when given. Remove an edit once scriptc
// accepts the original.
export const patches = [
  {
    // The call result is inferred as `string | undefined` inside this callback.
    file: 'src/tsgo/modulespecifiers.ts',
    from: '        if ($tspath.TryGetExtensionFromPath(pattern).length > 0) {',
    to: "        if (($tspath.TryGetExtensionFromPath(pattern) ?? '').length > 0) {",
  },
  {
    // `baseName` is not treated as a string here.
    file: 'src/tsgo/printer.ts',
    from: "      baseName += '_';\n    }\n    let i: number = 1;",
    to: "      baseName = String(baseName) + '_';\n    }\n    let i: number = 1;",
  },
  // orderedSet<Type | undefined> crashes code generation ("expected object,
  // got union"); it is the only instantiation, so make the class concrete.
  { file: 'src/tsgo/checker.ts', from: 'orderedSet<Type | undefined>', to: 'orderedSet', count: 4 },
  {
    file: 'src/tsgo/checker.ts',
    within: 'export class orderedSet<T> extends',
    from: '<T, $rt.Empty>',
    to: '<Type | undefined, $rt.Empty>',
    count: 2,
  },
  {
    file: 'src/tsgo/checker.ts',
    within: 'export class orderedSet<T> extends',
    from: 'value: T)',
    to: 'value: Type | undefined)',
    count: 2,
  },
  {
    file: 'src/tsgo/checker.ts',
    within: 'export class orderedSet<T> extends',
    from: 'values: T[]',
    to: 'values: (Type | undefined)[]',
  },
  {
    file: 'src/tsgo/checker.ts',
    within: 'export class orderedSet<T> extends',
    from: 'undefined as unknown as T',
    to: 'undefined',
  },
  {
    file: 'src/tsgo/checker.ts',
    within: 'export class orderedSet<T> extends',
    from: 'orderedSet<T>',
    to: 'orderedSet',
    count: 4,
  },
];
