package main

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"strings"
)

func (x *fn) call(e *ast.CallExpr) string {
	s := x.callWithArgs(e, nil)
	if x.isStdFunc(unparen(e.Fun)) {
		return x.stdCast(s, x.info.TypeOf(e))
	}
	return s
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
	// slices.Contains and slices.Index compare struct elements by value.
	if (x.isPkgFunc(fun, "slices", "Contains") || x.isPkgFunc(fun, "slices", "Index")) && len(e.Args) == 2 && args == nil {
		if st, ok := under(x.info.TypeOf(e.Args[0])).(*types.Slice); ok && isStructType(st.Elem()) {
			et := x.f.tsType(st.Elem())
			eq := x.equalText("a", st.Elem(), "b", st.Elem(), nil)
			call := fmt.Sprintf("$rt.slices_IndexEq(%s, %s, (a: %s, b: %s) => %s)", x.expr(e.Args[0]), x.expr(e.Args[1]), et, et, eq)
			if x.isPkgFunc(fun, "slices", "Contains") {
				return "(" + call + " >= 0)"
			}
			return call
		}
	}
	// fmt.Fprint* to a writer translated code implements: format, then Write.
	for _, fn := range []string{"Fprintf", "Fprintln", "Fprint"} {
		if x.isPkgFunc(fun, "fmt", fn) && len(e.Args) > 0 && args == nil && isIfaceType(x.info.TypeOf(e.Args[0])) && x.ifaceHasClasses(x.info.TypeOf(e.Args[0])) {
			w := x.expr(e.Args[0])
			rest := &ast.CallExpr{Fun: e.Fun, Args: e.Args[1:], Ellipsis: e.Ellipsis}
			sig := x.info.TypeOf(e.Fun).(*types.Signature)
			var params []*types.Var
			for i := 1; i < sig.Params().Len(); i++ {
				params = append(params, sig.Params().At(i))
			}
			restArgs := x.args(rest, types.NewSignatureType(nil, nil, nil, types.NewTuple(params...), sig.Results(), sig.Variadic()))
			sprint := "$rt.fmt_S" + strings.TrimPrefix(fn, "F") + "(" + strings.Join(restArgs, ", ") + ")"
			return "$rt.nn(" + w + ").Write($rt.stringToBytes(" + sprint + "))"
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
	// maps.Keys/Values/Clone/Copy on struct-keyed maps.
	if sel, ok := fun.(*ast.SelectorExpr); ok && len(e.Args) > 0 {
		if id, ok := sel.X.(*ast.Ident); ok {
			if pn, ok := x.info.Uses[id].(*types.PkgName); ok && pn.Imported().Path() == "maps" {
				if m, ok := under(x.info.TypeOf(e.Args[0])).(*types.Map); ok && isSpecialMap(m) {
					var as []string
					for _, a := range e.Args {
						as = append(as, x.expr(a))
					}
					return "$rt.structMap_" + sel.Sel.Name + "(" + strings.Join(as, ", ") + ")"
				}
			}
		}
	}
	sig, _ := under(x.info.TypeOf(e.Fun)).(*types.Signature)
	if args == nil {
		args = x.args(e, sig)
	}
	if x.isStdFunc(fun) {
		defer func() {}()
	}
	if sel, ok := fun.(*ast.SelectorExpr); ok {
		if s := x.info.Selections[sel]; s != nil && s.Kind() == types.MethodVal {
			if call, ok := x.atomicCall(sel, args); ok {
				return call
			}
			recv := x.expr(sel.X)
			// (*T)(nil).M(): the method only uses the receiver's type.
			if conv, ok := unparen(sel.X).(*ast.CallExpr); ok && len(conv.Args) == 1 && isNilType(x.info.TypeOf(conv.Args[0])) {
				if p, ok := x.info.TypeOf(sel.X).(*types.Pointer); ok && isStructType(p.Elem()) {
					recv = x.f.zero(p.Elem())
				}
			}
			return x.methodCallOn(sel, recv, args)
		}
	}
	if z := x.callFactories(fun); len(z) > 0 {
		args = append(z, args...)
	}
	callee := x.expr(e.Fun)
	// Calls pass factories themselves, so use the bare instantiation.
	switch g := fun.(type) {
	case *ast.IndexExpr:
		if isGenericFunc(x.info, g.X) {
			callee = x.genericRef(g.X, []ast.Expr{g.Index})
		}
	case *ast.IndexListExpr:
		callee = x.genericRef(g.X, g.Indices)
	}
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
			if !sig.Variadic() {
				return []string{"..." + x.expr(e.Args[0])}
			}
			// f(g()) with variadic f: pack g's trailing results into the slice.
			n := sig.Params().Len()
			t := x.tmp()
			var fixed, rest []string
			for i := 0; i < tuple.Len(); i++ {
				el := fmt.Sprintf("%s[%d]", t, i)
				if i < n-1 {
					fixed = append(fixed, x.convertValue(el, nil, tuple.At(i).Type(), sig.Params().At(i).Type()))
				} else {
					elem := sig.Params().At(n - 1).Type().(*types.Slice).Elem()
					rest = append(rest, x.convertValue(el, nil, tuple.At(i).Type(), elem))
				}
			}
			x.pre = append(x.pre, fmt.Sprintf("const %s = %s;\n", t, x.expr(e.Args[0])))
			return append(fixed, "["+strings.Join(rest, ", ")+"]")
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
	if pt != nil && x.f.needsCopy(pt) && x.borrowedParam(e, i) {
		return x.expr(a)
	}
	// A struct pointer passed where the generic function takes *T as a Ptr.
	if fn := staticCallee(x.info, e); fn != nil && i < n {
		op := fn.Type().(*types.Signature).Params().At(i).Type()
		if p, ok := op.(*types.Pointer); ok {
			if tp, ok := p.Elem().(*types.TypeParam); ok && !structTPGlobal[tp.Obj()] && isPtrToStruct(x.info.TypeOf(a)) {
				return "$rt.ptrToObject(" + x.expr(a) + ")"
			}
		}
	}
	return x.valueExpr(a, pt)
}

func (x *fn) conversion(e *ast.CallExpr, to types.Type, args []string) string {
	if _, isTP := types.Unalias(to).(*types.TypeParam); isTP && !isIfaceType(to) {
		return "(" + x.conversionInner(e, to, args) + " as unknown as " + x.f.tsType(to) + ")"
	}
	return x.conversionInner(e, to, args)
}

func (x *fn) conversionInner(e *ast.CallExpr, to types.Type, args []string) string {
	if from := x.info.TypeOf(e.Args[0]); isWide(to) != isWide(from) && x.info.Types[e].Value == nil {
		v := x.expr(e.Args[0])
		if args != nil {
			v = args[0]
		}
		if isWide(to) {
			return "BigInt(" + v + ")"
		}
		return x.wrap("Number("+v+")", to)
	}
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
		if sh := x.shadowOf(e.Args[0]); sh != "" {
			return sh + ".length"
		}
		t := under(x.info.TypeOf(e.Args[0]))
		switch tm := t.(type) {
		case *types.Map:
			if isSpecialMap(tm) {
				return "$rt.structMapLen(" + arg(0) + ")"
			}
			return "$rt.mapLen(" + arg(0) + ")"
		case *types.Pointer:
			if isArrayPtr(x.info.TypeOf(e.Args[0])) {
				return arg(0) + "!.length"
			}
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
			return x.f.newMap(u)
		case *types.Chan:
			size := "0"
			if len(e.Args) > 1 {
				size = arg(1)
			}
			return fmt.Sprintf("new $rt.Chan<%s>(%s, %s)", x.f.tsType(u.Elem()), size, x.f.zero(u.Elem()))
		}
	case "new":
		t := x.info.TypeOf(e.Args[0])
		if isStructType(t) || isArrayType(t) {
			return x.f.zero(t)
		}
		return "new $rt.Ptr<" + x.f.tsType(t) + ">(" + x.f.zero(t) + ")"
	case "delete":
		t := under(x.info.TypeOf(e.Args[0])).(*types.Map)
		return arg(0) + "?.delete(" + x.mapKey(e.Args[1], t.Key()) + ")"
	case "copy":
		if sl, ok := unparen(e.Args[0]).(*ast.SliceExpr); ok && !sl.Slice3 {
			if _, isStr := under(x.info.TypeOf(sl.X)).(*types.Basic); !isStr {
				src := x.expr(e.Args[1])
				if b, ok := under(x.info.TypeOf(e.Args[1])).(*types.Basic); ok && b.Info()&types.IsString != 0 {
					src = "$rt.stringToBytes(" + src + ")"
				}
				lo, hi := "0", "-1"
				if sl.Low != nil {
					lo = x.expr(sl.Low)
				}
				if sl.High != nil {
					hi = x.expr(sl.High)
				}
				return "$rt.copyAt(" + x.expr(sl.X) + ", " + lo + ", " + hi + ", " + src + ")"
			}
		}
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
	case "close":
		return arg(0) + "!.close()"
	case "clear":
		t := under(x.info.TypeOf(e.Args[0]))
		if m, ok := t.(*types.Map); ok {
			if isSpecialMap(m) {
				return arg(0) + "?.clear()"
			}
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

func (x *fn) isPkgFunc(fun ast.Expr, path, name string) bool {
	sel, ok := fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != name {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	if !ok {
		return false
	}
	pn, ok := x.info.Uses[id].(*types.PkgName)
	return ok && pn.Imported().Path() == path
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
	// binary.LittleEndian.PutUintN(b[i:], v) writes into b in place.
	if inner, ok := sel.X.(*ast.SelectorExpr); ok && inner.Sel.Name == "LittleEndian" && strings.HasPrefix(sel.Sel.Name, "PutUint") && len(e.Args) == 2 {
		if sl, ok := unparen(e.Args[0]).(*ast.SliceExpr); ok && sl.Low != nil {
			return "$rt.put" + strings.TrimPrefix(sel.Sel.Name, "Put") + "LE(" + x.expr(sl.X) + ", " + x.expr(sl.Low) + ", " + x.expr(e.Args[1]) + ")", true
		}
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
		if sh := x.shadowOf(sl.X); sh != "" {
			return "$rt.utf8_DecodeRuneBytesAt(" + sh + ", " + off + ")", true
		}
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

// stdCast converts a value produced by library code to the type translated
// code uses, when the runtime declares it differently (library interfaces
// that translated types implement are GoObject in the runtime).
func (x *fn) stdCast(text string, tt types.Type) string {
	if tt == nil {
		return text
	}
	normal := x.f.tsType(tt)
	x.f.runtime = true
	rt := x.f.tsType(tt)
	x.f.runtime = false
	if normal == rt {
		return text
	}
	// scriptc can't convert a tuple element by casting the whole tuple;
	// narrow the elements that differ one at a time.
	if tuple, ok := tt.(*types.Tuple); ok {
		p := x.tmp()
		elems := make([]string, tuple.Len())
		for i := range elems {
			elem := fmt.Sprintf("%s[%d]", p, i)
			et := tuple.At(i).Type()
			x.f.runtime = true
			ert := x.f.tsType(et)
			x.f.runtime = false
			if x.f.tsType(et) == ert {
				elems[i] = elem
			} else if s := x.unionNarrow(elem, et, "undefined"); s != "" {
				elems[i] = s
			} else {
				t := x.f.tsType(et)
				elems[i] = fmt.Sprintf("(%s === undefined ? undefined : $rt.unsupportedConversion<%s>(%q))", elem, t, t)
			}
		}
		return fmt.Sprintf("((%s: %s): %s => [%s])(%s)", p, rt, normal, strings.Join(elems, ", "), text)
	}
	return "(" + text + " as unknown as " + normal + ")"
}

// unionNarrow narrows interface value v to tt when tt is represented as a
// union of classes, or returns "". scriptc narrows only parameters, and one
// class per instanceof test, so v passes through a function whose tests
// each yield one class; fallback is the value when none matches.
func (x *fn) unionNarrow(v string, tt types.Type, fallback string) string {
	it, ok := tt.Underlying().(*types.Interface)
	if !ok || it.NumMethods() == 0 {
		return ""
	}
	n, _ := types.Unalias(tt).(*types.Named)
	var m *ifaceMap
	if n != nil {
		m = x.f.t.ifaces[n.Origin().Obj()]
	} else {
		m = x.f.t.anonIfaces[types.TypeString(it, nil)]
	}
	if m == nil || m.stub || m.base != nil || len(m.union) == 0 || !x.ifaceClassesReachable(n, it) {
		return ""
	}
	p := x.tmp()
	t := x.f.tsType(tt)
	var b strings.Builder
	fmt.Fprintf(&b, "((%s: $rt.GoObject | undefined): %s => ", p, t)
	for _, u := range m.union {
		var class string
		if ptr, ok := u.(*types.Pointer); ok {
			class = x.f.qualify(ptr.Elem().(*types.Named).Obj())
		} else {
			class = x.f.boxRef(u.(*types.Named).Obj())
		}
		fmt.Fprintf(&b, "%s instanceof %s ? %s : ", p, class, p)
	}
	fmt.Fprintf(&b, "%s)(%s)", fallback, v)
	return b.String()
}

func (x *fn) isStdFunc(fun ast.Expr) bool {
	var id *ast.Ident
	switch f := fun.(type) {
	case *ast.Ident:
		id = f
	case *ast.SelectorExpr:
		id = f.Sel
	default:
		return false
	}
	fn, ok := x.info.Uses[id].(*types.Func)
	return ok && fn.Pkg() != nil && !x.f.t.translated(fn.Pkg())
}
