package main

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"sort"
	"strings"
)

// Generic code that creates zero values of a type parameter receives a zero
// factory for it: a constructor argument for generic classes, a leading
// parameter for generic functions.

// overrides replaces Go types with hand-written runtime classes. The value
// lists the type parameters whose zero factory the class constructor takes.
var overrides = map[string][]int{
	"core.Arena":                   {0},
	"core.LinkStore":               {1},
	"checker.nodeLinkStore":        {0},
	"checker.symbolArenaLinkStore": {0},
}

func overrideKey(obj types.Object) string {
	if obj.Pkg() == nil {
		return ""
	}
	return strings.TrimPrefix(obj.Pkg().Path(), modulePrefix) + "." + obj.Name()
}

func (t *translator) overridden(tn *types.TypeName) bool {
	_, ok := overrides[overrideKey(tn)]
	return ok
}

// zeroNeeds maps generic type and function objects to the indexes of type
// parameters that need a zero factory.
func (t *translator) analyzeZero() {
	t.zeroNeeds = map[types.Object][]bool{}
	for key, idx := range overrides {
		for _, p := range t.order {
			if strings.TrimPrefix(p.p.PkgPath, modulePrefix)+"."+key[strings.Index(key, ".")+1:] != key {
				continue
			}
			if obj := p.p.Types.Scope().Lookup(key[strings.Index(key, ".")+1:]); obj != nil {
				n := obj.Type().(*types.Named)
				needs := make([]bool, n.TypeParams().Len())
				for _, i := range idx {
					needs[i] = true
				}
				t.zeroNeeds[obj] = needs
			}
		}
	}
	type unit struct {
		obj    types.Object // generic type name or function
		params *types.TypeParamList
		nodes  []ast.Node
		info   *types.Info
	}
	var units []*unit
	byObj := map[types.Object]*unit{}
	for _, p := range t.order {
		info := p.p.TypesInfo
		for _, f := range p.p.Syntax {
			for _, d := range f.Decls {
				switch d := d.(type) {
				case *ast.FuncDecl:
					obj := info.Defs[d.Name].(*types.Func)
					sig := obj.Type().(*types.Signature)
					if d.Recv != nil {
						n, _ := derefNamed(sig.Recv().Type())
						if n == nil || n.TypeParams().Len() == 0 {
							continue
						}
						tn := n.Origin().Obj()
						u := byObj[tn]
						if u == nil {
							u = &unit{obj: tn, params: n.Origin().TypeParams(), info: info}
							byObj[tn] = u
							units = append(units, u)
						}
						u.nodes = append(u.nodes, d)
						continue
					}
					if sig.TypeParams().Len() == 0 {
						continue
					}
					u := &unit{obj: obj, params: sig.TypeParams(), nodes: []ast.Node{d}, info: info}
					byObj[obj] = u
					units = append(units, u)
				case *ast.GenDecl:
					for _, s := range d.Specs {
						ts, ok := s.(*ast.TypeSpec)
						if !ok || ts.TypeParams == nil {
							continue
						}
						tn := info.Defs[ts.Name].(*types.TypeName)
						u := byObj[tn]
						if u == nil {
							u = &unit{obj: tn, params: tn.Type().(*types.Named).TypeParams(), info: info}
							byObj[tn] = u
							units = append(units, u)
						}
						u.nodes = append(u.nodes, ts)
					}
				}
			}
		}
	}
	// paramIndex finds which of the unit's type parameters tp is, mapping
	// method receiver type parameters to the type's own.
	paramIndex := func(u *unit, tp *types.TypeParam) int {
		for i := 0; i < u.params.Len(); i++ {
			if u.params.At(i) == tp || u.params.At(i).Obj().Name() == tp.Obj().Name() && u.params.At(i).Index() == tp.Index() {
				return i
			}
		}
		return -1
	}
	needsZeroOf := func(tt types.Type) []*types.TypeParam {
		// A zero value of tt needs factories for these type parameters.
		var out []*types.TypeParam
		var walk func(types.Type)
		walk = func(tt types.Type) {
			switch x := types.Unalias(tt).(type) {
			case *types.TypeParam:
				out = append(out, x)
			case *types.Named:
				if needs := t.zeroNeeds[x.Origin().Obj()]; needs != nil {
					for i, n := range needs {
						if n && i < x.TypeArgs().Len() {
							walk(x.TypeArgs().At(i))
						}
					}
				}
			case *types.Array:
				walk(x.Elem())
			}
		}
		walk(tt)
		return out
	}
	for changed := true; changed; {
		changed = false
		for _, u := range units {
			needs := t.zeroNeeds[u.obj]
			if needs == nil {
				needs = make([]bool, u.params.Len())
			}
			mark := func(tt types.Type) {
				for _, tp := range needsZeroOf(tt) {
					if i := paramIndex(u, tp); i >= 0 && !needs[i] {
						needs[i] = true
						changed = true
					}
				}
			}
			for _, node := range u.nodes {
				if ts, ok := node.(*ast.TypeSpec); ok {
					if st, ok := u.info.TypeOf(ts.Type).Underlying().(*types.Struct); ok {
						for i := 0; i < st.NumFields(); i++ {
							mark(st.Field(i).Type())
						}
					}
					continue
				}
				fd := node.(*ast.FuncDecl)
				if fd.Type.Results != nil {
					for _, r := range fd.Type.Results.List {
						if len(r.Names) > 0 {
							mark(u.info.TypeOf(r.Type))
						}
					}
				}
				if fd.Body == nil {
					continue
				}
				ast.Inspect(fd.Body, func(n ast.Node) bool {
					switch n := n.(type) {
					case *ast.ValueSpec:
						if len(n.Values) == 0 && n.Type != nil {
							mark(u.info.TypeOf(n.Type))
						}
					case *ast.CallExpr:
						if id, ok := unparen(n.Fun).(*ast.Ident); ok {
							if b, ok := u.info.Uses[id].(*types.Builtin); ok {
								switch b.Name() {
								case "new":
									mark(u.info.TypeOf(n.Args[0]))
								case "make":
									if sl, ok := u.info.TypeOf(n.Args[0]).Underlying().(*types.Slice); ok && len(n.Args) > 1 {
										mark(sl.Elem())
									}
								}
							}
						}
					case *ast.IndexExpr:
						if m, ok := under(u.info.TypeOf(n.X)).(*types.Map); ok {
							mark(m.Elem())
						}
					case *ast.TypeAssertExpr:
						if n.Type != nil {
							mark(u.info.TypeOf(n.Type))
						}
					case *ast.Ident:
						if inst, ok := u.info.Instances[n]; ok {
							obj := u.info.Uses[n]
							if obj == nil {
								break
							}
							key := obj
							if f, ok := obj.(*types.Func); ok {
								key = f.Origin()
							}
							if tn, ok := obj.(*types.TypeName); ok {
								key = tn.Type().(*types.Named).Origin().Obj()
							}
							if needs := t.zeroNeeds[key]; needs != nil {
								for i, nd := range needs {
									if nd && i < inst.TypeArgs.Len() {
										mark(inst.TypeArgs.At(i))
									}
								}
							}
						}
					}
					return true
				})
			}
			if t.zeroNeeds[u.obj] == nil && anyTrue(needs) {
				t.zeroNeeds[u.obj] = needs
				changed = true
			} else if t.zeroNeeds[u.obj] != nil {
				t.zeroNeeds[u.obj] = needs
			}
		}
	}
}

func anyTrue(b []bool) bool {
	for _, x := range b {
		if x {
			return true
		}
	}
	return false
}

// needsFor returns the zero-factory needs of a generic type or function.
func (t *translator) needsFor(obj types.Object) []bool {
	switch o := obj.(type) {
	case *types.Func:
		return t.zeroNeeds[o.Origin()]
	case *types.TypeName:
		if n, ok := o.Type().(*types.Named); ok {
			return t.zeroNeeds[n.Origin().Obj()]
		}
	}
	return t.zeroNeeds[obj]
}

// zscope maps type parameters to the expression holding their zero factory.
type zscope map[*types.TypeParam]string

func (f *file) zeroParamName(tp *types.TypeParam) string {
	return "$z_" + tp.Obj().Name()
}

// factory returns an expression for a zero factory of tt.
func (f *file) factory(tt types.Type) string {
	if tp, ok := types.Unalias(tt).(*types.TypeParam); ok {
		if e, ok := f.zs[tp]; ok {
			return e
		}
		for k, e := range f.zs {
			if k.Obj().Name() == tp.Obj().Name() {
				return e
			}
		}
		return "$rt.unsupported(" + fmt.Sprintf("%q", "zero factory for "+tp.Obj().Name()) + ")"
	}
	z := f.zero(tt)
	text := fmt.Sprintf("(): %s => %s", f.tsType(tt), z)
	if strings.Contains(z, "$z_") || mentionsTypeParam(tt) {
		return text
	}
	return f.hoist(text)
}

// hoist stores a closed factory expression in a module constant.
func (f *file) hoist(text string) string {
	if f.hoisted == nil {
		f.hoisted = map[string]string{}
	}
	if name, ok := f.hoisted[text]; ok {
		return name
	}
	name := fmt.Sprintf("$zf%d", len(f.hoisted))
	f.hoisted[text] = name
	return name
}

func (f *file) hoistedDecls() string {
	var keys []string
	for k := range f.hoisted {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return f.hoisted[keys[i]] < f.hoisted[keys[j]] })
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "const %s = %s;\n", f.hoisted[k], k)
	}
	return b.String()
}

// factoryArgs renders factory arguments for an instantiation of a generic
// type or function.
func (f *file) factoryArgs(obj types.Object, args *types.TypeList) []string {
	needs := f.t.needsFor(obj)
	if needs == nil || args == nil {
		return nil
	}
	var out []string
	for i, n := range needs {
		if n && i < args.Len() {
			out = append(out, f.factory(args.At(i)))
		}
	}
	return out
}

// withScope runs fn with type parameters bound to factory expressions.
func (f *file) withScope(params *types.TypeParamList, needs []bool, expr func(tp *types.TypeParam) string, fn func()) {
	saved := f.zs
	next := zscope{}
	for k, v := range saved {
		next[k] = v
	}
	if params != nil {
		for i := 0; i < params.Len(); i++ {
			if i < len(needs) && needs[i] {
				next[params.At(i)] = expr(params.At(i))
			}
		}
	}
	f.zs = next
	fn()
	f.zs = saved
}

var _ = token.ILLEGAL

func mentionsTypeParam(tt types.Type) bool {
	found := false
	var walk func(types.Type, int)
	walk = func(tt types.Type, depth int) {
		if found || depth > 8 {
			return
		}
		switch x := types.Unalias(tt).(type) {
		case *types.TypeParam:
			found = true
		case *types.Pointer:
			walk(x.Elem(), depth+1)
		case *types.Slice:
			walk(x.Elem(), depth+1)
		case *types.Array:
			walk(x.Elem(), depth+1)
		case *types.Map:
			walk(x.Key(), depth+1)
			walk(x.Elem(), depth+1)
		case *types.Named:
			if args := x.TypeArgs(); args != nil {
				for i := 0; i < args.Len(); i++ {
					walk(args.At(i), depth+1)
				}
			}
		case *types.Signature:
			for i := 0; i < x.Params().Len(); i++ {
				walk(x.Params().At(i).Type(), depth+1)
			}
			for i := 0; i < x.Results().Len(); i++ {
				walk(x.Results().At(i).Type(), depth+1)
			}
		}
	}
	walk(tt, 0)
	return found
}

// hoistFn stores a closure that captures nothing in a module constant.
func (f *file) hoistFn(text string) string {
	if f.hoistedFns == nil {
		f.hoistedFns = map[string]string{}
	}
	if name, ok := f.hoistedFns[text]; ok {
		return name
	}
	name := fmt.Sprintf("$fn%d", len(f.hoistedFns))
	f.hoistedFns[text] = name
	return name
}

func (f *file) hoistedFnDecls() string {
	var keys []string
	for k := range f.hoistedFns {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return f.hoistedFns[keys[i]] < f.hoistedFns[keys[j]] })
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "const %s = %s;\n", f.hoistedFns[k], k)
	}
	return b.String()
}
