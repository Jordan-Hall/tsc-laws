/**
 * Binding and checking a program: the checker host over a `Program`, and the bind, semantic,
 * suggestion and global diagnostics of its files, like tsgo's `Program` with a single checker.
 *
 * ```ts
 * const checked = new CheckedProgram(program);
 * const errors = checked.getSemanticDiagnostics(undefined);
 * ```
 */
import { type Node, ScriptKind, type SourceFile } from './ast.js';
import { Checker, CheckerHost } from './checker.js';
import { createDiagnostic, Diagnostic, type DiagnosticMessage, Diagnostics, messageCode } from './diagnostics.js';
import type { CompilerOptions, ModuleKind } from './options.js';
import { Program, sortAndDeduplicateDiagnostics } from './program.js';
import {
  getEmitSyntaxForUsageLocation,
  isCheckJsEnabledForFile,
  type SourceFileMetadata,
} from './program-utilities.js';
import { bindSourceFile } from './binder.js';
import { computeLineOfPosition } from './scanner.js';
import { CommentDirectiveKind } from './types.js';

/** What the checker needs, answered by a program. */
export class ProgramCheckerHost extends CheckerHost {
  constructor(readonly program: Program) {
    super();
  }

  getCompilerOptions(): CompilerOptions {
    return this.program.options;
  }

  getSourceFiles(): readonly SourceFile[] {
    return this.program.getSourceFiles();
  }

  isSourceFileDefaultLibrary(file: SourceFile): boolean {
    return this.program.isSourceFileDefaultLibrary(file.path);
  }

  getSourceFileForModuleName(file: SourceFile, moduleName: string): SourceFile | undefined {
    return this.program.getSourceFileForModuleName(file, moduleName);
  }

  getJSXRuntimeImportSpecifier(file: SourceFile): Node | undefined {
    return this.program.jsxRuntimeImportSpecifier(file.path);
  }

  getImpliedNodeFormatForEmit(file: SourceFile): ModuleKind {
    return this.program.getImpliedNodeFormatForEmit(file);
  }

  getEmitSyntaxForUsageLocation(file: SourceFile, usage: Node): ModuleKind {
    const program = this.program;
    return getEmitSyntaxForUsageLocation(
      file.fileName,
      program.sourceFileMetadata(file.path),
      usage,
      program.getCompilerOptionsForFile(file),
    );
  }

  getSourceFileMetadata(file: SourceFile): SourceFileMetadata | undefined {
    return this.program.sourceFileMetadata(file.path);
  }
}

/** Binds every file of `program`. */
export function bindProgram(program: Program): void {
  for (const file of program.getSourceFiles()) bindSourceFile(file);
}

/** A bound program with the checker that reports its diagnostics. */
export class CheckedProgram {
  readonly checker: Checker;

  constructor(readonly program: Program) {
    bindProgram(program);
    this.checker = new Checker(new ProgramCheckerHost(program));
  }

  /** A new checker for the program, independent of the one reporting diagnostics. */
  createChecker(): Checker {
    return new Checker(new ProgramCheckerHost(this.program));
  }

  getBindDiagnostics(file: SourceFile | undefined): Diagnostic[] {
    return this.collect(file, (f) => f.bindDiagnostics);
  }

  getSemanticDiagnostics(file: SourceFile | undefined): Diagnostic[] {
    return this.collectChecked(file, (f) => {
      const diagnostics = this.getBindAndCheckDiagnostics(f);
      const result = this.program.options.noEmit === true ? diagnostics.filter((d) => !d.skippedOnNoEmit) : diagnostics;
      for (const d of this.getIncludeProcessorDiagnostics(f)) result.push(d);
      return result;
    });
  }

  /** The bind and check diagnostics of `file` before `noEmit` filtering and without include errors. */
  getSemanticDiagnosticsWithoutNoEmitFiltering(file: SourceFile): Diagnostic[] {
    return this.skipTypeChecking(file) ? [] : sortAndDeduplicateDiagnostics(this.getBindAndCheckDiagnostics(file));
  }

  getSuggestionDiagnostics(file: SourceFile | undefined): Diagnostic[] {
    return this.collectChecked(file, (f) => this.checker.getSuggestionDiagnostics(f));
  }

  /** Diagnostics without a file, once every file is checked. */
  getGlobalDiagnostics(): Diagnostic[] {
    if (this.program.getSourceFiles().length === 0) return [];
    return this.checker.getGlobalDiagnostics();
  }

  /** Whether `file`'s bind and check diagnostics are reported. */
  skipTypeChecking(file: SourceFile): boolean {
    const options = this.program.options;
    return (
      options.noCheck === true ||
      (options.skipLibCheck === true && file.isDeclarationFile) ||
      (options.skipDefaultLibCheck === true && this.program.isSourceFileDefaultLibrary(file.path)) ||
      this.program.getProjectReferenceFromSource(file.path) !== undefined ||
      !canIncludeBindAndCheckDiagnostics(file, options)
    );
  }

  private collect(file: SourceFile | undefined, get: (file: SourceFile) => readonly Diagnostic[]): Diagnostic[] {
    if (file !== undefined) return sortAndDeduplicateDiagnostics(get(file));
    const result: Diagnostic[] = [];
    for (const f of this.program.getSourceFiles()) for (const d of get(f)) result.push(d);
    return sortAndDeduplicateDiagnostics(result);
  }

  private collectChecked(file: SourceFile | undefined, get: (file: SourceFile) => readonly Diagnostic[]): Diagnostic[] {
    if (file !== undefined) return this.skipTypeChecking(file) ? [] : sortAndDeduplicateDiagnostics(get(file));
    const result: Diagnostic[] = [];
    for (const f of this.program.getSourceFiles()) {
      if (this.skipTypeChecking(f)) continue;
      for (const d of get(f)) result.push(d);
    }
    return sortAndDeduplicateDiagnostics(result);
  }

  private getBindAndCheckDiagnostics(file: SourceFile): Diagnostic[] {
    const options = this.program.options;
    const diagnostics = file.bindDiagnostics.slice();
    for (const d of this.checker.getDiagnostics(file)) diagnostics.push(d);
    if (isPlainJSFile(file, options)) return diagnostics.filter((d) => plainJSErrors.has(d.code));
    if (isJSFile(file) && isCheckJsEnabledForFile(file, options)) {
      for (const d of file.jsDocDiagnostics) diagnostics.push(d);
    }
    const directives = new Directives(file);
    const filtered = directives.filter(diagnostics);
    for (const directive of directives.unused()) {
      filtered.push(
        createDiagnostic(
          file.diagnosticFile(),
          directive.pos,
          directive.end,
          Diagnostics.Unused_ts_expect_error_directive,
        ),
      );
    }
    return filtered;
  }

  getIncludeProcessorDiagnostics(file: SourceFile): Diagnostic[] {
    if (this.skipTypeChecking(file)) return [];
    return new Directives(file).filter(this.program.getIncludeProcessorDiagnostics(file));
  }
}

/** The `@ts-ignore` and `@ts-expect-error` comments of a file, by line. */
class Directives {
  private readonly byLine = new Map<number, { pos: number; end: number; kind: CommentDirectiveKind }>();

  constructor(readonly file: SourceFile) {
    const lineStarts = file.diagnosticFile().getLineStarts();
    for (const directive of file.commentDirectives) {
      const line = computeLineOfPosition(lineStarts, directive.pos);
      this.byLine.set(line, { pos: directive.pos, end: directive.end, kind: directive.kind });
    }
  }

  /** The diagnostics no directive suppresses; a suppressing `@ts-expect-error` counts as used. */
  filter(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    if (this.byLine.size === 0) return diagnostics.slice();
    const text = this.file.text;
    const lineStarts = this.file.diagnosticFile().getLineStarts();
    const result: Diagnostic[] = [];
    for (const diagnostic of diagnostics) {
      let ignored = false;
      for (let line = computeLineOfPosition(lineStarts, diagnostic.pos) - 1; line >= 0; line--) {
        const directive = this.byLine.get(line);
        if (directive !== undefined) {
          ignored = true;
          directive.kind = CommentDirectiveKind.Ignore;
          break;
        }
        if (!isCommentOrBlankLine(text, lineStarts[line])) break;
      }
      if (!ignored) result.push(diagnostic);
    }
    return result;
  }

  /** `@ts-expect-error` comments that suppressed nothing. */
  unused(): { pos: number; end: number }[] {
    const result: { pos: number; end: number }[] = [];
    for (const directive of this.byLine.values()) {
      if (directive.kind === CommentDirectiveKind.ExpectError) result.push(directive);
    }
    return result;
  }
}

function isCommentOrBlankLine(text: string, lineStart: number): boolean {
  let pos = lineStart;
  while (pos < text.length && (text.charCodeAt(pos) === 0x20 || text.charCodeAt(pos) === 0x09)) pos += 1;
  if (pos === text.length) return true;
  const ch = text.charCodeAt(pos);
  if (ch === 0x0d || ch === 0x0a) return true;
  return pos + 1 < text.length && ch === 0x2f && text.charCodeAt(pos + 1) === 0x2f;
}

function isJSFile(file: SourceFile): boolean {
  return file.scriptKind === ScriptKind.JS || file.scriptKind === ScriptKind.JSX;
}

/** A JavaScript file without `@ts-check` or `@ts-nocheck` when `checkJs` is unset. */
function isPlainJSFile(file: SourceFile, options: CompilerOptions): boolean {
  return isJSFile(file) && file.checkJsDirective === undefined && options.checkJs === undefined;
}

function canIncludeBindAndCheckDiagnostics(file: SourceFile, options: CompilerOptions): boolean {
  if (file.checkJsDirective !== undefined && !file.checkJsDirective.enabled) return false;
  const kind = file.scriptKind;
  if (kind === ScriptKind.TS || kind === ScriptKind.TSX || kind === ScriptKind.External) return true;
  const isCheckJS = isJSFile(file) && isCheckJsEnabledForFile(file, options);
  return isPlainJSFile(file, options) || isCheckJS || kind === ScriptKind.Deferred;
}

/** The errors reported in JavaScript files that aren't type checked. */
const plainJSErrors = codesOf([
  Diagnostics.Cannot_redeclare_block_scoped_variable_0,
  Diagnostics.A_module_cannot_have_multiple_default_exports,
  Diagnostics.Another_export_default_is_here,
  Diagnostics.The_first_export_default_is_here,
  Diagnostics.Identifier_expected_0_is_a_reserved_word_at_the_top_level_of_a_module,
  Diagnostics.Identifier_expected_0_is_a_reserved_word_in_strict_mode_Modules_are_automatically_in_strict_mode,
  Diagnostics.Identifier_expected_0_is_a_reserved_word_that_cannot_be_used_here,
  Diagnostics.X_constructor_is_a_reserved_word,
  Diagnostics.X_delete_cannot_be_called_on_an_identifier_in_strict_mode,
  Diagnostics.Code_contained_in_a_class_is_evaluated_in_JavaScript_s_strict_mode_which_does_not_allow_this_use_of_0_For_more_information_see_https_Colon_Slash_Slashdeveloper_mozilla_org_Slashen_US_Slashdocs_SlashWeb_SlashJavaScript_SlashReference_SlashStrict_mode,
  Diagnostics.Invalid_use_of_0_Modules_are_automatically_in_strict_mode,
  Diagnostics.Invalid_use_of_0_in_strict_mode,
  Diagnostics.A_label_is_not_allowed_here,
  Diagnostics.X_with_statements_are_not_allowed_in_strict_mode,
  Diagnostics.A_break_statement_can_only_be_used_within_an_enclosing_iteration_or_switch_statement,
  Diagnostics.A_break_statement_can_only_jump_to_a_label_of_an_enclosing_statement,
  Diagnostics.A_class_declaration_without_the_default_modifier_must_have_a_name,
  Diagnostics.A_class_member_cannot_have_the_0_keyword,
  Diagnostics.A_comma_expression_is_not_allowed_in_a_computed_property_name,
  Diagnostics.A_continue_statement_can_only_be_used_within_an_enclosing_iteration_statement,
  Diagnostics.A_continue_statement_can_only_jump_to_a_label_of_an_enclosing_iteration_statement,
  Diagnostics.A_default_clause_cannot_appear_more_than_once_in_a_switch_statement,
  Diagnostics.A_default_export_must_be_at_the_top_level_of_a_file_or_module_declaration,
  Diagnostics.A_definite_assignment_assertion_is_not_permitted_in_this_context,
  Diagnostics.A_destructuring_declaration_must_have_an_initializer,
  Diagnostics.A_get_accessor_cannot_have_parameters,
  Diagnostics.A_rest_element_cannot_contain_a_binding_pattern,
  Diagnostics.A_rest_element_cannot_have_a_property_name,
  Diagnostics.A_rest_element_cannot_have_an_initializer,
  Diagnostics.A_rest_element_must_be_last_in_a_destructuring_pattern,
  Diagnostics.A_rest_parameter_cannot_have_an_initializer,
  Diagnostics.A_rest_parameter_must_be_last_in_a_parameter_list,
  Diagnostics.A_rest_parameter_or_binding_pattern_may_not_have_a_trailing_comma,
  Diagnostics.A_return_statement_cannot_be_used_inside_a_class_static_block,
  Diagnostics.A_set_accessor_cannot_have_rest_parameter,
  Diagnostics.A_set_accessor_must_have_exactly_one_parameter,
  Diagnostics.An_export_declaration_can_only_be_used_at_the_top_level_of_a_module,
  Diagnostics.An_export_declaration_cannot_have_modifiers,
  Diagnostics.An_import_declaration_can_only_be_used_at_the_top_level_of_a_module,
  Diagnostics.An_import_declaration_cannot_have_modifiers,
  Diagnostics.An_object_member_cannot_be_declared_optional,
  Diagnostics.Argument_of_dynamic_import_cannot_be_spread_element,
  Diagnostics.Cannot_assign_to_private_method_0_Private_methods_are_not_writable,
  Diagnostics.Cannot_redeclare_identifier_0_in_catch_clause,
  Diagnostics.Catch_clause_variable_cannot_have_an_initializer,
  Diagnostics.Class_decorators_can_t_be_used_with_static_private_identifier_Consider_removing_the_experimental_decorator,
  Diagnostics.Classes_can_only_extend_a_single_class,
  Diagnostics.Classes_may_not_have_a_field_named_constructor,
  Diagnostics.Did_you_mean_to_use_a_Colon_An_can_only_follow_a_property_name_when_the_containing_object_literal_is_part_of_a_destructuring_pattern,
  Diagnostics.Duplicate_label_0,
  Diagnostics.Dynamic_imports_can_only_accept_a_module_specifier_and_an_optional_set_of_attributes_as_arguments,
  Diagnostics.X_for_await_loops_cannot_be_used_inside_a_class_static_block,
  Diagnostics.JSX_attributes_must_only_be_assigned_a_non_empty_expression,
  Diagnostics.JSX_elements_cannot_have_multiple_attributes_with_the_same_name,
  Diagnostics.JSX_expressions_may_not_use_the_comma_operator_Did_you_mean_to_write_an_array,
  Diagnostics.JSX_property_access_expressions_cannot_include_JSX_namespace_names,
  Diagnostics.Jump_target_cannot_cross_function_boundary,
  Diagnostics.Line_terminator_not_permitted_before_arrow,
  Diagnostics.Modifiers_cannot_appear_here,
  Diagnostics.Only_a_single_variable_declaration_is_allowed_in_a_for_in_statement,
  Diagnostics.Only_a_single_variable_declaration_is_allowed_in_a_for_of_statement,
  Diagnostics.Private_identifiers_are_not_allowed_outside_class_bodies,
  Diagnostics.Private_identifiers_are_only_allowed_in_class_bodies_and_may_only_be_used_as_part_of_a_class_member_declaration_property_access_or_on_the_left_hand_side_of_an_in_expression,
  Diagnostics.Property_0_is_not_accessible_outside_class_1_because_it_has_a_private_identifier,
  Diagnostics.Tagged_template_expressions_are_not_permitted_in_an_optional_chain,
  Diagnostics.The_left_hand_side_of_a_for_of_statement_may_not_be_async,
  Diagnostics.The_variable_declaration_of_a_for_in_statement_cannot_have_an_initializer,
  Diagnostics.The_variable_declaration_of_a_for_of_statement_cannot_have_an_initializer,
  Diagnostics.Trailing_comma_not_allowed,
  Diagnostics.Variable_declaration_list_cannot_be_empty,
  Diagnostics.X_0_and_1_operations_cannot_be_mixed_without_parentheses,
  Diagnostics.X_0_expected,
  Diagnostics.X_0_is_not_a_valid_meta_property_for_keyword_1_Did_you_mean_2,
  Diagnostics.X_0_list_cannot_be_empty,
  Diagnostics.X_0_modifier_already_seen,
  Diagnostics.X_0_modifier_cannot_appear_on_a_constructor_declaration,
  Diagnostics.X_0_modifier_cannot_appear_on_a_module_or_namespace_element,
  Diagnostics.X_0_modifier_cannot_appear_on_a_parameter,
  Diagnostics.X_0_modifier_cannot_appear_on_class_elements_of_this_kind,
  Diagnostics.X_0_modifier_cannot_be_used_here,
  Diagnostics.X_0_modifier_must_precede_1_modifier,
  Diagnostics.X_0_declarations_can_only_be_declared_inside_a_block,
  Diagnostics.X_0_declarations_must_be_initialized,
  Diagnostics.X_extends_clause_already_seen,
  Diagnostics.X_let_is_not_allowed_to_be_used_as_a_name_in_let_or_const_declarations,
  Diagnostics.Class_constructor_may_not_be_a_generator,
  Diagnostics.Class_constructor_may_not_be_an_accessor,
  Diagnostics.X_await_expressions_are_only_allowed_within_async_functions_and_at_the_top_levels_of_modules,
  Diagnostics.X_await_using_statements_are_only_allowed_within_async_functions_and_at_the_top_levels_of_modules,
  Diagnostics.Private_field_0_must_be_declared_in_an_enclosing_class,
  Diagnostics.This_condition_will_always_return_0_since_JavaScript_compares_objects_by_reference_not_value,
]);

function codesOf(messages: readonly DiagnosticMessage[]): Set<number> {
  const codes = new Set<number>();
  for (const message of messages) codes.add(messageCode(message));
  return codes;
}
