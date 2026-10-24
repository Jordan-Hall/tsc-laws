// tsc-laws diagnostics, appended to tsgo's generated catalog by generate-diagnostics.mjs. Codes 9101+ are ours.
const error = 1;
export const lawMessages = [
  ['A_law_must_return_boolean_or_void_not_0', 9101, "A law must return boolean or void, not '{0}'."],
  ['A_law_must_be_exported_so_tslaws_can_load_it', 9102, 'A law must be exported so tslaws can load it.'],
  [
    'Parameter_0_of_a_law_needs_a_type_annotation_so_inputs_can_be_generated',
    9103,
    "Parameter '{0}' of a law needs a type annotation so inputs can be generated.",
  ],
  ['A_law_cannot_be_a_generator_or_a_default_export', 9104, 'A law cannot be a generator or a default export.'],
  [
    '_0_is_a_law_and_only_another_law_can_call_it',
    9105,
    "'{0}' is a law, a specification: only another law can call it.",
  ],
  [
    'A_law_parameter_must_be_a_plain_identifier',
    9106,
    'A law parameter must be a plain identifier so inputs can be generated.',
  ],
].map(([key, code, text]) => ({ name: key, code, flags: error, key: `${key}_${code}`, text }));
