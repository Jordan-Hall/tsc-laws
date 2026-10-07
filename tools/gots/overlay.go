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
