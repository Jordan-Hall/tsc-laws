/**
 * Trace and diagnostic messages used by module resolution, with TypeScript's codes and text.
 */

export enum DiagnosticCategory {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

export interface DiagnosticMessage {
  readonly code: number;
  readonly category: DiagnosticCategory;
  readonly key: string;
  readonly text: string;
}

/** A message with its arguments, already converted to strings. */
export interface MessageWithArgs {
  readonly message: DiagnosticMessage;
  readonly args: readonly string[];
}

export function messageWithArgs(message: DiagnosticMessage, ...args: string[]): MessageWithArgs {
  return { message, args };
}

/** Replaces `{n}` placeholders in `text` with `args[n]`. */
export function formatMessage(text: string, args: readonly string[]): string {
  if (args.length === 0) return text;
  let result = '';
  let start = 0;
  for (let open = text.indexOf('{'); open >= 0; open = text.indexOf('{', open + 1)) {
    let end = open + 1;
    let index = 0;
    while (end < text.length) {
      const c = text.charCodeAt(end);
      if (c < 0x30 || c > 0x39) break;
      index = index * 10 + (c - 0x30);
      end++;
    }
    if (end === open + 1 || end >= text.length || text.charCodeAt(end) !== 0x7d) continue;
    if (index >= args.length) throw new Error('Invalid formatting placeholder');
    result += text.slice(start, open) + args[index];
    start = end + 1;
    open = end;
  }
  return result + text.slice(start);
}

export function formatMessageWithArgs(m: MessageWithArgs): string {
  return formatMessage(m.message.text, m.args);
}

export const Auto_discovery_for_typings_is_enabled_in_project_0_Running_extra_resolution_pass_for_module_1_using_cache_location_2: DiagnosticMessage =
  {
    code: 6140,
    category: DiagnosticCategory.Error,
    key: 'Auto_discovery_for_typings_is_enabled_in_project_0_Running_extra_resolution_pass_for_module_1_using__6140',
    text: "Auto discovery for typings is enabled in project '{0}'. Running extra resolution pass for module '{1}' using cache location '{2}'.",
  };

export const Checking_if_0_is_the_longest_matching_prefix_for_1_2: DiagnosticMessage = {
  code: 6104,
  category: DiagnosticCategory.Message,
  key: 'Checking_if_0_is_the_longest_matching_prefix_for_1_2_6104',
  text: "Checking if '{0}' is the longest matching prefix for '{1}' - '{2}'.",
};

export const Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type: DiagnosticMessage = {
  code: 7016,
  category: DiagnosticCategory.Error,
  key: 'Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type_7016',
  text: "Could not find a declaration file for module '{0}'. '{1}' implicitly has an 'any' type.",
};

export const Directory_0_does_not_exist_skipping_all_lookups_in_it: DiagnosticMessage = {
  code: 6148,
  category: DiagnosticCategory.Message,
  key: 'Directory_0_does_not_exist_skipping_all_lookups_in_it_6148',
  text: "Directory '{0}' does not exist, skipping all lookups in it.",
};

export const Directory_0_has_no_containing_package_json_scope_Imports_will_not_resolve: DiagnosticMessage = {
  code: 6270,
  category: DiagnosticCategory.Message,
  key: 'Directory_0_has_no_containing_package_json_scope_Imports_will_not_resolve_6270',
  text: "Directory '{0}' has no containing package.json scope. Imports will not resolve.",
};

export const Entering_conditional_exports: DiagnosticMessage = {
  code: 6413,
  category: DiagnosticCategory.Message,
  key: 'Entering_conditional_exports_6413',
  text: 'Entering conditional exports.',
};

export const Exiting_conditional_exports: DiagnosticMessage = {
  code: 6416,
  category: DiagnosticCategory.Message,
  key: 'Exiting_conditional_exports_6416',
  text: 'Exiting conditional exports.',
};

export const Expected_type_of_0_field_in_package_json_to_be_1_got_2: DiagnosticMessage = {
  code: 6105,
  category: DiagnosticCategory.Message,
  key: 'Expected_type_of_0_field_in_package_json_to_be_1_got_2_6105',
  text: "Expected type of '{0}' field in 'package.json' to be '{1}', got '{2}'.",
};

export const Explicitly_specified_module_resolution_kind_Colon_0: DiagnosticMessage = {
  code: 6087,
  category: DiagnosticCategory.Message,
  key: 'Explicitly_specified_module_resolution_kind_Colon_0_6087',
  text: "Explicitly specified module resolution kind: '{0}'.",
};

export const Export_specifier_0_does_not_exist_in_package_json_scope_at_path_1: DiagnosticMessage = {
  code: 6276,
  category: DiagnosticCategory.Message,
  key: 'Export_specifier_0_does_not_exist_in_package_json_scope_at_path_1_6276',
  text: "Export specifier '{0}' does not exist in package.json scope at path '{1}'.",
};

export const Failed_to_find_peerDependency_0: DiagnosticMessage = {
  code: 6283,
  category: DiagnosticCategory.Message,
  key: 'Failed_to_find_peerDependency_0_6283',
  text: "Failed to find peerDependency '{0}'.",
};

export const Failed_to_resolve_under_condition_0: DiagnosticMessage = {
  code: 6415,
  category: DiagnosticCategory.Message,
  key: 'Failed_to_resolve_under_condition_0_6415',
  text: "Failed to resolve under condition '{0}'.",
};

export const File_0_does_not_exist: DiagnosticMessage = {
  code: 6096,
  category: DiagnosticCategory.Message,
  key: 'File_0_does_not_exist_6096',
  text: "File '{0}' does not exist.",
};

export const File_0_does_not_exist_according_to_earlier_cached_lookups: DiagnosticMessage = {
  code: 6240,
  category: DiagnosticCategory.Message,
  key: 'File_0_does_not_exist_according_to_earlier_cached_lookups_6240',
  text: "File '{0}' does not exist according to earlier cached lookups.",
};

export const File_0_exists_according_to_earlier_cached_lookups: DiagnosticMessage = {
  code: 6239,
  category: DiagnosticCategory.Message,
  key: 'File_0_exists_according_to_earlier_cached_lookups_6239',
  text: "File '{0}' exists according to earlier cached lookups.",
};

export const File_0_exists_use_it_as_a_name_resolution_result: DiagnosticMessage = {
  code: 6097,
  category: DiagnosticCategory.Message,
  key: 'File_0_exists_use_it_as_a_name_resolution_result_6097',
  text: "File '{0}' exists - use it as a name resolution result.",
};

export const File_name_0_has_a_1_extension_stripping_it: DiagnosticMessage = {
  code: 6132,
  category: DiagnosticCategory.Message,
  key: 'File_name_0_has_a_1_extension_stripping_it_6132',
  text: "File name '{0}' has a '{1}' extension - stripping it.",
};

export const Found_package_json_at_0: DiagnosticMessage = {
  code: 6099,
  category: DiagnosticCategory.Message,
  key: 'Found_package_json_at_0_6099',
  text: "Found 'package.json' at '{0}'.",
};

export const Found_peerDependency_0_with_1_version: DiagnosticMessage = {
  code: 6282,
  category: DiagnosticCategory.Message,
  key: 'Found_peerDependency_0_with_1_version_6282',
  text: "Found peerDependency '{0}' with '{1}' version.",
};

export const Import_specifier_0_does_not_exist_in_package_json_scope_at_path_1: DiagnosticMessage = {
  code: 6271,
  category: DiagnosticCategory.Message,
  key: 'Import_specifier_0_does_not_exist_in_package_json_scope_at_path_1_6271',
  text: "Import specifier '{0}' does not exist in package.json scope at path '{1}'.",
};

export const Invalid_import_specifier_0_has_no_possible_resolutions: DiagnosticMessage = {
  code: 6272,
  category: DiagnosticCategory.Message,
  key: 'Invalid_import_specifier_0_has_no_possible_resolutions_6272',
  text: "Invalid import specifier '{0}' has no possible resolutions.",
};

export const Loading_0_from_the_root_dir_1_candidate_location_2: DiagnosticMessage = {
  code: 6109,
  category: DiagnosticCategory.Message,
  key: 'Loading_0_from_the_root_dir_1_candidate_location_2_6109',
  text: "Loading '{0}' from the root dir '{1}', candidate location '{2}'.",
};

export const Loading_module_0_from_node_modules_folder_target_file_types_Colon_1: DiagnosticMessage = {
  code: 6098,
  category: DiagnosticCategory.Message,
  key: 'Loading_module_0_from_node_modules_folder_target_file_types_Colon_1_6098',
  text: "Loading module '{0}' from 'node_modules' folder, target file types: {1}.",
};

export const Loading_module_as_file_Slash_folder_candidate_module_location_0_target_file_types_Colon_1: DiagnosticMessage =
  {
    code: 6095,
    category: DiagnosticCategory.Message,
    key: 'Loading_module_as_file_Slash_folder_candidate_module_location_0_target_file_types_Colon_1_6095',
    text: "Loading module as file / folder, candidate module location '{0}', target file types: {1}.",
  };

export const Longest_matching_prefix_for_0_is_1: DiagnosticMessage = {
  code: 6108,
  category: DiagnosticCategory.Message,
  key: 'Longest_matching_prefix_for_0_is_1_6108',
  text: "Longest matching prefix for '{0}' is '{1}'.",
};

export const Looking_up_in_node_modules_folder_initial_location_0: DiagnosticMessage = {
  code: 6125,
  category: DiagnosticCategory.Message,
  key: 'Looking_up_in_node_modules_folder_initial_location_0_6125',
  text: "Looking up in 'node_modules' folder, initial location '{0}'.",
};

export const Matched_0_condition_1: DiagnosticMessage = {
  code: 6403,
  category: DiagnosticCategory.Message,
  key: 'Matched_0_condition_1_6403',
  text: "Matched '{0}' condition '{1}'.",
};

export const Module_0_was_resolved_to_1_but_allowArbitraryExtensions_is_not_set: DiagnosticMessage = {
  code: 6263,
  category: DiagnosticCategory.Error,
  key: 'Module_0_was_resolved_to_1_but_allowArbitraryExtensions_is_not_set_6263',
  text: "Module '{0}' was resolved to '{1}', but '--allowArbitraryExtensions' is not set.",
};

export const Module_0_was_resolved_to_1_but_jsx_is_not_set: DiagnosticMessage = {
  code: 6142,
  category: DiagnosticCategory.Error,
  key: 'Module_0_was_resolved_to_1_but_jsx_is_not_set_6142',
  text: "Module '{0}' was resolved to '{1}', but '--jsx' is not set.",
};

export const Module_0_was_resolved_to_1_but_resolveJsonModule_is_not_used: DiagnosticMessage = {
  code: 7042,
  category: DiagnosticCategory.Error,
  key: 'Module_0_was_resolved_to_1_but_resolveJsonModule_is_not_used_7042',
  text: "Module '{0}' was resolved to '{1}', but '--resolveJsonModule' is not used.",
};

export const Module_name_0_matched_pattern_1: DiagnosticMessage = {
  code: 6092,
  category: DiagnosticCategory.Message,
  key: 'Module_name_0_matched_pattern_1_6092',
  text: "Module name '{0}', matched pattern '{1}'.",
};

export const Module_name_0_was_not_resolved: DiagnosticMessage = {
  code: 6090,
  category: DiagnosticCategory.Message,
  key: 'Module_name_0_was_not_resolved_6090',
  text: "======== Module name '{0}' was not resolved. ========",
};

export const Module_name_0_was_successfully_resolved_to_1: DiagnosticMessage = {
  code: 6089,
  category: DiagnosticCategory.Message,
  key: 'Module_name_0_was_successfully_resolved_to_1_6089',
  text: "======== Module name '{0}' was successfully resolved to '{1}'. ========",
};

export const Module_name_0_was_successfully_resolved_to_1_with_Package_ID_2: DiagnosticMessage = {
  code: 6218,
  category: DiagnosticCategory.Message,
  key: 'Module_name_0_was_successfully_resolved_to_1_with_Package_ID_2_6218',
  text: "======== Module name '{0}' was successfully resolved to '{1}' with Package ID '{2}'. ========",
};

export const Module_resolution_kind_is_not_specified_using_0: DiagnosticMessage = {
  code: 6088,
  category: DiagnosticCategory.Message,
  key: 'Module_resolution_kind_is_not_specified_using_0_6088',
  text: "Module resolution kind is not specified, using '{0}'.",
};

export const Module_resolution_using_rootDirs_has_failed: DiagnosticMessage = {
  code: 6111,
  category: DiagnosticCategory.Message,
  key: 'Module_resolution_using_rootDirs_has_failed_6111',
  text: "Module resolution using 'rootDirs' has failed.",
};

export const Resolution_of_non_relative_name_failed_trying_with_modern_Node_resolution_features_disabled_to_see_if_npm_library_needs_configuration_update: DiagnosticMessage =
  {
    code: 6277,
    category: DiagnosticCategory.Message,
    key: 'Resolution_of_non_relative_name_failed_trying_with_modern_Node_resolution_features_disabled_to_see_i_6277',
    text: 'Resolution of non-relative name failed; trying with modern Node resolution features disabled to see if npm library needs configuration update.',
  };

export const Resolved_under_condition_0: DiagnosticMessage = {
  code: 6414,
  category: DiagnosticCategory.Message,
  key: 'Resolved_under_condition_0_6414',
  text: "Resolved under condition '{0}'.",
};

export const Resolving_in_0_mode_with_conditions_1: DiagnosticMessage = {
  code: 6402,
  category: DiagnosticCategory.Message,
  key: 'Resolving_in_0_mode_with_conditions_1_6402',
  text: 'Resolving in {0} mode with conditions {1}.',
};

export const Resolving_module_0_from_1: DiagnosticMessage = {
  code: 6086,
  category: DiagnosticCategory.Message,
  key: 'Resolving_module_0_from_1_6086',
  text: "======== Resolving module '{0}' from '{1}'. ========",
};

export const Resolving_real_path_for_0_result_1: DiagnosticMessage = {
  code: 6130,
  category: DiagnosticCategory.Message,
  key: 'Resolving_real_path_for_0_result_1_6130',
  text: "Resolving real path for '{0}', result '{1}'.",
};

export const Resolving_type_reference_directive_0_containing_file_1_root_directory_2: DiagnosticMessage = {
  code: 6116,
  category: DiagnosticCategory.Message,
  key: 'Resolving_type_reference_directive_0_containing_file_1_root_directory_2_6116',
  text: "======== Resolving type reference directive '{0}', containing file '{1}', root directory '{2}'. ========",
};

export const Resolving_type_reference_directive_for_program_that_specifies_custom_typeRoots_skipping_lookup_in_node_modules_folder: DiagnosticMessage =
  {
    code: 6265,
    category: DiagnosticCategory.Message,
    key: 'Resolving_type_reference_directive_for_program_that_specifies_custom_typeRoots_skipping_lookup_in_no_6265',
    text: "Resolving type reference directive for program that specifies custom typeRoots, skipping lookup in 'node_modules' folder.",
  };

export const Resolving_with_primary_search_path_0: DiagnosticMessage = {
  code: 6121,
  category: DiagnosticCategory.Message,
  key: 'Resolving_with_primary_search_path_0_6121',
  text: "Resolving with primary search path '{0}'.",
};

export const Root_directory_cannot_be_determined_skipping_primary_search_paths: DiagnosticMessage = {
  code: 6122,
  category: DiagnosticCategory.Message,
  key: 'Root_directory_cannot_be_determined_skipping_primary_search_paths_6122',
  text: 'Root directory cannot be determined, skipping primary search paths.',
};

export const Saw_non_matching_condition_0: DiagnosticMessage = {
  code: 6405,
  category: DiagnosticCategory.Message,
  key: 'Saw_non_matching_condition_0_6405',
  text: "Saw non-matching condition '{0}'.",
};

export const Scoped_package_detected_looking_in_0: DiagnosticMessage = {
  code: 6182,
  category: DiagnosticCategory.Message,
  key: 'Scoped_package_detected_looking_in_0_6182',
  text: "Scoped package detected, looking in '{0}'",
};

export const Searching_all_ancestor_node_modules_directories_for_fallback_extensions_Colon_0: DiagnosticMessage = {
  code: 6418,
  category: DiagnosticCategory.Message,
  key: 'Searching_all_ancestor_node_modules_directories_for_fallback_extensions_Colon_0_6418',
  text: 'Searching all ancestor node_modules directories for fallback extensions: {0}.',
};

export const Searching_all_ancestor_node_modules_directories_for_preferred_extensions_Colon_0: DiagnosticMessage = {
  code: 6417,
  category: DiagnosticCategory.Message,
  key: 'Searching_all_ancestor_node_modules_directories_for_preferred_extensions_Colon_0_6417',
  text: 'Searching all ancestor node_modules directories for preferred extensions: {0}.',
};

export const Skipping_module_0_that_looks_like_an_absolute_URI_target_file_types_Colon_1: DiagnosticMessage = {
  code: 6164,
  category: DiagnosticCategory.Message,
  key: 'Skipping_module_0_that_looks_like_an_absolute_URI_target_file_types_Colon_1_6164',
  text: "Skipping module '{0}' that looks like an absolute URI, target file types: {1}.",
};

export const The_project_root_is_ambiguous_but_is_required_to_resolve_export_map_entry_0_in_file_1_Supply_the_rootDir_compiler_option_to_disambiguate: DiagnosticMessage =
  {
    code: 2209,
    category: DiagnosticCategory.Error,
    key: 'The_project_root_is_ambiguous_but_is_required_to_resolve_export_map_entry_0_in_file_1_Supply_the_roo_2209',
    text: "The project root is ambiguous, but is required to resolve export map entry '{0}' in file '{1}'. Supply the `rootDir` compiler option to disambiguate.",
  };

export const The_project_root_is_ambiguous_but_is_required_to_resolve_import_map_entry_0_in_file_1_Supply_the_rootDir_compiler_option_to_disambiguate: DiagnosticMessage =
  {
    code: 2210,
    category: DiagnosticCategory.Error,
    key: 'The_project_root_is_ambiguous_but_is_required_to_resolve_import_map_entry_0_in_file_1_Supply_the_roo_2210',
    text: "The project root is ambiguous, but is required to resolve import map entry '{0}' in file '{1}'. Supply the `rootDir` compiler option to disambiguate.",
  };

export const Trying_other_entries_in_rootDirs: DiagnosticMessage = {
  code: 6110,
  category: DiagnosticCategory.Message,
  key: 'Trying_other_entries_in_rootDirs_6110',
  text: "Trying other entries in 'rootDirs'.",
};

export const Trying_substitution_0_candidate_module_location_Colon_1: DiagnosticMessage = {
  code: 6093,
  category: DiagnosticCategory.Message,
  key: 'Trying_substitution_0_candidate_module_location_Colon_1_6093',
  text: "Trying substitution '{0}', candidate module location: '{1}'.",
};

export const Type_reference_directive_0_was_not_resolved: DiagnosticMessage = {
  code: 6120,
  category: DiagnosticCategory.Message,
  key: 'Type_reference_directive_0_was_not_resolved_6120',
  text: "======== Type reference directive '{0}' was not resolved. ========",
};

export const Type_reference_directive_0_was_successfully_resolved_to_1_primary_Colon_2: DiagnosticMessage = {
  code: 6119,
  category: DiagnosticCategory.Message,
  key: 'Type_reference_directive_0_was_successfully_resolved_to_1_primary_Colon_2_6119',
  text: "======== Type reference directive '{0}' was successfully resolved to '{1}', primary: {2}. ========",
};

export const Type_reference_directive_0_was_successfully_resolved_to_1_with_Package_ID_2_primary_Colon_3: DiagnosticMessage =
  {
    code: 6219,
    category: DiagnosticCategory.Message,
    key: 'Type_reference_directive_0_was_successfully_resolved_to_1_with_Package_ID_2_primary_Colon_3_6219',
    text: "======== Type reference directive '{0}' was successfully resolved to '{1}' with Package ID '{2}', primary: {3}. ========",
  };

export const Using_0_subpath_1_with_target_2: DiagnosticMessage = {
  code: 6404,
  category: DiagnosticCategory.Message,
  key: 'Using_0_subpath_1_with_target_2_6404',
  text: "Using '{0}' subpath '{1}' with target '{2}'.",
};

export const Using_compiler_options_of_project_reference_redirect_0: DiagnosticMessage = {
  code: 6215,
  category: DiagnosticCategory.Message,
  key: 'Using_compiler_options_of_project_reference_redirect_0_6215',
  text: "Using compiler options of project reference redirect '{0}'.",
};

export const package_json_does_not_have_a_0_field: DiagnosticMessage = {
  code: 6100,
  category: DiagnosticCategory.Message,
  key: 'package_json_does_not_have_a_0_field_6100',
  text: "'package.json' does not have a '{0}' field.",
};

export const package_json_does_not_have_a_typesVersions_entry_that_matches_version_0: DiagnosticMessage = {
  code: 6207,
  category: DiagnosticCategory.Message,
  key: 'package_json_does_not_have_a_typesVersions_entry_that_matches_version_0_6207',
  text: "'package.json' does not have a 'typesVersions' entry that matches version '{0}'.",
};

export const package_json_had_a_falsy_0_field: DiagnosticMessage = {
  code: 6220,
  category: DiagnosticCategory.Message,
  key: 'package_json_had_a_falsy_0_field_6220',
  text: "'package.json' had a falsy '{0}' field.",
};

export const package_json_has_0_field_1_that_references_2: DiagnosticMessage = {
  code: 6101,
  category: DiagnosticCategory.Message,
  key: 'package_json_has_0_field_1_that_references_2_6101',
  text: "'package.json' has '{0}' field '{1}' that references '{2}'.",
};

export const package_json_has_a_peerDependencies_field: DiagnosticMessage = {
  code: 6281,
  category: DiagnosticCategory.Message,
  key: 'package_json_has_a_peerDependencies_field_6281',
  text: "'package.json' has a 'peerDependencies' field.",
};

export const package_json_has_a_typesVersions_entry_0_that_is_not_a_valid_semver_range: DiagnosticMessage = {
  code: 6209,
  category: DiagnosticCategory.Message,
  key: 'package_json_has_a_typesVersions_entry_0_that_is_not_a_valid_semver_range_6209',
  text: "'package.json' has a 'typesVersions' entry '{0}' that is not a valid semver range.",
};

export const package_json_has_a_typesVersions_entry_0_that_matches_compiler_version_1_looking_for_a_pattern_to_match_module_name_2: DiagnosticMessage =
  {
    code: 6208,
    category: DiagnosticCategory.Message,
    key: 'package_json_has_a_typesVersions_entry_0_that_matches_compiler_version_1_looking_for_a_pattern_to_ma_6208',
    text: "'package.json' has a 'typesVersions' entry '{0}' that matches compiler version '{1}', looking for a pattern to match module name '{2}'.",
  };

export const package_json_has_a_typesVersions_field_with_version_specific_path_mappings: DiagnosticMessage = {
  code: 6206,
  category: DiagnosticCategory.Message,
  key: 'package_json_has_a_typesVersions_field_with_version_specific_path_mappings_6206',
  text: "'package.json' has a 'typesVersions' field with version-specific path mappings.",
};

export const package_json_scope_0_explicitly_maps_specifier_1_to_null: DiagnosticMessage = {
  code: 6274,
  category: DiagnosticCategory.Message,
  key: 'package_json_scope_0_explicitly_maps_specifier_1_to_null_6274',
  text: "package.json scope '{0}' explicitly maps specifier '{1}' to null.",
};

export const package_json_scope_0_has_invalid_type_for_target_of_specifier_1: DiagnosticMessage = {
  code: 6275,
  category: DiagnosticCategory.Message,
  key: 'package_json_scope_0_has_invalid_type_for_target_of_specifier_1_6275',
  text: "package.json scope '{0}' has invalid type for target of specifier '{1}'",
};

export const package_json_scope_0_has_no_imports_defined: DiagnosticMessage = {
  code: 6273,
  category: DiagnosticCategory.Message,
  key: 'package_json_scope_0_has_no_imports_defined_6273',
  text: "package.json scope '{0}' has no imports defined.",
};

export const paths_option_is_specified_looking_for_a_pattern_to_match_module_name_0: DiagnosticMessage = {
  code: 6091,
  category: DiagnosticCategory.Message,
  key: 'paths_option_is_specified_looking_for_a_pattern_to_match_module_name_0_6091',
  text: "'paths' option is specified, looking for a pattern to match module name '{0}'.",
};

export const rootDirs_option_is_set_using_it_to_resolve_relative_module_name_0: DiagnosticMessage = {
  code: 6107,
  category: DiagnosticCategory.Message,
  key: 'rootDirs_option_is_set_using_it_to_resolve_relative_module_name_0_6107',
  text: "'rootDirs' option is set, using it to resolve relative module name '{0}'.",
};
