/**
 * Diagnostic messages used by option parsing and the `tsc` command line, with tsgo's codes and texts.
 *
 * `{0}`-style placeholders are filled by `formatMessage`.
 */

export enum DiagnosticCategory {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

export interface Message {
  readonly code: number;
  readonly category: DiagnosticCategory;
  readonly text: string;
}

/** A diagnostic without a source location. */
export interface Diagnostic {
  readonly message: Message;
  readonly args: readonly string[];
}

export function createDiagnostic(message: Message, ...args: string[]): Diagnostic {
  return { message, args };
}

/** Replaces `{n}` placeholders with `args[n]`; text without args is returned unchanged. */
export function formatMessage(message: Message, args: readonly string[]): string {
  const text = message.text;
  if (args.length === 0) return text;
  let result = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 123 /* { */) continue;
    let j = i + 1;
    while (j < text.length && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
    if (j === i + 1 || j >= text.length || text.charCodeAt(j) !== 125 /* } */) continue;
    result += text.slice(start, i) + args[Number(text.slice(i + 1, j))];
    start = j + 1;
    i = j;
  }
  return result + text.slice(start);
}

export function categoryName(category: DiagnosticCategory): string {
  switch (category) {
    case DiagnosticCategory.Warning:
      return 'warning';
    case DiagnosticCategory.Error:
      return 'error';
    case DiagnosticCategory.Suggestion:
      return 'suggestion';
    case DiagnosticCategory.Message:
      return 'message';
  }
}

function error(code: number, text: string): Message {
  return { code, category: DiagnosticCategory.Error, text };
}

function message(code: number, text: string): Message {
  return { code, category: DiagnosticCategory.Message, text };
}

export const Print_the_final_configuration_instead_of_building = message(
  1350,
  'Print the final configuration instead of building.',
);
export const Control_what_method_is_used_to_detect_module_format_JS_files = message(
  1475,
  'Control what method is used to detect module-format JS files.',
);
export const auto_Colon_Treat_files_with_imports_exports_import_meta_jsx_with_jsx_Colon_react_jsx_or_esm_format_with_module_Colon_node16_as_modules =
  message(
    1476,
    '"auto": Treat files with imports, exports, import.meta, jsx (with jsx: react-jsx), or esm format (with module: node16+) as modules.',
  );
export const Ignore_the_tsconfig_found_and_build_with_commandline_options_and_files = message(
  1549,
  'Ignore the tsconfig found and build with commandline options and files.',
);
export const Option_0_requires_value_to_be_greater_than_1 = error(
  5002,
  "Option '{0}' requires value to be greater than '{1}'.",
);
export const File_specification_cannot_end_in_a_recursive_directory_wildcard_Asterisk_Asterisk_Colon_0 = error(
  5010,
  "File specification cannot end in a recursive directory wildcard ('**'): '{0}'.",
);
export const Unknown_compiler_option_0 = error(5023, "Unknown compiler option '{0}'.");
export const Option_project_cannot_be_mixed_with_source_files_on_a_command_line = error(
  5042,
  "Option 'project' cannot be mixed with source files on a command line.",
);
export const A_tsconfig_json_file_is_already_defined_at_Colon_0 = error(
  5054,
  "A 'tsconfig.json' file is already defined at: '{0}'.",
);
export const The_specified_path_does_not_exist_Colon_0 = error(5058, "The specified path does not exist: '{0}'.");
export const File_specification_cannot_contain_a_parent_directory_that_appears_after_a_recursive_directory_wildcard_Asterisk_Asterisk_Colon_0 =
  error(
    5065,
    "File specification cannot contain a parent directory ('..') that appears after a recursive directory wildcard ('**'): '{0}'.",
  );
export const Unknown_build_option_0 = error(5072, "Unknown build option '{0}'.");
export const Build_option_0_requires_a_value_of_type_1 = error(
  5073,
  "Build option '{0}' requires a value of type {1}.",
);
export const Unknown_watch_option_0 = error(5078, "Unknown watch option '{0}'.");
export const Watch_option_0_requires_a_value_of_type_1 = error(
  5080,
  "Watch option '{0}' requires a value of type {1}.",
);
export const Cannot_find_a_tsconfig_json_file_at_the_current_directory_Colon_0 = error(
  5081,
  'Cannot find a tsconfig.json file at the current directory: {0}.',
);
export const Cannot_read_file_0 = error(5083, "Cannot read file '{0}'.");
export const Compiler_option_0_may_only_be_used_with_build = error(
  5093,
  "Compiler option '--{0}' may only be used with '--build'.",
);
export const Compiler_option_0_may_not_be_used_with_build = error(
  5094,
  "Compiler option '--{0}' may not be used with '--build'.",
);
export const tsconfig_json_is_present_but_will_not_be_loaded_if_files_are_specified_on_commandline_Use_ignoreConfig_to_skip_this_error =
  error(
    5112,
    "tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.",
  );
export const Watch_input_files = message(6005, 'Watch input files.');
export const Print_this_message = message(6017, 'Print this message.');
export const Print_the_compiler_s_version = message(6019, "Print the compiler's version.");
export const Compile_the_project_given_the_path_to_its_configuration_file_or_to_a_folder_with_a_tsconfig_json = message(
  6020,
  "Compile the project given the path to its configuration file, or to a folder with a 'tsconfig.json'.",
);
export const Version_0 = message(6029, 'Version {0}');
export const Compiler_option_0_expects_an_argument = error(6044, "Compiler option '{0}' expects an argument.");
export const Unterminated_quoted_string_in_response_file_0 = error(
  6045,
  "Unterminated quoted string in response file '{0}'.",
);
export const Argument_for_0_option_must_be_Colon_1 = error(6046, "Argument for '{0}' option must be: {1}.");
export const Locale_must_be_an_IETF_BCP_47_language_tag_Examples_Colon_0_1 = error(
  6048,
  "Locale must be an IETF BCP 47 language tag. Examples: '{0}', '{1}'.",
);
export const Option_0_can_only_be_specified_in_tsconfig_json_file_or_set_to_null_on_command_line = error(
  6064,
  "Option '{0}' can only be specified in 'tsconfig.json' file or set to 'null' on command line.",
);
export const Initializes_a_TypeScript_project_and_creates_a_tsconfig_json_file = message(
  6070,
  'Initializes a TypeScript project and creates a tsconfig.json file.',
);
export const Show_all_compiler_options = message(6169, 'Show all compiler options.');
export const Command_line_Options = message(6171, 'Command-line Options');
export const Enable_all_strict_type_checking_options = message(6180, 'Enable all strict type-checking options.');
export const Option_0_can_only_be_specified_in_tsconfig_json_file_or_set_to_false_or_null_on_command_line = error(
  6230,
  "Option '{0}' can only be specified in 'tsconfig.json' file or set to 'false' or 'null' on command line.",
);
export const Generates_an_event_trace_and_a_list_of_types = message(
  6237,
  'Generates an event trace and a list of types.',
);
export const Interpret_optional_property_types_as_written_rather_than_adding_undefined = message(
  6243,
  "Interpret optional property types as written, rather than adding 'undefined'.",
);
export const Modules = message(6244, 'Modules');
export const Emit = message(6246, 'Emit');
export const JavaScript_Support = message(6247, 'JavaScript Support');
export const Type_Checking = message(6248, 'Type Checking');
export const Editor_Support = message(6249, 'Editor Support');
export const Watch_and_Build_Modes = message(6250, 'Watch and Build Modes');
export const Compiler_Diagnostics = message(6251, 'Compiler Diagnostics');
export const Interop_Constraints = message(6252, 'Interop Constraints');
export const Language_and_Environment = message(6254, 'Language and Environment');
export const Projects = message(6255, 'Projects');
export const Output_Formatting = message(6256, 'Output Formatting');
export const Completeness = message(6257, 'Completeness');
export const Enable_importing_files_with_any_extension_provided_a_declaration_file_is_present = message(
  6264,
  'Enable importing files with any extension, provided a declaration file is present.',
);
export const File_Layout = message(6284, 'File Layout');
export const Environment_Settings = message(6285, 'Environment Settings');
export const See_also_https_Colon_Slash_Slashaka_ms_Slashtsconfig_Slashmodule = message(
  6286,
  'See also https://aka.ms/tsconfig/module',
);
export const For_nodejs_Colon = message(6287, 'For nodejs:');
export const and_npm_install_D_types_Slashnode = message(6290, 'and npm install -D @types/node');
export const Other_Outputs = message(6291, 'Other Outputs');
export const Stricter_Typechecking_Options = message(6292, 'Stricter Typechecking Options');
export const Style_Options = message(6293, 'Style Options');
export const Recommended_Options = message(6294, 'Recommended Options');
export const Build_one_or_more_projects_and_their_dependencies_if_out_of_date = message(
  6364,
  'Build one or more projects and their dependencies, if out of date',
);
export const Delete_the_outputs_of_all_projects = message(6365, 'Delete the outputs of all projects.');
export const Show_what_would_be_built_or_deleted_if_specified_with_clean = message(
  6367,
  "Show what would be built (or deleted, if specified with '--clean')",
);
export const Option_build_must_be_the_first_command_line_argument = error(
  6369,
  "Option '--build' must be the first command line argument.",
);
export const Options_0_and_1_cannot_be_combined = error(6370, "Options '{0}' and '{1}' cannot be combined.");
export const Allow_imports_to_include_TypeScript_file_extensions_Requires_moduleResolution_bundler_and_either_noEmit_or_emitDeclarationOnly_to_be_set =
  message(
    6407,
    "Allow imports to include TypeScript file extensions. Requires '--moduleResolution bundler' and either '--noEmit' or '--emitDeclarationOnly' to be set.",
  );
export const Use_the_package_json_exports_field_when_resolving_package_imports = message(
  6408,
  "Use the package.json 'exports' field when resolving package imports.",
);
export const Use_the_package_json_imports_field_when_resolving_imports = message(
  6409,
  "Use the package.json 'imports' field when resolving imports.",
);
export const Conditions_to_set_in_addition_to_the_resolver_specific_defaults_when_resolving_imports = message(
  6410,
  'Conditions to set in addition to the resolver-specific defaults when resolving imports.',
);
export const true_when_moduleResolution_is_node16_nodenext_or_bundler_otherwise_false = message(
  6411,
  "`true` when 'moduleResolution' is 'node16', 'nodenext', or 'bundler'; otherwise `false`.",
);
export const Rewrite_ts_tsx_mts_and_cts_file_extensions_in_relative_import_paths_to_their_JavaScript_equivalent_in_output_files =
  message(
    6421,
    "Rewrite '.ts', '.tsx', '.mts', and '.cts' file extensions in relative import paths to their JavaScript equivalent in output files.",
  );
export const Print_names_of_files_that_are_part_of_the_compilation_and_then_stop_processing = message(
  6503,
  'Print names of files that are part of the compilation and then stop processing.',
);
export const Allow_JavaScript_files_to_be_a_part_of_your_program_Use_the_checkJs_option_to_get_errors_from_these_files =
  message(
    6600,
    "Allow JavaScript files to be a part of your program. Use the 'checkJs' option to get errors from these files.",
  );
export const Allow_import_x_from_y_when_a_module_doesn_t_have_a_default_export = message(
  6601,
  "Allow 'import x from y' when a module doesn't have a default export.",
);
export const Allow_accessing_UMD_globals_from_modules = message(6602, 'Allow accessing UMD globals from modules.');
export const Disable_error_reporting_for_unreachable_code = message(
  6603,
  'Disable error reporting for unreachable code.',
);
export const Disable_error_reporting_for_unused_labels = message(6604, 'Disable error reporting for unused labels.');
export const Ensure_use_strict_is_always_emitted = message(6605, "Ensure 'use strict' is always emitted.");
export const Have_recompiles_in_projects_that_use_incremental_and_watch_mode_assume_that_changes_within_a_file_will_only_affect_files_directly_depending_on_it =
  message(
    6606,
    "Have recompiles in projects that use 'incremental' and 'watch' mode assume that changes within a file will only affect files directly depending on it.",
  );
export const Specify_the_base_directory_to_resolve_non_relative_module_names = message(
  6607,
  'Specify the base directory to resolve non-relative module names.',
);
export const Enable_error_reporting_in_type_checked_JavaScript_files = message(
  6609,
  'Enable error reporting in type-checked JavaScript files.',
);
export const Enable_constraints_that_allow_a_TypeScript_project_to_be_used_with_project_references = message(
  6611,
  'Enable constraints that allow a TypeScript project to be used with project references.',
);
export const Generate_d_ts_files_from_TypeScript_and_JavaScript_files_in_your_project = message(
  6612,
  'Generate .d.ts files from TypeScript and JavaScript files in your project.',
);
export const Specify_the_output_directory_for_generated_declaration_files = message(
  6613,
  'Specify the output directory for generated declaration files.',
);
export const Create_sourcemaps_for_d_ts_files = message(6614, 'Create sourcemaps for d.ts files.');
export const Output_compiler_performance_information_after_building = message(
  6615,
  'Output compiler performance information after building.',
);
export const Reduce_the_number_of_projects_loaded_automatically_by_TypeScript = message(
  6617,
  'Reduce the number of projects loaded automatically by TypeScript.',
);
export const Remove_the_20mb_cap_on_total_source_code_size_for_JavaScript_files_in_the_TypeScript_language_server =
  message(
    6618,
    'Remove the 20mb cap on total source code size for JavaScript files in the TypeScript language server.',
  );
export const Opt_a_project_out_of_multi_project_reference_checking_when_editing = message(
  6619,
  'Opt a project out of multi-project reference checking when editing.',
);
export const Disable_preferring_source_files_instead_of_declaration_files_when_referencing_composite_projects = message(
  6620,
  'Disable preferring source files instead of declaration files when referencing composite projects.',
);
export const Emit_more_compliant_but_verbose_and_less_performant_JavaScript_for_iteration = message(
  6621,
  'Emit more compliant, but verbose and less performant JavaScript for iteration.',
);
export const Emit_a_UTF_8_Byte_Order_Mark_BOM_in_the_beginning_of_output_files = message(
  6622,
  'Emit a UTF-8 Byte Order Mark (BOM) in the beginning of output files.',
);
export const Only_output_d_ts_files_and_not_JavaScript_files = message(
  6623,
  'Only output d.ts files and not JavaScript files.',
);
export const Emit_design_type_metadata_for_decorated_declarations_in_source_files = message(
  6624,
  'Emit design-type metadata for decorated declarations in source files.',
);
export const Emit_additional_JavaScript_to_ease_support_for_importing_CommonJS_modules_This_enables_allowSyntheticDefaultImports_for_type_compatibility =
  message(
    6626,
    "Emit additional JavaScript to ease support for importing CommonJS modules. This enables 'allowSyntheticDefaultImports' for type compatibility.",
  );
export const Remove_a_list_of_directories_from_the_watch_process = message(
  6628,
  'Remove a list of directories from the watch process.',
);
export const Remove_a_list_of_files_from_the_watch_mode_s_processing = message(
  6629,
  "Remove a list of files from the watch mode's processing.",
);
export const Enable_experimental_support_for_legacy_experimental_decorators = message(
  6630,
  'Enable experimental support for legacy experimental decorators.',
);
export const Print_files_read_during_the_compilation_including_why_it_was_included = message(
  6631,
  'Print files read during the compilation including why it was included.',
);
export const Output_more_detailed_compiler_performance_information_after_building = message(
  6632,
  'Output more detailed compiler performance information after building.',
);
export const Specify_what_approach_the_watcher_should_use_if_the_system_runs_out_of_native_file_watchers = message(
  6634,
  'Specify what approach the watcher should use if the system runs out of native file watchers.',
);
export const Build_all_projects_including_those_that_appear_to_be_up_to_date = message(
  6636,
  'Build all projects, including those that appear to be up to date.',
);
export const Ensure_that_casing_is_correct_in_imports = message(6637, 'Ensure that casing is correct in imports.');
export const Emit_a_v8_CPU_profile_of_the_compiler_run_for_debugging = message(
  6638,
  'Emit a v8 CPU profile of the compiler run for debugging.',
);
export const Allow_importing_helper_functions_from_tslib_once_per_project_instead_of_including_them_per_file = message(
  6639,
  'Allow importing helper functions from tslib once per project, instead of including them per-file.',
);
export const Skip_building_downstream_projects_on_error_in_upstream_project = message(
  6640,
  'Skip building downstream projects on error in upstream project.',
);
export const Save_tsbuildinfo_files_to_allow_for_incremental_compilation_of_projects = message(
  6642,
  'Save .tsbuildinfo files to allow for incremental compilation of projects.',
);
export const Include_sourcemap_files_inside_the_emitted_JavaScript = message(
  6643,
  'Include sourcemap files inside the emitted JavaScript.',
);
export const Include_source_code_in_the_sourcemaps_inside_the_emitted_JavaScript = message(
  6644,
  'Include source code in the sourcemaps inside the emitted JavaScript.',
);
export const Ensure_that_each_file_can_be_safely_transpiled_without_relying_on_other_imports = message(
  6645,
  'Ensure that each file can be safely transpiled without relying on other imports.',
);
export const Specify_what_JSX_code_is_generated = message(6646, 'Specify what JSX code is generated.');
export const Specify_the_JSX_factory_function_used_when_targeting_React_JSX_emit_e_g_React_createElement_or_h = message(
  6647,
  "Specify the JSX factory function used when targeting React JSX emit, e.g. 'React.createElement' or 'h'.",
);
export const Specify_the_JSX_Fragment_reference_used_for_fragments_when_targeting_React_JSX_emit_e_g_React_Fragment_or_Fragment =
  message(
    6648,
    "Specify the JSX Fragment reference used for fragments when targeting React JSX emit e.g. 'React.Fragment' or 'Fragment'.",
  );
export const Specify_module_specifier_used_to_import_the_JSX_factory_functions_when_using_jsx_Colon_react_jsx_Asterisk =
  message(6649, "Specify module specifier used to import the JSX factory functions when using 'jsx: react-jsx*'.");
export const Specify_a_set_of_bundled_library_declaration_files_that_describe_the_target_runtime_environment = message(
  6651,
  'Specify a set of bundled library declaration files that describe the target runtime environment.',
);
export const Print_the_names_of_emitted_files_after_a_compilation = message(
  6652,
  'Print the names of emitted files after a compilation.',
);
export const Print_all_of_the_files_read_during_the_compilation = message(
  6653,
  'Print all of the files read during the compilation.',
);
export const Set_the_language_of_the_messaging_from_TypeScript_This_does_not_affect_emit = message(
  6654,
  'Set the language of the messaging from TypeScript. This does not affect emit.',
);
export const Specify_the_location_where_debugger_should_locate_map_files_instead_of_generated_locations = message(
  6655,
  'Specify the location where debugger should locate map files instead of generated locations.',
);
export const Specify_the_maximum_folder_depth_used_for_checking_JavaScript_files_from_node_modules_Only_applicable_with_allowJs =
  message(
    6656,
    "Specify the maximum folder depth used for checking JavaScript files from 'node_modules'. Only applicable with 'allowJs'.",
  );
export const Specify_what_module_code_is_generated = message(6657, 'Specify what module code is generated.');
export const Specify_how_TypeScript_looks_up_a_file_from_a_given_module_specifier = message(
  6658,
  'Specify how TypeScript looks up a file from a given module specifier.',
);
export const Set_the_newline_character_for_emitting_files = message(
  6659,
  'Set the newline character for emitting files.',
);
export const Disable_emitting_files_from_a_compilation = message(6660, 'Disable emitting files from a compilation.');
export const Disable_generating_custom_helper_functions_like_extends_in_compiled_output = message(
  6661,
  "Disable generating custom helper functions like '__extends' in compiled output.",
);
export const Disable_emitting_files_if_any_type_checking_errors_are_reported = message(
  6662,
  'Disable emitting files if any type checking errors are reported.',
);
export const Disable_truncating_types_in_error_messages = message(6663, 'Disable truncating types in error messages.');
export const Enable_error_reporting_for_fallthrough_cases_in_switch_statements = message(
  6664,
  'Enable error reporting for fallthrough cases in switch statements.',
);
export const Enable_error_reporting_for_expressions_and_declarations_with_an_implied_any_type = message(
  6665,
  "Enable error reporting for expressions and declarations with an implied 'any' type.",
);
export const Ensure_overriding_members_in_derived_classes_are_marked_with_an_override_modifier = message(
  6666,
  'Ensure overriding members in derived classes are marked with an override modifier.',
);
export const Enable_error_reporting_for_codepaths_that_do_not_explicitly_return_in_a_function = message(
  6667,
  'Enable error reporting for codepaths that do not explicitly return in a function.',
);
export const Enable_error_reporting_when_this_is_given_the_type_any = message(
  6668,
  "Enable error reporting when 'this' is given the type 'any'.",
);
export const Disable_including_any_library_files_including_the_default_lib_d_ts = message(
  6670,
  'Disable including any library files, including the default lib.d.ts.',
);
export const Enforces_using_indexed_accessors_for_keys_declared_using_an_indexed_type = message(
  6671,
  'Enforces using indexed accessors for keys declared using an indexed type.',
);
export const Disallow_import_s_require_s_or_reference_s_from_expanding_the_number_of_files_TypeScript_should_add_to_a_project =
  message(
    6672,
    "Disallow 'import's, 'require's or '<reference>'s from expanding the number of files TypeScript should add to a project.",
  );
export const Add_undefined_to_a_type_when_accessed_using_an_index = message(
  6674,
  "Add 'undefined' to a type when accessed using an index.",
);
export const Enable_error_reporting_when_local_variables_aren_t_read = message(
  6675,
  "Enable error reporting when local variables aren't read.",
);
export const Raise_an_error_when_a_function_parameter_isn_t_read = message(
  6676,
  "Raise an error when a function parameter isn't read.",
);
export const Specify_an_output_folder_for_all_emitted_files = message(
  6678,
  'Specify an output folder for all emitted files.',
);
export const Specify_a_file_that_bundles_all_outputs_into_one_JavaScript_file_If_declaration_is_true_also_designates_a_file_that_bundles_all_d_ts_output =
  message(
    6679,
    "Specify a file that bundles all outputs into one JavaScript file. If 'declaration' is true, also designates a file that bundles all .d.ts output.",
  );
export const Specify_a_set_of_entries_that_re_map_imports_to_additional_lookup_locations = message(
  6680,
  'Specify a set of entries that re-map imports to additional lookup locations.',
);
export const Specify_a_list_of_language_service_plugins_to_include = message(
  6681,
  'Specify a list of language service plugins to include.',
);
export const Disable_erasing_const_enum_declarations_in_generated_code = message(
  6682,
  "Disable erasing 'const enum' declarations in generated code.",
);
export const Disable_resolving_symlinks_to_their_realpath_This_correlates_to_the_same_flag_in_node = message(
  6683,
  'Disable resolving symlinks to their realpath. This correlates to the same flag in node.',
);
export const Disable_wiping_the_console_in_watch_mode = message(6684, 'Disable wiping the console in watch mode.');
export const Enable_color_and_formatting_in_TypeScript_s_output_to_make_compiler_errors_easier_to_read = message(
  6685,
  "Enable color and formatting in TypeScript's output to make compiler errors easier to read.",
);
export const Specify_the_object_invoked_for_createElement_This_only_applies_when_targeting_react_JSX_emit = message(
  6686,
  "Specify the object invoked for 'createElement'. This only applies when targeting 'react' JSX emit.",
);
export const Disable_emitting_comments = message(6688, 'Disable emitting comments.');
export const Enable_importing_json_files = message(6689, 'Enable importing .json files.');
export const Specify_the_root_folder_within_your_source_files = message(
  6690,
  'Specify the root folder within your source files.',
);
export const Allow_multiple_folders_to_be_treated_as_one_when_resolving_modules = message(
  6691,
  'Allow multiple folders to be treated as one when resolving modules.',
);
export const Skip_type_checking_d_ts_files_that_are_included_with_TypeScript = message(
  6692,
  'Skip type checking .d.ts files that are included with TypeScript.',
);
export const Skip_type_checking_all_d_ts_files = message(6693, 'Skip type checking all .d.ts files.');
export const Create_source_map_files_for_emitted_JavaScript_files = message(
  6694,
  'Create source map files for emitted JavaScript files.',
);
export const Specify_the_root_path_for_debuggers_to_find_the_reference_source_code = message(
  6695,
  'Specify the root path for debuggers to find the reference source code.',
);
export const Check_that_the_arguments_for_bind_call_and_apply_methods_match_the_original_function = message(
  6697,
  "Check that the arguments for 'bind', 'call', and 'apply' methods match the original function.",
);
export const When_assigning_functions_check_to_ensure_parameters_and_the_return_values_are_subtype_compatible = message(
  6698,
  'When assigning functions, check to ensure parameters and the return values are subtype-compatible.',
);
export const When_type_checking_take_into_account_null_and_undefined = message(
  6699,
  "When type checking, take into account 'null' and 'undefined'.",
);
export const Check_for_class_properties_that_are_declared_but_not_set_in_the_constructor = message(
  6700,
  'Check for class properties that are declared but not set in the constructor.',
);
export const Disable_emitting_declarations_that_have_internal_in_their_JSDoc_comments = message(
  6701,
  "Disable emitting declarations that have '@internal' in their JSDoc comments.",
);
export const Synchronously_call_callbacks_and_update_the_state_of_directory_watchers_on_platforms_that_don_t_support_recursive_watching_natively =
  message(
    6704,
    'Synchronously call callbacks and update the state of directory watchers on platforms that don`t support recursive watching natively.',
  );
export const Set_the_JavaScript_language_version_for_emitted_JavaScript_and_include_compatible_library_declarations =
  message(
    6705,
    'Set the JavaScript language version for emitted JavaScript and include compatible library declarations.',
  );
export const Log_paths_used_during_the_moduleResolution_process = message(
  6706,
  "Log paths used during the 'moduleResolution' process.",
);
export const Specify_the_path_to_tsbuildinfo_incremental_compilation_file = message(
  6707,
  'Specify the path to .tsbuildinfo incremental compilation file.',
);
export const Specify_multiple_folders_that_act_like_Slashnode_modules_Slash_types = message(
  6710,
  "Specify multiple folders that act like './node_modules/@types'.",
);
export const Specify_type_package_names_to_be_included_without_being_referenced_in_a_source_file = message(
  6711,
  'Specify type package names to be included without being referenced in a source file.',
);
export const Emit_ECMAScript_standard_compliant_class_fields = message(
  6712,
  'Emit ECMAScript-standard-compliant class fields.',
);
export const Enable_verbose_logging = message(6713, 'Enable verbose logging.');
export const Specify_how_directories_are_watched_on_systems_that_lack_recursive_file_watching_functionality = message(
  6714,
  'Specify how directories are watched on systems that lack recursive file-watching functionality.',
);
export const Specify_how_the_TypeScript_watch_mode_works = message(
  6715,
  'Specify how the TypeScript watch mode works.',
);
export const Require_sufficient_annotation_on_exports_so_other_tools_can_trivially_generate_declaration_files = message(
  6719,
  'Require sufficient annotation on exports so other tools can trivially generate declaration files.',
);
export const Built_in_iterators_are_instantiated_with_a_TReturn_type_of_undefined_instead_of_any = message(
  6720,
  "Built-in iterators are instantiated with a 'TReturn' type of 'undefined' instead of 'any'.",
);
export const Do_not_allow_runtime_constructs_that_are_not_part_of_ECMAScript = message(
  6721,
  'Do not allow runtime constructs that are not part of ECMAScript.',
);
export const Default_catch_clause_variables_as_unknown_instead_of_any = message(
  6803,
  "Default catch clause variables as 'unknown' instead of 'any'.",
);
export const Do_not_transform_or_elide_any_imports_or_exports_not_marked_as_type_only_ensuring_they_are_written_in_the_output_file_s_format_based_on_the_module_setting =
  message(
    6804,
    "Do not transform or elide any imports or exports not marked as type-only, ensuring they are written in the output file's format based on the 'module' setting.",
  );
export const Disable_full_type_checking_only_critical_parse_and_emit_errors_will_be_reported = message(
  6805,
  'Disable full type checking (only critical parse and emit errors will be reported).',
);
export const Check_side_effect_imports = message(6806, 'Check side effect imports.');
export const Enable_lib_replacement = message(6808, 'Enable lib replacement.');
export const Ensure_types_are_ordered_stably_and_deterministically_across_compilations = message(
  6809,
  'Ensure types are ordered stably and deterministically across compilations.',
);
export const one_of_Colon = message(6900, 'one of:');
export const one_or_more_Colon = message(6901, 'one or more:');
export const type_Colon = message(6902, 'type:');
export const default_Colon = message(6903, 'default:');
export const true_unless_strict_is_false = message(6905, '`true`, unless `strict` is `false`');
export const false_unless_composite_is_set = message(6906, '`false`, unless `composite` is set');
export const Computed_from_the_list_of_input_files = message(6911, 'Computed from the list of input files');
export const Platform_specific = message(6912, 'Platform specific');
export const You_can_learn_about_all_of_the_compiler_options_at_0 = message(
  6913,
  'You can learn about all of the compiler options at {0}',
);
export const Including_watch_w_will_start_watching_the_current_project_for_the_file_changes_Once_set_you_can_config_watch_mode_with_Colon =
  message(
    6914,
    'Including --watch, -w will start watching the current project for the file changes. Once set, you can config watch mode with:',
  );
export const Using_build_b_will_make_tsc_behave_more_like_a_build_orchestrator_than_a_compiler_This_is_used_to_trigger_building_composite_projects_which_you_can_learn_more_about_at_0 =
  message(
    6915,
    'Using --build, -b will make tsc behave more like a build orchestrator than a compiler. This is used to trigger building composite projects which you can learn more about at {0}',
  );
export const COMMON_COMMANDS = message(6916, 'COMMON COMMANDS');
export const ALL_COMPILER_OPTIONS = message(6917, 'ALL COMPILER OPTIONS');
export const WATCH_OPTIONS = message(6918, 'WATCH OPTIONS');
export const BUILD_OPTIONS = message(6919, 'BUILD OPTIONS');
export const COMMON_COMPILER_OPTIONS = message(6920, 'COMMON COMPILER OPTIONS');
export const COMMAND_LINE_FLAGS = message(6921, 'COMMAND LINE FLAGS');
export const tsc_Colon_The_TypeScript_Compiler = message(6922, 'tsc: The TypeScript Compiler');
export const Compiles_the_current_project_tsconfig_json_in_the_working_directory = message(
  6923,
  'Compiles the current project (tsconfig.json in the working directory.)',
);
export const Ignoring_tsconfig_json_compiles_the_specified_files_with_default_compiler_options = message(
  6924,
  'Ignoring tsconfig.json, compiles the specified files with default compiler options.',
);
export const Build_a_composite_project_in_the_working_directory = message(
  6925,
  'Build a composite project in the working directory.',
);
export const Creates_a_tsconfig_json_with_the_recommended_settings_in_the_working_directory = message(
  6926,
  'Creates a tsconfig.json with the recommended settings in the working directory.',
);
export const Compiles_the_TypeScript_project_located_at_the_specified_path = message(
  6927,
  'Compiles the TypeScript project located at the specified path.',
);
export const An_expanded_version_of_this_information_showing_all_possible_compiler_options = message(
  6928,
  'An expanded version of this information, showing all possible compiler options',
);
export const Compiles_the_current_project_with_additional_settings = message(
  6929,
  'Compiles the current project, with additional settings.',
);
export const true_for_ES2022_and_above_including_ESNext = message(
  6930,
  '`true` for ES2022 and above, including ESNext.',
);
export const List_of_file_name_suffixes_to_search_when_resolving_a_module = error(
  6931,
  'List of file name suffixes to search when resolving a module.',
);
export const false_unless_checkJs_is_set = message(6932, '`false`, unless `checkJs` is set');
export const Unknown_type_acquisition_option_0 = error(17010, "Unknown type acquisition option '{0}'.");
export const nodenext_if_module_is_nodenext_node16_if_module_is_node16_or_node18_otherwise_bundler = message(
  69010,
  '`nodenext` if `module` is `nodenext`; `node16` if `module` is `node16` or `node18`; otherwise, `bundler`.',
);
export const Visit_https_Colon_Slash_Slashaka_ms_Slashtsconfig_to_read_more_about_this_file = message(
  95110,
  'Visit https://aka.ms/tsconfig to read more about this file',
);
export const Do_not_print_diagnostics = message(100000, 'Do not print diagnostics.');
export const Run_in_single_threaded_mode = message(100001, 'Run in single threaded mode.');
export const Generate_pprof_CPU_Slashmemory_profiles_to_the_given_directory = message(
  100002,
  'Generate pprof CPU/memory profiles to the given directory.',
);
export const Set_the_number_of_checkers_per_project = message(100003, 'Set the number of checkers per project.');
export const _4_unless_singleThreaded_is_passed = message(100004, '4, unless --singleThreaded is passed.');
export const Set_the_number_of_projects_to_build_concurrently = message(
  100009,
  'Set the number of projects to build concurrently.',
);
export const Deduplicate_packages_with_the_same_name_and_version = message(
  100011,
  'Deduplicate packages with the same name and version.',
);
