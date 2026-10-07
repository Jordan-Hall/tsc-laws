package main

import (
	"go/ast"
	"go/token"
	"go/types"
)

// Slice ownership: Go's append only writes in place when the slice has
// spare capacity, so appending never changes a zero-capacity slice shared
// with a cache or caller. Arrays here have no capacity, so a local slice
// is appended in place only when every value it holds was created in this
// function (a literal, make, nil, or an append to itself).

func (x *fn) findOwned(body *ast.BlockStmt, sig *types.Signature) {
	notOwned := map[*types.Var]bool{}
	if sig != nil {
		for i := 0; i < sig.Params().Len(); i++ {
			notOwned[sig.Params().At(i)] = true
		}
	}
	isFreshSlice := func(v *types.Var, e ast.Expr) bool {
		switch r := unparen(e).(type) {
		case *ast.CompositeLit:
			return true
		case *ast.Ident:
			return r.Name == "nil"
		case *ast.CallExpr:
			if id, ok := unparen(r.Fun).(*ast.Ident); ok {
				if b, ok := x.info.Uses[id].(*types.Builtin); ok {
					switch b.Name() {
					case "make":
						return true
					case "append":
						if len(r.Args) > 0 {
							if a, ok := unparen(r.Args[0]).(*ast.Ident); ok && x.info.Uses[a] == v {
								return true
							}
						}
						return false
					}
				}
			}
		}
		return false
	}
	assignTo := func(lhs ast.Expr, rhs ast.Expr, multi bool) {
		id, ok := unparen(lhs).(*ast.Ident)
		if !ok {
			return
		}
		v, _ := x.info.Defs[id].(*types.Var)
		if v == nil {
			v, _ = x.info.Uses[id].(*types.Var)
		}
		if v == nil {
			return
		}
		if _, ok := v.Type().Underlying().(*types.Slice); !ok {
			return
		}
		if multi || rhs == nil || !isFreshSlice(v, rhs) {
			notOwned[v] = true
		}
	}
	ast.Inspect(body, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.AssignStmt:
			if s.Tok != token.DEFINE && s.Tok != token.ASSIGN {
				return true
			}
			if len(s.Lhs) == len(s.Rhs) {
				for i := range s.Lhs {
					assignTo(s.Lhs[i], s.Rhs[i], false)
				}
			} else {
				for _, l := range s.Lhs {
					assignTo(l, nil, true)
				}
			}
		case *ast.ValueSpec:
			for i, id := range s.Names {
				if i < len(s.Values) && len(s.Values) == len(s.Names) {
					assignTo(id, s.Values[i], false)
				} else if len(s.Values) > 0 {
					assignTo(id, nil, true)
				}
			}
		case *ast.RangeStmt:
			if s.Key != nil {
				assignTo(s.Key, nil, true)
			}
			if s.Value != nil {
				assignTo(s.Value, nil, true)
			}
		case *ast.UnaryExpr:
			// &v may let others append to the same array.
			if s.Op == token.AND {
				if id, ok := unparen(s.X).(*ast.Ident); ok {
					if v, ok := x.info.Uses[id].(*types.Var); ok {
						notOwned[v] = true
					}
				}
			}
		}
		return true
	})
	if x.notOwned == nil {
		x.notOwned = map[*types.Var]bool{}
	}
	for v := range notOwned {
		x.notOwned[v] = true
	}
}

// ownedTarget reports whether appending to l may write in place.
func (x *fn) ownedTarget(l ast.Expr) bool {
	switch e := unparen(l).(type) {
	case *ast.Ident:
		v, ok := x.info.Uses[e].(*types.Var)
		if !ok {
			return false
		}
		if v.Pkg() != nil && v.Parent() == v.Pkg().Scope() {
			return true // package variables own their arrays
		}
		return !x.notOwned[v]
	case *ast.SelectorExpr:
		return true // struct fields own their arrays
	}
	return false
}
