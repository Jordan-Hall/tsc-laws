// Command gots translates Go packages from TypeScript-Go into TypeScript that
// scriptc can compile statically.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

const modulePrefix = "github.com/microsoft/typescript-go/internal/"

func main() {
	upstream := flag.String("upstream", "upstream/typescript-go", "TypeScript-Go checkout")
	out := flag.String("out", "src/tsgo", "output directory")
	flag.Parse()
	names := flag.Args()
	if len(names) == 0 {
		fmt.Fprintln(os.Stderr, "usage: gots [-upstream dir] [-out dir] package...")
		os.Exit(2)
	}
	patterns := make([]string, len(names))
	for i, name := range names {
		patterns[i] = modulePrefix + name
	}
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedTypes | packages.NeedSyntax | packages.NeedTypesInfo | packages.NeedImports | packages.NeedDeps,
		Dir:  *upstream,
	}
	loaded, err := packages.Load(cfg, patterns...)
	if err != nil {
		fatal(err)
	}
	if packages.PrintErrors(loaded) > 0 {
		os.Exit(1)
	}
	t := newTranslator()
	for _, p := range loaded {
		t.add(p)
	}
	t.analyze()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fatal(err)
	}
	outputs := t.emitAll()
	for _, p := range t.order {
		file := filepath.Join(*out, p.module+".ts")
		if err := os.WriteFile(file, []byte(outputs[p]), 0o644); err != nil {
			fatal(err)
		}
	}
	t.emitGlobals(*out)
	t.emitRuntime(filepath.Join(filepath.Dir(*out), "go"))
	t.report()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "gots:", err)
	os.Exit(1)
}

// pkg is one translated Go package.
type pkg struct {
	p      *packages.Package
	module string // output module name, e.g. "scanner"
}

type translator struct {
	pkgs    map[*types.Package]*pkg
	order   []*pkg
	fset    *token.FileSet
	info    map[*types.Package]*types.Info
	classes map[*types.TypeName]*class
	ifaces  map[*types.TypeName]*ifaceMap
	// fieldNames renames struct fields that collide with methods in the same hierarchy.
	fieldNames map[*types.Var]string
	// mutable lists struct types whose values can change after construction.
	mutable  map[*types.TypeName]bool
	anon     map[string]*anonStruct
	anonList []*anonStruct
	stubs    []string
	files    map[*types.Package]*file
	stdRefs  map[string]stdRef
	// structAlias maps types declared as `type X Y`, where Y is a struct
	// type, to Y. They share Y's class; their methods are free functions.
	structAlias  map[*types.TypeName]types.Type
	zeroNeeds    map[types.Object][]bool
	localTypes   map[*types.TypeName]string
	localByPkg   map[*types.Package][]*types.TypeName
	localTParams map[*types.TypeName]*types.TypeParamList
	anonIfaces   map[string]*ifaceMap
	named        []*types.TypeName
	methodNames  map[*types.Func]string
	// shadowed marks methods that a subclass redeclares with the same
	// signature; static calls use their class-qualified name.
	shadowed map[*types.Func]bool
	// structTP marks type parameters (by object) whose instantiations are
	// all struct types; *T then means an object reference.
	structTP map[*types.TypeName]bool
	// keyTypes are struct types used, directly or nested, as map keys.
	keyTypes map[*types.TypeName]bool
	// wide marks named 64-bit integer types with constants beyond 2^53;
	// they are translated as bigint.
	wide map[*types.TypeName]bool
	// badMethodNames are method names that equal a type named in the
	// method's own signature; scriptc can reject such classes.
	badMethodNames map[string]bool
	boxes          map[string]types.Type
	// nilSafe marks pointer methods that test their receiver against nil;
	// Go allows calling them on nil pointers.
	nilSafe map[*types.Func]bool
}

func newTranslator() *translator {
	return &translator{
		pkgs:       map[*types.Package]*pkg{},
		info:       map[*types.Package]*types.Info{},
		classes:    map[*types.TypeName]*class{},
		ifaces:     map[*types.TypeName]*ifaceMap{},
		fieldNames: map[*types.Var]string{},
		mutable:    map[*types.TypeName]bool{},
		anon:       map[string]*anonStruct{},
	}
}

func (t *translator) add(p *packages.Package) {
	if _, ok := t.pkgs[p.Types]; ok {
		return
	}
	for _, path := range sortedKeys(p.Imports) {
		imp := p.Imports[path]
		if strings.HasPrefix(imp.PkgPath, modulePrefix) {
			t.add(imp)
		}
	}
	t.fset = p.Fset
	module := strings.ReplaceAll(strings.TrimPrefix(p.PkgPath, modulePrefix), "/", "_")
	tp := &pkg{p: p, module: module}
	t.pkgs[p.Types] = tp
	t.info[p.Types] = p.TypesInfo
	t.order = append(t.order, tp)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (t *translator) translated(p *types.Package) bool {
	_, ok := t.pkgs[p]
	return ok
}

func (t *translator) stub(pos token.Pos, msg string) string {
	where := t.fset.Position(pos)
	rel := where.Filename
	if i := strings.Index(rel, "/internal/"); i >= 0 {
		rel = rel[i+1:]
	}
	t.stubs = append(t.stubs, fmt.Sprintf("%s:%d: %s", rel, where.Line, msg))
	return msg
}

func (t *translator) report() {
	fmt.Fprintf(os.Stderr, "gots: %d packages, %d unsupported constructs\n", len(t.order), len(t.stubs))
	counts := map[string]int{}
	for _, s := range t.stubs {
		msg := s[strings.Index(s, ": ")+2:]
		counts[msg]++
	}
	type kv struct {
		k string
		v int
	}
	var list []kv
	for k, v := range counts {
		list = append(list, kv{k, v})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].v > list[j].v || list[i].v == list[j].v && list[i].k < list[j].k })
	for _, e := range list {
		fmt.Fprintf(os.Stderr, "  %5d  %s\n", e.v, e.k)
	}
	if f := os.Getenv("GOTS_STUBS"); f != "" {
		os.WriteFile(f, []byte(strings.Join(t.stubs, "\n")+"\n"), 0o644)
	}
}

// class describes how a named struct type is emitted.
type class struct {
	name   *types.TypeName
	st     *types.Struct
	base   *types.TypeName // value-embedded struct emitted as the superclass
	baseAt int             // field index of base, or -1
	subs   []*class
	// stubs are interface methods declared on this class so that interface
	// values typed as this class can call them.
	stubs map[string]*types.Func
	// forwards are methods promoted through non-base embedded fields that
	// must exist on the class to satisfy an interface.
	forwards map[string]*types.Selection
}

// ifaceMap describes how an interface type is represented.
type ifaceMap struct {
	// stub is set for interfaces without translated implementers; the
	// interface is emitted as a class declaring its methods.
	stub  bool
	base  *types.TypeName   // common superclass, if any
	union []types.Type      // implementing types otherwise
	boxed []*types.TypeName // named non-struct implementers
}

type anonStruct struct {
	name string
	st   *types.Struct
}

func (t *translator) analyze() {
	var named []*types.TypeName
	t.localTypes = map[*types.TypeName]string{}
	t.localTParams = map[*types.TypeName]*types.TypeParamList{}
	t.localByPkg = map[*types.Package][]*types.TypeName{}
	for _, p := range t.order {
		scope := p.p.Types.Scope()
		for _, n := range scope.Names() {
			if tn, ok := scope.Lookup(n).(*types.TypeName); ok && !tn.IsAlias() {
				named = append(named, tn)
			}
		}
		used := map[string]int{}
		for _, f := range p.p.Syntax {
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Body == nil {
					continue
				}
				ast.Inspect(fd.Body, func(n ast.Node) bool {
					ts, ok := n.(*ast.TypeSpec)
					if !ok {
						return true
					}
					tn, ok := p.p.TypesInfo.Defs[ts.Name].(*types.TypeName)
					if !ok {
						return true
					}
					name := fd.Name.Name + "$" + tn.Name()
					if c := used[name]; c > 0 {
						name = fmt.Sprintf("%s%d", name, c)
					}
					used[fd.Name.Name+"$"+tn.Name()]++
					t.localTypes[tn] = name
					if fobj, ok := p.p.TypesInfo.Defs[fd.Name].(*types.Func); ok {
						sig := fobj.Type().(*types.Signature)
						if sig.TypeParams().Len() > 0 {
							t.localTParams[tn] = sig.TypeParams()
						} else if sig.RecvTypeParams().Len() > 0 {
							t.localTParams[tn] = sig.RecvTypeParams()
						}
					}
					t.localByPkg[p.p.Types] = append(t.localByPkg[p.p.Types], tn)
					if !tn.IsAlias() {
						named = append(named, tn)
					}
					return true
				})
			}
		}
	}
	t.named = named
	t.structAlias = map[*types.TypeName]types.Type{}
	specs := map[*types.TypeName]*ast.TypeSpec{}
	for _, p := range t.order {
		for _, f := range p.p.Syntax {
			for _, d := range f.Decls {
				gd, ok := d.(*ast.GenDecl)
				if !ok {
					continue
				}
				for _, s := range gd.Specs {
					if ts, ok := s.(*ast.TypeSpec); ok {
						if tn, ok := p.p.TypesInfo.Defs[ts.Name].(*types.TypeName); ok {
							specs[tn] = ts
						}
					}
				}
			}
			ast.Inspect(f, func(n ast.Node) bool {
				if ts, ok := n.(*ast.TypeSpec); ok {
					if tn, ok := p.p.TypesInfo.Defs[ts.Name].(*types.TypeName); ok {
						specs[tn] = ts
					}
				}
				return true
			})
		}
	}
	for _, tn := range named {
		st, ok := tn.Type().Underlying().(*types.Struct)
		if !ok {
			continue
		}
		if t.overridden(tn) {
			continue
		}
		if ts := specs[tn]; ts != nil {
			if _, isLit := ts.Type.(*ast.StructType); !isLit {
				t.structAlias[tn] = t.info[tn.Pkg()].TypeOf(ts.Type)
				continue
			}
		}
		t.classes[tn] = &class{name: tn, st: st, baseAt: -1, stubs: map[string]*types.Func{}, forwards: map[string]*types.Selection{}}
	}
	// The superclass is the value-embedded struct with the deepest embedding
	// chain, so that node types extend Node through their richest base.
	depth := map[*types.TypeName]int{}
	var depthOf func(tn *types.TypeName) int
	depthOf = func(tn *types.TypeName) int {
		if d, ok := depth[tn]; ok {
			return d
		}
		depth[tn] = 1
		c := t.classes[tn]
		if c == nil {
			return 1
		}
		best := 0
		for i := 0; i < c.st.NumFields(); i++ {
			f := c.st.Field(i)
			if !f.Embedded() {
				continue
			}
			n, ok := types.Unalias(f.Type()).(*types.Named)
			if !ok || t.classes[n.Origin().Obj()] == nil {
				continue
			}
			if d := depthOf(n.Origin().Obj()); d > best {
				best = d
				c.base, c.baseAt = n.Origin().Obj(), i
			}
		}
		depth[tn] = best + 1
		return best + 1
	}
	for _, tn := range named {
		if t.classes[tn] != nil {
			depthOf(tn)
		}
	}
	for _, c := range t.classes {
		if c.base != nil {
			if b := t.classes[c.base]; b != nil {
				b.subs = append(b.subs, c)
			}
		}
	}
	for _, tn := range named {
		if it, ok := tn.Type().Underlying().(*types.Interface); ok {
			t.mapInterface(tn, it, named)
		}
	}
	t.anonIfaces = map[string]*ifaceMap{}
	for _, p := range t.order {
		for _, f := range p.p.Syntax {
			ast.Inspect(f, func(n ast.Node) bool {
				if it, ok := n.(*ast.InterfaceType); ok {
					if iface, ok := p.p.TypesInfo.TypeOf(it).(*types.Interface); ok && iface.NumMethods() > 0 {
						key := types.TypeString(iface, nil)
						if t.anonIfaces[key] == nil {
							t.anonIfaces[key] = t.mapIface(iface, named)
						}
					}
				}
				return true
			})
		}
	}
	t.findNilSafe()
	t.renameMethods()
	t.renameFields()
	t.findMutable()
	t.analyzeZero()
	t.analyzeStructTP()
	t.analyzeKeyTypes()
	t.analyzeWide()
	wideGlobal = t.wide
	structTPGlobal = t.structTP
	localTParamsGlobal = t.localTParams
}

// chain returns the superclass chain of a class, most derived first.
func (t *translator) chain(tn *types.TypeName) []*types.TypeName {
	var out []*types.TypeName
	for tn != nil {
		out = append(out, tn)
		c := t.classes[tn]
		if c == nil {
			break
		}
		tn = c.base
	}
	return out
}

func (t *translator) mapInterface(tn *types.TypeName, it *types.Interface, named []*types.TypeName) {
	m := t.mapIface(it, named)
	if it.NumMethods() > 0 && m.base == nil && len(m.union) == 0 && len(m.boxed) == 0 {
		if n, ok := tn.Type().(*types.Named); ok && n.TypeParams().Len() == 0 {
			m.stub = true
		}
	}
	t.ifaces[tn] = m
}

func (t *translator) mapIface(it *types.Interface, named []*types.TypeName) *ifaceMap {
	m := &ifaceMap{}
	if it.NumMethods() == 0 {
		return m
	}
	var impls []*types.TypeName
	for _, cand := range named {
		if _, isIface := cand.Type().Underlying().(*types.Interface); isIface {
			continue
		}
		if n, ok := cand.Type().(*types.Named); ok && n.TypeParams().Len() > 0 {
			continue
		}
		if types.Implements(types.NewPointer(cand.Type()), it) || types.Implements(cand.Type(), it) {
			impls = append(impls, cand)
		}
	}
	if len(impls) == 0 {
		return m
	}
	var common []*types.TypeName
	allStruct := true
	first := true
	for _, impl := range impls {
		if _, isAlias := t.structAlias[impl]; isAlias && t.classOf(impl) == nil {
			continue
		}
		if t.classes[impl] == nil {
			allStruct = false
			m.boxed = append(m.boxed, impl)
			continue
		}
		ch := t.chain(impl)
		if first {
			common = ch
			first = false
			continue
		}
		var keep []*types.TypeName
		for _, a := range common {
			for _, b := range ch {
				if a == b {
					keep = append(keep, a)
				}
			}
		}
		common = keep
	}
	if allStruct && len(common) > 0 {
		base := common[0]
		m.base = base
		bc := t.classes[base]
		ms := types.NewMethodSet(types.NewPointer(base.Type()))
		for i := 0; i < it.NumMethods(); i++ {
			fn := it.Method(i)
			sel := ms.Lookup(fn.Pkg(), fn.Name())
			if sel == nil {
				bc.stubs[fn.Name()] = fn
			}
		}
		for _, impl := range impls {
			t.addForwards(impl, it)
		}
		return m
	}
	for _, impl := range impls {
		if _, isAlias := t.structAlias[impl]; isAlias && t.classOf(impl) == nil {
			continue
		}
		if t.classes[impl] != nil {
			m.union = append(m.union, types.NewPointer(impl.Type()))
			t.addForwards(impl, it)
		} else {
			m.union = append(m.union, impl.Type())
		}
	}
	return m
}

// addForwards records interface methods that a class gets only through a
// non-superclass embedded field, so the class needs a forwarding method.
func (t *translator) addForwards(impl *types.TypeName, it *types.Interface) {
	c := t.classes[impl]
	ms := types.NewMethodSet(types.NewPointer(impl.Type()))
	for i := 0; i < it.NumMethods(); i++ {
		fn := it.Method(i)
		sel := ms.Lookup(fn.Pkg(), fn.Name())
		if sel == nil || len(sel.Index()) == 1 {
			continue
		}
		if t.pathCrossesField(impl, sel.Index()) {
			c.forwards[fn.Name()] = sel
		}
	}
}

// pathCrossesField reports whether an embedded selection path leaves the
// superclass chain, i.e. needs a field hop at runtime.
func (t *translator) pathCrossesField(start *types.TypeName, index []int) bool {
	cur := start
	for _, i := range index[:len(index)-1] {
		c := t.classes[cur]
		if c == nil || c.baseAt != i {
			return true
		}
		cur = c.base
	}
	return false
}

// renameFields renames fields whose names collide with a method anywhere in
// the same class hierarchy.
func (t *translator) renameFields() {
	roots := map[*types.TypeName][]*class{}
	for _, c := range t.classes {
		ch := t.chain(c.name)
		root := ch[len(ch)-1]
		roots[root] = append(roots[root], c)
	}
	for _, members := range roots {
		methods := map[string]bool{}
		for _, c := range members {
			n := c.name.Type().(*types.Named)
			for i := 0; i < n.NumMethods(); i++ {
				methods[n.Method(i).Name()] = true
			}
			for name := range c.stubs {
				methods[name] = true
			}
			for name := range c.forwards {
				methods[name] = true
			}
		}
		for _, c := range members {
			for i := 0; i < c.st.NumFields(); i++ {
				f := c.st.Field(i)
				if methods[f.Name()] || f.Name() == "constructor" || f.Name() == "Error" || f.Name() == "String" {
					t.fieldNames[f] = f.Name() + "_"
				}
				if f.Name() == "_" {
					t.fieldNames[f] = fmt.Sprintf("$_%d", i)
				}
				// scriptc can reject a class with a field named like the
				// class of its type (e.g. SpanMap *spanmap.SpanMap).
				if typeNamed(f.Type(), f.Name()) {
					t.fieldNames[f] = f.Name() + "_"
				}
			}
		}
		// A field that shadows a field of a superclass gets its own name;
		// Go keeps both. Superclasses are processed first.
		sort.Slice(members, func(i, j int) bool { return len(t.chain(members[i].name)) < len(t.chain(members[j].name)) })
		for _, c := range members {
			inherited := map[string]bool{}
			for _, anc := range t.chain(c.name)[1:] {
				ac := t.classes[anc]
				if ac == nil {
					continue
				}
				for i := 0; i < ac.st.NumFields(); i++ {
					if i != ac.baseAt {
						inherited[t.fieldName(ac.st.Field(i))] = true
					}
				}
			}
			depth := len(t.chain(c.name))
			for i := 0; i < c.st.NumFields(); i++ {
				if i == c.baseAt {
					continue
				}
				f := c.st.Field(i)
				if inherited[t.fieldName(f)] {
					t.fieldNames[f] = fmt.Sprintf("%s$%d", t.fieldName(f), depth)
				}
			}
		}
	}
}

// findMutable marks struct types whose fields are assigned, incremented or
// addressed after construction. Values of other struct types can be shared
// instead of copied.
func (t *translator) findMutable() {
	mark := func(e ast.Expr, info *types.Info) {
		for {
			switch x := e.(type) {
			case *ast.ParenExpr:
				e = x.X
				continue
			case *ast.SelectorExpr:
				if sel := info.Selections[x]; sel != nil && sel.Kind() == types.FieldVal {
					recv := sel.Recv()
					if p, ok := recv.(*types.Pointer); ok {
						recv = p.Elem()
					}
					if n, ok := recv.(*types.Named); ok {
						t.mutable[n.Origin().Obj()] = true
						// Promoted fields live in embedded structs too.
						for _, tn := range t.embeddedPath(n, sel.Index()) {
							t.mutable[tn] = true
						}
					}
				}
			case *ast.IndexExpr:
				if _, ok := info.TypeOf(x.X).Underlying().(*types.Array); ok {
					e = x.X
					continue
				}
			case *ast.StarExpr:
				if n, ok := info.TypeOf(x).(*types.Named); ok {
					t.mutable[n.Origin().Obj()] = true
				}
			}
			return
		}
	}
	for _, p := range t.order {
		info := p.p.TypesInfo
		for _, f := range p.p.Syntax {
			ast.Inspect(f, func(n ast.Node) bool {
				switch s := n.(type) {
				case *ast.AssignStmt:
					if s.Tok != token.DEFINE {
						for _, l := range s.Lhs {
							mark(l, info)
						}
					}
				case *ast.IncDecStmt:
					mark(s.X, info)
				case *ast.UnaryExpr:
					if s.Op == token.AND {
						if _, isLit := s.X.(*ast.CompositeLit); !isLit {
							mark(s.X, info)
							if n, ok := info.TypeOf(s.X).(*types.Named); ok {
								t.mutable[n.Origin().Obj()] = true
							}
						}
					}
				case *ast.FuncDecl:
					// Pointer receivers can mutate their struct.
					if s.Recv != nil && len(s.Recv.List) == 1 {
						if star, ok := s.Recv.List[0].Type.(*ast.StarExpr); ok {
							if n, ok := derefNamed(info.TypeOf(star.X)); ok {
								t.mutable[n.Origin().Obj()] = true
							}
						}
					}
				}
				return true
			})
		}
	}
}

func derefNamed(tt types.Type) (*types.Named, bool) {
	tt = types.Unalias(tt)
	if p, ok := tt.(*types.Pointer); ok {
		tt = types.Unalias(p.Elem())
	}
	n, ok := tt.(*types.Named)
	return n, ok
}

func (t *translator) embeddedPath(n *types.Named, index []int) []*types.TypeName {
	var out []*types.TypeName
	var cur types.Type = n
	for _, i := range index[:len(index)-1] {
		st, ok := cur.Underlying().(*types.Struct)
		if !ok {
			break
		}
		ft := st.Field(i).Type()
		if p, ok := ft.(*types.Pointer); ok {
			ft = p.Elem()
		}
		if fn, ok := ft.(*types.Named); ok {
			out = append(out, fn.Origin().Obj())
		}
		cur = ft
	}
	return out
}

var reserved = map[string]bool{
	"arguments": true, "await": true, "break": true, "case": true, "catch": true, "class": true, "const": true,
	"continue": true, "debugger": true, "default": true, "delete": true, "do": true, "else": true, "enum": true,
	"eval": true, "export": true, "extends": true, "false": true, "finally": true, "for": true, "function": true,
	"if": true, "implements": true, "import": true, "in": true, "instanceof": true, "interface": true, "let": true,
	"new": true, "null": true, "package": true, "private": true, "protected": true, "public": true, "return": true,
	"static": true, "super": true, "switch": true, "this": true, "throw": true, "true": true, "try": true,
	"typeof": true, "var": true, "void": true, "while": true, "with": true, "yield": true, "undefined": true,
	"constructor": true, "Object": true, "String": true, "Number": true, "Boolean": true, "Array": true,
	"Map": true, "Set": true, "Math": true, "Error": true, "Symbol": true, "JSON": true, "console": true,
	"process": true, "length": true, "name": true, "prototype": true, "as": true, "of": true, "type": true,
	"keyof": true, "never": true, "unknown": true, "any": true, "string": true, "number": true, "boolean": true,
	"object": true, "symbol": true, "bigint": true, "declare": true, "namespace": true, "module": true,
	"abstract": true, "readonly": true, "is": true, "infer": true, "global": true, "async": true, "get": true,
	"set": true, "from": true, "require": true, "accessor": true, "satisfies": true, "out": true, "override": true,
}

func safeName(name string) string {
	if reserved[name] {
		return name + "_"
	}
	if name == "_" {
		return "$_"
	}
	return name
}

// under returns the underlying type, using the core type of a type parameter.
func under(t types.Type) types.Type {
	if tp, ok := t.(*types.TypeParam); ok {
		it, _ := tp.Constraint().Underlying().(*types.Interface)
		if it == nil {
			return t.Underlying()
		}
		var core types.Type
		for i := 0; i < it.NumEmbeddeds(); i++ {
			switch e := it.EmbeddedType(i).(type) {
			case *types.Union:
				for j := 0; j < e.Len(); j++ {
					u := e.Term(j).Type().Underlying()
					if core == nil {
						core = u
					} else if !types.Identical(core, u) {
						if _, isBasic := u.(*types.Basic); isBasic {
							continue
						}
						return t.Underlying()
					}
				}
			default:
				u := e.Underlying()
				if _, ok := u.(*types.Interface); ok {
					continue
				}
				core = u
			}
		}
		if core != nil {
			return core
		}
	}
	return t.Underlying()
}

// classOf returns the class that represents tn, following `type X Y`
// declarations to the struct type's class.
func (t *translator) classOf(tn *types.TypeName) *class {
	for i := 0; i < 8 && tn != nil; i++ {
		if c := t.classes[tn]; c != nil {
			return c
		}
		base, ok := t.structAlias[tn]
		if !ok {
			return nil
		}
		n, ok := types.Unalias(base).(*types.Named)
		if !ok {
			return nil
		}
		tn = n.Origin().Obj()
	}
	return nil
}

func (t *translator) fieldName(v *types.Var) string {
	if n, ok := t.fieldNames[v.Origin()]; ok {
		return n
	}
	return v.Name()
}

// typeName is the TypeScript name of a declared type; local types declared
// inside functions get a unique module-level name.
func (t *translator) typeName(tn *types.TypeName) string {
	if n, ok := t.localTypes[tn]; ok {
		return n
	}
	return tn.Name()
}

// renameMethods renames methods that shadow a superclass method with a
// different signature. Go only promotes embedded methods, but TypeScript
// subclasses would override them.
func (t *translator) renameMethods() {
	t.methodNames = map[*types.Func]string{}
	t.shadowed = map[*types.Func]bool{}
	t.badMethodNames = map[string]bool{}
	for _, tn := range t.named {
		n, ok := tn.Type().(*types.Named)
		if !ok {
			continue
		}
		var methods []*types.Func
		for i := 0; i < n.NumMethods(); i++ {
			methods = append(methods, n.Method(i))
		}
		if it, ok := n.Underlying().(*types.Interface); ok {
			for i := 0; i < it.NumMethods(); i++ {
				methods = append(methods, it.Method(i))
			}
		}
		for _, m := range methods {
			sig := m.Type().(*types.Signature)
			if m.Name() == "Error" || m.Name() == "String" {
				isStringer := sig.Params().Len() == 0 && sig.Results().Len() == 1 && types.Identical(sig.Results().At(0).Type(), types.Typ[types.String])
				if !isStringer {
					t.badMethodNames[m.Name()] = true
				}
			}
			for i := 0; i < sig.Results().Len(); i++ {
				if typeNamed(sig.Results().At(i).Type(), m.Name()) {
					t.badMethodNames[m.Name()] = true
				}
			}
			for i := 0; i < sig.Params().Len(); i++ {
				if typeNamed(sig.Params().At(i).Type(), m.Name()) {
					t.badMethodNames[m.Name()] = true
				}
			}
		}
	}
	sigOf := func(fn *types.Func) *types.Signature {
		s := fn.Type().(*types.Signature)
		return types.NewSignatureType(nil, nil, nil, s.Params(), s.Results(), s.Variadic())
	}
	for _, c := range t.classes {
		n := c.name.Type().(*types.Named)
		for i := 0; i < n.NumMethods(); i++ {
			m := n.Method(i)
			for _, anc := range t.chain(c.name)[1:] {
				ac := t.classes[anc]
				if ac == nil {
					continue
				}
				clash := false
				an := anc.Type().(*types.Named)
				for j := 0; j < an.NumMethods(); j++ {
					am := an.Method(j)
					if am.Name() == m.Name() && !types.Identical(sigOf(am), sigOf(m)) {
						clash = true
					}
				}
				if stub, ok := ac.stubs[m.Name()]; ok && !types.Identical(sigOf(stub), sigOf(m)) {
					clash = true
				}
				if clash {
					t.methodNames[m] = m.Name() + "$" + c.name.Name()
					break
				}
				for j := 0; j < an.NumMethods(); j++ {
					if am := an.Method(j); am.Name() == m.Name() {
						t.shadowed[am] = true
					}
				}
			}
		}
	}
}

func (t *translator) methodName(fn *types.Func) string {
	if n, ok := t.methodNames[fn.Origin()]; ok {
		return n
	}
	if fn.Pkg() == nil || !t.translated(fn.Pkg()) {
		return fn.Name()
	}
	if (fn.Name() == "Error" || fn.Name() == "String") && isStringerSig(fn) {
		return fn.Name()
	}
	return t.methodNameStr(fn.Name())
}

func isStringerSig(fn *types.Func) bool {
	sig := fn.Type().(*types.Signature)
	return sig.Params().Len() == 0 && sig.Results().Len() == 1 && types.Identical(sig.Results().At(0).Type(), types.Typ[types.String])
}

func (t *translator) methodNameStr(name string) string {
	if t.badMethodNames[name] {
		return name + "$m"
	}
	return name
}

// typeNamed reports whether tt, or the element of a pointer or slice tt,
// is a named type called name.
func typeNamed(tt types.Type, name string) bool {
	for i := 0; i < 3; i++ {
		switch x := types.Unalias(tt).(type) {
		case *types.Pointer:
			tt = x.Elem()
			continue
		case *types.Slice:
			tt = x.Elem()
			continue
		case *types.Named:
			return x.Obj().Name() == name
		}
		return false
	}
	return false
}

func (t *translator) findNilSafe() {
	t.nilSafe = map[*types.Func]bool{}
	for _, p := range t.order {
		info := p.p.TypesInfo
		for _, f := range p.p.Syntax {
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Recv == nil || fd.Body == nil || len(fd.Recv.List[0].Names) == 0 {
					continue
				}
				if _, isPtr := fd.Recv.List[0].Type.(*ast.StarExpr); !isPtr {
					continue
				}
				recv, _ := info.Defs[fd.Recv.List[0].Names[0]].(*types.Var)
				obj, _ := info.Defs[fd.Name].(*types.Func)
				if recv == nil || obj == nil {
					continue
				}
				n, _ := derefNamed(recv.Type())
				if n == nil || n.TypeParams().Len() > 0 || t.classes[n.Origin().Obj()] == nil {
					continue
				}
				ast.Inspect(fd.Body, func(node ast.Node) bool {
					be, ok := node.(*ast.BinaryExpr)
					if !ok || (be.Op != token.EQL && be.Op != token.NEQ) {
						return true
					}
					for _, side := range []ast.Expr{be.X, be.Y} {
						if id, ok := side.(*ast.Ident); ok && info.Uses[id] == recv {
							t.nilSafe[obj] = true
						}
					}
					return true
				})
			}
		}
	}
}

// helperKey names a class in its generated helper methods ($copy_, $clone_,
// $equals_, $cast_, $lit_), unique across packages.
func (t *translator) helperKey(tn *types.TypeName) string {
	module := "x"
	if p := t.pkgs[tn.Pkg()]; p != nil {
		module = p.module
	}
	return module + "_" + t.typeName(tn)
}

func (t *translator) analyzeStructTP() {
	// args[tp] collects every type argument bound to tp.
	args := map[*types.TypeName][]types.Type{}
	recvAlias := map[*types.TypeName]*types.TypeName{}
	for _, p := range t.order {
		info := p.p.TypesInfo
		for id, inst := range info.Instances {
			var params *types.TypeParamList
			switch o := info.Uses[id].(type) {
			case *types.Func:
				params = o.Origin().Type().(*types.Signature).TypeParams()
			case *types.TypeName:
				if n, ok := o.Type().(*types.Named); ok {
					params = n.Origin().TypeParams()
				}
			}
			if params == nil {
				continue
			}
			for i := 0; i < params.Len() && i < inst.TypeArgs.Len(); i++ {
				args[params.At(i).Obj()] = append(args[params.At(i).Obj()], inst.TypeArgs.At(i))
			}
		}
		// Method receiver type parameters alias the type's parameters.
		for _, f := range p.p.Syntax {
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Recv == nil {
					continue
				}
				fn, ok := info.Defs[fd.Name].(*types.Func)
				if !ok {
					continue
				}
				sig := fn.Type().(*types.Signature)
				n, _ := derefNamed(sig.Recv().Type())
				if n == nil || sig.RecvTypeParams().Len() == 0 {
					continue
				}
				for i := 0; i < sig.RecvTypeParams().Len() && i < n.Origin().TypeParams().Len(); i++ {
					recvAlias[sig.RecvTypeParams().At(i).Obj()] = n.Origin().TypeParams().At(i).Obj()
				}
			}
		}
	}
	t.structTP = map[*types.TypeName]bool{}
	for tp := range args {
		t.structTP[tp] = true
	}
	// Remove type parameters with a non-struct argument, to a fixed point
	// (an argument that is itself a type parameter inherits its status).
	for changed := true; changed; {
		changed = false
		for tp, list := range args {
			if !t.structTP[tp] {
				continue
			}
			for _, a := range list {
				ok := isStructType(a)
				if p, isTP := types.Unalias(a).(*types.TypeParam); isTP {
					obj := p.Obj()
					if alias, ok2 := recvAlias[obj]; ok2 {
						obj = alias
					}
					ok = t.structTP[obj]
				}
				if !ok {
					t.structTP[tp] = false
					changed = true
					break
				}
			}
		}
	}
	for recv, typ := range recvAlias {
		t.structTP[recv] = t.structTP[typ]
	}
}

func (t *translator) analyzeKeyTypes() {
	t.keyTypes = map[*types.TypeName]bool{}
	var mark func(tt types.Type)
	mark = func(tt types.Type) {
		switch u := types.Unalias(tt).(type) {
		case *types.Named:
			tn := u.Origin().Obj()
			if c := t.classOf(tn); c != nil {
				tn = c.name
			}
			if t.keyTypes[tn] {
				return
			}
			if st, ok := u.Underlying().(*types.Struct); ok {
				t.keyTypes[tn] = true
				for i := 0; i < st.NumFields(); i++ {
					mark(st.Field(i).Type())
				}
				if c := t.classes[tn]; c != nil && c.base != nil {
					mark(c.base.Type())
				}
			} else if a, ok := u.Underlying().(*types.Array); ok {
				mark(a.Elem())
			}
		case *types.Array:
			mark(u.Elem())
		}
	}
	for _, p := range t.order {
		for _, tv := range p.p.TypesInfo.Types {
			if m, ok := tv.Type.Underlying().(*types.Map); ok && isStructKey(m.Key()) {
				mark(m.Key())
			}
		}
		for _, obj := range p.p.TypesInfo.Defs {
			if obj == nil {
				continue
			}
			if m, ok := obj.Type().Underlying().(*types.Map); ok && isStructKey(m.Key()) {
				mark(m.Key())
			}
		}
	}
}

var wideGlobal map[*types.TypeName]bool

func (t *translator) analyzeWide() {
	t.wide = map[*types.TypeName]bool{}
	for _, p := range t.order {
		scope := p.p.Types.Scope()
		for _, n := range scope.Names() {
			c, ok := scope.Lookup(n).(*types.Const)
			if !ok {
				continue
			}
			named, ok := types.Unalias(c.Type()).(*types.Named)
			if !ok {
				continue
			}
			v := constant.ToInt(c.Val())
			big := false
			if u, ok := constant.Uint64Val(v); ok && u > 1<<53 {
				big = true
			}
			if i, ok := constant.Int64Val(v); ok && i < -(1<<53) {
				big = true
			}
			if big {
				t.wide[named.Origin().Obj()] = true
			}
		}
	}
}

// isWide reports whether values of tt are represented as bigint.
func isWide(tt types.Type) bool {
	if tt == nil {
		return false
	}
	n, ok := types.Unalias(tt).(*types.Named)
	return ok && wideGlobal[n.Origin().Obj()]
}
