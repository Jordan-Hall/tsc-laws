/**
 * The tsconfig.json written by `tsc --init`.
 */
import * as m from './command-line-messages.js';
import type { Message } from './command-line-messages.js';
import {
  compilerOptionsByName,
  sameEnumValue,
  watchOptionsByName,
  type OptionDeclaration,
} from './option-declarations.js';
import { JsxEmit, ModuleDetectionKind, ModuleKind, ScriptTarget, type OptionValue } from './options.js';

const enum Commented {
  /** Always written as a setting. */
  Never,
  /** Written as a setting only if given on the command line. */
  Optional,
}

/** Generates tsconfig.json text with the recommended settings plus the command-line `options`. */
export function generateTSConfig(options: ReadonlyMap<string, OptionValue>): string {
  const writer = new ConfigWriter(options);
  writer.line('{');
  writer.line('  // ' + m.Visit_https_Colon_Slash_Slashaka_ms_Slashtsconfig_to_read_more_about_this_file.text);
  writer.line('  "compilerOptions": {');

  writer.heading(m.File_Layout);
  writer.option('rootDir', './src', Commented.Optional);
  writer.option('outDir', './dist', Commented.Optional);
  writer.line('');

  writer.heading(m.Environment_Settings);
  writer.heading(m.See_also_https_Colon_Slash_Slashaka_ms_Slashtsconfig_Slashmodule);
  writer.option('module', ModuleKind.NodeNext, Commented.Never);
  writer.option('target', ScriptTarget.ESNext, Commented.Never);
  writer.option('types', [], Commented.Never);
  const lib = options.get('lib');
  if (lib !== undefined) writer.option('lib', lib, Commented.Never);
  writer.heading(m.For_nodejs_Colon);
  writer.line('    // "lib": ["esnext"],');
  writer.line('    // "types": ["node"],');
  writer.heading(m.and_npm_install_D_types_Slashnode);
  writer.line('');

  writer.heading(m.Other_Outputs);
  writer.option('sourceMap', true, Commented.Never);
  writer.option('declaration', true, Commented.Never);
  writer.option('declarationMap', true, Commented.Never);
  writer.line('');

  writer.heading(m.Stricter_Typechecking_Options);
  writer.option('noUncheckedIndexedAccess', true, Commented.Never);
  writer.option('exactOptionalPropertyTypes', true, Commented.Never);
  writer.line('');

  writer.heading(m.Style_Options);
  writer.option('noImplicitReturns', true, Commented.Optional);
  writer.option('noImplicitOverride', true, Commented.Optional);
  writer.option('noUnusedLocals', true, Commented.Optional);
  writer.option('noUnusedParameters', true, Commented.Optional);
  writer.option('noFallthroughCasesInSwitch', true, Commented.Optional);
  writer.option('noPropertyAccessFromIndexSignature', true, Commented.Optional);
  writer.line('');

  writer.heading(m.Recommended_Options);
  writer.option('strict', true, Commented.Never);
  writer.option('jsx', JsxEmit.ReactJSX, Commented.Never);
  writer.option('verbatimModuleSyntax', true, Commented.Never);
  writer.option('isolatedModules', true, Commented.Never);
  writer.option('noUncheckedSideEffectImports', true, Commented.Never);
  writer.option('moduleDetection', ModuleDetectionKind.Force, Commented.Never);
  writer.option('skipLibCheck', true, Commented.Never);

  // Then any other options given on the command line.
  const rest = writer.unwritten();
  if (rest.length > 0) {
    writer.line('');
    for (const name of rest) writer.option(name, options.get(name) ?? null, Commented.Never);
  }

  writer.line('  }');
  writer.line('}');
  writer.line('');
  return writer.lines.join('\n');
}

class ConfigWriter {
  readonly lines: string[] = [];
  private readonly written = new Set<string>(['init', 'help', 'watch']);

  constructor(private readonly options: ReadonlyMap<string, OptionValue>) {}

  line(text: string): void {
    this.lines.push(text);
  }

  heading(message: Message): void {
    this.lines.push('    // ' + message.text);
  }

  option(name: string, defaultValue: OptionValue, commented: Commented): void {
    this.written.add(name);
    const given = this.options.get(name);
    const value = given === undefined ? defaultValue : given;
    const prefix = commented === Commented.Optional && !this.options.has(name) ? '    // "' : '    "';
    this.lines.push(prefix + name + '": ' + formatValue(name, value) + ',');
  }

  /** Command-line options not written yet, in the order given. */
  unwritten(): string[] {
    const names: string[] = [];
    for (const name of this.options.keys()) if (!this.written.has(name)) names.push(name);
    return names;
  }
}

function formatValue(name: string, value: OptionValue): string {
  const option = compilerOptionsByName.get(name) ?? watchOptionsByName.get(name);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'string') return formatScalar(value, option);
  const element = option?.element;
  return '[' + value.map((item) => formatScalar(item, element)).join(', ') + ']';
}

/** JSON for `value`; enum values are written as their first name. */
function formatScalar(value: number | string, option: OptionDeclaration | undefined): string {
  if (option?.values !== undefined) {
    for (const [name, enumValue] of option.values) if (sameEnumValue(enumValue, value)) return JSON.stringify(name);
  }
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}
