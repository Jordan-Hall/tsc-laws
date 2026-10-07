package main

import (
	"go/ast"
	"go/token"
	"go/types"
)

// Locals that are never assigned after their definition are declared with
// const: scriptc keeps const references without the reference counting a
// mutable let slot costs (several times faster for loop variables).

// findAssigned records the variables assigned in body after definition.
func (x *fn) findAssigned(body *ast.BlockStmt) {
	if x.assigned == nil {
		x.assigned = map[*types.Var]bool{}
	}
	mark := func(e ast.Expr) {
		if id, ok := unparen(e).(*ast.Ident); ok {
			if v, ok := x.info.Uses[id].(*types.Var); ok {
				x.assigned[v] = true
			}
		}
	}
	ast.Inspect(body, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.AssignStmt:
			// := also assigns the variables it redeclares (in Uses).
			for _, l := range s.Lhs {
				mark(l)
			}
		case *ast.IncDecStmt:
			mark(s.X)
		case *ast.RangeStmt:
			if s.Tok == token.ASSIGN {
				if s.Key != nil {
					mark(s.Key)
				}
				if s.Value != nil {
					mark(s.Value)
				}
			}
		case *ast.UnaryExpr:
			if s.Op == token.AND {
				mark(s.X)
			}
		}
		return true
	})
}

// declKeyword is const for a variable never assigned after its definition.
func (x *fn) declKeyword(v *types.Var) string {
	// Atomic values are assigned through their methods.
	if v == nil || x.assigned == nil || x.assigned[v] || x.views[v] != nil || atomicGlobal[v.Origin()] {
		return "let"
	}
	return "const"
}
