// Package checkhost is a minimal checker.Program for checking one file
// against the bundled lib files. It is translated with the checker so the Go
// reference and the TypeScript port use the same host.
package checkhost

import (
	"context"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/binder"
	"github.com/microsoft/typescript-go/internal/checker"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/module"
	"github.com/microsoft/typescript-go/internal/packagejson"
	"github.com/microsoft/typescript-go/internal/parser"
	"github.com/microsoft/typescript-go/internal/symlinks"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/tspath"
)

// LibDir is the virtual directory of the bundled lib files.
const LibDir = "/libs/"

// libCache keeps parsed lib files across programs; binding is per file, and
// checkers keep their own state, so programs can share them.
var libCache = map[string]*ast.SourceFile{}

type Program struct {
	options *core.CompilerOptions
	files   []*ast.SourceFile
	byPath  map[tspath.Path]*ast.SourceFile
	libs    map[tspath.Path]bool
}

func parseFile(fileName string, text string) *ast.SourceFile {
	opts := ast.SourceFileParseOptions{FileName: fileName, Path: tspath.Path(fileName)}
	return parser.ParseSourceFile(opts, text, core.GetScriptKindFromFileName(fileName))
}

// NewProgram parses fileName and the lib files it needs. readLib returns the
// text of a bundled lib file by name.
func NewProgram(fileName string, text string, readLib func(name string) (string, bool)) *Program {
	p := &Program{
		options: &core.CompilerOptions{Strict: core.TSTrue, Target: core.ScriptTargetESNext, NoEmit: core.TSTrue},
		byPath:  map[tspath.Path]*ast.SourceFile{},
		libs:    map[tspath.Path]bool{},
	}
	var addLib func(name string)
	addLib = func(name string) {
		path := tspath.Path(LibDir + name)
		if p.byPath[path] != nil {
			return
		}
		file := libCache[name]
		if file == nil {
			libText, ok := readLib(name)
			if !ok {
				return
			}
			file = parseFile(LibDir+name, libText)
			libCache[name] = file
		}
		p.byPath[path] = file
		p.libs[path] = true
		for _, ref := range file.LibReferenceDirectives {
			if libName, ok := tsoptions.GetLibFileName(ref.FileName); ok {
				addLib(libName)
			}
		}
		p.files = append(p.files, file)
	}
	addLib(tsoptions.GetDefaultLibFileName(p.options))
	main := parseFile(fileName, text)
	p.byPath[main.Path()] = main
	p.files = append(p.files, main)
	return p
}

// Check returns the diagnostics of fileName: syntactic, bind, semantic, and
// global diagnostics, in that order.
func Check(fileName string, text string, readLib func(name string) (string, bool)) []*ast.Diagnostic {
	p := NewProgram(fileName, text, readLib)
	p.BindSourceFiles()
	c, _ := checker.NewChecker(p, nil)
	file := p.byPath[tspath.Path(fileName)]
	var diags []*ast.Diagnostic
	diags = append(diags, file.Diagnostics()...)
	diags = append(diags, file.BindDiagnostics()...)
	diags = append(diags, c.GetDiagnostics(context.Background(), file)...)
	diags = append(diags, c.GetGlobalDiagnostics()...)
	return diags
}

func (p *Program) Options() *core.CompilerOptions  { return p.options }
func (p *Program) SourceFiles() []*ast.SourceFile  { return p.files }
func (p *Program) FileExists(fileName string) bool { return p.byPath[tspath.Path(fileName)] != nil }
func (p *Program) GetSourceFile(fileName string) *ast.SourceFile {
	return p.byPath[tspath.Path(fileName)]
}

func (p *Program) GetSourceFileForResolvedModule(fileName string) *ast.SourceFile {
	return p.GetSourceFile(fileName)
}

func (p *Program) BindSourceFiles() {
	for _, file := range p.files {
		if !file.IsBound() {
			binder.BindSourceFile(file)
		}
	}
}

func (p *Program) GetSourceFileMetaData(path tspath.Path) ast.SourceFileMetaData {
	return ast.SourceFileMetaData{}
}

func (p *Program) GetEmitModuleFormatOfFile(sourceFile ast.HasFileName) core.ModuleKind {
	return ast.GetEmitModuleFormatOfFileWorker(sourceFile.FileName(), p.options, p.GetSourceFileMetaData(sourceFile.Path()))
}

func (p *Program) GetEmitSyntaxForUsageLocation(sourceFile ast.HasFileName, location *ast.StringLiteralLike) core.ResolutionMode {
	return core.ResolutionModeESM
}

func (p *Program) GetImpliedNodeFormatForEmit(sourceFile ast.HasFileName) core.ModuleKind {
	return ast.GetImpliedNodeFormatForEmitWorker(sourceFile.FileName(), p.options.GetEmitModuleKind(), p.GetSourceFileMetaData(sourceFile.Path()))
}

func (p *Program) GetResolvedModule(currentSourceFile ast.HasFileName, moduleReference string, mode core.ResolutionMode) *module.ResolvedModule {
	return nil
}

func (p *Program) GetResolvedModules() map[tspath.Path]module.ModeAwareCache[*module.ResolvedModule] {
	return nil
}

func (p *Program) GetPackagesMap() map[string]bool { return nil }

func (p *Program) GetJSXRuntimeImportSpecifier(path tspath.Path) (moduleReference string, specifier *ast.Node) {
	return "", nil
}

func (p *Program) GetImportHelpersImportSpecifier(path tspath.Path) *ast.Node { return nil }

func (p *Program) SourceFileMayBeEmitted(sourceFile *ast.SourceFile, forceDtsEmit bool) bool {
	return !p.libs[sourceFile.Path()]
}

func (p *Program) IsSourceFileDefaultLibrary(path tspath.Path) bool { return p.libs[path] }

func (p *Program) GetProjectReferenceFromOutputDts(path tspath.Path) *tsoptions.SourceOutputAndProjectReference {
	return nil
}

func (p *Program) GetRedirectForResolution(file ast.HasFileName) *tsoptions.ParsedCommandLine {
	return nil
}

func (p *Program) CommonSourceDirectory() string { return "/" }

// Host methods.

func (p *Program) GetSymlinkCache() *symlinks.KnownSymlinks { return nil }
func (p *Program) ContentMapperExtensions() []string        { return nil }
func (p *Program) GetGlobalTypingsCacheLocation() string    { return "" }
func (p *Program) UseCaseSensitiveFileNames() bool          { return true }
func (p *Program) GetCurrentDirectory() string              { return "/" }

func (p *Program) GetProjectReferenceFromSource(path tspath.Path) *tsoptions.SourceOutputAndProjectReference {
	return nil
}

func (p *Program) GetRedirectTargets(path tspath.Path) []string { return nil }

func (p *Program) GetSourceOfProjectReferenceIfOutputIncluded(file ast.HasFileName) string {
	return ""
}

func (p *Program) GetNearestAncestorDirectoryWithPackageJson(dirname string) string { return "" }

func (p *Program) GetPackageJsonInfo(pkgJsonPath string) *packagejson.InfoCacheEntry { return nil }

func (p *Program) GetDefaultResolutionModeForFile(file ast.HasFileName) core.ResolutionMode {
	return core.ResolutionModeESM
}

func (p *Program) GetResolvedModuleFromModuleSpecifier(file ast.HasFileName, moduleSpecifier *ast.StringLiteralLike) *module.ResolvedModule {
	return nil
}

func (p *Program) GetModeForUsageLocation(file ast.HasFileName, moduleSpecifier *ast.StringLiteralLike) core.ResolutionMode {
	return core.ResolutionModeESM
}

var _ checker.Program = (*Program)(nil)
