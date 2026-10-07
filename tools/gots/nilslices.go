package main

import (
	"go/ast"
	"go/token"
	"go/types"
)

// Nil-sensitive slices: slices are arrays, so nil and empty slices look the
// same. Some code stores an empty non-nil slice to mark a computed result
// and tests the variable against nil. Variables that are both compared with
// nil and assigned an empty literal (directly or through plain assignments
// between variables) are typed `T[] | undefined`, with nil as undefined.

var nilSliceGlobal map[*types.Var]bool

func (t *translator) findNilSlices() {
	parent := map[*types.Var]*types.Var{}
	var find func(v *types.Var) *types.Var
	find = func(v *types.Var) *types.Var {
		p, ok := parent[v]
		if !ok || p == v {
			parent[v] = v
			return v
		}
		r := find(p)
		parent[v] = r
		return r
	}
	compared := map[*types.Var]bool{}
	emptied := map[*types.Var]bool{}
	for _, p := range t.order {
		info := p.p.TypesInfo
		sliceVar := func(e ast.Expr) *types.Var {
			var v *types.Var
			switch e := unparen(e).(type) {
			case *ast.Ident:
				v, _ = info.Uses[e].(*types.Var)
				if v == nil {
					v, _ = info.Defs[e].(*types.Var)
				}
			case *ast.SelectorExpr:
				if sel := info.Selections[e]; sel != nil && sel.Kind() == types.FieldVal {
					v, _ = sel.Obj().(*types.Var)
				}
			}
			if v == nil {
				return nil
			}
			if _, ok := v.Type().Underlying().(*types.Slice); !ok {
				return nil
			}
			return v.Origin()
		}
		isNil := func(e ast.Expr) bool {
			id, ok := unparen(e).(*ast.Ident)
			if !ok {
				return false
			}
			_, ok = info.Uses[id].(*types.Nil)
			return ok
		}
		isEmptyLit := func(e ast.Expr) bool {
			cl, ok := unparen(e).(*ast.CompositeLit)
			if !ok || len(cl.Elts) > 0 {
				return false
			}
			_, ok = info.TypeOf(cl).Underlying().(*types.Slice)
			return ok
		}
		assign := func(l, r ast.Expr) {
			lv := sliceVar(l)
			if lv == nil {
				return
			}
			if isEmptyLit(r) {
				emptied[lv] = true
			} else if rv := sliceVar(r); rv != nil {
				parent[find(lv)] = find(rv)
			}
		}
		for _, f := range p.p.Syntax {
			ast.Inspect(f, func(n ast.Node) bool {
				switch s := n.(type) {
				case *ast.BinaryExpr:
					if s.Op == token.EQL || s.Op == token.NEQ {
						if v := sliceVar(s.X); v != nil && isNil(s.Y) {
							compared[v] = true
						}
						if v := sliceVar(s.Y); v != nil && isNil(s.X) {
							compared[v] = true
						}
					}
				case *ast.AssignStmt:
					if len(s.Lhs) == len(s.Rhs) && (s.Tok == token.ASSIGN || s.Tok == token.DEFINE) {
						for i := range s.Lhs {
							assign(s.Lhs[i], s.Rhs[i])
						}
					}
				case *ast.ValueSpec:
					if len(s.Values) == len(s.Names) {
						for i := range s.Names {
							assign(s.Names[i], s.Values[i])
						}
					}
				}
				return true
			})
		}
	}
	hasCompare := map[*types.Var]bool{}
	hasEmpty := map[*types.Var]bool{}
	for v := range compared {
		hasCompare[find(v)] = true
	}
	for v := range emptied {
		hasEmpty[find(v)] = true
	}
	t.nilSlices = map[*types.Var]bool{}
	for v := range parent {
		if r := find(v); hasCompare[r] && hasEmpty[r] {
			t.nilSlices[v] = true
		}
	}
	for v := range compared {
		if r := find(v); hasCompare[r] && hasEmpty[r] {
			t.nilSlices[v] = true
		}
	}
	for v := range emptied {
		if r := find(v); hasCompare[r] && hasEmpty[r] {
			t.nilSlices[v] = true
		}
	}
}

// nilSliceVar returns the nil-sensitive variable e names, if any.
func (x *fn) nilSliceVar(e ast.Expr) *types.Var {
	var v *types.Var
	switch e := unparen(e).(type) {
	case *ast.Ident:
		v, _ = x.info.Uses[e].(*types.Var)
		if v == nil {
			v, _ = x.info.Defs[e].(*types.Var)
		}
	case *ast.SelectorExpr:
		if sel := x.info.Selections[e]; sel != nil && sel.Kind() == types.FieldVal {
			v, _ = sel.Obj().(*types.Var)
		}
	}
	if v == nil || !nilSliceGlobal[v.Origin()] {
		return nil
	}
	return v
}

// rawExpr renders e without coalescing a nil-sensitive slice to [].
func (x *fn) rawExpr(e ast.Expr) string {
	switch u := unparen(e).(type) {
	case *ast.Ident:
		if x.nilSliceVar(u) != nil {
			return x.ident(u)
		}
	case *ast.SelectorExpr:
		if x.nilSliceVar(u) != nil {
			return x.selector(u)
		}
	}
	return x.expr(e)
}

// varType is the declared type of v.
func (f *file) varType(v *types.Var) string {
	if nilSliceGlobal[v.Origin()] {
		return f.tsType(v.Type()) + " | undefined"
	}
	return f.tsType(v.Type())
}

// varZero is the zero value of v.
func (f *file) varZero(v *types.Var) string {
	if nilSliceGlobal[v.Origin()] {
		return "undefined"
	}
	return f.zero(v.Type())
}

// rhsFor renders r for assignment to l, keeping nil distinct from empty
// when l is nil-sensitive.
func (x *fn) rhsFor(l, r ast.Expr, lt types.Type) string {
	if x.nilSliceVar(l) != nil {
		if isNilType(x.info.TypeOf(r)) {
			return "undefined"
		}
		if x.nilSliceVar(r) != nil {
			return x.rawExpr(r)
		}
	}
	return x.valueExpr(r, lt)
}
