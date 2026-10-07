package main

import (
	"go/ast"
	"go/token"
	"go/types"
)

// String views: a local `v := s[a:b]` that is never reassigned and only
// used as len(v), v[i] or v[i:j] is translated as offsets into s, because
// TypeScript substrings copy while Go substrings are views.

type view struct {
	base, off, n string // TypeScript names holding the base string, offset and length
	bytes        string // byte array of the base, when it is a shadowed field
}

func (x *fn) findViews(body *ast.BlockStmt) {
	candidates := map[*types.Var]*ast.AssignStmt{}
	ast.Inspect(body, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok || as.Tok != token.DEFINE || len(as.Lhs) != 1 || len(as.Rhs) != 1 {
			return true
		}
		id, ok := as.Lhs[0].(*ast.Ident)
		if !ok {
			return true
		}
		v, ok := x.info.Defs[id].(*types.Var)
		if !ok {
			return true
		}
		sl, ok := unparen(as.Rhs[0]).(*ast.SliceExpr)
		if !ok || sl.Slice3 || !simpleExpr(sl.X) {
			return true
		}
		if b, ok := under(x.info.TypeOf(sl.X)).(*types.Basic); !ok || b.Info()&types.IsString == 0 {
			return true
		}
		candidates[v] = as
		return true
	})
	if len(candidates) == 0 {
		return
	}
	bad := map[*types.Var]bool{}
	// Check every use, tracking the parent node.
	var stack []ast.Node
	ast.Inspect(body, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return true
		}
		if id, ok := n.(*ast.Ident); ok {
			if v, ok := x.info.Uses[id].(*types.Var); ok && candidates[v] != nil {
				parent := stack[len(stack)-1]
				okUse := false
				switch p := parent.(type) {
				case *ast.CallExpr:
					okUse = x.isBuiltin(p, "len")
				case *ast.IndexExpr:
					okUse = p.X == id
				case *ast.SliceExpr:
					okUse = p.X == id && !p.Slice3
				}
				if !okUse {
					bad[v] = true
				}
			}
		}
		if fl, ok := n.(*ast.FuncLit); ok {
			// Uses inside closures are fine; the view names are captured.
			_ = fl
		}
		stack = append(stack, n)
		return true
	})
	// The base must not be assigned anywhere in the function.
	for v, as := range candidates {
		if bad[v] {
			continue
		}
		base := types.ExprString(unparen(as.Rhs[0]).(*ast.SliceExpr).X)
		ast.Inspect(body, func(n ast.Node) bool {
			if a, ok := n.(*ast.AssignStmt); ok && a != as {
				for _, l := range a.Lhs {
					if types.ExprString(l) == base {
						bad[v] = true
					}
				}
			}
			return true
		})
		if !bad[v] {
			if x.views == nil {
				x.views = map[*types.Var]*view{}
			}
			name := x.name(v)
			x.views[v] = &view{base: name + "$b", off: name + "$o", n: name + "$n"}
		}
	}
}

// viewOf returns the view for an identifier expression, if any.
func (x *fn) viewOf(e ast.Expr) *view {
	id, ok := unparen(e).(*ast.Ident)
	if !ok || x.views == nil {
		return nil
	}
	if v, ok := x.info.Uses[id].(*types.Var); ok {
		return x.views[v]
	}
	return nil
}

// defineView emits the declaration of a view.
func (x *fn) defineView(vw *view, sl *ast.SliceExpr) {
	base := x.expr(sl.X)
	lo := "0"
	if sl.Low != nil {
		lo = x.expr(sl.Low)
	}
	x.flushPre()
	if sh := x.shadowOf(sl.X); sh != "" {
		vw.bytes = vw.base + "y"
		x.line("const %s = %s;", vw.bytes, sh)
	}
	x.line("const %s = %s;", vw.base, base)
	x.line("const %s = %s;", vw.off, lo)
	if sl.High != nil {
		x.line("const %s = %s - %s;", vw.n, x.expr(sl.High), vw.off)
	} else {
		x.line("const %s = %s.length - %s;", vw.n, vw.base, vw.off)
	}
}
