package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/vfs/vfstest"
	"os"
	"runtime"
	"time"
)

type query struct {
	Source string `json:"source"`
	Target string `json:"target"`
}
type input struct {
	Source                     string  `json:"source"`
	Queries                    []query `json:"queries"`
	Rounds                     int     `json:"rounds"`
	Cold                       bool    `json:"cold"`
	StrictNullChecks           *bool   `json:"strictNullChecks"`
	StrictFunctionTypes        *bool   `json:"strictFunctionTypes"`
	ExactOptionalPropertyTypes bool    `json:"exactOptionalPropertyTypes"`
}
type graphQuery struct {
	Source   int    `json:"source"`
	Target   int    `json:"target"`
	Expected bool   `json:"expected"`
	Label    string `json:"label"`
}
type graph struct {
	Schema                     string                 `json:"schema"`
	Revision                   string                 `json:"revision"`
	StrictNullChecks           bool                   `json:"strictNullChecks"`
	StrictFunctionTypes        bool                   `json:"strictFunctionTypes"`
	ExactOptionalPropertyTypes bool                   `json:"exactOptionalPropertyTypes"`
	Types                      []*checker.RelaterType `json:"types"`
	Queries                    []graphQuery           `json:"queries"`
}
type benchmark struct {
	ElapsedMs float64 `json:"elapsedMs"`
	Rounds    int     `json:"rounds"`
	Checks    int     `json:"checks"`
	Checksum  int     `json:"checksum"`
	Cold      bool    `json:"cold"`
	Arch      string  `json:"arch"`
	GoVersion string  `json:"goVersion"`
}
type output struct {
	Graph     graph     `json:"graph"`
	Benchmark benchmark `json:"benchmark"`
}

func main() {
	if len(os.Args) != 2 {
		panic("usage: tsgo-oracle input.json")
	}
	content, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var in input
	if err := json.Unmarshal(content, &in); err != nil {
		panic(err)
	}
	nullChecks := true
	if in.StrictNullChecks != nil {
		nullChecks = *in.StrictNullChecks
	}
	functionTypes := true
	if in.StrictFunctionTypes != nil {
		functionTypes = *in.StrictFunctionTypes
	}
	config, _ := json.Marshal(map[string]any{"compilerOptions": map[string]any{"strict": true, "strictNullChecks": nullChecks, "strictFunctionTypes": functionTypes, "exactOptionalPropertyTypes": in.ExactOptionalPropertyTypes, "target": "es2025", "noEmit": true, "types": []string{}}, "files": []string{"case.ts"}})
	fs := bundled.WrapFS(vfstest.FromMap(map[string]string{"/case.ts": in.Source, "/tsconfig.json": string(config)}, false))
	host := compiler.NewCompilerHost("/", fs, bundled.LibPath(), nil, nil)
	parsed, errors := tsoptions.GetParsedCommandLineOfConfigFile("/tsconfig.json", &core.CompilerOptions{}, nil, host, nil)
	if len(errors) > 0 {
		panic(fmt.Sprint(errors))
	}
	p := compiler.NewProgram(compiler.ProgramOptions{Config: parsed, Host: host})
	c, done := p.GetTypeChecker(context.Background())
	defer done()
	file := p.GetSourceFile("/case.ts")
	aliases := make(map[string]*checker.Type)
	for _, n := range file.Statements.Nodes {
		if n.Name() != nil {
			sym := c.GetSymbolAtLocation(n.Name())
			if sym != nil {
				aliases[n.Name().Text()] = c.GetDeclaredTypeOfSymbol(sym)
			}
		}
	}
	exporter := checker.RelaterNewExporter(c)
	g := graph{Schema: "relater.type-graph.v11", Revision: "2bd066d87f5bafd315be9f40889d0a60b9e58e0b", StrictNullChecks: nullChecks, StrictFunctionTypes: functionTypes, ExactOptionalPropertyTypes: in.ExactOptionalPropertyTypes, Queries: []graphQuery{}}
	sources := make([]*checker.Type, len(in.Queries))
	targets := make([]*checker.Type, len(in.Queries))
	for i, q := range in.Queries {
		s, t := aliases[q.Source], aliases[q.Target]
		if s == nil || t == nil {
			panic("unknown type alias in query: " + q.Source + " -> " + q.Target)
		}
		sources[i] = s
		targets[i] = t
		g.Queries = append(g.Queries, graphQuery{Source: exporter.Add(s), Target: exporter.Add(t), Expected: c.IsTypeAssignableTo(s, t), Label: q.Source + " -> " + q.Target})
	}
	exporter.AddRuntimeDeclarations()
	g.Types = exporter.Types
	rounds := in.Rounds
	if rounds <= 0 {
		rounds = 1
	}
	checker.RelaterResetRelations(c)
	// One unmeasured warm-up keeps first-time lazy resolution out of both lanes.
	for i := range sources {
		c.IsTypeAssignableTo(sources[i], targets[i])
	}
	checksum := 0
	start := time.Now()
	for round := 0; round < rounds; round++ {
		if in.Cold {
			checker.RelaterResetRelations(c)
		}
		for i := range sources {
			if c.IsTypeAssignableTo(sources[i], targets[i]) {
				checksum++
			}
		}
	}
	elapsed := time.Since(start).Seconds() * 1000
	result := output{Graph: g, Benchmark: benchmark{ElapsedMs: elapsed, Rounds: rounds, Checks: rounds * len(sources), Checksum: checksum, Cold: in.Cold, Arch: runtime.GOARCH, GoVersion: runtime.Version()}}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		panic(err)
	}
}
