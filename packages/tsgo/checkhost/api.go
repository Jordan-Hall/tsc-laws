package checkhost

import (
	"context"
	"errors"
	"time"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/collections"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/jsnum"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs"
)

// APIHost is the file system of an API session, provided by the caller.
type APIHost struct {
	Cwd                  string
	LibPath              string
	UseCaseSensitive     bool
	ReadFile             func(path string) (string, bool)
	FileExists           func(path string) bool
	DirectoryExists      func(path string) bool
	GetAccessibleEntries func(path string) (files []string, dirs []string)
	Realpath             func(path string) string
	// Stat returns 1 for a file, 2 for a directory, 0 if path doesn't exist,
	// with the size and modification time in milliseconds.
	Stat func(path string) (kind int, size int, mtime float64)
}

// APIProject is a configured project opened by an API session. Its checker
// answers queries; diagnostics use the program's own checker, as in tsgo.
type APIProject struct {
	Config  *tsoptions.ParsedCommandLine
	Program *compiler.Program
	Checker *checker.Checker
}

// OpenAPIProject parses the config file through host and creates its program.
func OpenAPIProject(host *APIHost, configFileName string) *APIProject {
	compilerHost := compiler.NewCompilerHost(host.Cwd, &apiFS{host: host}, host.LibPath, nil, nil)
	config, errs := tsoptions.GetParsedCommandLineOfConfigFile(configFileName, nil, nil, compilerHost, nil)
	if config == nil {
		config = &tsoptions.ParsedCommandLine{}
	}
	if len(errs) > 0 {
		config.Errors = append(config.Errors, errs...)
	}
	return newAPIProject(config, compilerHost)
}

// OpenInferredAPIProject creates the program for open files that no config
// file contains, with tsgo's default inferred project options.
func OpenInferredAPIProject(host *APIHost, rootFileNames []string) *APIProject {
	compilerHost := compiler.NewCompilerHost(host.Cwd, &apiFS{host: host}, host.LibPath, nil, nil)
	options := &core.CompilerOptions{
		AllowJs:                    core.TSTrue,
		Module:                     core.ModuleKindESNext,
		ModuleResolution:           core.ModuleResolutionKindBundler,
		Target:                     core.ScriptTargetLatestStandard,
		Jsx:                        core.JsxEmitReactJSX,
		AllowImportingTsExtensions: core.TSTrue,
		StrictNullChecks:           core.TSTrue,
		StrictFunctionTypes:        core.TSTrue,
		SourceMap:                  core.TSTrue,
		AllowNonTsExtensions:       core.TSTrue,
		ResolveJsonModule:          core.TSTrue,
	}
	config := tsoptions.NewParsedCommandLine(options, rootFileNames, tspath.ComparePathsOptions{
		UseCaseSensitiveFileNames: host.UseCaseSensitive,
		CurrentDirectory:          host.Cwd,
	})
	return newAPIProject(config, compilerHost)
}

func newAPIProject(config *tsoptions.ParsedCommandLine, compilerHost compiler.CompilerHost) *APIProject {
	program := compiler.NewProgram(compiler.ProgramOptions{
		Config:                      config,
		Host:                        compilerHost,
		UseSourceOfProjectReference: true,
		SingleThreaded:              core.TSTrue,
	})
	program.BindSourceFiles()
	c, _ := checker.NewChecker(program, nil)
	return &APIProject{Config: config, Program: program, Checker: c}
}

// Diagnostics returns the program's diagnostics of one kind ("config",
// "program", "global", "syntactic", "bind", "semantic", "suggestion",
// "declaration"), for file or all files.
func (p *APIProject) Diagnostics(kind string, file *ast.SourceFile) []*ast.Diagnostic {
	ctx := context.Background()
	switch kind {
	case "config":
		return p.Program.GetConfigFileParsingDiagnostics()
	case "program":
		return p.Program.GetProgramDiagnostics()
	case "global":
		p.Program.GetSemanticDiagnostics(ctx, nil)
		all := compiler.SortAndDeduplicateDiagnostics(append(append(append([]*ast.Diagnostic{},
			p.Program.GetConfigFileParsingDiagnostics()...),
			p.Program.GetProgramDiagnostics()...),
			p.Program.GetGlobalDiagnostics(ctx)...))
		return core.Filter(all, func(d *ast.Diagnostic) bool { return d.File() == nil })
	case "syntactic":
		return p.Program.GetSyntacticDiagnostics(ctx, file)
	case "bind":
		return p.Program.GetBindDiagnostics(ctx, file)
	case "semantic":
		return p.Program.GetSemanticDiagnostics(ctx, file)
	case "suggestion":
		return p.Program.GetSuggestionDiagnostics(ctx, file)
	case "declaration":
		return p.Program.GetDeclarationDiagnostics(ctx, file)
	}
	return nil
}

// ParseAPIConfigFile parses a config file without creating a program. It
// returns nil if the file can't be read.
func ParseAPIConfigFile(host *APIHost, configFileName string) *tsoptions.ParsedCommandLine {
	fs := &apiFS{host: host}
	text, ok := fs.ReadFile(configFileName)
	if !ok {
		return nil
	}
	compilerHost := compiler.NewCompilerHost(host.Cwd, fs, host.LibPath, nil, nil)
	path := tspath.ToPath(configFileName, host.Cwd, host.UseCaseSensitive)
	sourceFile := tsoptions.NewTsconfigSourceFileFromFilePath(configFileName, path, text)
	return tsoptions.ParseJsonSourceFileConfigFileContent(sourceFile, compilerHost, tspath.GetDirectoryPath(configFileName), nil, nil, configFileName, nil, nil, nil)
}

// RawCompilerOption reports whether a config file sets a compiler option
// itself. It tells an empty list option apart from an unset one.
func RawCompilerOption(config *tsoptions.ParsedCommandLine, name string) bool {
	raw, ok := config.Raw.(*collections.OrderedMap[string, any])
	if !ok {
		return false
	}
	options, ok := raw.Get("compilerOptions")
	if !ok {
		return false
	}
	m, ok := options.(*collections.OrderedMap[string, any])
	return ok && m.Has(name)
}

// LiteralValue is the value of a literal type or enum member: Kind is 0 for
// none, 1 for a string, 2 for a number, 3 for a boolean and 4 for a bigint
// (as decimal text).
type LiteralValue struct {
	Kind   int
	Text   string
	Number float64
	Bool   bool
}

func literalValueOf(value any) LiteralValue {
	switch v := value.(type) {
	case string:
		return LiteralValue{Kind: 1, Text: v}
	case jsnum.Number:
		return LiteralValue{Kind: 2, Number: float64(v)}
	case bool:
		return LiteralValue{Kind: 3, Bool: v}
	case jsnum.PseudoBigInt:
		return LiteralValue{Kind: 4, Text: v.String()}
	}
	return LiteralValue{}
}

// LiteralTypeValue returns the value of a literal type.
func LiteralTypeValue(t *checker.Type) LiteralValue {
	return literalValueOf(t.AsLiteralType().Value())
}

// ConstantValue returns the constant value of an enum member or property
// access.
func ConstantValue(c *checker.Checker, node *ast.Node) LiteralValue {
	return literalValueOf(c.GetConstantValue(node))
}

type apiFS struct{ host *APIHost }

func (f *apiFS) UseCaseSensitiveFileNames() bool     { return f.host.UseCaseSensitive }
func (f *apiFS) FileExists(path string) bool         { return f.host.FileExists(path) }
func (f *apiFS) DirectoryExists(path string) bool    { return f.host.DirectoryExists(path) }
func (f *apiFS) ReadFile(path string) (string, bool) { return f.host.ReadFile(path) }
func (f *apiFS) Realpath(path string) string         { return f.host.Realpath(path) }
func (f *apiFS) WriteFile(path string, data string) error {
	return errors.New("writing files is not supported")
}
func (f *apiFS) AppendFile(path string, data string) error {
	return errors.New("writing files is not supported")
}
func (f *apiFS) Remove(path string) error                            { return errors.New("removing files is not supported") }
func (f *apiFS) Chtimes(path string, a time.Time, m time.Time) error { return nil }

func (f *apiFS) GetAccessibleEntries(path string) vfs.Entries {
	files, dirs := f.host.GetAccessibleEntries(path)
	return vfs.Entries{Files: files, Directories: dirs}
}

func (f *apiFS) Stat(path string) vfs.FileInfo {
	kind, size, mtime := f.host.Stat(path)
	if kind == 0 {
		return nil
	}
	return &hostFileInfo{name: tspath.GetBaseFileName(path), dir: kind == 2, size: size, mtime: mtime}
}

func (f *apiFS) WalkDir(root string, walkFn vfs.WalkDirFunc) error {
	return errors.New("walking directories is not supported")
}
