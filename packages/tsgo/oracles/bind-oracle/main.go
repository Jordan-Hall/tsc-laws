// Command bind-oracle prints TypeScript-Go's symbols and bind diagnostics
// for a file, or times parsing and binding with --bench.
package main

import (
	"bufio"
	"fmt"
	"os"
	"slices"
	"time"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/binder"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/parser"
	"github.com/microsoft/typescript-go/internal/tspath"
)

func parse(text string) *ast.SourceFile {
	opts := ast.SourceFileParseOptions{FileName: "/input.ts", Path: tspath.Path("/input.ts")}
	return parser.ParseSourceFile(opts, text, core.ScriptKindTS)
}

func symbol(s *ast.Symbol) string {
	if s == nil {
		return "-"
	}
	return fmt.Sprintf("%q:%d:%d", s.Name, s.Flags, len(s.Declarations))
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	text := string(data)
	if len(os.Args) > 2 && os.Args[2] == "--bench" {
		start := time.Now()
		for range 20 {
			binder.BindSourceFile(parse(text))
		}
		fmt.Printf("time %.2fms\n", float64(time.Since(start).Microseconds())/1000/20)
		return
	}
	f := parse(text)
	binder.BindSourceFile(f)
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	var visit func(n *ast.Node, depth int) bool
	visit = func(n *ast.Node, depth int) bool {
		fmt.Fprintf(w, "%d %d %d %d %d %s %s", depth, n.Kind, n.Pos(), n.End(), n.Flags, symbol(n.Symbol()), symbol(n.LocalSymbol()))
		if locals := n.Locals(); len(locals) > 0 {
			names := make([]string, 0, len(locals))
			for name := range locals {
				names = append(names, name)
			}
			slices.Sort(names)
			for _, name := range names {
				fmt.Fprintf(w, " %s", symbol(locals[name]))
			}
		}
		fmt.Fprintln(w)
		n.ForEachChild(func(c *ast.Node) bool { return visit(c, depth+1) })
		return false
	}
	visit(f.AsNode(), 0)
	for _, d := range f.BindDiagnostics() {
		fmt.Fprintf(w, "diag %d %d %d %s\n", d.Code(), d.Pos(), d.Len(), d.String())
	}
}
