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
	// Package.json fields are generic Expected[T] values, which the
	// translation can't pass as the TypeValidatedField interface.
	{"module/resolver.go", "func (r *resolutionState) validatePackageJSONField(fieldName string, field packagejson.TypeValidatedField) bool {", "func validatePackageJSONField[T any](r *resolutionState, fieldName string, field *packagejson.Expected[T]) bool {"},
	{"module/resolver.go", `r.validatePackageJSONField("peerDependencies", &peerDependencies)`, `validatePackageJSONField(r, "peerDependencies", &peerDependencies)`},
	{"module/resolver.go", `!r.validatePackageJSONField(fieldName, field)`, `!validatePackageJSONField(r, fieldName, field)`},
	// JSDoc parsing tests the text around each comment without taking
	// substrings, which the translation copies.
	{"parser/jsdoc.go", "if !isJSDocLikeText(p.sourceText[start:]) {", "if !isJSDocLikeTextAt(p.sourceText, start) {"},
	{"parser/jsdoc.go", `strings.LastIndex(p.sourceText[:start], "\n")`, "lastLineFeedBefore(p.sourceText, start)"},
	{"parser/utilities.go", "func isJSDocLikeText(text string) bool {", `func isJSDocLikeTextAt(text string, start int) bool {
	return len(text)-start >= 4 && text[start+1] == '*' && text[start+2] == '*' && text[start+3] != '/'
}

func lastLineFeedBefore(text string, end int) int {
	for i := end - 1; i >= 0; i-- {
		if text[i] == '\n' {
			return i
		}
	}
	return -1
}

func isJSDocLikeText(text string) bool {`},
	// Source file data cells hold their value as an interface: generic class
	// instances can't be recovered from an interface value in scriptc.
	{"ast/ast.go", `type sourceFileDataCell[T any] struct {
	once  sync.Once
	value T
}`, `type sourceFileDataCell struct {
	once  sync.Once
	value any
}`},
	{"ast/ast.go", `	cell.once.Do(func() {
		cell.value = compute(file)
	})
	return cell.value
}

func getSourceFileDataCell[T any](file *SourceFile, key *SourceFileDataKey[T]) *sourceFileDataCell[T] {`, `	cell.once.Do(func() {
		cell.value = compute(file)
	})
	return cell.value.(T)
}

func getSourceFileDataCell[T any](file *SourceFile, key *SourceFileDataKey[T]) *sourceFileDataCell {`},
	{"ast/ast.go", `	if file.data == nil {
		file.data = make(map[sourceFileDataKey]any)
	}
	if cell, ok := file.data[key.key]; ok {
		return cell.(*sourceFileDataCell[T])
	}
	cell := &sourceFileDataCell[T]{}`, `	if file.data == nil {
		file.data = make(map[sourceFileDataKey]*sourceFileDataCell)
	}
	if cell, ok := file.data[key.key]; ok {
		return cell
	}
	cell := &sourceFileDataCell{}`},
	{"ast/ast.go", "	data   map[sourceFileDataKey]any\n", "	data   map[sourceFileDataKey]*sourceFileDataCell\n"},
	{"scanner/scanner.go", "func (s *Scanner) Rewind(state ScannerState) {", "func (s *Scanner) MarkInto(dst *ScannerState) {\n\t*dst = s.ScannerState\n}\n\nfunc (s *Scanner) Rewind(state ScannerState) {"},
}

// patternEdits rewrite every match of a regular expression in a file.
var patternEdits = []struct{ file, pattern, to string }{
	// tsconfig parsing classifies JSON values with reflect; use type tests.
	{"tsoptions/tsconfigparsing.go", `reflect\.TypeOf\(([^()]+)\)\.Kind\(\) == reflect\.Slice`, "isSliceJSONValue($1)"},
	{"tsoptions/tsconfigparsing.go", `reflect\.TypeOf\(([^()]+)\)\.Kind\(\) == reflect\.String`, "isStringJSONValue($1)"},
	{"tsoptions/tsconfigparsing.go", `reflect\.TypeOf\(([^()]+)\)\.Kind\(\) != reflect\.String`, "!isStringJSONValue($1)"},
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
	{"tsoptions/tsconfigparsing.go", `\t"reflect"\n`, ""},
	// packagejson: Parse is replaced (tsgo overlay/packagejson/parse.go).
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
	// Decoding JSON into an OrderedMap is only reached through the JSON
	// library, which the translation doesn't include; scriptc can't lower
	// pointers to every key and value type it would instantiate.
	{"collections/ordered_map.go", `(?s)\nvar _ json\.UnmarshalerFrom = .*?\n}\n`, ""},
	{"collections/ordered_map.go", `\t"errors"\n`, ""},
	// fmtMain is unused; dropping it keeps the formatter and the language
	// server protocol out of the tsc command line.
	{"execute/tsc.go", `(?s)\nfunc fmtMain\(.*?\n}\n`, ""},
	{"execute/tsc.go", `\t"github.com/microsoft/typescript-go/internal/(core|format|ls/lsutil|parser)"\n`, ""},
	// The encoder's visitors call factory updates through a nil *NodeFactory,
	// which Go allows for unchanged nodes but the translation can't.
	{"api/encoder/encoder.go", `visitor := &ast.NodeVisitor\{\n`, "visitor := &ast.NodeVisitor{\n\t\tFactory: &ast.NodeFactory{},\n"},
	// The encoder patches offsets through subslices, which the translation
	// copies; write through the slice itself.
	{"api/encoder/encoder.go", `binary\.LittleEndian\.PutUint32\(extendedData\[([^\]]+):\], `, "putUint32At(extendedData, $1, "},
	{"api/encoder/encoder.go", `\nfunc recordExtendedData_TemplateHead\(`, `
func putUint32At(b []byte, offset int, v uint32) {
	b[offset] = byte(v)
	b[offset+1] = byte(v >> 8)
	b[offset+2] = byte(v >> 16)
	b[offset+3] = byte(v >> 24)
}

func recordExtendedData_TemplateHead(`},
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
