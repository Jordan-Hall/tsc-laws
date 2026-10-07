// Edits to generated code that work around scriptc 0.2.5 rejecting it.
// Each edit must match exactly once; remove it once scriptc accepts the original.
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
];
