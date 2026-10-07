package main

import (
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"sort"
	"strings"
)

// expr translates an expression without target-type conversion.
func (x *fn) expr(e ast.Expr) string {
	tv := x.info.Types[e]
	if tv.Value != nil && !tv.IsType() {
		return x.f.constValue(tv.Value, tv.Type)
	}
	switch e := e.(type) {
	case *ast.ParenExpr:
		return "(" + x.expr(e.X) + ")"
	case *ast.Ident:
		return x.ident(e)
	case *ast.BasicLit:
		return x.f.constValue(constant.MakeFromLiteral(e.Value, e.Kind, 0), tv.Type)
	case *ast.SelectorExpr:
		return x.selector(e)
	case *ast.CallExpr:
		return x.call(e)
	case *ast.IndexExpr:
		return x.index(e)
	case *ast.IndexListExpr:
		return x.genericRef(e.X, e.Indices)
	case *ast.SliceExpr:
		return x.slice(e)
	case *ast.StarExpr:
		return x.deref(e)
	case *ast.UnaryExpr:
		return x.unary(e)
	case *ast.BinaryExpr:
		return x.binary(e)
	case *ast.CompositeLit:
		return x.composite(e, tv.Type)
	case *ast.FuncLit:
		return x.funcLit(e)
	case *ast.TypeAssertExpr:
		return x.typeAssert(e)
	case *ast.KeyValueExpr:
		return x.expr(e.Value)
	}
	return "$rt.unsupported(" + fmt.Sprintf("%q", x.f.t.stub(e.Pos(), fmt.Sprintf("expression %T", e))) + ")"
}

func (x *fn) ident(e *ast.Ident) string {
	obj := x.info.Uses[e]
	if obj == nil {
		obj = x.info.Defs[e]
	}
	switch o := obj.(type) {
	case *types.Nil:
		return "undefined"
	case *types.Var:
		if o.Pkg() != nil && o.Parent() == o.Pkg().Scope() {
			return x.f.qualify(o)
		}
		if o.IsField() {
			return safeName(o.Name())
		}
		return x.name(o)
	case *types.Const:
		return x.f.constValue(o.Val(), o.Type())
	case *types.Func:
		return x.f.qualify(o)
	case *types.Builtin:
		return "$rt.builtin_" + o.Name()
	case *types.TypeName:
		return x.f.qualify(o)
	}
	if e.Name == "true" || e.Name == "false" {
		return e.Name
	}
	return safeName(e.Name)
}

// valueExpr translates e as a value assigned to a location of type to,
// copying structs and boxing values stored in interfaces.
func (x *fn) valueExpr(e ast.Expr, to types.Type) string {
	from := x.info.TypeOf(e)
	if lit, ok := e.(*ast.CompositeLit); ok && from == nil {
		return x.composite(lit, to)
	}
	if u, ok := unparen(e).(*ast.UnaryExpr); ok && u.Op == token.AND && to != nil {
		if _, isLit := u.X.(*ast.CompositeLit); !isLit && !isStructType(x.info.TypeOf(u.X)) {
			return fmt.Sprintf("$rt.unsupportedAs<%s>(%q)", x.f.tsType(to), x.f.t.stub(e.Pos(), "address of non-struct value"))
		}
	}
	s := x.expr(e)
	return x.convertValue(s, e, from, to)
}

func (x *fn) convertValue(s string, e ast.Expr, from, to types.Type) string {
	if to == nil || from == nil {
		return s
	}
	if isNilType(from) {
		return x.f.nilFor(to)
	}
	if isIfaceType(to) && !isIfaceType(from) {
		return x.box(s, from)
	}
	if e != nil && x.f.needsCopy(from) && !fresh(e) {
		return s + x.f.cloneCall(from)
	}
	return s
}

// nilFor is the representation of nil for a type.
func (f *file) nilFor(tt types.Type) string {
	if _, ok := under(tt).(*types.Slice); ok {
		return "[]"
	}
	return "undefined"
}

// fresh reports whether an expression produces a new value that needs no copy.
func fresh(e ast.Expr) bool {
	switch e := e.(type) {
	case *ast.CompositeLit, *ast.CallExpr, *ast.FuncLit, *ast.BasicLit:
		return true
	case *ast.ParenExpr:
		return fresh(e.X)
	case *ast.UnaryExpr:
		return e.Op != token.AND
	case *ast.BinaryExpr:
		return true
	}
	return false
}

// box wraps a concrete value stored in an interface.
func (x *fn) box(s string, from types.Type) string {
	switch u := from.(type) {
	case *types.Pointer:
		return s
	case *types.Named:
		if _, isStruct := u.Underlying().(*types.Struct); isStruct {
			if x.f.needsCopy(u) {
				return s + x.f.cloneCall(from)
			}
			return s
		}
		if x.f.t.translated(u.Obj().Pkg()) && x.f.boxedBy(u.Obj()) {
			return "new " + x.f.boxRef(u.Obj()) + "(" + s + ")"
		}
		if _, isSig := u.Underlying().(*types.Signature); isSig {
			return "new " + x.f.boxRefFor(from) + "(" + s + ")"
		}
	case *types.TypeParam:
		return "$rt.boxAny(" + s + ")"
	case *types.Basic:
		if u.Kind() == types.UntypedNil {
			return "undefined"
		}

	}
	if b, ok := from.Underlying().(*types.Basic); ok {
		tag := typeTag(from)
		if b.Info()&types.IsUntyped != 0 {
			tag = typeTag(types.Default(b))
		}
		switch basicKind(b) {
		case "string":
			return fmt.Sprintf("new $rt.BoxStr(%s, %q)", s, tag)
		case "boolean":
			return fmt.Sprintf("new $rt.BoxBool(%s, %q)", s, tag)
		default:
			return fmt.Sprintf("new $rt.BoxNum(%s, %q)", s, tag)
		}
	}
	return "new " + x.f.boxRefFor(from) + "(" + s + ")"
}

func (x *fn) selector(e *ast.SelectorExpr) string {
	if id, ok := e.X.(*ast.Ident); ok {
		if pn, ok := x.info.Uses[id].(*types.PkgName); ok {
			obj := pn.Imported().Scope().Lookup(e.Sel.Name)
			if obj == nil {
				return "$rt." + stdName(pn.Imported().Path()) + "_" + e.Sel.Name
			}
			if _, isTypeName := obj.(*types.TypeName); isTypeName && !x.f.t.translated(obj.Pkg()) {
				return x.f.qualify(obj)
			}
			if c, ok := obj.(*types.Const); ok {
				return x.f.constValue(c.Val(), c.Type())
			}
			return x.f.qualify(obj)
		}
	}
	sel := x.info.Selections[e]
	if sel == nil {
		return x.expr(e.X) + "." + e.Sel.Name
	}
	switch sel.Kind() {
	case types.FieldVal:
		base := x.expr(e.X)
		if x.f.isNullable(x.info.TypeOf(e.X)) {
			base += "!"
		}
		path := x.f.embedPath(sel.Recv(), sel.Index()[:len(sel.Index())-1])
		field := sel.Obj().(*types.Var)
		// Selecting the superclass-embedded field yields the object itself.
		owner := x.embeddedType(sel.Recv(), sel.Index()[:len(sel.Index())-1])
		if on, ok := derefNamed(owner); ok {
			if c := x.f.t.classOf(on.Origin().Obj()); c != nil && c.baseAt == sel.Index()[len(sel.Index())-1] {
				return strings.TrimSuffix(base+path, "!")
			}
		}
		return base + path + "." + x.f.fieldName(field)
	case types.MethodVal:
		// Method value: bind the receiver now.
		fnc := sel.Obj().(*types.Func)
		sig := fnc.Type().(*types.Signature)
		recv := x.expr(e.X)
		t := x.tmp()
		params, args := x.f.sigParams(sig)
		argList := strings.Split(args, ", ")
		if args == "" {
			argList = nil
		}
		call := x.methodCallOn(e, t, argList)
		return fmt.Sprintf("((%s: %s) => (%s): %s => %s)(%s)", t, x.f.tsType(sel.Recv()), params, x.f.results(sig), call, recv)
	case types.MethodExpr:
		fnc := sel.Obj().(*types.Func)
		sig := fnc.Type().(*types.Signature)
		params, args := x.f.sigParams(sig)
		argList := strings.Split(args, ", ")
		if args == "" {
			argList = nil
		}
		call := x.methodCallOn(e, "$r", argList)
		return fmt.Sprintf("(($r: %s%s): %s => %s)", x.f.tsType(sel.Recv()), prefixComma(params), x.f.results(sig), call)
	}
	return x.expr(e.X) + "." + e.Sel.Name
}

// methodCallOn renders a call of the method selected by e on receiver text r.
func (x *fn) methodCallOn(e *ast.SelectorExpr, r string, args []string) string {
	sel := x.info.Selections[e]
	fnc := sel.Obj().(*types.Func)
	sig := fnc.Type().(*types.Signature)
	recvType := sel.Recv()
	path := ""
	if len(sel.Index()) > 1 {
		path = x.f.embedPath(recvType, sel.Index()[:len(sel.Index())-1])
		recvType = x.embeddedType(recvType, sel.Index()[:len(sel.Index())-1])
	}
	if xt := x.info.TypeOf(e.X); xt != nil && x.f.isNullable(xt) && !strings.HasSuffix(r, "!") {
		r += "!"
	}
	argStr := strings.Join(args, ", ")
	declRecv := sig.Recv().Type()
	n, _ := derefNamed(declRecv)
	if n != nil && !isIfaceType(n) && x.f.t.classes[n.Origin().Obj()] == nil && !x.f.t.overridden(n.Origin().Obj()) && x.f.t.translated(n.Obj().Pkg()) {
		// Method on a named non-struct type: a free function.
		fname := x.f.qualifyMethod(n, fnc.Name())
		if _, isPtr := declRecv.(*types.Pointer); isPtr && !isStructType(n) {
			return fmt.Sprintf("%s(%s%s)", fname, x.addrOfText(e.X), prefixComma(argStr))
		}
		return fmt.Sprintf("%s(%s%s%s)", fname, r, path, prefixComma(argStr))
	}
	if n != nil && !x.f.t.translated(n.Obj().Pkg()) && !isIfaceType(n) {
		if _, isStruct := n.Underlying().(*types.Struct); !isStruct {
			// Methods on std named non-struct types (e.g. time.Duration).
			name := fmt.Sprintf("%s_%s$%s", stdName(n.Obj().Pkg().Path()), n.Obj().Name(), fnc.Name())
			x.f.t.noteStd(name, stdRef{obj: fnc, recv: n})
			return fmt.Sprintf("$rt.%s(%s%s%s)", name, r, path, prefixComma(argStr))
		}
	}
	name := x.f.t.methodName(fnc)
	if x.f.t.nilSafe[fnc.Origin()] && !isIfaceType(sel.Recv()) {
		if dn, ok := derefNamed(declRecv); ok {
			recvText := strings.TrimSuffix(r, "!") + path
			return fmt.Sprintf("%s.%s$nil(%s)", x.f.qualify(dn.Origin().Obj()), name, strings.Join(append([]string{strings.TrimSuffix(recvText, "!")}, args...), ", "))
		}
	}
	if x.f.t.shadowed[fnc.Origin()] && !isIfaceType(sel.Recv()) {
		if dn, ok := derefNamed(declRecv); ok {
			name += "$" + x.f.t.typeName(dn.Origin().Obj())
		}
	}
	return fmt.Sprintf("%s%s.%s(%s)", r, path, name, argStr)
}

func (f *file) qualifyMethod(n *types.Named, method string) string {
	obj := n.Origin().Obj()
	if obj.Pkg() == f.p.p.Types {
		return obj.Name() + "$" + method
	}
	tp := f.t.pkgs[obj.Pkg()]
	f.imports[tp.module] = true
	return "$" + tp.module + "." + obj.Name() + "$" + method
}

// addrOfText renders &e for a pointer-receiver call on a named non-struct
// value; such values are not addressable in TypeScript.
func (x *fn) addrOfText(e ast.Expr) string {
	return x.unsupportedExpr(e, x.f.t.stub(e.Pos(), "pointer method on non-struct value"))
}

func (x *fn) embeddedType(recv types.Type, index []int) types.Type {
	cur := recv
	for _, i := range index {
		if p, ok := cur.(*types.Pointer); ok {
			cur = p.Elem()
		}
		st, ok := cur.Underlying().(*types.Struct)
		if !ok {
			return cur
		}
		cur = st.Field(i).Type()
	}
	return cur
}

func (x *fn) genericRef(fun ast.Expr, indices []ast.Expr) string {
	base := x.expr(fun)
	var args []string
	for _, i := range indices {
		args = append(args, x.f.tsType(x.info.TypeOf(i)))
	}
	return base + "<" + strings.Join(args, ", ") + ">"
}

func (x *fn) index(e *ast.IndexExpr) string {
	if tv := x.info.Types[e.X]; tv.IsType() || isGenericFunc(x.info, e.X) {
		return x.genericRef(e.X, []ast.Expr{e.Index})
	}
	if vw := x.viewOf(e.X); vw != nil {
		return vw.base + ".charCodeAt(" + vw.off + " + " + x.expr(e.Index) + ")"
	}
	xt := x.info.TypeOf(e.X)
	switch u := under(xt).(type) {
	case *types.Basic:
		return x.expr(e.X) + ".charCodeAt(" + x.expr(e.Index) + ")"
	case *types.Map:
		return fmt.Sprintf("(%s?.get(%s) ?? %s)", x.expr(e.X), x.mapKey(e.Index, u.Key()), x.f.zero(u.Elem()))
	case *types.Pointer:
		return x.expr(e.X) + "!.v[" + x.expr(e.Index) + "]"
	}
	return x.expr(e.X) + "[" + x.expr(e.Index) + "]"
}

func isGenericFunc(info *types.Info, e ast.Expr) bool {
	t := info.TypeOf(e)
	if sig, ok := t.(*types.Signature); ok {
		return sig.TypeParams().Len() > 0
	}
	switch e := e.(type) {
	case *ast.Ident:
		if f, ok := info.Uses[e].(*types.Func); ok {
			return f.Type().(*types.Signature).TypeParams().Len() > 0
		}
	case *ast.SelectorExpr:
		if f, ok := info.Uses[e.Sel].(*types.Func); ok {
			return f.Type().(*types.Signature).TypeParams().Len() > 0
		}
	}
	return false
}

// mapKey renders a map key, encoding struct keys as strings.
func (x *fn) mapKey(e ast.Expr, key types.Type) string {
	s := x.valueExpr(e, key)
	if _, ok := key.Underlying().(*types.Struct); ok {
		return "$rt.structKey(" + s + ")"
	}
	if _, ok := key.Underlying().(*types.Array); ok {
		return "$rt.structKey(" + s + ")"
	}
	return s
}

func (x *fn) slice(e *ast.SliceExpr) string {
	if vw := x.viewOf(e.X); vw != nil {
		lo, hi := vw.off, vw.off+" + "+vw.n
		if e.Low != nil {
			lo = vw.off + " + " + x.expr(e.Low)
		}
		if e.High != nil {
			hi = vw.off + " + " + x.expr(e.High)
		}
		return vw.base + ".substring(" + lo + ", " + hi + ")"
	}
	xt := x.info.TypeOf(e.X)
	lo, hi := "0", ""
	if e.Low != nil {
		lo = x.expr(e.Low)
	}
	if e.High != nil {
		hi = x.expr(e.High)
	}
	base := x.expr(e.X)
	if b, ok := under(xt).(*types.Basic); ok && b.Info()&types.IsString != 0 {
		if hi == "" {
			if lo == "0" {
				return base
			}
			return base + ".substring(" + lo + ")"
		}
		return base + ".substring(" + lo + ", " + hi + ")"
	}
	if _, ok := under(xt).(*types.Pointer); ok {
		base += "!.v"
	}
	if hi == "" {
		if lo == "0" {
			return base + ".slice()"
		}
		return base + ".slice(" + lo + ")"
	}
	return base + ".slice(" + lo + ", " + hi + ")"
}

func (x *fn) deref(e *ast.StarExpr) string {
	t := x.info.TypeOf(e.X)
	p, ok := under(t).(*types.Pointer)
	if !ok {
		return x.expr(e.X)
	}
	if isStructType(p.Elem()) {
		return x.expr(e.X) + "!"
	}
	return x.expr(e.X) + "!.v"
}

func isStructType(t types.Type) bool {
	_, ok := under(t).(*types.Struct)
	return ok
}

func (x *fn) unary(e *ast.UnaryExpr) string {
	switch e.Op {
	case token.AND:
		if lit, ok := e.X.(*ast.CompositeLit); ok {
			return x.composite(lit, x.info.TypeOf(lit))
		}
		if isStructType(x.info.TypeOf(e.X)) {
			return x.expr(e.X)
		}
		return x.unsupportedExpr(e, x.f.t.stub(e.Pos(), "address of non-struct value"))
	case token.NOT:
		return "!" + x.expr(e.X)
	case token.SUB:
		return x.wrap("-"+x.expr(e.X), x.info.TypeOf(e))
	case token.ADD:
		return x.expr(e.X)
	case token.XOR:
		return x.wrap("~"+x.expr(e.X), x.info.TypeOf(e))
	case token.ARROW:
		return x.unsupportedExpr(e, x.f.t.stub(e.Pos(), "channel receive"))
	}
	return x.expr(e.X)
}

// wrap applies Go integer overflow semantics for sized integer types.
func (x *fn) wrap(s string, tt types.Type) string {
	b, ok := under(tt).(*types.Basic)
	if !ok {
		return s
	}
	switch b.Kind() {
	case types.Int8:
		return "((" + s + ") << 24 >> 24)"
	case types.Int16:
		return "((" + s + ") << 16 >> 16)"
	case types.Int32:
		return "((" + s + ") | 0)"
	case types.Uint8:
		return "((" + s + ") & 0xff)"
	case types.Uint16:
		return "((" + s + ") & 0xffff)"
	case types.Uint32:
		return "((" + s + ") >>> 0)"
	}
	return s
}

func intKind(tt types.Type) (types.BasicKind, bool) {
	b, ok := under(tt).(*types.Basic)
	if !ok || b.Info()&types.IsInteger == 0 {
		return 0, false
	}
	return b.Kind(), true
}

func is64(k types.BasicKind) bool {
	switch k {
	case types.Int, types.Int64, types.Uint, types.Uint64, types.Uintptr, types.UntypedInt, types.UntypedRune:
		return true
	}
	return false
}

func (x *fn) binary(e *ast.BinaryExpr) string {
	lt, rt := x.info.TypeOf(e.X), x.info.TypeOf(e.Y)
	switch e.Op {
	case token.LAND:
		return x.expr(e.X) + " && " + x.expr(e.Y)
	case token.LOR:
		return x.expr(e.X) + " || " + x.expr(e.Y)
	case token.EQL, token.NEQ:
		eq := x.equalExprs(e.X, lt, e.Y, rt)
		if e.Op == token.NEQ {
			return "!(" + eq + ")"
		}
		return eq
	case token.LSS, token.GTR, token.LEQ, token.GEQ:
		return x.expr(e.X) + " " + e.Op.String() + " " + x.expr(e.Y)
	}
	l, r := x.expr(e.X), x.expr(e.Y)
	resT := x.info.TypeOf(e)
	kind, isInt := intKind(resT)
	switch e.Op {
	case token.ADD:
		if b, ok := resT.Underlying().(*types.Basic); ok && b.Info()&types.IsString != 0 {
			return l + " + " + r
		}
		return x.wrap(l+" + "+r, resT)
	case token.SUB:
		return x.wrap(l+" - "+r, resT)
	case token.MUL:
		if isInt && (kind == types.Int32 || kind == types.Uint32) {
			return x.wrap("Math.imul("+l+", "+r+")", resT)
		}
		return x.wrap(l+" * "+r, resT)
	case token.QUO:
		if isInt {
			if kind == types.Int32 {
				return "((" + l + " / " + r + ") | 0)"
			}
			return "Math.trunc(" + l + " / " + r + ")"
		}
		return l + " / " + r
	case token.REM:
		if isInt {
			return "$rt.imod(" + l + ", " + r + ")"
		}
		return l + " % " + r
	case token.AND:
		if isInt && is64(kind) {
			return "$rt.and64(" + l + ", " + r + ")"
		}
		if kind == types.Uint32 && !x.nonNegSmallConst(e.X) && !x.nonNegSmallConst(e.Y) {
			return "((" + l + " & " + r + ") >>> 0)"
		}
		return "(" + l + " & " + r + ")"
	case token.OR:
		if isInt && is64(kind) {
			return "$rt.or64(" + l + ", " + r + ")"
		}
		return x.wrap(l+" | "+r, resT)
	case token.XOR:
		if isInt && is64(kind) {
			return "$rt.xor64(" + l + ", " + r + ")"
		}
		return x.wrap(l+" ^ "+r, resT)
	case token.AND_NOT:
		if isInt && is64(kind) {
			return "$rt.andNot64(" + l + ", " + r + ")"
		}
		return x.wrap(l+" & ~"+r, resT)
	case token.SHL:
		if isInt && is64(kind) {
			return "$rt.shl64(" + l + ", " + r + ")"
		}
		return x.wrap(l+" << "+r, resT)
	case token.SHR:
		if isInt && is64(kind) {
			return "$rt.shr64(" + l + ", " + r + ")"
		}
		if kind == types.Uint32 || kind == types.Uint16 || kind == types.Uint8 {
			return "(" + l + " >>> " + r + ")"
		}
		return "(" + l + " >> " + r + ")"
	}
	_ = rt
	return l + " " + e.Op.String() + " " + r
}

func (x *fn) nonNegSmallConst(e ast.Expr) bool {
	tv := x.info.Types[e]
	if tv.Value == nil {
		return false
	}
	v, ok := constant.Int64Val(constant.ToInt(tv.Value))
	return ok && v >= 0 && v < 1<<31
}

// equal compares a stored tag value with a case expression.
func (x *fn) equal(tag string, tagType types.Type, e ast.Expr) string {
	return x.equalText(tag, tagType, x.widened(e), x.info.TypeOf(e), e)
}

func (x *fn) equalExprs(a ast.Expr, at types.Type, b ast.Expr, bt types.Type) string {
	// &s1[i] == &s2[j] tests whether two slices share storage.
	if ua, ok := unparen(a).(*ast.UnaryExpr); ok && ua.Op == token.AND {
		if ub, ok := unparen(b).(*ast.UnaryExpr); ok && ub.Op == token.AND {
			ia, okA := unparen(ua.X).(*ast.IndexExpr)
			ib, okB := unparen(ub.X).(*ast.IndexExpr)
			if okA && okB {
				return "(" + x.expr(ia.X) + " === " + x.expr(ib.X) + " && " + x.expr(ia.Index) + " === " + x.expr(ib.Index) + ")"
			}
		}
	}
	return x.equalText(x.widened(a), at, x.widened(b), bt, b)
}

// widened renders a constant operand of a comparison with its general type,
// so TypeScript's literal narrowing (which method calls don't reset) does
// not reject comparisons that are valid in Go.
func (x *fn) widened(e ast.Expr) string {
	s := x.expr(e)
	tv := x.info.Types[e]
	if tv.Value == nil {
		return s
	}
	if b, ok := under(tv.Type).(*types.Basic); ok {
		switch basicKind(b) {
		case "number":
			return "(" + s + " as number)"
		case "string":
			return "(" + s + " as string)"
		}
	}
	return s
}

func (x *fn) equalText(l string, lt types.Type, r string, rt types.Type, re ast.Expr) string {
	if isNilType(rt) {
		if _, ok := under(lt).(*types.Slice); ok {
			return l + ".length === 0"
		}
		return l + " === undefined"
	}
	if isNilType(lt) {
		if _, ok := under(rt).(*types.Slice); ok {
			return r + ".length === 0"
		}
		return r + " === undefined"
	}
	li, ri := isIfaceType(lt), isIfaceType(rt)
	switch {
	case li && ri:
		return "$rt.ifaceEq(" + l + ", " + r + ")"
	case li:
		if _, isPtr := under(rt).(*types.Pointer); isPtr {
			return l + " === " + r
		}
		return "$rt.ifaceEq(" + l + ", " + x.box(r, rt) + ")"
	case ri:
		if _, isPtr := under(lt).(*types.Pointer); isPtr {
			return l + " === " + r
		}
		return "$rt.ifaceEq(" + x.box(l, lt) + ", " + r + ")"
	}
	if isStructType(lt) {
		if n, ok := types.Unalias(lt).(*types.Named); ok {
			if c := x.f.t.classOf(n.Origin().Obj()); c != nil {
				return l + ".$equals_" + x.f.t.typeName(c.name) + "(" + r + ")"
			}
			if !x.f.t.translated(n.Obj().Pkg()) && stdEquals[n.Obj().Pkg().Path()+"."+n.Obj().Name()] {
				return l + ".$equals(" + r + ")"
			}
		}
		return "$rt.structEq(" + l + ", " + r + ")"
	}
	if _, ok := under(lt).(*types.Array); ok {
		return "$rt.arrayEq(" + l + ", " + r + ")"
	}
	return l + " === " + r
}

func (x *fn) funcLit(e *ast.FuncLit) string {
	sig := x.info.TypeOf(e).(*types.Signature)
	inner := newFunc(x.f, x)
	inner.sig = sig
	params := inner.params(sig)
	var b strings.Builder
	inner.out = &b
	inner.indent = x.indent + 1
	inner.body(e.Body, e.Type)
	// Propagate names allocated inside so later siblings stay unique.
	for k, v := range inner.used {
		if v > x.used[k] {
			x.used[k] = v
		}
	}
	return fmt.Sprintf("(%s): %s => {\n%s%s}", strings.Join(params, ", "), x.f.results(sig), b.String(), strings.Repeat("  ", x.indent))
}

func (x *fn) typeAssert(e *ast.TypeAssertExpr) string {
	v := x.expr(e.X)
	tt := x.info.TypeOf(e.Type)
	if !simpleExpr(e.X) {
		t := x.tmp()
		return fmt.Sprintf("((%s: %s) => %s)(%s)", t, x.f.tsType(x.info.TypeOf(e.X)), x.checked(t, tt, e.Type), v)
	}
	return x.checked(v, tt, e.Type)
}

// checked asserts that interface value v holds type tt and yields it typed,
// using non-generic helpers (scriptc limits generic instantiations).
func (x *fn) checked(v string, tt types.Type, te ast.Expr) string {
	test := x.typeTest(v, tt, te)
	if b, ok := under(tt).(*types.Basic); ok && !isIfaceType(tt) {
		boxed := !(func() bool {
			n, isNamed := types.Unalias(tt).(*types.Named)
			return isNamed && x.f.t.translated(n.Obj().Pkg()) && x.f.boxedBy(n.Obj())
		})()
		if boxed {
			switch basicKind(b) {
			case "string":
				return fmt.Sprintf("$rt.checkString(%s, %s)", test, v)
			case "boolean":
				return fmt.Sprintf("$rt.checkBool(%s, %s)", test, v)
			default:
				return fmt.Sprintf("$rt.checkNumber(%s, %s)", test, v)
			}
		}
	}
	if c := x.castClass(tt); c != "" {
		return c + "(" + v + ")"
	}
	return fmt.Sprintf("(%s ? %s : $rt.typeAssertFail<%s>())", test, x.unbox(v, tt), x.f.tsType(tt))
}

func simpleExpr(e ast.Expr) bool {
	switch e := e.(type) {
	case *ast.Ident:
		return true
	case *ast.SelectorExpr:
		return simpleExpr(e.X)
	case *ast.ParenExpr:
		return simpleExpr(e.X)
	case *ast.StarExpr:
		return simpleExpr(e.X)
	}
	return false
}

// composite translates a composite literal of type tt.
func (x *fn) composite(e *ast.CompositeLit, tt types.Type) string {
	if t := x.info.TypeOf(e); t != nil {
		tt = t
	}
	if p, ok := under(tt).(*types.Pointer); ok {
		tt = p.Elem()
	}
	switch u := under(tt).(type) {
	case *types.Struct:
		return x.structLit(e, tt, u)
	case *types.Slice:
		return x.arrayLit(e, u.Elem(), -1)
	case *types.Array:
		return x.arrayLit(e, u.Elem(), int(u.Len()))
	case *types.Map:
		var parts []string
		for _, el := range e.Elts {
			kv := el.(*ast.KeyValueExpr)
			k := x.compositeElem(kv.Key, u.Key())
			if isStructType(u.Key()) {
				k = "$rt.structKey(" + k + ")"
			}
			parts = append(parts, "["+k+", "+x.compositeElem(kv.Value, u.Elem())+"]")
		}
		typ := strings.TrimSuffix(x.f.tsType(u), " | undefined")
		if len(parts) == 0 {
			return "new " + typ + "()"
		}
		return "new " + typ + "([" + strings.Join(parts, ", ") + "])"
	}
	return x.unsupportedExpr(e, x.f.t.stub(e.Pos(), "composite literal"))
}

func (x *fn) compositeElem(e ast.Expr, elem types.Type) string {
	if lit, ok := e.(*ast.CompositeLit); ok && lit.Type == nil {
		if p, ok := elem.(*types.Pointer); ok {
			return x.composite(lit, p.Elem())
		}
		return x.composite(lit, elem)
	}
	if u, ok := e.(*ast.UnaryExpr); ok && u.Op == token.AND {
		if lit, ok := u.X.(*ast.CompositeLit); ok && lit.Type == nil {
			if p, ok := elem.(*types.Pointer); ok {
				return x.composite(lit, p.Elem())
			}
		}
	}
	return x.valueExpr(e, elem)
}

func (x *fn) arrayLit(e *ast.CompositeLit, elem types.Type, n int) string {
	keyed := false
	for _, el := range e.Elts {
		if _, ok := el.(*ast.KeyValueExpr); ok {
			keyed = true
		}
	}
	if !keyed {
		parts := make([]string, len(e.Elts))
		for i, el := range e.Elts {
			parts[i] = x.compositeElem(el, elem)
		}
		for i := len(parts); i < n; i++ {
			parts = append(parts, x.f.zero(elem))
		}
		if len(parts) == 0 {
			return "([] as " + x.f.arrayOf(elem) + ")"
		}
		return "[" + strings.Join(parts, ", ") + "]"
	}
	var parts []string
	idx := int64(0)
	for _, el := range e.Elts {
		v := el
		if kv, ok := el.(*ast.KeyValueExpr); ok {
			k, _ := constant.Int64Val(constant.ToInt(x.info.Types[kv.Key].Value))
			idx = k
			v = kv.Value
		}
		parts = append(parts, fmt.Sprintf("[%d, %s]", idx, x.compositeElem(v, elem)))
		idx++
	}
	length := fmt.Sprint(n)
	if n < 0 {
		length = fmt.Sprint(idx)
		for _, p := range parts {
			var k int64
			fmt.Sscanf(p, "[%d,", &k)
			if k+1 > idx {
				length = fmt.Sprint(k + 1)
			}
		}
	}
	return fmt.Sprintf("$rt.indexedArray<%s>(%s, [%s], () => %s)", x.f.tsType(elem), length, strings.Join(parts, ", "), x.f.zero(elem))
}

func (x *fn) structLit(e *ast.CompositeLit, tt types.Type, st *types.Struct) string {
	n, isNamed := tt.(*types.Named)
	if a, ok := tt.(*types.Alias); ok {
		n, isNamed = types.Unalias(a).(*types.Named)
	}
	if !isNamed && st.NumFields() == 0 {
		return "$rt.EMPTY"
	}
	if !isNamed || !x.f.t.translated(n.Obj().Pkg()) {
		var typ string
		if isNamed {
			typ = x.f.stdType(n)
		} else {
			typ = x.f.anonClass(st)
		}
		if len(e.Elts) == 0 {
			return "new " + typ + "()"
		}
		// Library struct classes take exported fields positionally;
		// anonymous struct classes take all fields.
		var fields []int
		for i := 0; i < st.NumFields(); i++ {
			if !isNamed || st.Field(i).Exported() {
				fields = append(fields, i)
			}
		}
		pos := map[int]int{}
		for j, i := range fields {
			pos[i] = j
		}
		vals := make([]string, len(fields))
		set := make([]bool, len(fields))
		for i, el := range e.Elts {
			idx, val := i, el
			if kv, ok := el.(*ast.KeyValueExpr); ok {
				idx, val = fieldIndex(st, kv.Key.(*ast.Ident).Name), kv.Value
			}
			j, ok := pos[idx]
			if !ok {
				continue
			}
			vals[j], set[j] = x.compositeElem(val, st.Field(idx).Type()), true
		}
		last := 0
		for j := range vals {
			if set[j] {
				last = j + 1
			} else {
				vals[j] = x.f.zero(st.Field(fields[j]).Type())
			}
		}
		return "new " + typ + "(" + strings.Join(vals[:last], ", ") + ")"
	}
	tn := n.Origin().Obj()
	if c := x.f.t.classOf(tn); c != nil {
		tn = c.name
	}
	classType := x.f.qualify(tn) + x.f.typeArgs(n.TypeArgs())
	if len(e.Elts) == 0 {
		return "new " + classType + "(" + strings.Join(x.f.factoryArgs(tn, n.TypeArgs()), ", ") + ")"
	}
	type fv struct {
		idx int
		val string
	}
	var fields []fv
	for i, el := range e.Elts {
		if kv, ok := el.(*ast.KeyValueExpr); ok {
			name := kv.Key.(*ast.Ident).Name
			idx := fieldIndex(st, name)
			fields = append(fields, fv{idx, x.compositeElem(kv.Value, st.Field(idx).Type())})
		} else {
			fields = append(fields, fv{i, x.compositeElem(el, st.Field(i).Type())})
		}
	}
	// Keep source order for evaluation; the factory key lists field indexes
	// in that order.
	idx := make([]int, len(fields))
	vals := make([]string, len(fields))
	for i, f := range fields {
		idx[i], vals[i] = f.idx, f.val
	}
	factory := x.f.litFactory(tn, idx)
	vals = append(x.f.factoryArgs(tn, n.TypeArgs()), vals...)
	return fmt.Sprintf("%s.%s%s(%s)", x.f.qualify(tn), factory, x.f.typeArgs(n.TypeArgs()), strings.Join(vals, ", "))
}

func fieldIndex(st *types.Struct, name string) int {
	for i := 0; i < st.NumFields(); i++ {
		if st.Field(i).Name() == name {
			return i
		}
	}
	return -1
}

func fieldByName(st *types.Struct, name string) *types.Var {
	return st.Field(fieldIndex(st, name))
}

// assign translates assignment statements.
func (x *fn) assign(s *ast.AssignStmt) {
	switch s.Tok {
	case token.DEFINE, token.ASSIGN:
	default:
		op := strings.TrimSuffix(s.Tok.String(), "=")
		x.opAssign(s.Lhs[0], op, s.Rhs[0], s.Pos())
		return
	}
	define := s.Tok == token.DEFINE
	// Comma-ok forms.
	if len(s.Lhs) == 2 && len(s.Rhs) == 1 {
		switch r := unparen(s.Rhs[0]).(type) {
		case *ast.IndexExpr:
			if m, ok := under(x.info.TypeOf(r.X)).(*types.Map); ok {
				t := x.tmp()
				mexpr := x.expr(r.X)
				key := x.mapKey(r.Index, m.Key())
				x.flushPre()
				x.line("const %s = %s;", t, mexpr)
				k := x.tmp()
				x.line("const %s = %s;", k, key)
				x.bindTwo(s, define, fmt.Sprintf("(%s?.get(%s) ?? %s)", t, k, x.f.zero(m.Elem())), fmt.Sprintf("(%s !== undefined && %s.has(%s))", t, t, k))
				return
			}
		case *ast.TypeAssertExpr:
			t := x.tmp()
			v := x.expr(r.X)
			x.flushPre()
			x.line("const %s = %s;", t, v)
			tt := x.info.TypeOf(r.Type)
			ok := x.tmp()
			x.line("const %s = %s;", ok, x.typeTest(t, tt, r.Type))
			x.bindTwo(s, define, fmt.Sprintf("(%s ? %s : %s)", ok, x.unbox(t, tt), x.f.zero(tt)), ok)
			return
		case *ast.UnaryExpr:
			if r.Op == token.ARROW {
				x.line("throw $rt.unsupported(%q);", x.f.t.stub(s.Pos(), "channel receive"))
				return
			}
		}
	}
	// Multi-value call.
	if len(s.Lhs) > 1 && len(s.Rhs) == 1 {
		rhs := x.expr(s.Rhs[0])
		x.flushPre()
		t := x.tmp()
		x.line("const %s = %s;", t, rhs)
		tuple := x.info.TypeOf(s.Rhs[0]).(*types.Tuple)
		for i, l := range s.Lhs {
			if id, ok := l.(*ast.Ident); ok && id.Name == "_" {
				continue
			}
			x.store(l, define, fmt.Sprintf("%s[%d]", t, i), tuple.At(i).Type(), nil)
		}
		return
	}
	if len(s.Lhs) == 1 && define {
		if id, ok := s.Lhs[0].(*ast.Ident); ok {
			if v, ok := x.info.Defs[id].(*types.Var); ok && x.views[v] != nil {
				x.defineView(x.views[v], unparen(s.Rhs[0]).(*ast.SliceExpr))
				return
			}
		}
	}
	if len(s.Lhs) == 1 {
		l := s.Lhs[0]
		if id, ok := l.(*ast.Ident); ok && id.Name == "_" {
			v := x.expr(s.Rhs[0])
			x.flushPre()
			x.line("%s;", v)
			return
		}
		// s = append(s, ...) appends in place.
		if call, ok := unparen(s.Rhs[0]).(*ast.CallExpr); ok && !define && x.isBuiltin(call, "append") && len(call.Args) > 0 && sameExpr(l, call.Args[0]) {
			x.appendInPlace(l, call)
			return
		}
		lt := x.lhsType(l, define)
		v := x.valueExpr(s.Rhs[0], lt)
		x.flushPre()
		x.store(l, define, v, lt, s.Rhs[0])
		return
	}
	// Parallel assignment: evaluate all right-hand sides first.
	var temps []string
	for i, r := range s.Rhs {
		v := x.valueExpr(r, x.lhsType(s.Lhs[i], define))
		x.flushPre()
		t := x.tmp()
		x.line("const %s = %s;", t, v)
		temps = append(temps, t)
	}
	for i, l := range s.Lhs {
		if id, ok := l.(*ast.Ident); ok && id.Name == "_" {
			continue
		}
		x.store(l, define, temps[i], x.lhsType(l, define), nil)
	}
}

func unparen(e ast.Expr) ast.Expr {
	for {
		p, ok := e.(*ast.ParenExpr)
		if !ok {
			return e
		}
		e = p.X
	}
}

func (x *fn) bindTwo(s *ast.AssignStmt, define bool, v, ok string) {
	types2 := []string{v, ok}
	for i, l := range s.Lhs {
		if id, isId := l.(*ast.Ident); isId && id.Name == "_" {
			continue
		}
		x.store(l, define, types2[i], x.lhsType(l, define), nil)
	}
}

func (x *fn) lhsType(l ast.Expr, define bool) types.Type {
	if id, ok := l.(*ast.Ident); ok {
		if v, ok := x.info.Defs[id].(*types.Var); ok && v != nil {
			return v.Type()
		}
		if v, ok := x.info.Uses[id].(*types.Var); ok {
			return v.Type()
		}
	}
	return x.info.TypeOf(l)
}

// store writes value text v to the location l.
func (x *fn) store(l ast.Expr, define bool, v string, tt types.Type, src ast.Expr) {
	if id, ok := l.(*ast.Ident); ok {
		if define {
			if obj, ok := x.info.Defs[id].(*types.Var); ok && obj != nil {
				x.line("let %s: %s = %s;", x.name(obj), x.f.tsType(obj.Type()), v)
				return
			}
		}
		x.line("%s = %s;", x.expr(id), v)
		return
	}
	if sel, ok := unparen(l).(*ast.SelectorExpr); ok {
		if s := x.info.Selections[sel]; s != nil && s.Kind() == types.FieldVal {
			owner := x.embeddedType(s.Recv(), s.Index()[:len(s.Index())-1])
			if on, ok := derefNamed(owner); ok {
				if c := x.f.t.classOf(on.Origin().Obj()); c != nil && c.baseAt == s.Index()[len(s.Index())-1] {
					x.line("%s.$copy_%s(%s);", x.expr(l), x.f.t.typeName(c.base), v)
					return
				}
			}
		}
	}
	switch l := unparen(l).(type) {
	case *ast.IndexExpr:
		xt := x.info.TypeOf(l.X)
		if m, ok := under(xt).(*types.Map); ok {
			x.line("%s!.set(%s, %s);", x.expr(l.X), x.mapKey(l.Index, m.Key()), v)
			return
		}
		if _, ok := under(xt).(*types.Pointer); ok {
			x.line("%s!.v[%s] = %s;", x.expr(l.X), x.expr(l.Index), v)
			return
		}
		x.line("%s[%s] = %s;", x.expr(l.X), x.expr(l.Index), v)
		return
	case *ast.StarExpr:
		pt := under(x.info.TypeOf(l.X)).(*types.Pointer)
		if n, ok := types.Unalias(pt.Elem()).(*types.Named); ok && isStructType(n) && x.f.t.classOf(n.Origin().Obj()) != nil {
			x.line("%s!.$copy_%s(%s);", x.expr(l.X), x.f.t.classOf(n.Origin().Obj()).name.Name(), v)
			return
		}
		x.line("%s!.v = %s;", x.expr(l.X), v)
		return
	}
	x.line("%s = %s;", x.expr(l), v)
}

func (x *fn) opAssign(l ast.Expr, op string, r ast.Expr, pos token.Pos) {
	lt := x.info.TypeOf(l)
	bin := &ast.BinaryExpr{X: l, Op: binaryToken(op), Y: r, OpPos: pos}
	// Record the type of the synthesized expression.
	x.info.Types[bin] = types.TypeAndValue{Type: lt}
	if idx, ok := unparen(l).(*ast.IndexExpr); ok {
		if m, ok := under(x.info.TypeOf(idx.X)).(*types.Map); ok {
			mt, kt := x.tmp(), x.tmp()
			x.line("const %s = %s;", mt, x.expr(idx.X))
			x.line("const %s = %s;", kt, x.mapKey(idx.Index, m.Key()))
			cur := fmt.Sprintf("(%s!.get(%s) ?? %s)", mt, kt, x.f.zero(m.Elem()))
			val := x.binaryText(cur, op, x.expr(r), lt, r)
			x.flushPre()
			x.line("%s!.set(%s, %s);", mt, kt, val)
			return
		}
	}
	// Simple numeric ops on plain number types use compound assignment.
	kind, isInt := intKind(lt)
	if b, ok := under(lt).(*types.Basic); ok && (op == "+" || op == "-") && (!isInt || is64(kind)) && (b.Info()&(types.IsNumeric|types.IsString) != 0) {
		target := x.expr(l)
		val := x.expr(r)
		x.flushPre()
		if val == "1" && b.Info()&types.IsString == 0 {
			x.line("%s%s%s;", target, op, op)
			return
		}
		x.line("%s %s= %s;", target, op, val)
		return
	}
	v := x.binary(bin)
	x.flushPre()
	x.store(l, false, v, lt, nil)
}

func (x *fn) binaryText(cur, op, r string, lt types.Type, re ast.Expr) string {
	tmp := &ast.BinaryExpr{X: &ast.Ident{Name: "$cur"}, Op: binaryToken(op), Y: re}
	_ = tmp
	kind, isInt := intKind(lt)
	switch op {
	case "+", "-":
		if !isInt || is64(kind) {
			return cur + " " + op + " " + r
		}
	}
	return x.wrap(cur+" "+op+" "+r, lt)
}

func binaryToken(op string) token.Token {
	for t := token.ADD; t <= token.AND_NOT; t++ {
		if t.String() == op {
			return t
		}
	}
	switch op {
	case "&^":
		return token.AND_NOT
	case "<<":
		return token.SHL
	case ">>":
		return token.SHR
	}
	return token.ILLEGAL
}

func sameExpr(a, b ast.Expr) bool {
	return types.ExprString(a) == types.ExprString(b)
}

func (x *fn) isBuiltin(call *ast.CallExpr, name string) bool {
	id, ok := unparen(call.Fun).(*ast.Ident)
	if !ok {
		return false
	}
	b, ok := x.info.Uses[id].(*types.Builtin)
	return ok && b.Name() == name
}

func (x *fn) appendInPlace(l ast.Expr, call *ast.CallExpr) {
	target := x.expr(l)
	st := under(x.info.TypeOf(call.Args[0]))
	elem := types.Type(types.Typ[types.Byte])
	if sl, ok := st.(*types.Slice); ok {
		elem = sl.Elem()
	}
	if call.Ellipsis.IsValid() {
		src := x.expr(call.Args[1])
		x.flushPre()
		if b, ok := under(x.info.TypeOf(call.Args[1])).(*types.Basic); ok && b.Info()&types.IsString != 0 {
			x.line("$rt.appendInto(%s, $rt.stringToBytes(%s));", target, src)
			return
		}
		x.line("$rt.appendInto(%s, %s);", target, src)
		return
	}
	var vals []string
	for _, a := range call.Args[1:] {
		vals = append(vals, x.valueExpr(a, elem))
	}
	x.flushPre()
	x.line("%s.push(%s);", target, strings.Join(vals, ", "))
}

var _ = sort.Strings

// unsupportedExpr renders a typed placeholder for an untranslatable expression.
func (x *fn) unsupportedExpr(e ast.Expr, msg string) string {
	t := "unknown"
	if tt := x.info.TypeOf(e); tt != nil {
		t = x.f.tsType(tt)
	}
	return fmt.Sprintf("$rt.unsupportedAs<%s>(%q)", t, msg)
}
