// Command check-oracle prints TypeScript-Go's diagnostics for a file checked
// against the bundled libs, or times checking with --bench.
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/tststest"
)

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	libDir := os.Args[2]
	readLib := func(name string) (string, bool) {
		b, err := os.ReadFile(filepath.Join(libDir, name))
		return string(b), err == nil
	}
	text := string(data)
	if len(os.Args) > 3 && os.Args[3] == "--batch" {
		// The first argument lists input files, one per line.
		w := bufio.NewWriter(os.Stdout)
		defer w.Flush()
		for _, line := range strings.Split(text, "\n") {
			if line == "" {
				continue
			}
			input, err := os.ReadFile(line)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "== %s\n", line)
			func() {
				defer func() {
					if r := recover(); r != nil {
						fmt.Fprintf(w, "!! panic\n")
					}
				}()
				print(w, tststest.Check("/input.ts", string(input), readLib))
			}()
		}
		return
	}
	if len(os.Args) > 3 && os.Args[3] == "--bench" {
		start := time.Now()
		var diags []*ast.Diagnostic
		for range 5 {
			diags = tststest.Check("/input.ts", text, readLib)
		}
		fmt.Printf("diagnostics %d time %.2fms\n", len(diags), float64(time.Since(start).Microseconds())/1000/5)
		return
	}
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	print(w, tststest.Check("/input.ts", text, readLib))
}

func print(w *bufio.Writer, diags []*ast.Diagnostic) {
	for _, d := range diags {
		name := ""
		if d.File() != nil {
			name = d.File().FileName()
		}
		fmt.Fprintf(w, "%s %d %d %d %s\n", name, d.Code(), d.Pos(), d.Len(), d.String())
	}
}
