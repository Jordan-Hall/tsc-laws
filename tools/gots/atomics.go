package main

import (
	"fmt"
	"go/ast"
	"go/types"
)

// Atomic values: the translation is single-threaded, so sync/atomic
// variables that are only used through their methods become plain numbers
// and booleans, saving an object per field (every AST node and symbol has
// an atomic id).

var atomicGlobal map[*types.Var]bool

var atomicMethods = map[string]bool{"Load": true, "Store": true, "Add": true, "CompareAndSwap": true, "Swap": true}

// atomicKind returns "number" or "boolean" for a sync/atomic value type.
func atomicKind(tt types.Type) string {
	n, ok := types.Unalias(tt).(*types.Named)
	if !ok || n.Obj().Pkg() == nil || n.Obj().Pkg().Path() != "sync/atomic" {
		return ""
	}
	switch n.Obj().Name() {
	case "Bool":
		return "boolean"
	case "Int32", "Int64", "Uint32", "Uint64":
		return "number"
	}
	return ""
}

func (t *translator) findAtomics() {
	ok := map[*types.Var]bool{}
	bad := map[*types.Var]bool{}
	for _, p := range t.order {
		info := p.p.TypesInfo
		varOf := func(e ast.Expr) *types.Var {
			var v *types.Var
			switch e := unparen(e).(type) {
			case *ast.Ident:
				v, _ = info.Uses[e].(*types.Var)
			case *ast.SelectorExpr:
				if sel := info.Selections[e]; sel != nil && sel.Kind() == types.FieldVal {
					v, _ = sel.Obj().(*types.Var)
				} else if sel == nil {
					v, _ = info.Uses[e.Sel].(*types.Var)
				}
			}
			if v == nil || atomicKind(v.Type()) == "" {
				return nil
			}
			return v.Origin()
		}
		for _, f := range p.p.Syntax {
			// Uses as method receivers are fine; any other use disqualifies.
			allowed := map[ast.Expr]bool{}
			ast.Inspect(f, func(n ast.Node) bool {
				// defer and go evaluate the receiver early; keep the object.
				var deferred *ast.CallExpr
				switch s := n.(type) {
				case *ast.DeferStmt:
					deferred = s.Call
				case *ast.GoStmt:
					deferred = s.Call
				}
				if deferred != nil {
					if sel, isSel := deferred.Fun.(*ast.SelectorExpr); isSel {
						if v := varOf(sel.X); v != nil {
							bad[v] = true
						}
					}
				}
				if call, isCall := n.(*ast.CallExpr); isCall {
					if sel, isSel := call.Fun.(*ast.SelectorExpr); isSel && atomicMethods[sel.Sel.Name] {
						if v := varOf(sel.X); v != nil {
							allowed[sel.X] = true
							ok[v] = true
							if v.Parent() == v.Pkg().Scope() && v.Pkg() != p.p.Types {
								bad[v] = true // package variables are assigned only by their module
							}
						}
					}
				}
				return true
			})
			ast.Inspect(f, func(n ast.Node) bool {
				e, isExpr := n.(ast.Expr)
				if !isExpr || allowed[e] {
					// Don't descend: the receiver's own sub-expressions are not uses.
					return !allowed[e]
				}
				if _, isIdent := e.(*ast.Ident); !isIdent {
					if _, isSel := e.(*ast.SelectorExpr); !isSel {
						return true
					}
				}
				if v := varOf(e); v != nil {
					if id, isIdent := e.(*ast.Ident); isIdent && info.Defs[id] != nil {
						return true
					}
					bad[v] = true
				}
				return true
			})
		}
	}
	atomicGlobal = map[*types.Var]bool{}
	for v := range ok {
		if !bad[v] {
			atomicGlobal[v] = true
		}
	}
}

// atomicVar returns the atomic value variable that e names, if any.
func (x *fn) atomicVar(e ast.Expr) *types.Var {
	var v *types.Var
	switch e := unparen(e).(type) {
	case *ast.Ident:
		v, _ = x.info.Uses[e].(*types.Var)
	case *ast.SelectorExpr:
		if sel := x.info.Selections[e]; sel != nil && sel.Kind() == types.FieldVal {
			v, _ = sel.Obj().(*types.Var)
		} else if sel == nil {
			v, _ = x.info.Uses[e.Sel].(*types.Var)
		}
	}
	if v == nil || !atomicGlobal[v.Origin()] {
		return nil
	}
	return v
}

// atomicCall renders a method call on an atomic value variable.
func (x *fn) atomicCall(sel *ast.SelectorExpr, args []string) (string, bool) {
	v := x.atomicVar(sel.X)
	if v == nil {
		return "", false
	}
	r := x.rawExpr(sel.X)
	wrap := func(s string) string {
		switch types.Unalias(v.Type()).(*types.Named).Obj().Name() {
		case "Int32":
			return "(" + s + ") | 0"
		case "Uint32":
			return "(" + s + ") >>> 0"
		}
		return s
	}
	switch sel.Sel.Name {
	case "Load":
		return r, true
	case "Store":
		return fmt.Sprintf("(%s = %s)", r, args[0]), true
	case "Add":
		return fmt.Sprintf("(%s = %s)", r, wrap(r+" + "+args[0])), true
	case "Swap":
		return fmt.Sprintf("$rt.swapValue(%s, (v) => { %s = v; }, %s)", r, r, args[0]), true
	case "CompareAndSwap":
		return fmt.Sprintf("(%s === %s ? ((%s = %s), true) : false)", r, args[0], r, args[1]), true
	}
	return "", false
}

// atomicZero is the zero value of an atomic value variable.
func atomicZero(v *types.Var) string {
	if atomicKind(v.Type()) == "boolean" {
		return "false"
	}
	return "0"
}
