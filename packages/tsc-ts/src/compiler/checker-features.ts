// The library that adds each global and its members, for errors suggesting a newer `lib` setting.

export interface FeatureMapEntry {
  readonly lib: string;
  readonly props: readonly string[];
}

let features: Map<string, readonly FeatureMapEntry[]> | undefined;

/** Library features by global name, oldest library first. */
export function getFeatureMap(): Map<string, readonly FeatureMapEntry[]> {
  features ??= new Map<string, readonly FeatureMapEntry[]>([
    [
      'Array',
      [
        { lib: 'es2015', props: ['find', 'findIndex', 'fill', 'copyWithin', 'entries', 'keys', 'values'] },
        { lib: 'es2016', props: ['includes'] },
        { lib: 'es2019', props: ['flat', 'flatMap'] },
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    ['Iterator', [{ lib: 'es2015', props: [] }]],
    ['AsyncIterator', [{ lib: 'es2015', props: [] }]],
    [
      'ArrayBuffer',
      [
        {
          lib: 'es2024',
          props: ['maxByteLength', 'resizable', 'resize', 'detached', 'transfer', 'transferToFixedLength'],
        },
      ],
    ],
    [
      'Atomics',
      [
        {
          lib: 'es2017',
          props: [
            'add',
            'and',
            'compareExchange',
            'exchange',
            'isLockFree',
            'load',
            'or',
            'store',
            'sub',
            'wait',
            'notify',
            'xor',
          ],
        },
        { lib: 'es2024', props: ['waitAsync'] },
      ],
    ],
    [
      'SharedArrayBuffer',
      [
        { lib: 'es2017', props: ['byteLength', 'slice'] },
        { lib: 'es2024', props: ['growable', 'maxByteLength', 'grow'] },
      ],
    ],
    ['AsyncIterable', [{ lib: 'es2018', props: [] }]],
    ['AsyncIterableIterator', [{ lib: 'es2018', props: [] }]],
    ['AsyncGenerator', [{ lib: 'es2018', props: [] }]],
    ['AsyncGeneratorFunction', [{ lib: 'es2018', props: [] }]],
    [
      'RegExp',
      [
        { lib: 'es2015', props: ['flags', 'sticky', 'unicode'] },
        { lib: 'es2018', props: ['dotAll'] },
        { lib: 'es2024', props: ['unicodeSets'] },
      ],
    ],
    ['RegExpConstructor', [{ lib: 'es2025', props: ['escape'] }]],
    [
      'Reflect',
      [
        {
          lib: 'es2015',
          props: [
            'apply',
            'construct',
            'defineProperty',
            'deleteProperty',
            'get',
            'getOwnPropertyDescriptor',
            'getPrototypeOf',
            'has',
            'isExtensible',
            'ownKeys',
            'preventExtensions',
            'set',
            'setPrototypeOf',
          ],
        },
      ],
    ],
    [
      'ArrayConstructor',
      [
        { lib: 'es2015', props: ['from', 'of'] },
        { lib: 'esnext', props: ['fromAsync'] },
      ],
    ],
    [
      'ObjectConstructor',
      [
        { lib: 'es2015', props: ['assign', 'getOwnPropertySymbols', 'keys', 'is', 'setPrototypeOf'] },
        { lib: 'es2017', props: ['values', 'entries', 'getOwnPropertyDescriptors'] },
        { lib: 'es2019', props: ['fromEntries'] },
        { lib: 'es2022', props: ['hasOwn'] },
        { lib: 'es2024', props: ['groupBy'] },
      ],
    ],
    [
      'NumberConstructor',
      [{ lib: 'es2015', props: ['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt'] }],
    ],
    [
      'Math',
      [
        {
          lib: 'es2015',
          props: [
            'clz32',
            'imul',
            'sign',
            'log10',
            'log2',
            'log1p',
            'expm1',
            'cosh',
            'sinh',
            'tanh',
            'acosh',
            'asinh',
            'atanh',
            'hypot',
            'trunc',
            'fround',
            'cbrt',
          ],
        },
        { lib: 'es2025', props: ['f16round'] },
      ],
    ],
    [
      'Map',
      [
        { lib: 'es2015', props: ['entries', 'keys', 'values'] },
        { lib: 'esnext', props: ['getOrInsert', 'getOrInsertComputed'] },
      ],
    ],
    ['MapConstructor', [{ lib: 'es2024', props: ['groupBy'] }]],
    [
      'Set',
      [
        { lib: 'es2015', props: ['entries', 'keys', 'values'] },
        {
          lib: 'es2025',
          props: [
            'union',
            'intersection',
            'difference',
            'symmetricDifference',
            'isSubsetOf',
            'isSupersetOf',
            'isDisjointFrom',
          ],
        },
      ],
    ],
    [
      'PromiseConstructor',
      [
        { lib: 'es2015', props: ['all', 'race', 'reject', 'resolve'] },
        { lib: 'es2020', props: ['allSettled'] },
        { lib: 'es2021', props: ['any'] },
        { lib: 'es2024', props: ['withResolvers'] },
        { lib: 'es2025', props: ['try'] },
      ],
    ],
    [
      'Symbol',
      [
        { lib: 'es2015', props: ['for', 'keyFor'] },
        { lib: 'es2019', props: ['description'] },
      ],
    ],
    [
      'WeakMap',
      [
        { lib: 'es2015', props: [] },
        { lib: 'esnext', props: ['getOrInsert', 'getOrInsertComputed'] },
      ],
    ],
    ['WeakSet', [{ lib: 'es2015', props: [] }]],
    [
      'String',
      [
        {
          lib: 'es2015',
          props: [
            'codePointAt',
            'includes',
            'endsWith',
            'normalize',
            'repeat',
            'startsWith',
            'anchor',
            'big',
            'blink',
            'bold',
            'fixed',
            'fontcolor',
            'fontsize',
            'italics',
            'link',
            'small',
            'strike',
            'sub',
            'sup',
          ],
        },
        { lib: 'es2017', props: ['padStart', 'padEnd'] },
        { lib: 'es2019', props: ['trimStart', 'trimEnd', 'trimLeft', 'trimRight'] },
        { lib: 'es2020', props: ['matchAll'] },
        { lib: 'es2021', props: ['replaceAll'] },
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2024', props: ['isWellFormed', 'toWellFormed'] },
      ],
    ],
    ['StringConstructor', [{ lib: 'es2015', props: ['fromCodePoint', 'raw'] }]],
    ['DateTimeFormat', [{ lib: 'es2017', props: ['formatToParts'] }]],
    [
      'Promise',
      [
        { lib: 'es2015', props: [] },
        { lib: 'es2018', props: ['finally'] },
      ],
    ],
    ['RegExpMatchArray', [{ lib: 'es2018', props: ['groups'] }]],
    ['RegExpExecArray', [{ lib: 'es2018', props: ['groups'] }]],
    [
      'Intl',
      [
        { lib: 'es2018', props: ['PluralRules'] },
        { lib: 'es2020', props: ['RelativeTimeFormat', 'Locale', 'DisplayNames'] },
        { lib: 'es2021', props: ['ListFormat', 'DateTimeFormat'] },
        { lib: 'es2022', props: ['Segmenter'] },
        { lib: 'es2025', props: ['DurationFormat'] },
      ],
    ],
    ['NumberFormat', [{ lib: 'es2018', props: ['formatToParts'] }]],
    [
      'SymbolConstructor',
      [
        { lib: 'es2020', props: ['matchAll'] },
        { lib: 'esnext', props: ['metadata', 'dispose', 'asyncDispose'] },
      ],
    ],
    [
      'DataView',
      [
        { lib: 'es2020', props: ['setBigInt64', 'setBigUint64', 'getBigInt64', 'getBigUint64'] },
        { lib: 'es2025', props: ['setFloat16', 'getFloat16'] },
      ],
    ],
    ['BigInt', [{ lib: 'es2020', props: [] }]],
    ['RelativeTimeFormat', [{ lib: 'es2020', props: ['format', 'formatToParts', 'resolvedOptions'] }]],
    [
      'Int8Array',
      [
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    [
      'Uint8Array',
      [
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    [
      'Uint8ClampedArray',
      [
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    [
      'Int16Array',
      [
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    [
      'Uint16Array',
      [
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    [
      'Int32Array',
      [
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    [
      'Uint32Array',
      [
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    ['Float16Array', [{ lib: 'es2025', props: [] }]],
    [
      'Float32Array',
      [
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    [
      'Float64Array',
      [
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    [
      'BigInt64Array',
      [
        { lib: 'es2020', props: [] },
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    [
      'BigUint64Array',
      [
        { lib: 'es2020', props: [] },
        { lib: 'es2022', props: ['at'] },
        { lib: 'es2023', props: ['findLastIndex', 'findLast', 'toReversed', 'toSorted', 'toSpliced', 'with'] },
      ],
    ],
    ['Error', [{ lib: 'es2022', props: ['cause'] }]],
    ['ErrorConstructor', [{ lib: 'esnext', props: ['isError'] }]],
    ['Uint8ArrayConstructor', [{ lib: 'esnext', props: ['fromBase64', 'fromHex'] }]],
    ['DisposableStack', [{ lib: 'esnext', props: [] }]],
    ['AsyncDisposableStack', [{ lib: 'esnext', props: [] }]],
    ['Date', [{ lib: 'esnext', props: ['toTemporalInstant'] }]],
  ]);
  return features;
}
