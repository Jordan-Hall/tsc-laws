export const primitives = `
type Any = any; type Unknown = unknown; type Never = never; type Void = void;
type Undef = undefined; type Null = null; type Str = string; type Num = number;
type Big = bigint; type Bool = boolean; type Sym = symbol; type Obj = object;
type Empty = {}; type StrA = "a"; type StrB = "b"; type One = 1; type Two = 2;
type BigOne = 1n; type True = true; type False = false;
type StrNum = string | number; type StrOrUndef = string | undefined;
type UnknownLike = {} | null | undefined;
`;
export const primitiveNames = ['Any', 'Unknown', 'Never', 'Void', 'Undef', 'Null', 'Str', 'Num', 'Big', 'Bool', 'Sym', 'Obj', 'Empty', 'StrA', 'StrB', 'One', 'Two', 'BigOne', 'True', 'False', 'StrNum', 'StrOrUndef', 'UnknownLike'];
export const objects = `
type X = { x: number }; type XOne = { x: 1 }; type XY = { x: number; y: string };
type Y = { y: string }; type XOptional = { x?: number }; type XReadonly = { readonly x: number };
type XOptionalUndefined = { x?: number | undefined }; type XUndefined = { x: number | undefined };
type XYIntersection = { x: number } & { y: string };
type XOrY = X | Y; type TagA = { tag: "a"; x: number }; type TagB = { tag: "b"; y: string };
type Tagged = TagA | TagB; type TagAOne = { tag: "a"; x: 1 };
type IndexNum = { [key: string]: number }; type NumProperties = { x: number; y: 1 };
interface InterfaceX { x: number }
type RecursiveA = { value: string; next?: RecursiveA };
type RecursiveB = { value: string; next?: RecursiveB };
type RecursiveC = { value: number; next?: RecursiveC };
type CycleLateA = { next: CycleLateA; value: string };
type CycleLateB = { next: CycleLateB; value: number };
type NumArray = number[]; type LitArray = 1[]; type StrArray = string[];
type ReadonlyNumArray = readonly number[];
type Pair = [number, string]; type PairLit = [1, "a"]; type Short = [number];
type OptionalPair = [number, string?]; type ReadonlyPair = readonly [number, string];
type FNum = (x: number) => number; type FOne = (x: 1) => 1;
type FVoid = (x: number) => void; type FNoArg = () => number;
type FOptional = (x?: number) => number; type FTwoArg = (x: number, y: string) => number;
type MethodNum = { method(x: number): void }; type MethodOne = { method(x: 1): void };
type CallbackNum = (f: (x: number) => number) => void;
type CallbackOne = (f: (x: 1) => 1) => void;
`;
export const objectNames = ['X', 'XOne', 'XY', 'Y', 'XOptional', 'XReadonly', 'XOptionalUndefined', 'XUndefined', 'XYIntersection', 'XOrY', 'TagA', 'TagB', 'Tagged', 'TagAOne', 'IndexNum', 'NumProperties', 'InterfaceX', 'RecursiveA', 'RecursiveB', 'RecursiveC', 'CycleLateA', 'CycleLateB', 'NumArray', 'LitArray', 'StrArray', 'ReadonlyNumArray', 'Pair', 'PairLit', 'Short', 'OptionalPair', 'ReadonlyPair', 'FNum', 'FOne', 'FVoid', 'FNoArg', 'FOptional', 'FTwoArg', 'MethodNum', 'MethodOne', 'CallbackNum', 'CallbackOne'];
export function matrix(names) {
  return names.flatMap(source => names.map(target => ({ source, target })));
}

export const variadicSignatures = `
type VariadicId = <T extends unknown[]>(...args: T) => T;
type VariadicReadonly = <T extends readonly unknown[]>(args: T) => readonly [...T];
type VariadicCopy = <T extends unknown[]>(args: T) => [...T];
type VariadicPrefix = <T extends unknown[]>(...args: [string, ...T]) => T;
type VariadicSuffix = <T extends unknown[]>(...args: [...T, string]) => T;
type VariadicBoth = <T extends unknown[]>(...args: [string, ...T, boolean]) => T;
type VariadicOptional = <T extends unknown[]>(...args: [...T, string?]) => T;
type FixedEmpty = () => [];
type FixedPair = (a: number, b: string) => [number, string];
type FixedWrong = (a: number, b: string) => [string, number];
type FixedNumbers = (...args: number[]) => number[];
type FixedPrefix = (tag: string, a: number, b: boolean) => [number, boolean];
type FixedSuffix = (a: number, b: boolean, tag: string) => [number, boolean];
type FixedBoth = (tag: string, a: number, b: string, end: boolean) => [number, string];
type FixedOptional = (a: number, tag?: string) => [number];
type FixedCopy = (args: [number, string?]) => [number, string?];
type FixedReadonly = (args: readonly [number, string]) => readonly [number, string];
type FixedArrayCopy = (args: number[]) => number[];
`;
export const variadicSignatureNames = ['VariadicId', 'VariadicReadonly', 'VariadicCopy', 'VariadicPrefix', 'VariadicSuffix', 'VariadicBoth', 'VariadicOptional', 'FixedEmpty', 'FixedPair', 'FixedWrong', 'FixedNumbers', 'FixedPrefix', 'FixedSuffix', 'FixedBoth', 'FixedOptional', 'FixedCopy', 'FixedReadonly', 'FixedArrayCopy'];

export const noInferSignatures = `
    type Plain = <T>(value: T, hint: T) => T;
    type Blocked = <T>(value: T, hint: NoInfer<T>) => T;
    type BlockedReturn = <T>(value: T, hint: T) => NoInfer<T>;
    type DefaultPlain = <T = string>(value: T) => void;
    type DefaultBlocked = <T = string>(value: NoInfer<T>) => void;
    type ConstraintBlocked = <T extends "a" | "b" = "a">(value: NoInfer<T>) => void;
    type OnlyBlocked = <T>(value: NoInfer<T>) => T;
    type BothBlocked = <T>(value: NoInfer<T>) => NoInfer<T>;
    type PairSame = (value: 1, hint: 1) => 1;
    type PairDifferent = (value: 1, hint: 2) => 1 | 2;
    type PairWrong = (value: 1, hint: 2) => string;
    type NumberVoid = (value: number) => void;
    type StringVoid = (value: string) => void;
    type AVoid = (value: "a") => void;
    type BVoid = (value: "b") => void;
    type NumberReturn = (value: number) => number;
    type UnknownReturn = (value: number) => unknown;
    type StringReturn = (value: string) => string;
  `;
export const noInferSignatureNames = ['Plain', 'Blocked', 'BlockedReturn', 'DefaultPlain', 'DefaultBlocked', 'ConstraintBlocked', 'OnlyBlocked', 'BothBlocked', 'PairSame', 'PairDifferent', 'PairWrong', 'NumberVoid', 'StringVoid', 'AVoid', 'BVoid', 'NumberReturn', 'UnknownReturn', 'StringReturn'];

export const enumRelations = `
enum NumericEnum { A = 0, B = 1, C = 4 }
enum OtherNumericEnum { A = 0, B = 1, C = 4 }
enum TextEnum { A = "a", B = "b" }
enum MixedEnum { A = 0, B = "b" }
enum CollisionEnum { Text = "\u33b8", Number = 4464 }
enum ComputedEnum { A = Math.random(), B = Math.random() }
declare enum AmbientEnum { A, B = 1 }
const enum ConstantEnum { A = 0, B = 1 }
type NumericA = NumericEnum.A; type NumericB = NumericEnum.B;
type OtherA = OtherNumericEnum.A; type TextA = TextEnum.A;
type MixedA = MixedEnum.A; type MixedB = MixedEnum.B;
type ComputedA = ComputedEnum.A; type ComputedB = ComputedEnum.B;
type AmbientA = AmbientEnum.A; type AmbientB = AmbientEnum.B;
type ConstantA = ConstantEnum.A;
type CollisionText = CollisionEnum.Text; type CollisionNumber = CollisionEnum.Number;
type Zero = 0; type One = 1; type Four = 4; type Invalid = 5;
type LiteralA = "a"; type LiteralB = "b"; type Num = number; type Str = string;
type Any = any; type Unknown = unknown; type Never = never;
`;
export const enumRelationNames = ['NumericEnum', 'OtherNumericEnum', 'TextEnum', 'MixedEnum', 'CollisionEnum', 'ComputedEnum', 'AmbientEnum', 'ConstantEnum', 'NumericA', 'NumericB', 'OtherA', 'TextA', 'MixedA', 'MixedB', 'ComputedA', 'ComputedB', 'AmbientA', 'AmbientB', 'ConstantA', 'CollisionText', 'CollisionNumber', 'Zero', 'One', 'Four', 'Invalid', 'LiteralA', 'LiteralB', 'Num', 'Str', 'Any', 'Unknown', 'Never'];

export const templateSignatures = `
type Prefix = <T extends string>(x: T) => \`prefix_\${T}\`;
type Stringify = <T extends string | number | bigint | boolean | null | undefined>(x: T) => \`\${T}\`;
type Split = <T extends string>(x: T) => T extends \`\${infer A}.\${infer B}\` ? [A, B] : never;
type Chars = <T extends string>(x: T) => T extends \`\${infer A}\${infer B}\` ? [A, B] : never;
type Numeric = <T extends string>(x: T) => T extends \`\${infer N extends number}\` ? N : never;
type BigNumeric = <T extends string>(x: T) => T extends \`\${infer N extends bigint}\` ? N : never;
type Prefixed = (x: "a") => "prefix_a";
type WrongPrefix = (x: "a") => "prefix_b";
type PrefixedUnion = (x: "a" | "b") => "prefix_a" | "prefix_b";
type NumberString = (x: 42) => "42";
type BooleanString = (x: boolean) => "true" | "false";
type SplitDot = (x: "a.b.c") => ["a", "b.c"];
type WrongSplit = (x: "a.b.c") => ["a.b", "c"];
type Character = (x: "abc") => ["a", "bc"];
type EmptyCharacter = (x: "") => never;
type NumberParse = (x: "42") => 42;
type NonCanonical = (x: "042") => number;
type BigParse = (x: "9007199254740993") => 9007199254740993n;
type WrongParse = (x: "42") => string;
`;
export const templateSignatureNames = ['Prefix', 'Stringify', 'Split', 'Chars', 'Numeric', 'BigNumeric', 'Prefixed', 'WrongPrefix', 'PrefixedUnion', 'NumberString', 'BooleanString', 'SplitDot', 'WrongSplit', 'Character', 'EmptyCharacter', 'NumberParse', 'NonCanonical', 'BigParse', 'WrongParse'];

export const patternIndexes = `
type PrefixIndex = { [K: \`pre_\${string}\`]: number };
type NarrowIndex = { [K: \`pre_\${number}\`]: number };
type WrongIndex = { [K: \`pre_\${string}\`]: string };
type OtherIndex = { [K: \`other_\${string}\`]: number };
type SuffixIndex = { [K: \`\${string}_end\`]: number };
type UnionIndex = { [K: \`pre_\${string}\` | \`other_\${string}\`]: number };
type ReadonlyIndex = { readonly [K: \`pre_\${string}\`]: number };
type RecordIndex = Record<\`pre_\${string}\`, number>;
type NumericPatternIndex = { [K: \`\${number}\`]: number };
type NumberIndex = { [K: number]: number };
type StringIndex = { [K: string]: number };
type AnyIndex = { [K: string]: any };
type MixedIndex = { [K: string]: unknown; [K: \`pre_\${string}\`]: number };
type Good = { pre_a: number; other: string };
type Bad = { pre_a: string };
type Optional = { pre_a?: number };
type OptionalUndefined = { pre_a?: number | undefined };
type Numeric = { pre_42: number };
type Miss = { other: string };
type Empty = {};
interface InterfaceGood { pre_a: number }
interface InterfacePattern { [K: \`pre_\${string}\`]: number }
class ClassGood { pre_a = 1; }
type Str = string; type Num = number; type Any = any; type Unknown = unknown; type Never = never;
`;
export const patternIndexNames = ['PrefixIndex', 'NarrowIndex', 'WrongIndex', 'OtherIndex', 'SuffixIndex', 'UnionIndex', 'ReadonlyIndex', 'RecordIndex', 'NumericPatternIndex', 'NumberIndex', 'StringIndex', 'AnyIndex', 'MixedIndex', 'Good', 'Bad', 'Optional', 'OptionalUndefined', 'Numeric', 'Miss', 'Empty', 'InterfaceGood', 'InterfacePattern', 'ClassGood', 'Str', 'Num', 'Any', 'Unknown', 'Never'];

export const stringMappingSignatures = `
type UpperFn = <T extends string>(x: T) => Uppercase<T>;
type LowerFn = <T extends string>(x: T) => Lowercase<T>;
type CapitalFn = <T extends string>(x: T) => Capitalize<T>;
type UncapitalFn = <T extends string>(x: T) => Uncapitalize<T>;
type NestedFn = <T extends string>(x: T) => Uppercase<Lowercase<T>>;
type ParameterFn = <T extends string>(x: Uppercase<T>) => T;
type PatternFn = <T extends string>(x: T) => Uppercase<\`pre_\${T}_end\`>;
type FirstFn = <T extends string>(x: T) => Capitalize<\`\${T}_end\`>;
type UpperText = (x: "ßfoo") => "SSFOO";
type LowerText = (x: "ΟΣ") => "ος";
type CapitalText = (x: "ßfoo") => "SSfoo";
type UncapitalText = (x: "İFOO") => "i̇FOO";
type NestedText = (x: "AbC") => "ABC";
type PatternText = (x: "ab") => "PRE_AB_END";
type FirstText = (x: "ab") => "Ab_end";
type UnionText = (x: "a" | "b") => "A" | "B";
type EmptyText = (x: "") => "";
type WrongText = (x: "ßfoo") => "ßFOO";
`;
export const stringMappingSignatureNames = ['UpperFn', 'LowerFn', 'CapitalFn', 'UncapitalFn', 'NestedFn', 'ParameterFn', 'PatternFn', 'FirstFn', 'UpperText', 'LowerText', 'CapitalText', 'UncapitalText', 'NestedText', 'PatternText', 'FirstText', 'UnionText', 'EmptyText', 'WrongText'];
