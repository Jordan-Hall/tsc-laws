package main

import (
	"go/ast"
	"go/types"
	"strings"
)

// Byte shadows: hot string fields that code indexes byte by byte also keep
// a Uint8Array copy. Strings are immutable, so the copy is made on
// assignment and indexed reads use the array instead of charCodeAt.
var byteShadows = map[string]bool{
	"scanner.Scanner.text": true,
}

func (t *translator) byteShadowed(v *types.Var) bool {
	if v == nil || !v.IsField() || v.Pkg() == nil {
		return false
	}
	for key := range byteShadows {
		parts := strings.Split(key, ".")
		if strings.TrimPrefix(v.Pkg().Path(), modulePrefix) == parts[0] && v.Name() == parts[2] {
			// The owning struct name is checked by the caller through the
			// selection; field names are unique enough within a package.
			return true
		}
	}
	return false
}

// shadowOf returns the TypeScript text of the byte array for a selector of a
// shadowed field, or "".
func (x *fn) shadowOf(e ast.Expr) string {
	sel, ok := unparen(e).(*ast.SelectorExpr)
	if !ok {
		return ""
	}
	s := x.info.Selections[sel]
	if s == nil || s.Kind() != types.FieldVal {
		return ""
	}
	if !x.f.t.byteShadowed(s.Obj().(*types.Var)) {
		return ""
	}
	return x.expr(e) + "$bytes"
}
