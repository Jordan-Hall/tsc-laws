package main

import (
	"fmt"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

// Values of non-basic, non-class types stored in interfaces use one box
// class per Go type, declared in a shared module so instanceof works across
// modules without downcasts.

func (t *translator) boxClass(tt types.Type) string {
	tag := typeTag(tt)
	if t.boxes == nil {
		t.boxes = map[string]types.Type{}
	}
	if _, ok := t.boxes[tag]; !ok {
		t.boxes[tag] = tt
	}
	return boxName(tag)
}

func boxName(tag string) string {
	var b strings.Builder
	b.WriteString("Box_")
	for _, r := range tag {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

func (f *file) boxRefFor(tt types.Type) string {
	name := f.t.boxClass(tt)
	if owner := f.t.boxOwner(tt); owner != nil {
		if owner == f.p.p.Types {
			return name
		}
		tp := f.t.pkgs[owner]
		f.use(tp)
		return "$" + tp.module + "." + name
	}
	f.imports["boxes"] = true
	return "$boxes." + name
}

// boxOwner returns the package that declares the box for tt, or nil for
// the shared boxes module. scriptc only resolves a box field typed as a
// generic instantiation when the box is declared beside its type arguments.
func (t *translator) boxOwner(tt types.Type) *types.Package {
	if !isGenericPtr(tt) {
		return nil
	}
	n := types.Unalias(tt.(*types.Pointer).Elem()).(*types.Named)
	var owner *types.Package
	for i := 0; i < n.TypeArgs().Len(); i++ {
		if a, ok := types.Unalias(n.TypeArgs().At(i)).(*types.Named); ok && a.Obj().Pkg() != nil && t.translated(a.Obj().Pkg()) {
			owner = a.Obj().Pkg()
		}
	}
	return owner
}

// typeBoxDecl renders the box class for tag in file f.
func (f *file) typeBoxDecl(tag string) string {
	var b strings.Builder
	name := boxName(tag)
	tt := f.t.boxes[tag]
	typ := f.tsType(tt)
	fmt.Fprintf(&b, "export class %s extends $rt.GoObject {\n  v: %s;\n  constructor(v: %s) { super(); this.v = v; }\n", name, typ, typ)
	fmt.Fprintf(&b, "  static $cast(v: $rt.GoObject | undefined): %s { if (v instanceof %s) return v; throw $rt.typeAssertError(); }\n", name, name)
	b.WriteString("  override $unbox(): unknown { return this.v; }\n")
	if _, isPtr := tt.(*types.Pointer); isPtr {
		fmt.Fprintf(&b, "  override $eqv(o: $rt.GoObject): boolean { return o instanceof %s && o.v === this.v; }\n", name)
	}
	b.WriteString("}\n")
	return b.String()
}

// localBoxes renders the boxes owned by f's package.
func (f *file) localBoxes() string {
	var tags []string
	for tag, tt := range f.t.boxes {
		if f.t.boxOwner(tt) == f.p.p.Types {
			tags = append(tags, tag)
		}
	}
	sort.Strings(tags)
	var b strings.Builder
	for _, tag := range tags {
		b.WriteString(f.typeBoxDecl(tag))
	}
	return b.String()
}

func (t *translator) syntheticFile(module string) *file {
	p := &pkg{p: &packages.Package{Types: types.NewPackage("tsts/"+module, module)}, module: module}
	return &file{t: t, p: p, imports: map[string]bool{}, typeOnly: map[string]bool{}, lits: map[*types.TypeName]map[string][]int{}}
}

func (t *translator) emitGlobals(out string) {
	// boxes.ts
	f := t.syntheticFile("boxes")
	var body strings.Builder
	var tags []string
	for tag := range t.boxes {
		tags = append(tags, tag)
	}
	sort.Strings(tags)
	for _, tag := range tags {
		if t.boxOwner(t.boxes[tag]) == nil {
			body.WriteString(f.typeBoxDecl(tag))
		}
	}
	writeModule(filepath.Join(out, "boxes.ts"), f, body.String())

	// classes.ts
	f = t.syntheticFile("classes")
	var order []*types.TypeName
	seen := map[*types.TypeName]bool{}
	var visit func(tn *types.TypeName)
	refs := func(tt types.Type) []*types.TypeName {
		var out []*types.TypeName
		var walk func(types.Type, int)
		walk = func(tt types.Type, depth int) {
			if depth > 4 {
				return
			}
			switch x := types.Unalias(tt).(type) {
			case *types.Named:
				if c := t.classOf(x.Origin().Obj()); c != nil {
					out = append(out, c.name)
				}
			case *types.Pointer:
				walk(x.Elem(), depth+1)
			case *types.Slice:
				walk(x.Elem(), depth+1)
			case *types.Map:
				walk(x.Key(), depth+1)
				walk(x.Elem(), depth+1)
			}
		}
		walk(tt, 0)
		return out
	}
	visit = func(tn *types.TypeName) {
		if seen[tn] {
			return
		}
		seen[tn] = true
		c := t.classes[tn]
		if c.base != nil {
			visit(c.base)
		}
		for i := 0; i < c.st.NumFields(); i++ {
			for _, r := range refs(c.st.Field(i).Type()) {
				visit(r)
			}
		}
		order = append(order, tn)
	}
	var all []*types.TypeName
	for tn := range t.classes {
		all = append(all, tn)
	}
	sort.Slice(all, func(i, j int) bool {
		a, b := all[i], all[j]
		if a.Pkg().Path() != b.Pkg().Path() {
			return a.Pkg().Path() < b.Pkg().Path()
		}
		return t.typeName(a) < t.typeName(b)
	})
	for _, tn := range all {
		visit(tn)
	}
	var news []string
	for _, tn := range order {
		n := tn.Type().(*types.Named)
		if n.TypeParams().Len() > 0 || t.localTParams[tn] != nil || len(t.needsFor(tn)) > 0 {
			continue
		}
		news = append(news, "    new "+f.qualify(tn)+"() as $rt.GoObject,")
	}
	body.Reset()
	body.WriteString("// keepAll constructs every class so scriptc lowers each before its uses.\n")
	body.WriteString("export function keepAll(): $rt.GoObject[] {\n  return [\n" + strings.Join(news, "\n") + "\n  ];\n}\n")
	writeModule(filepath.Join(out, "classes.ts"), f, body.String())
}

func writeModule(path string, f *file, body string) {
	var head strings.Builder
	head.WriteString("// Generated by tools/gots. Do not edit.\n")
	head.WriteString("import * as $rt from '../go/runtime.js';\n")
	for _, m := range sortedKeys(f.imports) {
		fmt.Fprintf(&head, "import * as $%s from './%s.js';\n", m, m)
	}
	for _, m := range sortedKeys(f.typeOnly) {
		if !f.imports[m] {
			fmt.Fprintf(&head, "import type * as $%s from './%s.js';\n", m, m)
		}
	}
	if err := os.WriteFile(path, []byte(head.String()+body), 0o644); err != nil {
		fatal(err)
	}
}
