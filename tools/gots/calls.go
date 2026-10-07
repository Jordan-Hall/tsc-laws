package main

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"strings"
)

func (x *fn) call(e *ast.CallExpr) string {
	return x.callWithArgs(e, nil)
}

// callWithArgs translates a call; when args is non-nil it holds already
// translated argument text.
func (x *fn) callWithArgs(e *ast.CallExpr, args []string) string {
	fun := unparen(e.Fun)
	// Conversions.
	if tv := x.info.Types[fun]; tv.IsType() {
		return x.conversion(e, tv.Type, args)
	}
	if id, ok := fun.(*ast.Ident); ok {
		if b, ok := x.info.Uses[id].(*types.Builtin); ok {
			return x.builtin(e, b.Name(), args)
		}
	}
	// unsafe.String(unsafe.SliceData(b), n) converts a byte slice.
	if x.isUnsafe(fun, "String") && len(e.Args) == 2 {
		if inner, ok := unparen(e.Args[0]).(*ast.CallExpr); ok && x.isUnsafe(unparen(inner.Fun), "SliceData") {
			return "$rt.bytesToString(" + x.expr(inner.Args[0]) + ")"
		}
		// unsafe.String(&b[0], n)
		if u, ok := unparen(e.Args[0]).(*ast.UnaryExpr); ok && u.Op == token.AND {
			if ix, ok := unparen(u.X).(*ast.IndexExpr); ok {
				if _, isSlice := under(x.info.TypeOf(ix.X)).(*types.Slice); isSlice {
					return "$rt.bytesToString(" + x.expr(ix.X) + ".slice(" + x.expr(ix.Index) + ", " + x.expr(ix.Index) + " + " + x.expr(e.Args[1]) + "))"
				}
			}
		}
	}
	if r, ok := x.suffixCall(fun, e); ok {
		return r
	}
	sig, _ := under(x.info.TypeOf(e.Fun)).(*types.Signature)
	if args == nil {
		args = x.args(e, sig)
	}
	if sel, ok := fun.(*ast.SelectorExpr); ok {
		if s := x.info.Selections[sel]; s != nil && s.Kind() == types.MethodVal {
			recv := x.expr(sel.X)
			return x.methodCallOn(sel, recv, args)
		}
	}
	if z := x.callFactories(fun); len(z) > 0 {
		args = append(z, args...)
	}
	callee := x.expr(e.Fun)
	if _, isLit := fun.(*ast.FuncLit); isLit {
		callee = "(" + callee + ")"
	}
	// Pass inferred type arguments explicitly; TypeScript cannot infer type
	// parameters that only appear in another parameter's constraint.
	if ta := x.inferredTypeArgs(fun); ta != "" {
		callee += ta
	}
	if needsBang(x.info.TypeOf(e.Fun)) && !isFuncObject(x.info, fun) {
		callee += "!"
	}
	return callee + "(" + strings.Join(args, ", ") + ")"
}

func needsBang(t types.Type) bool {
	_, ok := under(t).(*types.Signature)
	return ok
}

// isFuncObject reports whether e names a declared function (never nil).
func isFuncObject(info *types.Info, e ast.Expr) bool {
	switch e := e.(type) {
	case *ast.Ident:
		_, ok := info.Uses[e].(*types.Func)
		return ok
	case *ast.SelectorExpr:
		if _, ok := info.Uses[e.Sel].(*types.Func); ok {
			return true
		}
	case *ast.IndexExpr:
		return isFuncObject(info, e.X)
	case *ast.IndexListExpr:
		return isFuncObject(info, e.X)
	case *ast.FuncLit:
		return true
	}
	return false
}

// args translates call arguments, packing variadic arguments into an array.
func (x *fn) args(e *ast.CallExpr, sig *types.Signature) []string {
	if sig == nil {
		out := make([]string, len(e.Args))
		for i, a := range e.Args {
			out[i] = x.expr(a)
		}
		return out
	}
	// f(g()) where g returns multiple values.
	if len(e.Args) == 1 && sig.Params().Len() > 1 {
		if tuple, ok := x.info.TypeOf(e.Args[0]).(*types.Tuple); ok && tuple.Len() > 1 {
			return []string{"..." + x.expr(e.Args[0])}
		}
	}
	var out []string
	n := sig.Params().Len()
	for i, a := range e.Args {
		if sig.Variadic() && i >= n-1 {
			break
		}
		out = append(out, x.argExpr(e, sig, i, a))
	}
	if sig.Variadic() {
		last := sig.Params().At(n - 1).Type().(*types.Slice)
		if e.Ellipsis.IsValid() {
			a := e.Args[len(e.Args)-1]
			if b, ok := under(x.info.TypeOf(a)).(*types.Basic); ok && b.Info()&types.IsString != 0 {
				out = append(out, "$rt.stringToBytes("+x.expr(a)+")")
			} else {
				out = append(out, x.expr(a))
			}
		} else {
			var rest []string
			for _, a := range e.Args[min(n-1, len(e.Args)):] {
				rest = append(rest, x.valueExpr(a, last.Elem()))
			}
			if len(rest) == 0 {
				out = append(out, "([] as "+x.f.arrayOf(last.Elem())+")")
			} else {
				out = append(out, "["+strings.Join(rest, ", ")+"]")
			}
		}
	}
	return out
}

func (x *fn) argExpr(e *ast.CallExpr, sig *types.Signature, i int, a ast.Expr) string {
	if sig == nil {
		return x.expr(a)
	}
	n := sig.Params().Len()
	var pt types.Type
	if sig.Variadic() && i >= n-1 {
		pt = sig.Params().At(n - 1).Type().(*types.Slice).Elem()
	} else if i < n {
		pt = sig.Params().At(i).Type()
	}
	return x.valueExpr(a, pt)
}

func (x *fn) conversion(e *ast.CallExpr, to types.Type, args []string) string {
	arg := e.Args[0]
	from := x.info.TypeOf(arg)
	var v string
	if args != nil {
		v = args[0]
	} else {
		v = x.expr(arg)
	}
	if tv := x.info.Types[e]; tv.Value != nil {
		return x.f.constValue(tv.Value, tv.Type)
	}
	if isNilType(from) {
		return x.f.nilFor(to)
	}
	if isIfaceType(to) {
		if isIfaceType(from) {
			return v
		}
		return x.box(v, from)
	}
	tu, fu := under(to), under(from)
	tb, tIsBasic := tu.(*types.Basic)
	fb, fIsBasic := fu.(*types.Basic)
	switch {
	case tIsBasic && tb.Info()&types.IsString != 0:
		if fIsBasic && fb.Info()&types.IsInteger != 0 {
			return "$rt.runeToString(" + v + ")"
		}
		if sl, ok := fu.(*types.Slice); ok {
			if eb, ok := sl.Elem().Underlying().(*types.Basic); ok && (eb.Kind() == types.Int32) {
				return "$rt.runesToString(" + v + ")"
			}
			return "$rt.bytesToString(" + v + ")"
		}
		return v
	case tIsBasic && tb.Info()&types.IsInteger != 0:
		if fIsBasic && fb.Info()&types.IsFloat != 0 {
			return x.wrap("Math.trunc("+v+")", to)
		}
		if fIsBasic && fb.Info()&types.IsInteger != 0 {
			if sameIntRange(tb.Kind(), fb.Kind()) {
				return v
			}
			return x.wrap(v, to)
		}
		return v
	case tIsBasic && tb.Info()&types.IsFloat != 0:
		if tb.Kind() == types.Float32 {
			return "Math.fround(" + v + ")"
		}
		return v
	}
	if sl, ok := tu.(*types.Slice); ok && fIsBasic && fb.Info()&types.IsString != 0 {
		if eb, ok := sl.Elem().Underlying().(*types.Basic); ok && eb.Kind() == types.Int32 {
			return "$rt.stringToRunes(" + v + ")"
		}
		return "$rt.stringToBytes(" + v + ")"
	}
	if x.f.needsCopy(from) && !fresh(arg) {
		return v + x.f.cloneCall(from)
	}
	return v
}

func sameIntRange(a, b types.BasicKind) bool {
	if a == b {
		return true
	}
	wide := func(k types.BasicKind) bool { return is64(k) }
	if wide(a) && wide(b) {
		return true
	}
	if is64(a) && (b == types.Int8 || b == types.Int16 || b == types.Int32 || b == types.Uint8 || b == types.Uint16 || b == types.Uint32) {
		return true
	}
	return false
}

func (x *fn) builtin(e *ast.CallExpr, name string, pre []string) string {
	arg := func(i int) string {
		if pre != nil {
			return pre[i]
		}
		return x.expr(e.Args[i])
	}
	switch name {
	case "len":
		if vw := x.viewOf(e.Args[0]); vw != nil {
			return vw.n
		}
		t := under(x.info.TypeOf(e.Args[0]))
		switch t.(type) {
		case *types.Map:
			return "$rt.mapLen(" + arg(0) + ")"
		case *types.Pointer:
			return arg(0) + "!.get().length"
		case *types.Chan:
			return x.unsupportedExpr(e, x.f.t.stub(e.Pos(), "len of channel"))
		}
		return arg(0) + ".length"
	case "cap":
		return arg(0) + ".length"
	case "append":
		if len(e.Args) == 1 {
			return arg(0)
		}
		st := under(x.info.TypeOf(e)).(*types.Slice)
		if e.Ellipsis.IsValid() {
			src := x.expr(e.Args[1])
			if b, ok := under(x.info.TypeOf(e.Args[1])).(*types.Basic); ok && b.Info()&types.IsString != 0 {
				src = "$rt.stringToBytes(" + src + ")"
			}
			return "$rt.appendCopy(" + arg(0) + ", " + src + ")"
		}
		var vals []string
		for _, a := range e.Args[1:] {
			vals = append(vals, x.valueExpr(a, st.Elem()))
		}
		return "$rt.appendCopy(" + arg(0) + ", [" + strings.Join(vals, ", ") + "])"
	case "make":
		t := x.info.TypeOf(e.Args[0])
		switch u := under(t).(type) {
		case *types.Slice:
			if len(e.Args) == 1 {
				return "([] as " + x.f.arrayOf(u.Elem()) + ")"
			}
			n := x.expr(e.Args[1])
			if n == "0" {
				return "([] as " + x.f.arrayOf(u.Elem()) + ")"
			}
			z := x.f.zero(u.Elem())
			if strings.HasPrefix(z, "new ") {
				return fmt.Sprintf("$rt.makeSliceFn<%s>(%s, () => %s)", x.f.tsType(u.Elem()), n, z)
			}
			return fmt.Sprintf("$rt.makeSlice<%s>(%s, %s)", x.f.tsType(u.Elem()), n, z)
		case *types.Map:
			return "new Map<" + x.f.keyType(u.Key()) + ", " + x.f.tsType(u.Elem()) + ">()"
		case *types.Chan:
			return x.unsupportedExpr(e, x.f.t.stub(e.Pos(), "make channel"))
		}
	case "new":
		t := x.info.TypeOf(e.Args[0])
		if isStructType(t) {
			return x.f.zero(t)
		}
		return "new $rt.Ptr<" + x.f.tsType(t) + ">(" + x.f.zero(t) + ")"
	case "delete":
		t := under(x.info.TypeOf(e.Args[0])).(*types.Map)
		return arg(0) + "?.delete(" + x.mapKey(e.Args[1], t.Key()) + ")"
	case "copy":
		src := arg(1)
		if b, ok := under(x.info.TypeOf(e.Args[1])).(*types.Basic); ok && b.Info()&types.IsString != 0 {
			src = "$rt.stringToBytes(" + src + ")"
		}
		return "$rt.copySlice(" + arg(0) + ", " + src + ")"
	case "panic":
		return "$rt.panicValue(" + x.valueExpr(e.Args[0], types.NewInterfaceType(nil, nil)) + ")"
	case "recover":
		return "$rt.recover()"
	case "min", "max":
		var parts []string
		for i := range e.Args {
			parts = append(parts, arg(i))
		}
		if b, ok := under(x.info.TypeOf(e)).(*types.Basic); ok && b.Info()&types.IsString != 0 {
			return "$rt.str" + strings.ToUpper(name[:1]) + name[1:] + "([" + strings.Join(parts, ", ") + "])"
		}
		return "Math." + name + "(" + strings.Join(parts, ", ") + ")"
	case "clear":
		t := under(x.info.TypeOf(e.Args[0]))
		if _, ok := t.(*types.Map); ok {
			return "$rt.clearMap(" + arg(0) + ")"
		}
		sl := t.(*types.Slice)
		return "$rt.clearSlice(" + arg(0) + ", " + x.f.zero(sl.Elem()) + ")"
	case "print", "println":
		var parts []string
		for i := range e.Args {
			parts = append(parts, arg(i))
		}
		return "console.error(" + strings.Join(parts, ", ") + ")"
	}
	return x.unsupportedExpr(e, x.f.t.stub(e.Pos(), "builtin "+name))
}

// callFactories returns zero-factory arguments for a call of a generic
// function that needs them.
func (x *fn) callFactories(fun ast.Expr) []string {
	var id *ast.Ident
	switch f := fun.(type) {
	case *ast.Ident:
		id = f
	case *ast.SelectorExpr:
		id = f.Sel
	case *ast.IndexExpr:
		return x.callFactories(f.X)
	case *ast.IndexListExpr:
		return x.callFactories(f.X)
	}
	if id == nil {
		return nil
	}
	obj, ok := x.info.Uses[id].(*types.Func)
	if !ok {
		return nil
	}
	inst, ok := x.info.Instances[id]
	if !ok {
		return nil
	}
	return x.f.factoryArgs(obj.Origin(), inst.TypeArgs)
}

func (x *fn) isUnsafe(fun ast.Expr, name string) bool {
	sel, ok := fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != name {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	if !ok {
		return false
	}
	pn, ok := x.info.Uses[id].(*types.PkgName)
	return ok && pn.Imported().Path() == "unsafe"
}

// suffixCall rewrites library calls whose first argument is a string suffix
// s[i:] to offset-based helpers, avoiding a copy of the rest of the string.
func (x *fn) suffixCall(fun ast.Expr, e *ast.CallExpr) (string, bool) {
	sel, ok := fun.(*ast.SelectorExpr)
	if !ok || len(e.Args) == 0 {
		return "", false
	}
	id, ok := sel.X.(*ast.Ident)
	if !ok {
		return "", false
	}
	pn, ok := x.info.Uses[id].(*types.PkgName)
	if !ok {
		return "", false
	}
	sl, ok := unparen(e.Args[0]).(*ast.SliceExpr)
	if !ok || sl.High != nil || sl.Low == nil || sl.Slice3 {
		return "", false
	}
	if b, ok := under(x.info.TypeOf(sl.X)).(*types.Basic); !ok || b.Info()&types.IsString == 0 {
		return "", false
	}
	str, off := x.expr(sl.X), x.expr(sl.Low)
	switch pn.Imported().Path() + "." + sel.Sel.Name {
	case "unicode/utf8.DecodeRuneInString":
		return "$rt.utf8_DecodeRuneInStringAt(" + str + ", " + off + ")", true
	case "strings.HasPrefix":
		return str + ".startsWith(" + x.expr(e.Args[1]) + ", " + off + ")", true
	case "strings.Index":
		return "$rt.strings_IndexFrom(" + str + ", " + off + ", " + x.expr(e.Args[1]) + ")", true
	case "strings.IndexByte":
		return "$rt.strings_IndexByteFrom(" + str + ", " + off + ", " + x.expr(e.Args[1]) + ")", true
	}
	return "", false
}

func (x *fn) inferredTypeArgs(fun ast.Expr) string {
	var id *ast.Ident
	switch f := fun.(type) {
	case *ast.Ident:
		id = f
	case *ast.SelectorExpr:
		id = f.Sel
	default:
		return ""
	}
	inst, ok := x.info.Instances[id]
	if !ok || inst.TypeArgs == nil || inst.TypeArgs.Len() == 0 {
		return ""
	}
	fn, ok := x.info.Uses[id].(*types.Func)
	if !ok || fn.Pkg() == nil || !x.f.t.translated(fn.Pkg()) {
		return ""
	}
	return x.f.typeArgs(inst.TypeArgs)
}
