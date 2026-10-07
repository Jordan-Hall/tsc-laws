package main

import (
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"sort"
	"strconv"
	"strings"
)

// file collects one output module.
type file struct {
	t          *translator
	p          *pkg
	imports    map[string]bool
	lits       map[*types.TypeName]map[string][]int
	methods    map[*types.TypeName][]string
	defined    map[*types.TypeName]map[string]bool
	anonOrder  []*anonStruct
	parts      struct{ types, consts, vars, funcs, inits string }
	zs         zscope
	hoisted    map[string]string
	hoistedFns map[string]string
	typeOnly   map[string]bool
	inType     int
	// runtime is set while generating runtime stubs, which must not refer
	// to translated modules.
	runtime bool
}

// emitAll translates every package. Function bodies are translated first so
// that composite literals can register factories on classes in any package.
func (t *translator) emitAll() map[*pkg]string {
	t.files = map[*types.Package]*file{}
	for _, p := range t.order {
		t.files[p.p.Types] = &file{t: t, p: p, imports: map[string]bool{}, typeOnly: map[string]bool{}, lits: map[*types.TypeName]map[string][]int{},
			methods: map[*types.TypeName][]string{}, defined: map[*types.TypeName]map[string]bool{}}
	}
	for _, p := range t.order {
		t.files[p.p.Types].translate()
	}
	out := map[*pkg]string{}
	for _, p := range t.order {
		out[p] = t.files[p.p.Types].assemble()
	}
	return out
}

func (t *translator) globalLits(p *types.Package) *file { return t.files[p] }

func (f *file) translate() {
	info := f.p.p.TypesInfo
	scope := f.p.p.Types.Scope()
	var w strings.Builder
	for _, n := range scope.Names() {
		if tn, ok := scope.Lookup(n).(*types.TypeName); ok && f.t.classes[tn] == nil {
			w.WriteString(f.typeDecl(tn))
		}
	}
	for _, tn := range f.t.localByPkg[f.p.p.Types] {
		if f.t.classes[tn] == nil {
			w.WriteString(f.typeDecl(tn))
		}
	}
	f.parts.types = w.String()
	w.Reset()
	for _, n := range scope.Names() {
		if c, ok := scope.Lookup(n).(*types.Const); ok {
			fmt.Fprintf(&w, "export const %s: %s = %s;\n", safeName(c.Name()), f.tsType(c.Type()), f.constValue(c.Val(), c.Type()))
		}
	}
	f.parts.consts = w.String()
	w.Reset()
	initialized := map[*types.Var]bool{}
	for _, init := range info.InitOrder {
		for _, v := range init.Lhs {
			initialized[v] = true
		}
		fx := newFunc(f, nil)
		if len(init.Lhs) == 1 && init.Lhs[0].Name() == "_" {
			continue
		}
		if len(init.Lhs) == 1 {
			v := init.Lhs[0]
			val := fx.valueExpr(init.Rhs, v.Type())
			w.WriteString(fx.prelude())
			fmt.Fprintf(&w, "export let %s: %s = %s;\n", safeName(v.Name()), f.tsType(v.Type()), val)
		} else {
			tmp := fx.tmp()
			val := fx.expr(init.Rhs)
			w.WriteString(fx.prelude())
			fmt.Fprintf(&w, "const %s = %s;\n", tmp, val)
			for i, v := range init.Lhs {
				if v.Name() == "_" {
					continue
				}
				fmt.Fprintf(&w, "export let %s: %s = %s[%d];\n", safeName(v.Name()), f.tsType(v.Type()), tmp, i)
			}
		}
	}
	for _, n := range scope.Names() {
		if v, ok := scope.Lookup(n).(*types.Var); ok && !initialized[v] && v.Name() != "_" {
			fmt.Fprintf(&w, "export let %s: %s = %s;\n", safeName(v.Name()), f.tsType(v.Type()), f.zero(v.Type()))
		}
	}
	f.parts.vars = w.String()
	w.Reset()
	var inits strings.Builder
	nInit := 0
	for _, file := range f.p.p.Syntax {
		for _, d := range file.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok {
				continue
			}
			if fd.Recv != nil {
				n, _ := derefNamed(info.TypeOf(fd.Recv.List[0].Type))
				if n == nil {
					continue
				}
				tn := n.Origin().Obj()
				if f.t.overridden(tn) {
					continue
				}
				if f.t.classes[tn] != nil {
					f.methods[tn] = append(f.methods[tn], f.methodDecl(fd))
					if f.defined[tn] == nil {
						f.defined[tn] = map[string]bool{}
					}
					f.defined[tn][fd.Name.Name] = true
				} else {
					w.WriteString(f.funcDecl(fd))
				}
				continue
			}
			if fd.Name.Name == "_" {
				continue
			}
			if fd.Name.Name == "init" {
				name := fmt.Sprintf("$init%d", nInit)
				nInit++
				fd2 := *fd
				fd2.Name = ast.NewIdent(name)
				f.p.p.TypesInfo.Defs[fd2.Name] = types.NewFunc(fd.Pos(), f.p.p.Types, name, info.Defs[fd.Name].Type().(*types.Signature))
				w.WriteString(f.funcDecl(&fd2))
				fmt.Fprintf(&inits, "%s();\n", name)
				continue
			}
			w.WriteString(f.funcDecl(fd))
		}
	}
	f.parts.funcs = w.String()
	f.parts.inits = inits.String()
}

func (f *file) assemble() string {
	scope := f.p.p.Types.Scope()
	var structs []*types.TypeName
	for _, n := range scope.Names() {
		if tn, ok := scope.Lookup(n).(*types.TypeName); ok && f.t.classes[tn] != nil {
			structs = append(structs, tn)
		}
	}
	for _, tn := range f.t.localByPkg[f.p.p.Types] {
		if f.t.classes[tn] != nil {
			structs = append(structs, tn)
		}
	}
	emitted := map[*types.TypeName]bool{}
	var classes strings.Builder
	var emitClass func(tn *types.TypeName)
	emitClass = func(tn *types.TypeName) {
		if emitted[tn] {
			return
		}
		emitted[tn] = true
		if c := f.t.classes[tn]; c.base != nil && c.base.Pkg() == tn.Pkg() {
			emitClass(c.base)
		}
		classes.WriteString(f.classDecl(tn))
	}
	for _, tn := range structs {
		emitClass(tn)
	}
	classText := classes.String()
	body := f.anonDecls() + f.hoistedDecls() + f.parts.types + classText + f.parts.consts + f.hoistedFnDecls() + f.parts.vars + f.parts.funcs + f.parts.inits
	var head strings.Builder
	head.WriteString("// Generated by tools/gots from TypeScript-Go internal/" + strings.TrimPrefix(f.p.p.PkgPath, modulePrefix) + ". Do not edit.\n")
	head.WriteString("// Copyright Microsoft Corporation. Licensed under Apache-2.0.\n")
	head.WriteString("import * as $rt from '../go/runtime.js';\n")
	for _, m := range sortedKeys(f.imports) {
		fmt.Fprintf(&head, "import * as $%s from './%s.js';\n", m, m)
	}
	for _, m := range sortedKeys(f.typeOnly) {
		if !f.imports[m] {
			fmt.Fprintf(&head, "import type * as $%s from './%s.js';\n", m, m)
		}
	}
	return head.String() + body
}

func (f *file) anonDecls() string {
	var w strings.Builder
	for i := 0; i < len(f.anonOrder); i++ {
		a := f.anonOrder[i]
		var fields, params, sets, copies []string
		for j := 0; j < a.st.NumFields(); j++ {
			fl := a.st.Field(j)
			typ := f.tsType(fl.Type())
			fields = append(fields, fmt.Sprintf("  %s: %s;\n", fl.Name(), typ))
			params = append(params, fmt.Sprintf("p%d: %s = %s", j, typ, f.zero(fl.Type())))
			sets = append(sets, fmt.Sprintf("this.%s = p%d;", fl.Name(), j))
			copies = append(copies, f.copyValue("this."+fl.Name(), fl.Type()))
		}
		fmt.Fprintf(&w, "export class %s extends $rt.GoObject {\n%s", a.name, strings.Join(fields, ""))
		fmt.Fprintf(&w, "  constructor(%s) { super(); %s }\n", strings.Join(params, ", "), strings.Join(sets, " "))
		fmt.Fprintf(&w, "  $clone(): %s { return new %s(%s); }\n}\n", a.name, a.name, strings.Join(copies, ", "))
	}
	return w.String()
}

func (f *file) typeDecl(tn *types.TypeName) string {
	if f.t.overridden(tn) {
		return ""
	}
	tp := f.typeParams(tn)
	if tn.IsAlias() {
		return fmt.Sprintf("export type %s%s = %s;\n", f.declName(tn), tp, f.tsType(types.Unalias(tn.Type())))
	}
	n := tn.Type().(*types.Named)
	if it, ok := n.Underlying().(*types.Interface); ok {
		return f.ifaceDecl(tn, it)
	}
	if base := f.t.structAlias[tn]; base != nil {
		return fmt.Sprintf("export type %s%s = %s;\n", f.declName(tn), tp, f.tsType(base))
	}
	s := fmt.Sprintf("export type %s%s = %s;\n", f.declName(tn), tp, f.tsType(n.Underlying()))
	if f.boxedBy(tn) {
		s += f.boxDecl(tn)
	}
	return s
}

func (f *file) typeParams(tn *types.TypeName) string {
	if list := f.t.localTParams[tn]; list != nil {
		return f.tparamList(list)
	}
	n, ok := tn.Type().(*types.Named)
	if !ok {
		if a, ok := tn.Type().(*types.Alias); ok && a.TypeParams().Len() > 0 {
			return f.tparamList(a.TypeParams())
		}
		return ""
	}
	return f.tparamList(n.TypeParams())
}

func (f *file) tparamList(list *types.TypeParamList) string {
	if list == nil || list.Len() == 0 {
		return ""
	}
	parts := make([]string, list.Len())
	for i := 0; i < list.Len(); i++ {
		tp := list.At(i)
		parts[i] = tp.Obj().Name() + f.constraint(tp)
	}
	return "<" + strings.Join(parts, ", ") + ">"
}

func (f *file) constraint(tp *types.TypeParam) string {
	it, ok := tp.Constraint().Underlying().(*types.Interface)
	if !ok {
		return ""
	}
	if f.t.structTP[tp.Obj()] && it.NumMethods() == 0 && it.NumEmbeddeds() == 0 {
		return " extends $rt.GoObject"
	}
	if it.NumMethods() > 0 {
		if n, ok := tp.Constraint().(*types.Named); ok {
			return " extends " + f.tsType(n)
		}
		return ""
	}
	// Slice and map type sets.
	switch core := under(tp).(type) {
	case *types.Slice:
		return " extends " + f.arrayOf(core.Elem())
	case *types.Map:
		return " extends " + f.tsType(core)
	}
	// Type sets: constrain to number or string when every term agrees.
	kind := ""
	for i := 0; i < it.NumEmbeddeds(); i++ {
		u, ok := it.EmbeddedType(i).(*types.Union)
		if !ok {
			if b, ok := it.EmbeddedType(i).Underlying().(*types.Basic); ok {
				k := basicKind(b)
				if kind == "" || kind == k {
					kind = k
					continue
				}
			}
			return ""
		}
		for j := 0; j < u.Len(); j++ {
			b, ok := u.Term(j).Type().Underlying().(*types.Basic)
			if !ok {
				return ""
			}
			k := basicKind(b)
			if kind != "" && kind != k {
				return ""
			}
			kind = k
		}
	}
	if kind != "" {
		return " extends " + kind
	}
	return ""
}

func basicKind(b *types.Basic) string {
	switch {
	case b.Info()&types.IsString != 0:
		return "string"
	case b.Info()&types.IsBoolean != 0:
		return "boolean"
	default:
		return "number"
	}
}

func (t *translator) boxedByAny(tn *types.TypeName) bool {
	for _, m := range t.ifaces {
		for _, b := range m.boxed {
			if b == tn {
				return true
			}
		}
	}
	return false
}

func (f *file) boxedBy(tn *types.TypeName) bool { return f.t.boxedByAny(tn) }

// boxDecl emits a class that carries a named non-struct value inside an
// interface, so type switches and method calls can recognize it.
func (f *file) boxDecl(tn *types.TypeName) string {
	var w strings.Builder
	n := tn.Type().(*types.Named)
	name := f.declName(tn)
	fmt.Fprintf(&w, "export class %s$Box extends $rt.GoObject {\n  v: %s;\n  constructor(v: %s) { super(); this.v = v; }\n", name, name, name)
	fmt.Fprintf(&w, "  static $cast(v: $rt.GoObject | undefined): %s$Box { if (v instanceof %s$Box) return v; throw $rt.typeAssertError(); }\n", name, name)
	for i := 0; i < n.NumMethods(); i++ {
		m := n.Method(i)
		sig := m.Type().(*types.Signature)
		if _, isPtr := sig.Recv().Type().(*types.Pointer); isPtr {
			continue
		}
		params, args := f.sigParams(sig)
		fmt.Fprintf(&w, "  %s(%s): %s { return %s$%s(this.v%s); }\n", f.t.methodName(m), params, f.results(sig), f.t.typeName(tn), m.Name(), prefixComma(args))
	}
	w.WriteString("}\n")
	return w.String()
}

func prefixComma(s string) string {
	if s == "" {
		return ""
	}
	return ", " + s
}

func (f *file) sigParams(sig *types.Signature) (string, string) {
	var params, args []string
	for i := 0; i < sig.Params().Len(); i++ {
		p := sig.Params().At(i)
		name := fmt.Sprintf("a%d", i)
		params = append(params, name+": "+f.tsType(p.Type()))
		args = append(args, name)
	}
	return strings.Join(params, ", "), strings.Join(args, ", ")
}

func (f *file) ifaceDecl(tn *types.TypeName, it *types.Interface) string {
	tp := f.typeParams(tn)
	m := f.t.ifaces[tn]
	if m != nil && m.stub {
		var w strings.Builder
		name := f.declName(tn)
		fmt.Fprintf(&w, "export class %s extends $rt.GoObject {\n", name)
		for i := 0; i < it.NumMethods(); i++ {
			fn := it.Method(i)
			sig := fn.Type().(*types.Signature)
			params, _ := f.sigParams(sig)
			override := ""
			if fn.Name() == "Error" || fn.Name() == "String" {
				override = "override "
			}
			fmt.Fprintf(&w, "  %s%s(%s): %s { throw $rt.unimplementedMethod(%q); }\n", override, f.t.methodNameStr(fn.Name()), params, f.results(sig), fn.Name())
		}
		fmt.Fprintf(&w, "  static $cast_%s(v: $rt.GoObject | undefined): %s { if (v instanceof %s) return v; throw $rt.typeAssertError(); }\n}\n", f.t.helperKey(tn), name, name)
		return w.String()
	}
	switch {
	case m == nil || it.NumMethods() == 0:
		return fmt.Sprintf("export type %s%s = $rt.GoObject | undefined;\n", f.declName(tn), tp)
	case m.base != nil:
		return fmt.Sprintf("export type %s%s = %s | undefined;\n", f.declName(tn), tp, f.classRef(m.base))
	case len(m.union) > 0:
		var parts []string
		for _, u := range m.union {
			if p, ok := u.(*types.Pointer); ok {
				parts = append(parts, f.classRef(p.Elem().(*types.Named).Obj()))
			} else {
				parts = append(parts, f.boxRef(u.(*types.Named).Obj()))
			}
		}
		return fmt.Sprintf("export type %s%s = %s | undefined;\n", f.declName(tn), tp, strings.Join(parts, " | "))
	}
	return fmt.Sprintf("export type %s%s = $rt.GoObject | undefined;\n", f.declName(tn), tp)
}

func (f *file) classRef(tn *types.TypeName) string {
	return f.qualify(tn)
}

func (f *file) boxRef(tn *types.TypeName) string {
	q := f.qualify(tn)
	return q + "$Box"
}

// qualify names a package-level object from this module.
func (f *file) qualify(obj types.Object) string {
	if tn, ok := obj.(*types.TypeName); ok && f.t.overridden(tn) {
		return "$rt." + strings.ReplaceAll(overrideKey(tn), ".", "_")
	}
	if tn, ok := obj.(*types.TypeName); ok {
		if local, ok := f.t.localTypes[tn]; ok {
			if tn.Pkg() == f.p.p.Types {
				return local
			}
			tp := f.t.pkgs[tn.Pkg()]
			f.use(tp)
			return "$" + tp.module + "." + local
		}
	}
	if obj.Pkg() == nil || obj.Pkg() == f.p.p.Types {
		return safeName(obj.Name())
	}
	if tn, ok := obj.(*types.TypeName); ok && f.t.overridden(tn) {
		return "$rt." + strings.ReplaceAll(overrideKey(tn), ".", "_")
	}
	if tp := f.t.pkgs[obj.Pkg()]; tp != nil {
		f.use(tp)
		return "$" + tp.module + "." + safeName(obj.Name())
	}
	name := stdName(obj.Pkg().Path()) + "_" + obj.Name()
	f.t.noteStd(name, stdRef{obj: obj})
	return "$rt." + name
}

func stdName(path string) string {
	return strings.NewReplacer("/", "_", ".", "_", "-", "_").Replace(path)
}

func (f *file) classDecl(tn *types.TypeName) string {
	c := f.t.classes[tn]
	var w strings.Builder
	tp := f.typeParams(tn)
	n := tn.Type().(*types.Named)
	needs := f.t.needsFor(tn)
	var zparams, zargs []string
	for i := 0; i < n.TypeParams().Len(); i++ {
		if i < len(needs) && needs[i] {
			p := n.TypeParams().At(i)
			zparams = append(zparams, fmt.Sprintf("%s: () => %s", f.zeroParamName(p), p.Obj().Name()))
			zargs = append(zargs, "this."+f.zeroParamName(p))
		}
	}
	var out string
	f.withScope(n.TypeParams(), needs, func(p *types.TypeParam) string { return "this." + f.zeroParamName(p) }, func() {
		ext := "$rt.GoObject"
		var superArgs []string
		if c.base != nil {
			bt := c.st.Field(c.baseAt).Type()
			ext = f.tsType(bt)
			if bn, ok := types.Unalias(bt).(*types.Named); ok {
				superArgs = f.factoryArgs(bn.Origin().Obj(), bn.TypeArgs())
			}
		}
		fmt.Fprintf(&w, "export class %s%s extends %s {\n", f.declName(tn), tp, ext)
		self := f.declName(tn) + typeArgNames(tn)
		ctorInit := len(zparams) > 0 || len(superArgs) > 0
		for _, zp := range zparams {
			fmt.Fprintf(&w, "  %s;\n", zp)
		}
		var inits []string
		for i := 0; i < c.st.NumFields(); i++ {
			if i == c.baseAt {
				continue
			}
			fl := c.st.Field(i)
			if ctorInit {
				fmt.Fprintf(&w, "  %s: %s;\n", f.fieldName(fl), f.tsType(fl.Type()))
				inits = append(inits, fmt.Sprintf("this.%s = %s;", f.fieldName(fl), f.zero(fl.Type())))
			} else {
				fmt.Fprintf(&w, "  %s: %s = %s;\n", f.fieldName(fl), f.tsType(fl.Type()), f.zero(fl.Type()))
			}
			if f.t.byteShadowed(fl) {
				fmt.Fprintf(&w, "  %s$bytes: Uint8Array = $rt.EMPTY_BYTES;\n", f.fieldName(fl))
			}
		}
		if ctorInit {
			var sets []string
			for i := 0; i < n.TypeParams().Len(); i++ {
				if i < len(needs) && needs[i] {
					name := f.zeroParamName(n.TypeParams().At(i))
					sets = append(sets, fmt.Sprintf("this.%s = %s;", name, name))
				}
			}
			// Factories referenced by field initializers use the parameters.
			body := strings.Join(append(sets, inits...), " ")
			fmt.Fprintf(&w, "  constructor(%s) { super(%s); %s }\n", strings.Join(zparams, ", "), strings.Join(superArgs, ", "), body)
		}
		// Copy helpers and literal factories.
		fmt.Fprintf(&w, "  $copy_%s(src: %s): void {", f.t.helperKey(tn), self)
		if c.base != nil {
			fmt.Fprintf(&w, " this.$copy_%s(src);", f.t.helperKey(c.base))
		}
		for i := 0; i < c.st.NumFields(); i++ {
			if i == c.baseAt {
				continue
			}
			fl := c.st.Field(i)
			fmt.Fprintf(&w, " this.%s = %s;", f.fieldName(fl), f.copyValue("src."+f.fieldName(fl), fl.Type()))
			if f.t.byteShadowed(fl) {
				fmt.Fprintf(&w, " this.%s$bytes = src.%s$bytes;", f.fieldName(fl), f.fieldName(fl))
			}
		}
		w.WriteString(" }\n")
		// Value equality for comparable structs.
		var eqs []string
		if c.base != nil {
			eqs = append(eqs, fmt.Sprintf("this.$equals_%s(o)", f.t.helperKey(c.base)))
		}
		comparable := true
		for i := 0; i < c.st.NumFields(); i++ {
			if i == c.baseAt {
				continue
			}
			fl := c.st.Field(i)
			if _, isTP := types.Unalias(fl.Type()).(*types.TypeParam); !isTP && !types.Comparable(fl.Type()) {
				comparable = false
				break
			}
			fname := f.fieldName(fl)
			if n, ok := types.Unalias(fl.Type()).(*types.Named); ok && isStructType(n) {
				if fc := f.t.classOf(n.Origin().Obj()); fc != nil {
					eqs = append(eqs, fmt.Sprintf("this.%s.$equals_%s(o.%s)", fname, f.t.helperKey(fc.name), fname))
					continue
				}
				if !f.t.translated(n.Obj().Pkg()) {
					if stdEquals[n.Obj().Pkg().Path()+"."+n.Obj().Name()] {
						eqs = append(eqs, fmt.Sprintf("this.%s.$equals(o.%s)", fname, fname))
					} else {
						eqs = append(eqs, fmt.Sprintf("this.%s === o.%s", fname, fname))
					}
					continue
				}
			}
			if isIfaceType(fl.Type()) {
				eqs = append(eqs, fmt.Sprintf("$rt.ifaceEq(this.%s, o.%s)", fname, fname))
				continue
			}
			eqs = append(eqs, fmt.Sprintf("this.%s === o.%s", fname, fname))
		}
		if comparable && n.TypeParams().Len() == 0 && types.Comparable(tn.Type()) && f.t.keyTypes[tn] {
			var keys []string
			if c.base != nil {
				keys = append(keys, fmt.Sprintf("this.$key_%s()", f.t.helperKey(c.base)))
			}
			for i := 0; i < c.st.NumFields(); i++ {
				if i == c.baseAt {
					continue
				}
				fl := c.st.Field(i)
				keys = append(keys, f.valueKey("this."+f.fieldName(fl), fl.Type()))
			}
			if len(keys) == 0 {
				keys = []string{"''"}
			}
			fmt.Fprintf(&w, "  $key_%s(): string { return [%s].join('|'); }\n", f.t.helperKey(tn), strings.Join(keys, ", "))
		}
		if comparable && (n.TypeParams().Len() > 0 || types.Comparable(tn.Type())) {
			if len(eqs) == 0 {
				eqs = []string{"true"}
			}
			fmt.Fprintf(&w, "  $equals_%s(o: %s): boolean { return %s; }\n", f.t.helperKey(tn), self, strings.Join(eqs, " && "))
		}
		fmt.Fprintf(&w, "  $clone_%s(): %s { const o = new %s%s(%s); o.$copy_%s(this); return o; }\n", f.t.helperKey(tn), self, f.declName(tn), typeArgNames(tn), strings.Join(zargs, ", "), f.t.helperKey(tn))
		var staticZ []string
		var staticZArgs []string
		for i := 0; i < n.TypeParams().Len(); i++ {
			if i < len(needs) && needs[i] {
				p := n.TypeParams().At(i)
				staticZ = append(staticZ, fmt.Sprintf("%s: () => %s", f.zeroParamName(p), p.Obj().Name()))
				staticZArgs = append(staticZArgs, f.zeroParamName(p))
			}
		}
		for _, key := range sortedKeys(f.litsFor(tn)) {
			idx := f.lits[tn][key]
			params := append([]string{}, staticZ...)
			var sets []string
			for j, i := range idx {
				fl := c.st.Field(i)
				params = append(params, fmt.Sprintf("p%d: %s", j, f.tsType(fl.Type())))
				if i == c.baseAt {
					sets = append(sets, fmt.Sprintf("o.$copy_%s(p%d);", f.t.helperKey(c.base), j))
				} else {
					sets = append(sets, fmt.Sprintf("o.%s = p%d;", f.fieldName(fl), j))
				}
			}
			fmt.Fprintf(&w, "  static $lit_%s_%s%s(%s): %s { const o = new %s%s(%s); %s return o; }\n", f.t.helperKey(tn), key, tp, strings.Join(params, ", "), self, f.declName(tn), typeArgNames(tn), strings.Join(staticZArgs, ", "), strings.Join(sets, " "))
		}
		if n.TypeParams().Len() == 0 && f.t.localTParams[tn] == nil {
			fmt.Fprintf(&w, "  static $cast_%s(v: $rt.GoObject | undefined): %s { if (v instanceof %s) return v; throw $rt.typeAssertError(); }\n", f.t.helperKey(tn), self, f.declName(tn))
		}
		// Methods.
		defined := f.defined[tn]
		for _, m := range f.methods[tn] {
			w.WriteString(m)
		}
		for _, name := range sortedFuncKeys(c.stubs) {
			if defined[name] {
				continue
			}
			fn := c.stubs[name]
			sig := fn.Type().(*types.Signature)
			params, _ := f.sigParams(sig)
			fmt.Fprintf(&w, "  %s(%s): %s { throw $rt.unimplementedMethod(%q); }\n", f.t.methodNameStr(name), params, f.results(sig), name)
		}
		for _, name := range sortedSelKeys(c.forwards) {
			sel := c.forwards[name]
			fn := sel.Obj().(*types.Func)
			sig := fn.Type().(*types.Signature)
			params, args := f.sigParams(sig)
			path := f.embedPath(types.NewPointer(tn.Type()), sel.Index()[:len(sel.Index())-1])
			fmt.Fprintf(&w, "  %s(%s): %s { return this%s.%s(%s); }\n", f.t.methodNameStr(name), params, f.results(sig), path, f.t.methodNameStr(name), args)
		}
		w.WriteString("}\n")
		out = w.String()
	})
	return out
}

func typeArgNames(tn *types.TypeName) string {
	if list := localTParamsGlobal[tn]; list != nil {
		parts := make([]string, list.Len())
		for i := range parts {
			parts[i] = list.At(i).Obj().Name()
		}
		return "<" + strings.Join(parts, ", ") + ">"
	}
	n, ok := tn.Type().(*types.Named)
	if !ok || n.TypeParams().Len() == 0 {
		return ""
	}
	parts := make([]string, n.TypeParams().Len())
	for i := range parts {
		parts[i] = n.TypeParams().At(i).Obj().Name()
	}
	return "<" + strings.Join(parts, ", ") + ">"
}

func sortedFuncKeys(m map[string]*types.Func) []string {
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sortedSelKeys(m map[string]*types.Selection) []string {
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (f *file) litsFor(tn *types.TypeName) map[string][]int {
	if f.lits[tn] == nil {
		return map[string][]int{}
	}
	return f.lits[tn]
}

// litFactory returns the factory name for a composite literal that sets the
// given fields, registering it for emission.
func (f *file) litFactory(tn *types.TypeName, idx []int) string {
	parts := make([]string, len(idx))
	for i, x := range idx {
		parts[i] = strconv.Itoa(x)
	}
	key := strings.Join(parts, "_")
	owner := f.fileFor(tn)
	if owner.lits[tn] == nil {
		owner.lits[tn] = map[string][]int{}
	}
	owner.lits[tn][key] = idx
	return "$lit_" + f.t.helperKey(tn) + "_" + key
}

// fileFor returns the output file that declares tn. Literal factories for
// classes in other packages are registered there before it is emitted;
// packages are emitted in dependency order, so a factory requested from a
// later package is added through litsGlobal.
func (f *file) fileFor(tn *types.TypeName) *file {
	if tn.Pkg() == f.p.p.Types {
		return f
	}
	return f.t.globalLits(tn.Pkg())
}

func (f *file) fieldName(v *types.Var) string {
	if n, ok := f.t.fieldNames[v.Origin()]; ok {
		return n
	}
	return v.Name()
}

func (f *file) constValue(v constant.Value, tt types.Type) string {
	switch v.Kind() {
	case constant.Bool:
		return v.String()
	case constant.String:
		return jsString(constant.StringVal(v))
	case constant.Int:
		if i, ok := constant.Int64Val(v); ok {
			if i < 0 {
				return "(" + strconv.FormatInt(i, 10) + ")"
			}
			return strconv.FormatInt(i, 10)
		}
		if u, ok := constant.Uint64Val(v); ok {
			return strconv.FormatUint(u, 10)
		}
		return v.ExactString()
	case constant.Float:
		x, _ := constant.Float64Val(v)
		if b, ok := tt.Underlying().(*types.Basic); ok && b.Info()&types.IsInteger != 0 {
			return strconv.FormatInt(int64(x), 10)
		}
		s := strconv.FormatFloat(x, 'g', -1, 64)
		if x < 0 {
			return "(" + s + ")"
		}
		switch s {
		case "+Inf":
			return "Infinity"
		case "-Inf":
			return "(-Infinity)"
		case "NaN":
			return "NaN"
		}
		return s
	}
	return "undefined"
}

// jsString renders Go string bytes as a TypeScript literal with one UTF-16
// code unit per byte.
func jsString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			b.WriteString(`\"`)
		case c == '\\':
			b.WriteString(`\\`)
		case c == '\n':
			b.WriteString(`\n`)
		case c == '\r':
			b.WriteString(`\r`)
		case c == '\t':
			b.WriteString(`\t`)
		case c >= 0x20 && c < 0x7f:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, `\x%02x`, c)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// tsType maps a Go type to TypeScript.
func (f *file) tsType(tt types.Type) string {
	f.inType++
	defer func() { f.inType-- }()
	switch x := tt.(type) {
	case *types.Basic:
		switch {
		case x.Kind() == types.UntypedNil:
			return "undefined"
		case x.Info()&types.IsBoolean != 0:
			return "boolean"
		case x.Info()&types.IsString != 0:
			return "string"
		case x.Kind() == types.UnsafePointer:
			return "unknown"
		default:
			return "number"
		}
	case *types.Alias:
		if x.Obj().Pkg() == nil {
			return f.tsType(types.Unalias(x))
		}
		if !f.t.translated(x.Obj().Pkg()) {
			return f.tsType(types.Unalias(x))
		}
		return f.qualify(x.Obj()) + f.typeArgs(x.TypeArgs())
	case *types.Named:
		obj := x.Obj()
		if obj.Pkg() == nil {
			if obj.Name() == "error" {
				return "$rt.GoObject | undefined"
			}
			return f.tsType(x.Underlying())
		}
		if !f.t.translated(obj.Pkg()) {
			return f.stdType(x)
		}
		if list := f.t.localTParams[obj]; list != nil {
			return f.qualify(obj) + typeArgNames(obj)
		}
		name := f.qualify(obj) + f.typeArgs(x.TypeArgs())
		if m := f.t.ifaces[obj]; m != nil && m.stub {
			return name + " | undefined"
		}
		return name
	case *types.Pointer:
		elem := x.Elem()
		if _, isArr := types.Unalias(elem).Underlying().(*types.Array); isArr {
			return f.tsType(elem) + " | undefined"
		}
		if tp, isTP := types.Unalias(elem).(*types.TypeParam); isTP && f.t.structTP[tp.Obj()] {
			return f.tsType(elem) + " | undefined"
		}
		if n, ok := types.Unalias(elem).(*types.Named); ok {
			if _, isStruct := n.Underlying().(*types.Struct); isStruct {
				return f.tsType(n) + " | undefined"
			}
		}
		if _, isStruct := types.Unalias(elem).(*types.Struct); isStruct {
			return f.tsType(elem) + " | undefined"
		}

		return "$rt.Ptr<" + f.tsType(elem) + "> | undefined"
	case *types.Slice:
		return f.arrayOf(x.Elem())
	case *types.Array:
		return f.arrayOf(x.Elem())
	case *types.Map:
		if isStructKey(x.Key()) {
			return "$rt.StructMap<" + f.tsType(x.Key()) + ", " + f.tsType(x.Elem()) + "> | undefined"
		}
		return "Map<" + f.keyType(x.Key()) + ", " + f.tsType(x.Elem()) + "> | undefined"
	case *types.Signature:
		return "((" + f.funcParams(x) + ") => " + f.results(x) + ") | undefined"
	case *types.Struct:
		if x.NumFields() == 0 {
			return "$rt.Empty"
		}
		return f.anonClass(x)
	case *types.Interface:
		if m := f.t.anonIfaces[types.TypeString(x, nil)]; m != nil {
			if s := f.ifaceText(m); s != "" {
				return s
			}
		}
		return "$rt.GoObject | undefined"
	case *types.TypeParam:
		return x.Obj().Name()
	case *types.Chan:
		return "$rt.Chan<" + f.tsType(x.Elem()) + "> | undefined"
	case *types.Tuple:
		var parts []string
		for i := 0; i < x.Len(); i++ {
			parts = append(parts, f.tsType(x.At(i).Type()))
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case *types.Union:
		return "unknown"
	}
	return "unknown"
}

func (f *file) arrayOf(elem types.Type) string {
	s := f.tsType(elem)
	if strings.ContainsAny(s, " |(") {
		return "(" + s + ")[]"
	}
	return s + "[]"
}

// keyType maps map keys. Struct keys are encoded as strings.
func (f *file) keyType(k types.Type) string {
	if _, ok := k.Underlying().(*types.Struct); ok {
		return "string"
	}
	if _, ok := k.Underlying().(*types.Array); ok {
		return "string"
	}
	return f.tsType(k)
}

func (f *file) typeArgs(list *types.TypeList) string {
	if list == nil || list.Len() == 0 {
		return ""
	}
	parts := make([]string, list.Len())
	for i := 0; i < list.Len(); i++ {
		parts[i] = f.tsType(list.At(i))
	}
	return "<" + strings.Join(parts, ", ") + ">"
}

func (f *file) funcParams(sig *types.Signature) string {
	var parts []string
	for i := 0; i < sig.Params().Len(); i++ {
		p := sig.Params().At(i)
		parts = append(parts, fmt.Sprintf("p%d: %s", i, f.tsType(p.Type())))
	}
	return strings.Join(parts, ", ")
}

func (f *file) results(sig *types.Signature) string {
	r := sig.Results()
	switch r.Len() {
	case 0:
		return "void"
	case 1:
		return f.tsType(r.At(0).Type())
	}
	return f.tsType(r)
}

func (f *file) stdType(n *types.Named) string {
	path := n.Obj().Pkg().Path()
	name := stdName(path) + "_" + n.Obj().Name()
	if _, ok := n.Underlying().(*types.Struct); ok {
		f.t.noteStd(name, stdRef{obj: n.Obj()})
	}
	switch path + "." + n.Obj().Name() {
	case "strings.Builder", "sync.Mutex", "sync.RWMutex", "sync.Once", "sync.WaitGroup", "sync.Map",
		"sync/atomic.Bool", "sync/atomic.Int32", "sync/atomic.Int64", "sync/atomic.Uint32", "sync/atomic.Uint64",
		"sync/atomic.Pointer", "sync/atomic.Value", "context.Context", "time.Time", "time.Duration", "regexp.Regexp",
		"iter.Seq", "iter.Seq2", "cmp.Ordering", "unicode.RangeTable", "strings.Reader", "bytes.Buffer", "math/big.Int":
		switch u := n.Underlying().(type) {
		case *types.Struct:
			return "$rt." + name + f.typeArgs(n.TypeArgs())
		case *types.Signature:
			return f.tsType(u)
		case *types.Basic:
			return f.tsType(u)
		case *types.Interface:
			return f.stdIface(n, n.Underlying().(*types.Interface))
		}
	}
	if _, ok := n.Underlying().(*types.Struct); ok {
		return "$rt." + name + f.typeArgs(n.TypeArgs())
	}
	if it, ok := n.Underlying().(*types.Interface); ok {
		return f.stdIface(n, it)
	}
	return f.tsType(n.Underlying())
}

// stdIface maps a standard-library interface: to translated implementers
// when there are any, otherwise to a generated stub class.
func (f *file) stdIface(n *types.Named, it *types.Interface) string {
	key := n.Obj().Pkg().Path() + "." + n.Obj().Name()
	if it.NumMethods() == 0 || key == "fmt.Stringer" {
		return "$rt.GoObject | undefined"
	}
	m := f.t.anonIfaces[key]
	if m == nil {
		m = f.t.mapIface(it, f.t.named)
		f.t.anonIfaces[key] = m
	}
	if s := f.ifaceText(m); s != "" {
		if f.runtime {
			return "$rt.GoObject | undefined"
		}
		return s
	}
	name := stdName(n.Obj().Pkg().Path()) + "_" + n.Obj().Name()
	f.t.noteStd(name, stdRef{obj: n.Obj()})
	return "$rt." + name + " | undefined"
}

// zero returns the zero value expression of a type.
func (f *file) zero(tt types.Type) string {
	switch x := tt.Underlying().(type) {
	case *types.Basic:
		switch {
		case x.Info()&types.IsBoolean != 0:
			return "false"
		case x.Info()&types.IsString != 0:
			return `""`
		case x.Kind() == types.UntypedNil, x.Kind() == types.UnsafePointer:
			return "undefined"
		default:
			return "0"
		}
	case *types.Struct:
		if x.NumFields() == 0 {
			if _, named := types.Unalias(tt).(*types.Named); !named {
				return "$rt.EMPTY"
			}
		}
		switch n := types.Unalias(tt).(type) {
		case *types.Named:
			if !f.t.translated(n.Obj().Pkg()) {
				return "new " + f.stdType(n) + "()"
			}
			if base, ok := f.t.structAlias[n.Origin().Obj()]; ok && f.t.classOf(n.Origin().Obj()) == nil {
				return f.zero(base)
			}
			tn := n.Origin().Obj()
			if c := f.t.classOf(tn); c != nil && c.name != tn {
				tn = c.name
			}
			return "new " + f.qualify(tn) + f.typeArgs(n.TypeArgs()) + "(" + strings.Join(f.factoryArgs(tn, n.TypeArgs()), ", ") + ")"
		case *types.Alias:
			return f.zero(types.Unalias(n))
		}
		return "new " + f.anonClass(x) + "()"
	case *types.Slice:
		return "[]"
	case *types.Array:
		return fmt.Sprintf("$rt.makeArray(%d, () => %s)", x.Len(), f.zero(x.Elem()))
	case *types.Interface:
		if tp, ok := types.Unalias(tt).(*types.TypeParam); ok {
			return f.typeParamZero(tp)
		}
		return "undefined"
	}
	if tp, ok := types.Unalias(tt).(*types.TypeParam); ok {
		return f.typeParamZero(tp)
	}
	return "undefined"
}

// copyValue copies a struct value when the struct can be mutated.
func (f *file) copyValue(expr string, tt types.Type) string {
	if f.needsCopy(tt) {
		return expr + f.cloneCall(tt)
	}
	if a, ok := tt.Underlying().(*types.Array); ok {
		_ = a
		return expr + ".slice()"
	}
	return expr
}

func (f *file) needsCopy(tt types.Type) bool {
	switch n := tt.(type) {
	case *types.Named:
		st, ok := n.Underlying().(*types.Struct)
		if !ok || st.NumFields() == 0 {
			return false
		}
		if !f.t.translated(n.Obj().Pkg()) {
			return false
		}
		return f.t.mutable[n.Origin().Obj()]
	case *types.Alias:
		return f.needsCopy(types.Unalias(n))
	case *types.Struct:
		return n.NumFields() > 0
	}
	return false
}

func (f *file) anonClass(st *types.Struct) string {
	key := types.TypeString(st, nil)
	a := f.t.anon[key]
	if a == nil {
		a = &anonStruct{name: fmt.Sprintf("$Anon%d", len(f.t.anon)), st: st}
		f.t.anon[key] = a
	}
	for _, x := range f.anonOrder {
		if x == a {
			return a.name
		}
	}
	f.anonOrder = append(f.anonOrder, a)
	return a.name
}

// embedPath renders field hops for an embedded selection path, skipping
// superclass steps that are the same object.
func (f *file) embedPath(recv types.Type, index []int) string {
	var b strings.Builder
	cur := recv
	for _, i := range index {
		if p, ok := cur.(*types.Pointer); ok {
			cur = p.Elem()
		}
		st, ok := cur.Underlying().(*types.Struct)
		if !ok {
			break
		}
		fl := st.Field(i)
		skip := false
		if n, ok := types.Unalias(cur).(*types.Named); ok {
			if c := f.t.classOf(n.Origin().Obj()); c != nil && c.baseAt == i {
				skip = true
			}
		}
		if !skip {
			b.WriteString("." + f.fieldName(fl))
			if f.isNullable(fl.Type()) {
				b.WriteString("!")
			}
		}
		cur = fl.Type()
	}
	return b.String()
}

func (f *file) isNullable(tt types.Type) bool {
	switch x := tt.Underlying().(type) {
	case *types.Pointer, *types.Map, *types.Signature:
		return true
	case *types.Interface:
		if tp, ok := tt.(*types.TypeParam); ok {
			return x.NumMethods() > 0 && !f.t.structTP[tp.Obj()]
		}
		return true
	}
	return false
}

var _ = token.ILLEGAL

func (f *file) typeParamZero(tp *types.TypeParam) string {
	if _, ok := f.zs[tp]; ok {
		return f.factory(tp) + "()"
	}
	for k := range f.zs {
		if k.Obj().Name() == tp.Obj().Name() {
			return f.factory(tp) + "()"
		}
	}
	return "undefined as unknown as " + tp.Obj().Name()
}

func (f *file) declName(tn *types.TypeName) string {
	if local, ok := f.t.localTypes[tn]; ok {
		return local
	}
	return safeName(tn.Name())
}

// ifaceText renders an interface mapping, or "" for the GoObject fallback.
func (f *file) ifaceText(m *ifaceMap) string {
	switch {
	case m.base != nil:
		return f.classRef(m.base) + " | undefined"
	case len(m.union) > 0:
		var parts []string
		for _, u := range m.union {
			if p, ok := u.(*types.Pointer); ok {
				parts = append(parts, f.classRef(p.Elem().(*types.Named).Obj()))
			} else {
				parts = append(parts, f.boxRef(u.(*types.Named).Obj()))
			}
		}
		return strings.Join(parts, " | ") + " | undefined"
	}
	return ""
}

var localTParamsGlobal map[*types.TypeName]*types.TypeParamList

// use records an import of tp, as type-only when referenced from a type.
func (f *file) use(tp *pkg) {
	if f.inType > 0 {
		f.typeOnly[tp.module] = true
		return
	}
	f.imports[tp.module] = true
}

// dependsOn reports whether this package imports p, directly or not; only
// those modules may be referenced at runtime without creating cycles.
func (f *file) dependsOn(p *types.Package) bool {
	if p == f.p.p.Types {
		return true
	}
	seen := map[*types.Package]bool{}
	var walk func(q *types.Package) bool
	walk = func(q *types.Package) bool {
		for _, imp := range q.Imports() {
			if imp == p {
				return true
			}
			if !seen[imp] {
				seen[imp] = true
				if walk(imp) {
					return true
				}
			}
		}
		return false
	}
	return walk(f.p.p.Types)
}

// cloneCall returns the method call that copies a struct value of type tt.
func (f *file) cloneCall(tt types.Type) string {
	if n, ok := types.Unalias(tt).(*types.Named); ok && f.t.translated(n.Obj().Pkg()) {
		if c := f.t.classOf(n.Origin().Obj()); c != nil {
			return ".$clone_" + f.t.helperKey(c.name) + "()"
		}
	}
	return ".$clone()"
}

// stdEquals lists library struct types whose runtime class has $equals.
var stdEquals = map[string]bool{"golang.org/x/text/language.Tag": true, "github.com/zeebo/xxh3.Uint128": true}

// isStructKey reports whether map keys of type k compare by value as
// structs or arrays.
func isStructKey(k types.Type) bool {
	switch k.Underlying().(type) {
	case *types.Struct, *types.Array:
		return true
	}
	return false
}

// newMap renders an empty map of type m.
func (f *file) newMap(m *types.Map) string {
	if isStructKey(m.Key()) {
		return "new $rt.StructMap<" + f.tsType(m.Key()) + ", " + f.tsType(m.Elem()) + ">(" + f.keyFn(m.Key()) + ")"
	}
	return "new Map<" + f.keyType(m.Key()) + ", " + f.tsType(m.Elem()) + ">()"
}

// keyFn renders a function computing a value key for a struct or array.
func (f *file) keyFn(k types.Type) string {
	t := f.tsType(k)
	return f.hoistFn(fmt.Sprintf("(k: %s): string => %s", t, f.valueKey("k", k)))
}

// valueKey renders a string key for the value expr of type tt.
func (f *file) valueKey(expr string, tt types.Type) string {
	switch u := tt.Underlying().(type) {
	case *types.Basic:
		switch basicKind(u) {
		case "string":
			return "$rt.strKey(" + expr + ")"
		case "boolean":
			return "(" + expr + " ? '1' : '0')"
		}
		return "$rt.numKey(" + expr + ")"
	case *types.Struct:
		if n, ok := types.Unalias(tt).(*types.Named); ok {
			if c := f.t.classOf(n.Origin().Obj()); c != nil {
				return expr + ".$key_" + f.t.helperKey(c.name) + "()"
			}
			if base, ok := f.t.structAlias[n.Origin().Obj()]; ok {
				return f.valueKey(expr, base)
			}
			if !f.t.translated(n.Obj().Pkg()) {
				return expr + ".String()"
			}
		}
		var parts []string
		for i := 0; i < u.NumFields(); i++ {
			parts = append(parts, f.valueKey(expr+"."+u.Field(i).Name(), u.Field(i).Type()))
		}
		if len(parts) == 0 {
			return "''"
		}
		return "[" + strings.Join(parts, ", ") + "].join('|')"
	case *types.Array:
		if b, ok := u.Elem().Underlying().(*types.Basic); ok && basicKind(b) == "number" {
			return "$rt.numArrayKey(" + expr + ")"
		}
		return expr + ".map((e: " + f.tsType(u.Elem()) + "): string => " + f.valueKey("e", u.Elem()) + ").join(',')"
	case *types.Interface:
		return "$rt.ifaceKey(" + expr + ")"
	}
	return "$rt.objKey(" + expr + ")"
}
