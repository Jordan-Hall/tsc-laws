package main

import (
	"go/ast"
	"go/token"
	"go/types"
)

// Borrowed struct parameters: Go passes structs by value, so callers clone
// mutable struct arguments. Callees copy a parameter whenever they store
// it, so the clone is only needed when the callee changes the parameter in
// place: assigns to its fields, takes its address, or calls a pointer
// method on it. Parameters the callee never changes are borrowed instead.

var borrowGlobal map[*types.Var]bool

func (t *translator) findBorrowed() {
	borrowGlobal = map[*types.Var]bool{}
	for _, p := range t.order {
		info := p.p.TypesInfo
		for _, f := range p.p.Syntax {
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Body == nil {
					continue
				}
				fn, ok := info.Defs[fd.Name].(*types.Func)
				if !ok {
					continue
				}
				sig := fn.Type().(*types.Signature)
				params := map[*types.Var]bool{}
				for i := 0; i < sig.Params().Len(); i++ {
					v := sig.Params().At(i)
					if isStructType(v.Type()) {
						params[v] = true
					}
				}
				if len(params) == 0 {
					continue
				}
				root := func(e ast.Expr) *types.Var {
					for {
						switch x := e.(type) {
						case *ast.ParenExpr:
							e = x.X
						case *ast.SelectorExpr:
							if sel := info.Selections[x]; sel == nil || sel.Kind() != types.FieldVal || isPointerType(info.TypeOf(x.X)) {
								return nil
							}
							e = x.X
						case *ast.IndexExpr:
							if _, isArray := under(info.TypeOf(x.X)).(*types.Array); !isArray {
								return nil
							}
							e = x.X
						case *ast.Ident:
							v, _ := info.Uses[x].(*types.Var)
							return v
						default:
							return nil
						}
					}
				}
				ast.Inspect(fd.Body, func(n ast.Node) bool {
					switch s := n.(type) {
					case *ast.AssignStmt:
						for _, l := range s.Lhs {
							if v := root(l); v != nil {
								delete(params, v)
							}
						}
					case *ast.IncDecStmt:
						if v := root(s.X); v != nil {
							delete(params, v)
						}
					case *ast.UnaryExpr:
						if s.Op == token.AND {
							if v := root(s.X); v != nil {
								delete(params, v)
							}
						}
					case *ast.FuncLit:
						// Closures may outlive the call.
						ast.Inspect(s.Body, func(m ast.Node) bool {
							if id, ok := m.(*ast.Ident); ok {
								if v, ok := info.Uses[id].(*types.Var); ok {
									delete(params, v)
								}
							}
							return true
						})
					case *ast.ReturnStmt:
						// A returned parameter would alias the caller's value.
						for _, r := range s.Results {
							if v := root(r); v != nil {
								delete(params, v)
							}
						}
					case *ast.RangeStmt:
						for _, e := range []ast.Expr{s.Key, s.Value} {
							if e != nil {
								if v := root(e); v != nil {
									delete(params, v)
								}
							}
						}
					case *ast.SelectorExpr:
						// Pointer methods called on the value (or its fields).
						if sel := info.Selections[s]; sel != nil && sel.Kind() == types.MethodVal {
							if _, isPtr := sel.Obj().Type().(*types.Signature).Recv().Type().(*types.Pointer); isPtr {
								if v := root(s.X); v != nil {
									delete(params, v)
								}
							}
						}
					}
					return true
				})
				for v := range params {
					borrowGlobal[v] = true
				}
			}
		}
	}
}

func isPointerType(tt types.Type) bool {
	_, ok := under(tt).(*types.Pointer)
	return ok
}

// borrowedParam reports whether the callee of e borrows its parameter i.
func (x *fn) borrowedParam(e *ast.CallExpr, i int) bool {
	var obj types.Object
	switch f := unparen(e.Fun).(type) {
	case *ast.Ident:
		obj = x.info.Uses[f]
	case *ast.SelectorExpr:
		if sel := x.info.Selections[f]; sel != nil {
			if sel.Kind() != types.MethodVal || isIfaceType(sel.Recv()) {
				return false
			}
			obj = sel.Obj()
		} else {
			obj = x.info.Uses[f.Sel]
		}
	}
	fn, ok := obj.(*types.Func)
	if !ok {
		return false
	}
	sig := fn.Origin().Type().(*types.Signature)
	if i >= sig.Params().Len() || (sig.Variadic() && i == sig.Params().Len()-1) {
		return false
	}
	return borrowGlobal[sig.Params().At(i)]
}

// staticCallee returns the function or concrete method a call invokes.
func staticCallee(info *types.Info, call *ast.CallExpr) *types.Func {
	var obj types.Object
	switch f := unparen(call.Fun).(type) {
	case *ast.Ident:
		obj = info.Uses[f]
	case *ast.SelectorExpr:
		if sel := info.Selections[f]; sel != nil {
			if sel.Kind() != types.MethodVal || isIfaceType(sel.Recv()) {
				return nil
			}
			obj = sel.Obj()
		} else {
			obj = info.Uses[f.Sel]
		}
	case *ast.IndexExpr:
		if id, ok := unparen(f.X).(*ast.Ident); ok {
			obj = info.Uses[id]
		}
	}
	fn, _ := obj.(*types.Func)
	if fn == nil {
		return nil
	}
	return fn.Origin()
}
