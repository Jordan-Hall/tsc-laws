package main

import (
	"io/fs"
	"os"
	"path/filepath"
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

func loadOverlay(dir, upstream string) map[string][]byte {
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
	for _, e := range sourceEdits {
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
	return out
}
