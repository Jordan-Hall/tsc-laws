package checkhost

import (
	"context"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/tsoptions"
)

// Project is a tsconfig.json and the program it describes.
type Project struct {
	Config  *tsoptions.ParsedCommandLine
	Program *compiler.Program
	Checker *checker.Checker
}

// OpenProject parses the config file through host and creates its program.
func OpenProject(host *Host, configFileName string) *Project {
	compilerHost := compiler.NewCompilerHost(host.Cwd, &hostFS{host: host}, host.LibPath, nil, nil)
	config, errors := tsoptions.GetParsedCommandLineOfConfigFile(configFileName, nil, nil, compilerHost, nil)
	if config == nil {
		config = &tsoptions.ParsedCommandLine{}
	}
	if len(errors) > 0 {
		config.Errors = append(config.Errors, errors...)
	}
	program := compiler.NewProgram(compiler.ProgramOptions{Config: config, Host: compilerHost, SingleThreaded: core.TSTrue})
	c, _ := program.GetTypeChecker(context.Background())
	return &Project{Config: config, Program: program, Checker: c}
}

// Diagnostics returns the program's diagnostics of one kind ("config",
// "program", "global", "syntactic", "semantic"), for file or all files.
func (p *Project) Diagnostics(kind string, file *ast.SourceFile) []*ast.Diagnostic {
	ctx := context.Background()
	switch kind {
	case "config":
		return p.Program.GetConfigFileParsingDiagnostics()
	case "program":
		return p.Program.GetProgramDiagnostics()
	case "global":
		return p.Program.GetGlobalDiagnostics(ctx)
	case "syntactic":
		return p.Program.GetSyntacticDiagnostics(ctx, file)
	case "semantic":
		return p.Program.GetSemanticDiagnostics(ctx, file)
	}
	return nil
}
