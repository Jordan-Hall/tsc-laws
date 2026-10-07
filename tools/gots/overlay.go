package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Source overlays change TypeScript-Go's Go source before translation, for
// representations that translate better. Files under the overlay directory
// replace the upstream file at the same path below internal/; sourceEdits
// make small replacements in other files.

var sourceEdits = []struct{ file, from, to string }{
	// TextRange is an integer in the overlay.
	{"ast/diagnostic.go", "core.TextRange{}", "core.TextRange(0)"},
	{"module/resolver.go", "core.TextRange{}", "core.TextRange(0)"},
	{"printer/emitcontext.go", "core.TextRange{}", "core.TextRange(0)"},
	{"transformers/destructuring.go", "core.TextRange{}", "core.TextRange(0)"},
	// removeSubtypes returns nil for a union too complex to represent, which
	// the translation can't tell from an empty slice; use a sentinel.
	{"checker/checker.go", "Expression_produces_a_union_type_that_is_too_complex_to_represent)\n\t\t\t\t\t\t\treturn nil", "Expression_produces_a_union_type_that_is_too_complex_to_represent)\n\t\t\t\t\t\t\treturn []*Type{nil}"},
	{"checker/checker.go", "typeSet = c.removeSubtypes(typeSet, includes&TypeFlagsObject != 0)\n\t\t\tif typeSet == nil {", "typeSet = c.removeSubtypes(typeSet, includes&TypeFlagsObject != 0)\n\t\t\tif len(typeSet) == 1 && typeSet[0] == nil {"},
	// lookAhead saves the parser state in a reused object per nesting depth
	// instead of a new value per call, which the translation allocates.
	{"parser/parser.go", "type Parser struct {\n\tscanner *scanner.Scanner\n", "type Parser struct {\n\tlookAheadStates []*ParserState\n\tlookAheadDepth  int\n\tscanner *scanner.Scanner\n"},
	{"parser/parser.go", `func (p *Parser) lookAhead(callback func(p *Parser) bool) bool {
	state := p.mark()
	result := callback(p)
	p.rewind(state)
	return result
}`, `func (p *Parser) lookAhead(callback func(p *Parser) bool) bool {
	if p.lookAheadDepth == len(p.lookAheadStates) {
		p.lookAheadStates = append(p.lookAheadStates, &ParserState{})
	}
	state := p.lookAheadStates[p.lookAheadDepth]
	p.scanner.MarkInto(&state.scannerState)
	state.contextFlags = p.contextFlags
	state.diagnosticsLen = len(p.diagnostics)
	state.jsDiagnosticsLen = len(p.jsDiagnostics)
	state.jsdocInfosLen = len(p.jsdocInfos)
	state.reparsedClonesLen = len(p.reparsedClones)
	state.statementHasAwaitIdentifier = p.statementHasAwaitIdentifier
	state.hasParseError = p.hasParseError
	p.lookAheadDepth++
	result := callback(p)
	p.lookAheadDepth--
	p.rewind(*state)
	return result
}`},
	{"scanner/scanner.go", "func (s *Scanner) Rewind(state ScannerState) {", "func (s *Scanner) MarkInto(dst *ScannerState) {\n\t*dst = s.ScannerState\n}\n\nfunc (s *Scanner) Rewind(state ScannerState) {"},
}

// patternEdits rewrite every match of a regular expression in a file.
var patternEdits = []struct{ file, pattern, to string }{
	// tsconfig parsing classifies JSON values with reflect; use type tests.
	{"tsoptions/tsconfigparsing.go", `reflect\.TypeOf\(([^()]+)\)\.Kind\(\) == reflect\.Slice`, "isSliceJSONValue($1)"},
	{"tsoptions/tsconfigparsing.go", `reflect\.TypeOf\(([^()]+)\)\.Kind\(\) == reflect\.String`, "isStringJSONValue($1)"},
	{"tsoptions/tsconfigparsing.go", `reflect\.TypeOf\(([^()]+)\)\.Kind\(\) == reflect\.Bool`, "isBoolJSONValue($1)"},
	{"tsoptions/tsconfigparsing.go", `reflect\.TypeOf\(([^()]+)\)\.Kind\(\) == reflect\.Float64`, "isFloatJSONValue($1)"},
	{"tsoptions/tsconfigparsing.go", `reflect\.TypeOf\(([^()]+)\) == orderedMapType`, "isOrderedMapJSONValue($1)"},
	{"tsoptions/tsconfigparsing.go", `var orderedMapType = reflect\.TypeFor\[\*collections\.OrderedMap\[string, any\]\]\(\)`, `func isSliceJSONValue(v any) bool {
	switch v.(type) {
	case []any, []string:
		return true
	}
	return false
}

func isStringJSONValue(v any) bool { _, ok := v.(string); return ok }

func isBoolJSONValue(v any) bool { _, ok := v.(bool); return ok }

func isFloatJSONValue(v any) bool { _, ok := v.(float64); return ok }

func isOrderedMapJSONValue(v any) bool { _, ok := v.(*collections.OrderedMap[string, any]); return ok }`},
	{"tsoptions/tsconfigparsing.go", `(?s)\tdefault:\n\t\treflected := reflect\.ValueOf\(value\).*?\t\treturn result\n\t\}\n\}`, `	case []string:
		result := make([]any, len(value))
		for i, child := range value {
			result[i] = child
		}
		return result
	default:
		return value
	}
}`},
	{"tsoptions/tsconfigparsing.go", `\t"reflect"\n`, ""},
	// packagejson: Parse is replaced (tools/overlay/packagejson/parse.go).
	{"packagejson/packagejson.go", `func Parse\(data \[\]byte\) \(Fields, error\) \{`, "func parseWithJSONLibrary(data []byte) (Fields, error) {"},
	{"packagejson/expected.go", `(?s)\tswitch reflect\.TypeFor\[T\]\(\)\.Kind\(\) \{.*?\n\t\}\n\}`, `	var zero T
	switch any(zero).(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case []string, []any:
		return "array"
	case map[string]string, map[string]any:
		return "object"
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return "number"
	default:
		return "unknown"
	}
}`},
	{"packagejson/expected.go", `\t"reflect"\n`, ""},
}

func loadOverlay(dir, upstream string, env, flags []string) map[string][]byte {
	out := map[string][]byte{}
	internal := filepath.Join(upstream, "internal")
	if dir != "" {
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(dir, path)
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			out[filepath.Join(internal, rel)] = data
			return nil
		})
		if err != nil {
			fatal(err)
		}
	}
	edits := append([]struct{ file, from, to string }{}, sourceEdits...)
	edits = append(edits,
		struct{ file, from, to string }{"tsoptions/parsinghelpers.go", mergeReflect, mergeCompilerOptionsCode(upstream, env, flags)},
		struct{ file, from, to string }{"tsoptions/parsinghelpers.go", "\t\"reflect\"\n", ""},
		struct{ file, from, to string }{"tsoptions/parsinghelpers.go", "\t\"strings\"\n", ""})
	for _, e := range edits {
		path := filepath.Join(internal, e.file)
		data, ok := out[path]
		if !ok {
			var err error
			if data, err = os.ReadFile(path); err != nil {
				fatal(err)
			}
		}
		if !strings.Contains(string(data), e.from) {
			fatal(&os.PathError{Op: "overlay edit", Path: e.file, Err: os.ErrNotExist})
		}
		out[path] = []byte(strings.ReplaceAll(string(data), e.from, e.to))
	}
	for _, e := range patternEdits {
		path := filepath.Join(internal, e.file)
		data, ok := out[path]
		if !ok {
			var err error
			if data, err = os.ReadFile(path); err != nil {
				fatal(err)
			}
		}
		re := regexp.MustCompile(e.pattern)
		if !re.Match(data) {
			fatal(&os.PathError{Op: "overlay pattern", Path: e.file, Err: os.ErrNotExist})
		}
		out[path] = re.ReplaceAll(data, []byte(e.to))
	}
	return out
}
