/**
 * `tsc --version`, `--help`, `--help --all` and `tsc --build --help` output.
 */
import * as m from './command-line-messages.js';
import { formatMessage } from './command-line-messages.js';
import type { Message } from './command-line-messages.js';
import {
  buildOption,
  buildOptionDeclarations,
  optionDeclarations,
  optionsForBuild,
  optionsForWatch,
  sameEnumValue,
  type OptionDeclaration,
} from './option-declarations.js';
import type { System } from './tsc-cli.js';

export const version = '7.0.2';

/** Whether output gets colors: `NO_COLOR` and `FORCE_COLOR` override the TTY check. */
export function defaultIsPretty(sys: System): boolean {
  if (sys.getEnvironmentVariable('NO_COLOR') !== '') return false;
  if (sys.getEnvironmentVariable('FORCE_COLOR') !== '') return true;
  return sys.writeOutputIsTTY;
}

/** ANSI styles, or plain text when colors are off. */
export class Colors {
  private readonly enabled: boolean;
  /** Console hosts where blue lacks contrast. */
  private readonly avoidBlue: boolean;
  private readonly richColors: boolean;

  constructor(sys: System) {
    this.enabled = defaultIsPretty(sys);
    const isWindows = sys.getEnvironmentVariable('OS').toLowerCase().includes('windows');
    const isWindowsTerminal = sys.getEnvironmentVariable('WT_SESSION') !== '';
    const isVSCode = sys.getEnvironmentVariable('TERM_PROGRAM') === 'vscode';
    this.avoidBlue = isWindows && !isWindowsTerminal && !isVSCode;
    this.richColors =
      sys.getEnvironmentVariable('COLORTERM') === 'truecolor' ||
      sys.getEnvironmentVariable('TERM') === 'xterm-256color';
  }

  bold(text: string): string {
    return this.enabled ? '\x1b[1m' + text + '\x1b[22m' : text;
  }

  blue(text: string): string {
    if (!this.enabled) return text;
    return this.avoidBlue ? this.brightWhite(text) : '\x1b[94m' + text + '\x1b[39m';
  }

  blueBackground(text: string): string {
    if (!this.enabled) return text;
    return (this.richColors ? '\x1b[48;5;68m' : '\x1b[44m') + text + '\x1b[39;49m';
  }

  brightWhite(text: string): string {
    return this.enabled ? '\x1b[97m' + text + '\x1b[39m' : text;
  }
}

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/** `message`, with the TypeScript logo right-aligned when the terminal is wide enough. */
export function header(sys: System, colors: Colors, message: string): string {
  const width = sys.terminalWidth;
  const icon = '     ';
  if (width < message.length + icon.length) return message + '\n\n';
  const leftAlign = Math.min(width, 120) - icon.length;
  return (
    padEnd(message, leftAlign) +
    colors.blueBackground(icon) +
    '\n' +
    ' '.repeat(leftAlign) +
    colors.blueBackground(colors.brightWhite('  TS ')) +
    '\n'
  );
}

function versionText(): string {
  return formatMessage(m.Version_0, [version]);
}

function title(): string {
  return m.tsc_Colon_The_TypeScript_Compiler.text + ' - ' + versionText();
}

export function printVersion(sys: System): void {
  sys.write(versionText() + '\n');
}

/** `tsc --help`, or with `all`, `tsc --help --all`. */
export function printHelp(sys: System, all: boolean): void {
  const options = [...optionDeclarations, buildOption];
  if (all) {
    options.sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    printAllHelp(sys, options);
  } else {
    printEasyHelp(
      sys,
      options.filter((option) => option.showInSimplifiedHelpView === true),
    );
  }
}

export function printBuildHelp(sys: System): void {
  const colors = new Colors(sys);
  const options = buildOptionDeclarations.filter((option) => option !== buildOption);
  sys.write(
    header(sys, colors, title()) +
      sectionOutput(sys, colors, m.BUILD_OPTIONS.text, options, false, buildModeIntroduction(), undefined),
  );
}

function buildModeIntroduction(): string {
  return formatMessage(
    m.Using_build_b_will_make_tsc_behave_more_like_a_build_orchestrator_than_a_compiler_This_is_used_to_trigger_building_composite_projects_which_you_can_learn_more_about_at_0,
    ['https://aka.ms/tsc-composite-builds'],
  );
}

function learnMore(): string {
  return formatMessage(m.You_can_learn_about_all_of_the_compiler_options_at_0, ['https://aka.ms/tsc']);
}

function printEasyHelp(sys: System, options: readonly OptionDeclaration[]): void {
  const colors = new Colors(sys);
  let out = header(sys, colors, title());
  out += colors.bold(m.COMMON_COMMANDS.text) + '\n\n';
  out += example(colors, ['tsc'], m.Compiles_the_current_project_tsconfig_json_in_the_working_directory);
  out += example(
    colors,
    ['tsc app.ts util.ts'],
    m.Ignoring_tsconfig_json_compiles_the_specified_files_with_default_compiler_options,
  );
  out += example(colors, ['tsc -b'], m.Build_a_composite_project_in_the_working_directory);
  out += example(
    colors,
    ['tsc --init'],
    m.Creates_a_tsconfig_json_with_the_recommended_settings_in_the_working_directory,
  );
  out += example(
    colors,
    ['tsc -p ./path/to/tsconfig.json'],
    m.Compiles_the_TypeScript_project_located_at_the_specified_path,
  );
  out += example(
    colors,
    ['tsc --help --all'],
    m.An_expanded_version_of_this_information_showing_all_possible_compiler_options,
  );
  out += example(
    colors,
    ['tsc --noEmit', 'tsc --target esnext'],
    m.Compiles_the_current_project_with_additional_settings,
  );

  const commandLineOptions: OptionDeclaration[] = [];
  const configOptions: OptionDeclaration[] = [];
  for (const option of options) {
    if (option.isCommandLineOnly === true || option.category === m.Command_line_Options)
      commandLineOptions.push(option);
    else configOptions.push(option);
  }
  out += sectionOutput(sys, colors, m.COMMAND_LINE_FLAGS.text, commandLineOptions, false, undefined, undefined);
  out += sectionOutput(sys, colors, m.COMMON_COMPILER_OPTIONS.text, configOptions, false, undefined, learnMore());
  sys.write(out);
}

function example(colors: Colors, commands: readonly string[], description: Message): string {
  let text = '';
  for (const command of commands) text += '  ' + colors.blue(command) + '\n';
  return text + '  ' + description.text + '\n\n';
}

function printAllHelp(sys: System, options: readonly OptionDeclaration[]): void {
  const colors = new Colors(sys);
  let out = header(sys, colors, title());
  out += sectionOutput(sys, colors, m.ALL_COMPILER_OPTIONS.text, options, true, undefined, learnMore());
  out += sectionOutput(
    sys,
    colors,
    m.WATCH_OPTIONS.text,
    optionsForWatch,
    false,
    m
      .Including_watch_w_will_start_watching_the_current_project_for_the_file_changes_Once_set_you_can_config_watch_mode_with_Colon
      .text,
    undefined,
  );
  out += sectionOutput(
    sys,
    colors,
    m.BUILD_OPTIONS.text,
    optionsForBuild.filter((option) => option !== buildOption),
    false,
    buildModeIntroduction(),
    undefined,
  );
  sys.write(out);
}

/** A section heading and its options, grouped by category when `byCategory` is set. */
function sectionOutput(
  sys: System,
  colors: Colors,
  name: string,
  options: readonly OptionDeclaration[],
  byCategory: boolean,
  before: string | undefined,
  after: string | undefined,
): string {
  let out = colors.bold(name) + '\n\n';
  if (before !== undefined) out += before + '\n\n';
  if (!byCategory) {
    out += groupOutput(sys, colors, options);
  } else {
    const categories = new Map<string, OptionDeclaration[]>();
    for (const option of options) {
      if (option.category === undefined) continue;
      const category = option.category.text;
      const group = categories.get(category);
      if (group === undefined) categories.set(category, [option]);
      else group.push(option);
    }
    for (const [category, group] of categories) out += '### ' + category + '\n\n' + groupOutput(sys, colors, group);
  }
  if (after !== undefined) out += after + '\n\n';
  return out;
}

function displayName(option: OptionDeclaration): string {
  return '--' + option.name + (option.shortName !== undefined ? ', -' + option.shortName : '');
}

function groupOutput(sys: System, colors: Colors, options: readonly OptionDeclaration[]): string {
  let maxLength = 0;
  for (const option of options) maxLength = Math.max(maxLength, displayName(option).length);
  // Names are right-aligned two spaces from the margin; descriptions start two spaces after them.
  const nameEnd = maxLength + 2;
  const descriptionStart = nameEnd + 2;
  let out = '';
  for (const option of options) out += optionOutput(sys, colors, option, nameEnd, descriptionStart);
  // Always end with a blank line.
  return out.endsWith('\n\n') ? out : out + '\n';
}

interface ValueCandidates {
  /** `type:`, `one of:` or `one or more:`. */
  readonly label: string;
  readonly values: string;
}

function optionOutput(
  sys: System,
  colors: Colors,
  option: OptionDeclaration,
  nameEnd: number,
  descriptionStart: number,
): string {
  const name = displayName(option);
  const candidates = valueCandidates(option);
  const defaultValue = defaultValueText(option);
  const showDetails = showAdditionalInfo(option, candidates);
  const width = sys.terminalWidth;
  const description = option.description?.text ?? '';
  let out = '';

  if (width >= 80) {
    out += prettyLines(colors, name, description, nameEnd, descriptionStart, width, true) + '\n';
    if (showDetails) {
      if (candidates !== undefined) {
        out += prettyLines(colors, candidates.label, candidates.values, nameEnd, descriptionStart, width, false) + '\n';
      }
      if (defaultValue !== '') {
        out += prettyLines(colors, m.default_Colon.text, defaultValue, nameEnd, descriptionStart, width, false) + '\n';
      }
    }
    return out + '\n';
  }

  out += colors.blue(name) + '\n' + description + '\n';
  if (showDetails) {
    if (candidates !== undefined) out += candidates.label + ' ' + candidates.values;
    if (defaultValue !== '') {
      if (candidates !== undefined) out += '\n';
      out += m.default_Colon.text + ' ' + defaultValue;
    }
    out += '\n';
  }
  return out + '\n';
}

/** `left` right-aligned in a column, then `right` wrapped at the terminal width. */
function prettyLines(
  colors: Colors,
  left: string,
  right: string,
  nameEnd: number,
  descriptionStart: number,
  width: number,
  colorLeft: boolean,
): string {
  const lineLength = width - descriptionStart;
  let out = '';
  let first = true;
  let rest = right;
  while (rest.length > 0) {
    let lineStart: string;
    if (first) {
      lineStart = padEnd(padStart(left, nameEnd), descriptionStart);
      if (colorLeft) lineStart = colors.blue(lineStart);
    } else {
      lineStart = ' '.repeat(descriptionStart);
    }
    const end = Math.min(lineLength, rest.length);
    out += lineStart + rest.slice(0, end) + '\n';
    rest = rest.slice(end);
    first = false;
  }
  return out;
}

function showAdditionalInfo(option: OptionDeclaration, candidates: ValueCandidates | undefined): boolean {
  if (option.category === m.Command_line_Options) return false;
  return !(candidates !== undefined && candidates.values === 'string' && option.defaultValueDescription === undefined);
}

function valueCandidates(option: OptionDeclaration): ValueCandidates | undefined {
  switch (option.kind) {
    case 'object':
      return undefined;
    case 'listOrElement':
      throw new Error('listOrElement options have no value candidates.');
    case 'string':
    case 'number':
    case 'boolean':
      return { label: m.type_Colon.text, values: possibleValues(option) };
    case 'list':
      return { label: m.one_or_more_Colon.text, values: possibleValues(option) };
    case 'enum':
      return { label: m.one_of_Colon.text, values: possibleValues(option) };
  }
}

function possibleValues(option: OptionDeclaration): string {
  switch (option.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return option.kind;
    case 'list':
    case 'listOrElement':
      return option.element !== undefined ? possibleValues(option.element) : '';
    case 'object':
      return '';
    case 'enum': {
      // Synonyms share a value: `es6/es2015`.
      const synonyms = new Map<string, string[]>();
      if (option.values !== undefined) {
        for (const [name, value] of option.values) {
          if (option.deprecatedValues?.has(name) === true) continue;
          const key = typeof value === 'number' ? String(value) : value;
          const names = synonyms.get(key);
          if (names === undefined) synonyms.set(key, [name]);
          else names.push(name);
        }
      }
      const groups: string[] = [];
      for (const names of synonyms.values()) groups.push(names.join('/'));
      return groups.join(', ');
    }
  }
}

function defaultValueText(option: OptionDeclaration): string {
  const value = option.defaultValueDescription;
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    const enumOption = option.kind === 'list' ? option.element : option;
    if (enumOption?.kind !== 'enum' || enumOption.values === undefined) return String(value);
    const names: string[] = [];
    for (const [name, enumValue] of enumOption.values) if (sameEnumValue(enumValue, value)) names.push(name);
    return names.join('/');
  }
  return value.text;
}
