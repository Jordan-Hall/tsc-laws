package main

import (
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"strconv"
	"strings"
)

// fn translates one Go function body.
type fn struct {
	f       *file
	info    *types.Info
	parent  *fn
	sig     *types.Signature
	recv    *types.Var
	names   map[*types.Var]string
	used    map[string]int
	tmpN    *int
	pre     []string
	targets []target
	// Functions containing defer return through a labeled try block.
	deferred bool
	results  []string
	// Range-over-func bodies run inside a callback.
	rangeFunc *rangeFuncCtx
	views     map[*types.Var]*view
	notOwned  map[*types.Var]bool
	// assigned are the locals assigned after their definition.
	assigned map[*types.Var]bool
	// subst replaces expressions with already translated text.
	subst map[ast.Expr]string
	// boxGeneric is set while asserting from an empty interface, where
	// pointers to generic structs are boxed (see isGenericPtr).
	boxGeneric bool
	indent     int
	out        *strings.Builder
}

type target struct {
	kind  string // "loop", "switch", "select", "block"
	label string // Go label, if any
	ts    string // TypeScript label to use for an unlabeled break, if needed
	cont  string // label of the block a continue breaks out of, if needed
}

type rangeFuncCtx struct {
	retFlag, retVal string
	depth           int // targets depth at the callback boundary
}

func newFunc(f *file, parent *fn) *fn {
	x := &fn{f: f, info: f.p.p.TypesInfo, parent: parent, names: map[*types.Var]string{}, used: map[string]int{}}
	if parent != nil {
		x.views = parent.views
		x.notOwned = parent.notOwned
		x.assigned = parent.assigned
		x.tmpN = parent.tmpN
		for k, v := range parent.names {
			x.names[k] = v
		}
		for k, v := range parent.used {
			x.used[k] = v
		}
	} else {
		n := 0
		x.tmpN = &n
	}
	return x
}

func (x *fn) tmp() string {
	*x.tmpN++
	return fmt.Sprintf("$t%d", *x.tmpN)
}

func (x *fn) prelude() string {
	s := strings.Join(x.pre, "")
	x.pre = nil
	return s
}

// name returns the TypeScript name of a local variable, renaming locals that
// shadow another local or a TypeScript reserved word.
func (x *fn) name(v *types.Var) string {
	if n, ok := x.names[v]; ok {
		return n
	}
	base := safeName(v.Name())
	if v.Name() == "_" {
		base = x.tmp()
	}
	n := base
	if c := x.used[base]; c > 0 {
		n = fmt.Sprintf("%s$%d", base, c)
	} else if _, isType := x.f.p.p.Types.Scope().Lookup(v.Name()).(*types.TypeName); isType {
		n = base + "$v"
	}
	x.used[base]++
	x.names[v] = n
	return n
}

func (x *fn) line(format string, args ...any) {
	x.out.WriteString(strings.Repeat("  ", x.indent))
	fmt.Fprintf(x.out, format, args...)
	x.out.WriteByte('\n')
}

func (x *fn) flushPre() {
	for _, p := range x.pre {
		x.line("%s", strings.TrimRight(p, "\n"))
	}
	x.pre = nil
}

// funcDecl emits a package-level function or a method on a non-struct type.
func (f *file) funcDecl(fd *ast.FuncDecl) string {
	obj := f.p.p.TypesInfo.Defs[fd.Name].(*types.Func)
	sig := obj.Type().(*types.Signature)
	x := newFunc(f, nil)
	x.sig = sig
	var params []string
	name := safeName(fd.Name.Name)
	tparams := f.tparamList(sig.TypeParams())
	if sig.Recv() != nil {
		n, _ := derefNamed(sig.Recv().Type())
		name = n.Obj().Name() + "$" + fd.Name.Name
		tparams = f.tparamList(sig.RecvTypeParams())
		if _, isPtr := sig.Recv().Type().(*types.Pointer); isPtr && !isStructType(n) {
			params = append(params, x.recvParam(sig.Recv(), "$rt.Ptr<"+f.tsType(n)+">"))
		} else {
			params = append(params, x.recvParam(sig.Recv(), f.tsType(sig.Recv().Type())))
		}
	}
	// Leading zero-factory parameters.
	var zlist *types.TypeParamList
	var needs []bool
	if sig.Recv() != nil {
		n, _ := derefNamed(sig.Recv().Type())
		zlist, needs = sig.RecvTypeParams(), f.t.needsFor(n.Origin().Obj())
	} else {
		zlist, needs = sig.TypeParams(), f.t.needsFor(obj)
	}
	var zparams []string
	if zlist != nil {
		for i := 0; i < zlist.Len(); i++ {
			if i < len(needs) && needs[i] {
				p := zlist.At(i)
				zparams = append(zparams, fmt.Sprintf("%s: () => %s", f.zeroParamName(p), p.Obj().Name()))
			}
		}
	}
	params = append(zparams, append(params, x.params(sig)...)...)
	var b strings.Builder
	x.out = &b
	x.indent = 1
	f.withScope(zlist, needs, func(p *types.TypeParam) string { return f.zeroParamName(p) }, func() {
		if fd.Body == nil {
			x.line("throw $rt.unsupported(%q);", "external function "+fd.Name.Name)
		} else {
			x.body(fd.Body, fd.Type)
		}
	})
	export := "export "
	return fmt.Sprintf("%sfunction %s%s(%s): %s {\n%s}\n", export, name, tparams, strings.Join(params, ", "), f.results(sig), b.String())
}

func (x *fn) recvParam(v *types.Var, typ string) string {
	if v.Name() == "" || v.Name() == "_" {
		return "$recv: " + typ
	}
	return x.name(v) + ": " + typ
}

// methodDecl emits a method on a class.
func (f *file) methodDecl(fd *ast.FuncDecl) string {
	obj := f.p.p.TypesInfo.Defs[fd.Name].(*types.Func)
	sig := obj.Type().(*types.Signature)
	x := newFunc(f, nil)
	x.sig = sig
	params := x.params(sig)
	var b strings.Builder
	x.out = &b
	x.indent = 2
	n, _ := derefNamed(sig.Recv().Type())
	f.withScope(sig.RecvTypeParams(), f.t.needsFor(n.Origin().Obj()), func(p *types.TypeParam) string { return "this." + f.zeroParamName(p) }, func() {
		if r := sig.Recv(); r.Name() != "" && r.Name() != "_" {
			x.line("const %s = this;", x.name(r))
		}
		x.body(fd.Body, fd.Type)
	})
	name := f.t.methodName(obj)
	if f.t.nilSafe[obj] {
		cls := f.declName(n.Origin().Obj())
		var args []string
		for _, p := range params {
			args = append(args, strings.SplitN(p, ":", 2)[0])
		}
		recvName := "$recv"
		if r := sig.Recv(); r.Name() != "" && r.Name() != "_" {
			recvName = x.name(r)
		}
		staticBody := strings.Replace(b.String(), "    const "+recvName+" = this;\n", "", 1)
		sp := append([]string{recvName + ": " + cls + " | undefined"}, params...)
		return fmt.Sprintf("  static %s$nil(%s): %s {\n%s  }\n  %s(%s): %s { return %s.%s$nil(%s); }\n", name, strings.Join(sp, ", "), f.results(sig), staticBody, name, strings.Join(params, ", "), f.results(sig), cls, name, strings.Join(append([]string{"this"}, args...), ", "))
	}
	if f.t.shadowed[obj] {
		static := name + "$" + f.t.typeName(n.Origin().Obj())
		var args []string
		for _, p := range params {
			args = append(args, strings.SplitN(p, ":", 2)[0])
		}
		return fmt.Sprintf("  %s(%s): %s {\n%s  }\n  %s(%s): %s { return this.%s(%s); }\n", static, strings.Join(params, ", "), f.results(sig), b.String(), name, strings.Join(params, ", "), f.results(sig), static, strings.Join(args, ", "))
	}
	return fmt.Sprintf("  %s(%s): %s {\n%s  }\n", name, strings.Join(params, ", "), f.results(sig), b.String())
}

func (x *fn) params(sig *types.Signature) []string {
	var out []string
	for i := 0; i < sig.Params().Len(); i++ {
		p := sig.Params().At(i)
		name := "$p" + fmt.Sprint(i)
		if p.Name() != "" && p.Name() != "_" {
			name = x.name(p)
		}
		out = append(out, name+": "+x.f.tsType(p.Type()))
	}
	return out
}

// body emits a function body, wrapping it for defer and named results.
func (x *fn) body(body *ast.BlockStmt, ft *ast.FuncType) {
	x.findViews(body)
	x.findOwned(body, x.sig)
	x.findAssigned(body)
	sig := x.sig
	res := sig.Results()
	named := res.Len() > 0 && res.At(0).Name() != ""
	if named {
		for i := 0; i < res.Len(); i++ {
			v := res.At(i)
			n := x.name(v)
			z := x.f.varZero(v)
			if z == "undefined" {
				z = "undefined as " + x.f.varType(v)
			}
			x.line("let %s: %s = %s;", n, x.f.varType(v), z)
			x.results = append(x.results, n)
		}
	}
	if !hasDefer(body) {
		x.stmts(body.List)
		if named && endsReachable(body) {
			x.line("return %s;", x.resultTuple())
		}
		return
	}
	x.deferred = true
	if !named {
		for i := 0; i < res.Len(); i++ {
			n := x.tmp()
			x.line("let %s: %s = %s;", n, x.f.tsType(res.At(i).Type()), x.f.zero(res.At(i).Type()))
			x.results = append(x.results, n)
		}
	}
	x.line("const $defers: (() => void)[] = [];")
	x.line("let $panic: $rt.Panic | undefined = undefined;")
	x.line("$body: try {")
	x.indent++
	x.targets = append(x.targets, target{kind: "body"})
	x.stmts(body.List)
	x.targets = x.targets[:len(x.targets)-1]
	x.indent--
	x.line("} catch ($e) {")
	x.line("  $panic = $rt.toPanic($e);")
	x.line("} finally {")
	x.line("  $panic = $rt.runDefers($defers, $panic);")
	x.line("}")
	x.line("if ($panic !== undefined) throw $panic;")
	if res.Len() > 0 {
		x.line("return %s;", x.resultTuple())
	}
}

func (x *fn) resultTuple() string {
	if len(x.results) == 1 {
		return x.results[0]
	}
	return "[" + strings.Join(x.results, ", ") + "]"
}

func hasDefer(body *ast.BlockStmt) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		switch n.(type) {
		case *ast.FuncLit:
			return false
		case *ast.DeferStmt:
			found = true
		}
		return !found
	})
	return found
}

func endsReachable(body *ast.BlockStmt) bool {
	if len(body.List) == 0 {
		return true
	}
	switch s := body.List[len(body.List)-1].(type) {
	case *ast.ReturnStmt:
		return false
	case *ast.ExprStmt:
		if c, ok := s.X.(*ast.CallExpr); ok {
			if id, ok := c.Fun.(*ast.Ident); ok && id.Name == "panic" {
				return false
			}
		}
	case *ast.ForStmt:
		return s.Cond != nil || hasBreak(s.Body)
	}
	return true
}

func hasBreak(b *ast.BlockStmt) bool {
	found := false
	ast.Inspect(b, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.FuncLit, *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt:
			return false
		case *ast.BranchStmt:
			if s.Tok == token.BREAK {
				found = true
			}
		}
		return !found
	})
	return found
}

func (x *fn) stmts(list []ast.Stmt) {
	for _, s := range list {
		x.stmt(s)
	}
}

func (x *fn) block(list []ast.Stmt) {
	x.indent++
	x.stmts(list)
	x.indent--
}

func (x *fn) stmt(s ast.Stmt) {
	switch s := s.(type) {
	case *ast.ExprStmt:
		if call, ok := unparen(s.X).(*ast.CallExpr); ok && x.writeBackCall(call) {
			return
		}
		e := x.expr(s.X)
		x.flushPre()
		if strings.HasPrefix(e, "$rt.panicValue(") {
			x.line("throw $rt.newPanic(%s;", strings.TrimPrefix(e, "$rt.panicValue("))
			return
		}
		x.line("%s;", e)
	case *ast.AssignStmt:
		x.assign(s)
	case *ast.IncDecStmt:
		op := "+"
		if s.Tok == token.DEC {
			op = "-"
		}
		x.opAssign(s.X, op, &ast.BasicLit{Kind: token.INT, Value: "1"}, s.Pos())
	case *ast.DeclStmt:
		x.declStmt(s)
	case *ast.ReturnStmt:
		x.returnStmt(s)
	case *ast.BlockStmt:
		x.line("{")
		x.block(s.List)
		x.line("}")
	case *ast.IfStmt:
		x.ifStmt(s, false)
	case *ast.ForStmt:
		x.forStmt(s, "")
	case *ast.RangeStmt:
		x.rangeStmt(s, "")
	case *ast.SwitchStmt:
		x.switchStmt(s, "")
	case *ast.TypeSwitchStmt:
		x.typeSwitch(s, "")
	case *ast.LabeledStmt:
		x.labeled(s)
	case *ast.BranchStmt:
		x.branch(s)
	case *ast.DeferStmt:
		x.deferStmt(s)
	case *ast.GoStmt:
		e := x.expr(s.Call)
		x.flushPre()
		x.line("%s; // go statement runs synchronously", e)
	case *ast.EmptyStmt:
	case *ast.SendStmt, *ast.SelectStmt:
		x.line("throw $rt.unsupported(%q);", x.f.t.stub(s.Pos(), "channel operation"))
	default:
		x.line("throw $rt.unsupported(%q);", x.f.t.stub(s.Pos(), fmt.Sprintf("statement %T", s)))
	}
}

func (x *fn) labeled(s *ast.LabeledStmt) {
	label := safeName(s.Label.Name)
	switch inner := s.Stmt.(type) {
	case *ast.ForStmt:
		x.forStmt(inner, label)
	case *ast.RangeStmt:
		x.rangeStmt(inner, label)
	case *ast.SwitchStmt:
		x.switchStmt(inner, label)
	case *ast.TypeSwitchStmt:
		x.typeSwitch(inner, label)
	default:
		x.line("%s: {", label)
		x.targets = append(x.targets, target{kind: "block", label: s.Label.Name, ts: label})
		x.indent++
		x.stmt(inner)
		x.indent--
		x.targets = x.targets[:len(x.targets)-1]
		x.line("}")
	}
}

func (x *fn) branch(s *ast.BranchStmt) {
	switch s.Tok {
	case token.BREAK, token.CONTINUE:
		word := "break"
		if s.Tok == token.CONTINUE {
			word = "continue"
		}
		// Find the target.
		idx := -1
		for i := len(x.targets) - 1; i >= 0; i-- {
			t := x.targets[i]
			if s.Label != nil {
				if t.label == s.Label.Name {
					idx = i
					break
				}
				continue
			}
			if t.kind == "body" {
				break
			}
			if s.Tok == token.CONTINUE && t.kind != "loop" && t.kind != "rangefunc" {
				continue
			}
			if t.kind == "block" {
				continue
			}
			idx = i
			break
		}
		if idx < 0 {
			x.line("throw $rt.unsupported(%q);", x.f.t.stub(s.Pos(), "unresolved branch target"))
			return
		}
		t := x.targets[idx]
		if rf := x.rangeFunc; rf != nil && idx < rf.depth {
			x.line("throw $rt.unsupported(%q);", x.f.t.stub(s.Pos(), "branch out of range-over-func body"))
			return
		}
		if t.kind == "rangefunc" {
			if s.Tok == token.BREAK {
				x.line("return false;")
			} else {
				x.line("return true;")
			}
			return
		}
		switch {
		case s.Tok == token.CONTINUE && t.cont != "":
			x.line("break %s;", t.cont)
		case s.Label != nil:
			x.line("%s %s;", word, safeName(s.Label.Name))
		case t.ts != "" && s.Tok == token.BREAK:
			x.line("break %s;", t.ts)
		default:
			x.line("%s;", word)
		}
	case token.FALLTHROUGH:
		// Handled by switch translation.
	case token.GOTO:
		x.line("throw $rt.unsupported(%q);", x.f.t.stub(s.Pos(), "goto"))
	}
}

func (x *fn) returnStmt(s *ast.ReturnStmt) {
	if rf := x.rangeFunc; rf != nil {
		if len(s.Results) > 0 {
			v := x.returnValue(s.Results)
			x.flushPre()
			x.line("%s = %s;", rf.retVal, v)
		} else if len(x.results) > 0 {
			x.line("%s = %s;", rf.retVal, x.resultTuple())
		}
		x.line("%s = true;", rf.retFlag)
		x.line("return false;")
		return
	}
	if x.deferred {
		if len(s.Results) == 1 && len(x.results) > 1 {
			v := x.expr(s.Results[0])
			x.flushPre()
			t := x.tmp()
			x.line("const %s = %s;", t, v)
			for i, r := range x.results {
				x.line("%s = %s[%d];", r, t, i)
			}
		} else {
			vals := make([]string, len(s.Results))
			for i, r := range s.Results {
				vals[i] = x.valueExpr(r, x.sig.Results().At(i).Type())
			}
			x.flushPre()
			if len(vals) > 1 {
				t := x.tmp()
				x.line("const %s: %s = [%s];", t, x.f.tsType(x.sig.Results()), strings.Join(vals, ", "))
				for i, r := range x.results {
					x.line("%s = %s[%d];", r, t, i)
				}
			} else if len(vals) == 1 {
				x.line("%s = %s;", x.results[0], vals[0])
			}
		}
		x.line("break $body;")
		return
	}
	if len(s.Results) == 0 {
		if len(x.results) > 0 {
			x.line("return %s;", x.resultTuple())
		} else {
			x.line("return;")
		}
		return
	}
	v := x.returnValue(s.Results)
	x.flushPre()
	x.line("return %s;", v)
}

func (x *fn) returnValue(results []ast.Expr) string {
	res := x.sig.Results()
	if len(results) == 1 {
		if res.Len() > 1 {
			// return f(): convert each element when the types differ.
			if tuple, ok := x.info.TypeOf(results[0]).(*types.Tuple); ok && !types.Identical(tuple, res) {
				t := x.tmp()
				x.pre = append(x.pre, fmt.Sprintf("const %s = %s;\n", t, x.expr(results[0])))
				vals := make([]string, res.Len())
				for i := range vals {
					vals[i] = x.convertValue(fmt.Sprintf("%s[%d]", t, i), nil, tuple.At(i).Type(), res.At(i).Type())
				}
				return "[" + strings.Join(vals, ", ") + "]"
			}
			return x.expr(results[0])
		}
		return x.valueExpr(results[0], res.At(0).Type())
	}
	vals := make([]string, len(results))
	for i, r := range results {
		vals[i] = x.valueExpr(r, res.At(i).Type())
	}
	return "[" + strings.Join(vals, ", ") + "]"
}

func (x *fn) deferStmt(s *ast.DeferStmt) {
	if lit, ok := s.Call.Fun.(*ast.FuncLit); ok && len(s.Call.Args) == 0 {
		inner := x.funcLit(lit)
		x.line("$defers.push(%s);", inner)
		return
	}
	// Evaluate the receiver and arguments now, call later.
	var temps []string
	args := make([]string, len(s.Call.Args))
	call := s.Call
	sig, _ := under(x.info.TypeOf(call.Fun)).(*types.Signature)
	if _, isConv := x.info.Types[call.Fun]; isConv && x.info.Types[call.Fun].IsType() {
		sig = nil
	}
	for i, a := range call.Args {
		v := x.argExpr(call, sig, i, a)
		t := x.tmp()
		temps = append(temps, fmt.Sprintf("const %s = %s;", t, v))
		args[i] = t
	}
	var fun string
	if sel, ok := call.Fun.(*ast.SelectorExpr); ok && x.info.Selections[sel] != nil && x.info.Selections[sel].Kind() == types.MethodVal {
		recv := x.expr(sel.X)
		t := x.tmp()
		temps = append(temps, fmt.Sprintf("const %s = %s;", t, recv))
		fun = x.methodCallOn(sel, t, args)
	} else {
		fun = x.callWithArgs(call, args)
	}
	x.flushPre()
	for _, t := range temps {
		x.line("%s", t)
	}
	x.line("$defers.push(() => { %s; });", fun)
}

func (x *fn) declStmt(s *ast.DeclStmt) {
	gd := s.Decl.(*ast.GenDecl)
	switch gd.Tok {
	case token.VAR:
		for _, spec := range gd.Specs {
			vs := spec.(*ast.ValueSpec)
			if len(vs.Values) == 0 {
				for _, id := range vs.Names {
					v := x.info.Defs[id].(*types.Var)
					z := x.f.varZero(v)
					if z == "undefined" {
						// Avoid TypeScript narrowing the variable to undefined
						// when it is only assigned inside closures.
						z = "undefined as " + x.f.varType(v)
					}
					x.line("%s %s: %s = %s;", x.declKeyword(v), x.name(v), x.f.varType(v), z)
				}
				continue
			}
			if len(vs.Values) == 1 && len(vs.Names) > 1 {
				rhs := x.expr(vs.Values[0])
				x.flushPre()
				t := x.tmp()
				x.line("const %s = %s;", t, rhs)
				for i, id := range vs.Names {
					if id.Name == "_" {
						continue
					}
					v := x.info.Defs[id].(*types.Var)
					x.line("%s %s: %s = %s;", x.declKeyword(v), x.name(v), x.f.tsType(v.Type()), x.tupleElem(t, vs.Values[0], i))
				}
				continue
			}
			for i, id := range vs.Names {
				var v *types.Var
				if d, ok := x.info.Defs[id].(*types.Var); ok {
					v = d
				}
				if v == nil {
					e := x.expr(vs.Values[i])
					x.flushPre()
					x.line("%s;", e)
					continue
				}
				val := x.rhsFor(id, vs.Values[i], v.Type())
				x.flushPre()
				x.line("%s %s: %s = %s;", x.declKeyword(v), x.name(v), x.f.varType(v), val)
			}
		}
	case token.CONST:
		for _, spec := range gd.Specs {
			vs := spec.(*ast.ValueSpec)
			for _, id := range vs.Names {
				if c, ok := x.info.Defs[id].(*types.Const); ok {
					x.line("const %s: %s = %s;", x.constName(c), x.f.tsType(c.Type()), x.f.constValue(c.Val(), c.Type()))
				}
			}
		}
	case token.TYPE:
		for _, spec := range gd.Specs {
			ts := spec.(*ast.TypeSpec)
			_ = ts
		}
	}
}

func (x *fn) constName(c *types.Const) string {
	return "$c_" + c.Name()
}

// tupleElem reads element i of a multi-value expression stored in t.
func (x *fn) tupleElem(t string, e ast.Expr, i int) string {
	return fmt.Sprintf("%s[%d]", t, i)
}

func (x *fn) ifStmt(s *ast.IfStmt, chained bool) {
	if s.Init != nil {
		if chained {
			x.line("{")
		} else {
			x.line("{")
		}
		x.indent++
		x.stmt(s.Init)
	}
	cond := x.cond(s.Cond)
	x.flushPre()
	x.line("if (%s) {", cond)
	x.block(s.Body.List)
	if s.Else != nil {
		switch e := s.Else.(type) {
		case *ast.IfStmt:
			if e.Init == nil {
				x.out.WriteString(strings.Repeat("  ", x.indent) + "} else ")
				// Emit the chained if without leading indentation.
				save := x.indent
				var b strings.Builder
				old := x.out
				x.out = &b
				x.ifStmt(e, true)
				x.out = old
				x.indent = save
				x.out.WriteString(strings.TrimLeft(b.String(), " "))
			} else {
				x.line("} else {")
				x.indent++
				x.ifStmt(e, false)
				x.indent--
				x.line("}")
			}
		case *ast.BlockStmt:
			x.line("} else {")
			x.block(e.List)
			x.line("}")
		}
	} else {
		x.line("}")
	}
	if s.Init != nil {
		x.indent--
		x.line("}")
	}
}

func (x *fn) cond(e ast.Expr) string {
	return x.expr(e)
}

func (x *fn) forStmt(s *ast.ForStmt, label string) {
	needsBlock := s.Init != nil
	if needsBlock {
		x.line("{")
		x.indent++
	}
	init := ""
	if s.Init != nil {
		// Declare loop variables with let in the for header so closures
		// capture per-iteration copies, as in Go 1.22.
		if as, ok := s.Init.(*ast.AssignStmt); ok && as.Tok == token.DEFINE && len(as.Lhs) == len(as.Rhs) {
			var parts []string
			for i, l := range as.Lhs {
				v := x.info.Defs[l.(*ast.Ident)].(*types.Var)
				parts = append(parts, fmt.Sprintf("%s: %s = %s", x.name(v), x.f.tsType(v.Type()), x.valueExpr(as.Rhs[i], v.Type())))
			}
			init = "let " + strings.Join(parts, ", ")
		} else {
			x.stmt(s.Init)
		}
	}
	cond := ""
	if s.Cond != nil {
		cond = x.cond(s.Cond)
	}
	post := ""
	complexPost := false
	if s.Post != nil {
		post = x.postExpr(s.Post)
		complexPost = strings.Contains(post, "const ")
	}
	x.flushPre()
	prefix := ""
	if label != "" {
		prefix = label + ": "
	}
	if complexPost {
		cont := fmt.Sprintf("$cont%d", *x.tmpN+1)
		*x.tmpN++
		x.line("%sfor (%s; %s; ) {", prefix, init, cond)
		x.indent++
		x.line("%s: {", cont)
		goLabel := strings.TrimSuffix(label, "_")
		x.targets = append(x.targets, target{kind: "loop", label: goLabel, cont: cont})
		x.block(s.Body.List)
		x.targets = x.targets[:len(x.targets)-1]
		x.line("}")
		x.stmt(s.Post)
		x.indent--
		x.line("}")
	} else {
		x.line("%sfor (%s; %s; %s) {", prefix, init, cond, post)
		x.loopBody(s.Body.List, label)
		x.line("}")
	}
	if needsBlock {
		x.indent--
		x.line("}")
	}
}

func (x *fn) loopBody(list []ast.Stmt, label string) {
	goLabel := ""
	if label != "" {
		goLabel = strings.TrimSuffix(label, "_")
	}
	x.targets = append(x.targets, target{kind: "loop", label: goLabel})
	x.block(list)
	x.targets = x.targets[:len(x.targets)-1]
}

// postExpr renders a for-loop post statement as an expression.
func (x *fn) postExpr(s ast.Stmt) string {
	var b strings.Builder
	old, oldIndent := x.out, x.indent
	x.out, x.indent = &b, 0
	x.stmt(s)
	x.out, x.indent = old, oldIndent
	lines := strings.Split(strings.TrimSpace(b.String()), "\n")
	for i := range lines {
		lines[i] = strings.TrimSuffix(strings.TrimSpace(lines[i]), ";")
	}
	if len(lines) == 1 {
		return lines[0]
	}
	return "(" + strings.Join(lines, ", ") + ")"
}

func (x *fn) rangeStmt(s *ast.RangeStmt, label string) {
	prefix := ""
	if label != "" {
		prefix = label + ": "
	}
	xt := x.info.TypeOf(s.X)
	under := under(xt)
	if p, ok := under.(*types.Pointer); ok {
		under = p.Elem().Underlying()
	}
	key, val := x.rangeVar(s.Key, s.Tok), x.rangeVar(s.Value, s.Tok)
	switch u := under.(type) {
	case *types.Basic:
		if u.Info()&types.IsString != 0 {
			src := x.tmp()
			e := x.expr(s.X)
			x.flushPre()
			i := key.name
			if i == "" {
				i = x.tmp()
			}
			sz := x.tmp()
			x.line("{")
			x.indent++
			x.line("const %s = %s;", src, e)
			x.line("%sfor (let %s = 0, %s = 0; %s < %s.length; %s += %s) {", prefix, i, sz, i, src, i, sz)
			x.indent++
			x.line("%s = $rt.utf8_DecodeRuneInStringAt(%s, %s)[1];", sz, src, i)
			if val.name != "" {
				x.line("%s %s = $rt.utf8_DecodeRuneInStringAt(%s, %s)[0];", val.decl, val.name, src, i)
			}
			x.indent--
			x.loopBody(s.Body.List, label)
			x.line("}")
			x.indent--
			x.line("}")
			return
		}
		// Range over an integer.
		n := x.expr(s.X)
		x.flushPre()
		i := key.name
		if i == "" {
			i = x.tmp()
		}
		lim := x.tmp()
		if key.decl == "" && key.name != "" {
			x.line("%sfor (let %s = 0, %s = %s; %s < %s; %s++) {", prefix, x.tmp(), lim, n, key.name, lim, key.name)
		} else {
			x.line("%sfor (let %s = 0, %s = %s; %s < %s; %s++) {", prefix, i, lim, n, i, lim, i)
		}
		x.loopBody(s.Body.List, label)
		x.line("}")
	case *types.Slice, *types.Array:
		src := x.tmp()
		e := x.expr(s.X)
		x.flushPre()
		i := x.tmp()
		x.line("{")
		x.indent++
		x.line("const %s = %s;", src, e)
		x.line("%sfor (let %s = 0, $n = %s.length; %s < $n; %s++) {", prefix, i, src, i, i)
		x.indent++
		if key.name != "" {
			x.line("%s %s = %s;", key.decl, key.name, i)
		}
		if val.name != "" {
			var elem types.Type
			if sl, ok := u.(*types.Slice); ok {
				elem = sl.Elem()
			} else {
				elem = u.(*types.Array).Elem()
			}
			x.line("%s %s = %s;", val.decl, val.name, x.f.copyValue(src+"["+i+"]", elem))
		}
		x.indent--
		x.loopBody(s.Body.List, label)
		x.line("}")
		x.indent--
		x.line("}")
	case *types.Map:
		e := x.expr(s.X)
		x.flushPre()
		empty := "new " + strings.TrimSuffix(x.f.tsType(u), " | undefined") + "()"
		if isSpecialMap(u) {
			e = "(" + e + ")?.entryList()"
			empty = "[]"
		}
		k, v := key.name, val.name
		if k == "" {
			k = x.tmp()
		}
		if v == "" {
			v = x.tmp()
		}
		if key.decl == "" && key.name != "" || val.decl == "" && val.name != "" {
			tk, tv := x.tmp(), x.tmp()
			x.line("%sfor (const [%s, %s] of (%s ?? %s)) {", prefix, tk, tv, e, empty)
			x.indent++
			if key.name != "" {
				x.line("%s = %s;", key.name, tk)
			}
			if val.name != "" {
				x.line("%s = %s;", val.name, tv)
			}
			x.indent--
		} else {
			x.line("%sfor (const [%s, %s] of (%s ?? %s)) {", prefix, k, v, e, empty)
		}
		x.loopBody(s.Body.List, label)
		x.line("}")
	case *types.Signature:
		x.rangeFuncStmt(s, u, key, val, label)
	default:
		x.line("throw $rt.unsupported(%q);", x.f.t.stub(s.Pos(), fmt.Sprintf("range over %T", u)))
	}
}

type rangeVarInfo struct {
	name string
	decl string // "let" for new variables, "" for assignment to existing ones
}

func (x *fn) rangeVar(e ast.Expr, tok token.Token) rangeVarInfo {
	if e == nil {
		return rangeVarInfo{}
	}
	id, ok := e.(*ast.Ident)
	if ok && id.Name == "_" {
		return rangeVarInfo{}
	}
	if tok == token.DEFINE && ok {
		v := x.info.Defs[id].(*types.Var)
		return rangeVarInfo{name: x.name(v), decl: x.declKeyword(v)}
	}
	return rangeVarInfo{name: x.expr(e)}
}

// rangeFuncStmt translates range-over-func into a callback.
func (x *fn) rangeFuncStmt(s *ast.RangeStmt, sig *types.Signature, key, val rangeVarInfo, label string) {
	seq := x.expr(s.X)
	x.flushPre()
	flag, ret := x.tmp(), x.tmp()
	x.line("let %s = false;", flag)
	// The result starts as the zero value, so its type never gains an
	// extra undefined arm.
	resType, resZero := "undefined", "undefined"
	if x.sig != nil && x.sig.Results().Len() > 0 {
		if x.sig.Results().Len() == 1 {
			resType = x.f.tsType(x.sig.Results().At(0).Type())
			resZero = x.f.zero(x.sig.Results().At(0).Type())
		} else {
			resType = x.f.tsType(x.sig.Results())
			var zs []string
			for i := 0; i < x.sig.Results().Len(); i++ {
				zs = append(zs, x.f.zero(x.sig.Results().At(i).Type()))
			}
			resZero = "[" + strings.Join(zs, ", ") + "]"
		}
	}
	if resZero == "undefined" && resType != "undefined" {
		resZero = "undefined as " + resType
	}
	x.line("let %s: %s = %s;", ret, resType, resZero)
	yield := sig.Params().At(0).Type().Underlying().(*types.Signature)
	var params []string
	names := []rangeVarInfo{key, val}
	var assigns []string
	for i := 0; i < yield.Params().Len(); i++ {
		pt := x.f.tsType(yield.Params().At(i).Type())
		n := names[i]
		switch {
		case n.name == "":
			params = append(params, fmt.Sprintf("%s: %s", x.tmp(), pt))
		case n.decl == "":
			t := x.tmp()
			params = append(params, fmt.Sprintf("%s: %s", t, pt))
			assigns = append(assigns, fmt.Sprintf("%s = %s;", n.name, t))
		default:
			params = append(params, fmt.Sprintf("%s: %s", n.name, pt))
		}
	}
	x.line("%s!((%s): boolean => {", seq, strings.Join(params, ", "))
	x.indent++
	for _, a := range assigns {
		x.line("%s", a)
	}
	saved := x.rangeFunc
	x.rangeFunc = &rangeFuncCtx{retFlag: flag, retVal: ret, depth: len(x.targets)}
	goLabel := strings.TrimSuffix(label, "_")
	x.targets = append(x.targets, target{kind: "rangefunc", label: goLabel})
	savedDeferred := x.deferred
	x.deferred = false
	x.stmts(s.Body.List)
	x.deferred = savedDeferred
	x.targets = x.targets[:len(x.targets)-1]
	x.rangeFunc = saved
	x.line("return true;")
	x.indent--
	x.line("});")
	if hasReturn(s.Body) {
		if x.sig != nil && x.sig.Results().Len() > 0 {
			x.emitReturnRaw(flag, ret)
		} else {
			x.emitReturnRaw(flag, "")
		}
	}
}

func (x *fn) emitReturnRaw(flag, val string) {
	if x.rangeFunc != nil {
		if val != "" {
			x.line("if (%s) { %s = %s; %s = true; return false; }", flag, x.rangeFunc.retVal, val, x.rangeFunc.retFlag)
		} else {
			x.line("if (%s) { %s = true; return false; }", flag, x.rangeFunc.retFlag)
		}
		return
	}
	if x.deferred {
		if val != "" {
			if len(x.results) == 1 {
				x.line("if (%s) { %s = %s; break $body; }", flag, x.results[0], val)
			} else {
				var sets []string
				for i, r := range x.results {
					sets = append(sets, fmt.Sprintf("%s = %s[%d];", r, val, i))
				}
				x.line("if (%s) { %s break $body; }", flag, strings.Join(sets, " "))
			}
		} else {
			x.line("if (%s) break $body;", flag)
		}
		return
	}
	if val != "" {
		x.line("if (%s) return %s;", flag, val)
	} else {
		x.line("if (%s) return;", flag)
	}
}

func hasReturn(b *ast.BlockStmt) bool {
	found := false
	ast.Inspect(b, func(n ast.Node) bool {
		switch n.(type) {
		case *ast.FuncLit:
			return false
		case *ast.ReturnStmt:
			found = true
		}
		return !found
	})
	return found
}

func (x *fn) switchStmt(s *ast.SwitchStmt, label string) {
	x.line("{")
	x.indent++
	if s.Init != nil {
		x.stmt(s.Init)
	}
	goLabel := strings.TrimSuffix(label, "_")
	// Use a native switch for constant cases without fallthrough into a
	// non-adjacent body.
	native := s.Tag != nil && x.constCases(s.Body)
	if native {
		tag := x.expr(s.Tag)
		x.flushPre()
		prefix := ""
		if label != "" {
			prefix = label + ": "
		}
		x.line("%sswitch (%s) {", prefix, tag)
		x.targets = append(x.targets, target{kind: "switch", label: goLabel})
		for _, c := range s.Body.List {
			cc := c.(*ast.CaseClause)
			if cc.List == nil {
				x.line("default: {")
			} else {
				for i, e := range cc.List {
					v := x.widened(e)
					if i == len(cc.List)-1 {
						x.line("case %s: {", v)
					} else {
						x.line("case %s:", v)
					}
				}
			}
			x.indent++
			x.stmts(cc.Body)
			if !endsWithFallthrough(cc.Body) && !terminates(cc.Body) {
				x.line("break;")
			}
			x.indent--
			x.line("}")
		}
		x.targets = x.targets[:len(x.targets)-1]
		x.line("}")
		x.indent--
		x.line("}")
		return
	}
	tsLabel := label
	if tsLabel == "" {
		tsLabel = fmt.Sprintf("$sw%d", *x.tmpN+1)
		*x.tmpN++
	}
	tag := ""
	var tagType types.Type
	if s.Tag != nil {
		tag = x.tmp()
		tagType = x.info.TypeOf(s.Tag)
		v := x.expr(s.Tag)
		x.flushPre()
		x.line("const %s = %s;", tag, v)
	}
	x.line("%s: {", tsLabel)
	x.indent++
	x.targets = append(x.targets, target{kind: "switch", label: goLabel, ts: tsLabel})
	var def *ast.CaseClause
	first := true
	clauses := s.Body.List
	for ci, c := range clauses {
		cc := c.(*ast.CaseClause)
		if cc.List == nil {
			def = cc
			continue
		}
		var conds []string
		for _, e := range cc.List {
			if s.Tag != nil {
				conds = append(conds, x.equal(tag, tagType, e))
			} else {
				conds = append(conds, x.cond(e))
			}
		}
		kw := "if"
		if !first {
			kw = "} else if"
		}
		first = false
		x.flushPre()
		x.line("%s (%s) {", kw, strings.Join(conds, " || "))
		x.indent++
		x.caseBody(cc, clauses, ci)
		x.indent--
	}
	if def != nil {
		if first {
			x.line("{")
		} else {
			x.line("} else {")
		}
		x.indent++
		x.stmts(def.Body)
		x.indent--
		x.line("}")
	} else if !first {
		x.line("}")
	}
	x.targets = x.targets[:len(x.targets)-1]
	x.indent--
	x.line("}")
	x.indent--
	x.line("}")
}

func (x *fn) caseBody(cc *ast.CaseClause, clauses []ast.Stmt, i int) {
	x.stmts(cc.Body)
	for endsWithFallthrough(cc.Body) && i+1 < len(clauses) {
		i++
		cc = clauses[i].(*ast.CaseClause)
		x.stmts(cc.Body)
	}
}

func endsWithFallthrough(list []ast.Stmt) bool {
	if len(list) == 0 {
		return false
	}
	b, ok := list[len(list)-1].(*ast.BranchStmt)
	return ok && b.Tok == token.FALLTHROUGH
}

func terminates(list []ast.Stmt) bool {
	if len(list) == 0 {
		return false
	}
	switch s := list[len(list)-1].(type) {
	case *ast.ReturnStmt:
		return true
	case *ast.BranchStmt:
		return s.Tok == token.CONTINUE || s.Tok == token.GOTO || s.Tok == token.BREAK && s.Label != nil
	case *ast.ExprStmt:
		if c, ok := s.X.(*ast.CallExpr); ok {
			if id, ok := c.Fun.(*ast.Ident); ok && id.Name == "panic" {
				return true
			}
		}
	}
	return false
}

func (x *fn) constCases(body *ast.BlockStmt) bool {
	for _, c := range body.List {
		for _, e := range c.(*ast.CaseClause).List {
			tv := x.info.Types[e]
			if tv.Value == nil {
				return false
			}
			if _, ok := tv.Type.Underlying().(*types.Basic); !ok {
				return false
			}
		}
	}
	return true
}

func (x *fn) typeSwitch(s *ast.TypeSwitchStmt, label string) {
	x.line("{")
	x.indent++
	if s.Init != nil {
		x.stmt(s.Init)
	}
	var subject ast.Expr
	var bind *ast.Ident
	switch a := s.Assign.(type) {
	case *ast.AssignStmt:
		bind = a.Lhs[0].(*ast.Ident)
		subject = a.Rhs[0].(*ast.TypeAssertExpr).X
	case *ast.ExprStmt:
		subject = a.X.(*ast.TypeAssertExpr).X
	}
	subj := x.tmp()
	v := x.expr(subject)
	x.flushPre()
	x.line("const %s: %s = %s;", subj, x.f.tsType(x.info.TypeOf(subject)), v)
	x.boxGeneric = isEmptyIface(x.info.TypeOf(subject))
	defer func() { x.boxGeneric = false }()
	tsLabel := label
	if tsLabel == "" {
		tsLabel = fmt.Sprintf("$sw%d", *x.tmpN+1)
		*x.tmpN++
	}
	x.line("%s: {", tsLabel)
	x.indent++
	x.targets = append(x.targets, target{kind: "switch", label: strings.TrimSuffix(label, "_"), ts: tsLabel})
	var def *ast.CaseClause
	first := true
	// Go interfaces can hold typed nil pointers, which match their pointer
	// case. Nil values here are untyped, so without a nil case they go to
	// the first pointer case.
	hasNilCase := false
	for _, c := range s.Body.List {
		for _, e := range c.(*ast.CaseClause).List {
			if isNilType(x.info.TypeOf(e)) {
				hasNilCase = true
			}
		}
	}
	nilRouted := hasNilCase
	for _, c := range s.Body.List {
		cc := c.(*ast.CaseClause)
		if cc.List == nil {
			def = cc
			continue
		}
		var conds []string
		routedHere := false
		for _, e := range cc.List {
			conds = append(conds, x.typeTest(subj, x.info.TypeOf(e), e))
			if !nilRouted {
				if _, isPtr := types.Unalias(x.info.TypeOf(e)).(*types.Pointer); isPtr {
					conds = append(conds, subj+" === undefined")
					nilRouted = true
					routedHere = true
				}
			}
		}
		kw := "if"
		if !first {
			kw = "} else if"
		}
		first = false
		x.line("%s (%s) {", kw, strings.Join(conds, " || "))
		x.indent++
		if bind != nil {
			if obj, ok := x.info.Implicits[cc].(*types.Var); ok && obj != nil {
				val := subj
				if len(cc.List) == 1 {
					val = x.unbox(subj, obj.Type())
				}
				if routedHere && len(cc.List) == 1 {
					val = subj + " === undefined ? undefined : " + x.unbox(subj, obj.Type())
				}
				x.line("const %s: %s = %s;", x.name(obj), x.f.tsType(obj.Type()), val)
			}
		}
		x.stmts(cc.Body)
		x.indent--
	}
	if def != nil {
		if first {
			x.line("{")
		} else {
			x.line("} else {")
		}
		x.indent++
		if bind != nil {
			if obj, ok := x.info.Implicits[def].(*types.Var); ok && obj != nil {
				x.line("const %s: %s = %s;", x.name(obj), x.f.tsType(obj.Type()), subj)
			}
		}
		x.stmts(def.Body)
		x.indent--
		x.line("}")
	} else if !first {
		x.line("}")
	}
	x.targets = x.targets[:len(x.targets)-1]
	x.indent--
	x.line("}")
	x.indent--
	x.line("}")
}

// typeTest renders a dynamic type check of an interface value.
func (x *fn) typeTest(v string, tt types.Type, e ast.Expr) string {
	if tt == nil || isNilType(tt) {
		return v + " === undefined"
	}
	if x.boxGeneric && isGenericPtr(tt) {
		return v + " instanceof " + x.f.boxRefFor(tt)
	}
	switch u := tt.(type) {
	case *types.Pointer:
		if n, ok := u.Elem().(*types.Named); ok {
			if _, isStruct := n.Underlying().(*types.Struct); isStruct {
				return v + " instanceof " + x.f.classExpr(n)
			}
		}
	case *types.Named:
		if _, isStruct := u.Underlying().(*types.Struct); isStruct {
			return v + " instanceof " + x.f.classExpr(u)
		}
		if it, isIface := u.Underlying().(*types.Interface); isIface {
			return x.ifaceTest(v, u, it)
		}
		if x.f.t.translated(u.Obj().Pkg()) && x.f.boxedBy(u.Obj()) {
			return v + " instanceof " + x.f.boxRef(u.Obj())
		}
		if _, isBasic := u.Underlying().(*types.Basic); !isBasic {
			return v + " instanceof " + x.f.boxRefFor(u)
		}
		return fmt.Sprintf("$rt.isValue(%s, %q)", v, typeTag(u))
	case *types.Basic:
		return fmt.Sprintf("$rt.isValue(%s, %q)", v, typeTag(u))
	case *types.Interface:
		return x.ifaceTest(v, nil, u)
	}
	if mentionsTypeParam(tt) {
		return v + " !== undefined"
	}
	if _, isBasic := under(tt).(*types.Basic); !isBasic {
		return v + " instanceof " + x.f.boxRefFor(tt)
	}
	return fmt.Sprintf("$rt.isValue(%s, %q)", v, typeTag(tt))
}

func (x *fn) ifaceTest(v string, n *types.Named, it *types.Interface) string {
	if it.NumMethods() == 0 {
		return v + " !== undefined"
	}
	if !x.ifaceClassesReachable(n, it) {
		var names []string
		for i := 0; i < it.NumMethods(); i++ {
			names = append(names, fmt.Sprintf("%q", it.Method(i).Name()))
		}
		return fmt.Sprintf("$rt.hasMethods(%s, [%s])", v, strings.Join(names, ", "))
	}
	if n != nil {
		if m := x.f.t.ifaces[n.Origin().Obj()]; m != nil && m.stub {
			return v + " instanceof " + x.f.qualify(n.Origin().Obj())
		}
		if m := x.f.t.ifaces[n.Origin().Obj()]; m != nil {
			if m.base != nil {
				return v + " instanceof " + x.f.qualify(m.base)
			}
			var parts []string
			for _, u := range m.union {
				if p, ok := u.(*types.Pointer); ok {
					parts = append(parts, v+" instanceof "+x.f.qualify(p.Elem().(*types.Named).Obj()))
				} else {
					parts = append(parts, v+" instanceof "+x.f.boxRef(u.(*types.Named).Obj()))
				}
			}
			if len(parts) > 0 {
				return "(" + strings.Join(parts, " || ") + ")"
			}
		}
	}
	if m := x.f.t.anonIfaces[types.TypeString(it, nil)]; m != nil && n == nil {
		if m.base != nil {
			return v + " instanceof " + x.f.qualify(m.base)
		}
		var parts []string
		for _, u := range m.union {
			if p, ok := u.(*types.Pointer); ok {
				parts = append(parts, v+" instanceof "+x.f.qualify(p.Elem().(*types.Named).Obj()))
			} else {
				parts = append(parts, v+" instanceof "+x.f.boxRef(u.(*types.Named).Obj()))
			}
		}
		if len(parts) > 0 {
			return "(" + strings.Join(parts, " || ") + ")"
		}
	}
	var names []string
	for i := 0; i < it.NumMethods(); i++ {
		names = append(names, fmt.Sprintf("%q", it.Method(i).Name()))
	}
	return fmt.Sprintf("$rt.hasMethods(%s, [%s])", v, strings.Join(names, ", "))
}

// classExpr names the runtime class of struct type n.
func (f *file) classExpr(n *types.Named) string {
	tn := n.Origin().Obj()
	if !f.t.translated(tn.Pkg()) {
		return f.stdType(n)
	}
	if c := f.t.classOf(tn); c != nil {
		return f.qualify(c.name)
	}
	if base, ok := f.t.structAlias[tn]; ok {
		if bn, ok := types.Unalias(base).(*types.Named); ok {
			return f.classExpr(bn)
		}
	}
	return f.qualify(tn)
}

func isNilType(tt types.Type) bool {
	b, ok := tt.(*types.Basic)
	return ok && b.Kind() == types.UntypedNil
}

// typeTag identifies a non-class dynamic type inside a value box.
func typeTag(tt types.Type) string {
	return types.TypeString(tt, func(p *types.Package) string {
		return strings.TrimPrefix(p.Path(), modulePrefix)
	})
}

// castClass returns the class whose static $cast narrows an interface value
// to tt, or "" when tt is not represented by a single translated class.
func (x *fn) castClass(tt types.Type) string {
	var n *types.Named
	switch u := types.Unalias(tt).(type) {
	case *types.Pointer:
		n, _ = types.Unalias(u.Elem()).(*types.Named)
	case *types.Named:
		n = u
	}
	if n == nil || !x.f.t.translated(n.Obj().Pkg()) || n.TypeArgs().Len() > 0 {
		return ""
	}
	tn := n.Origin().Obj()
	if it, ok := n.Underlying().(*types.Interface); ok {
		if m := x.f.t.ifaces[tn]; m != nil && m.stub {
			return x.f.qualify(tn) + ".$cast_" + x.f.t.helperKey(tn)
		}
		if m := x.f.t.ifaces[tn]; m != nil && m.base != nil && it.NumMethods() > 0 && x.f.dependsOn(m.base.Pkg()) {
			if bn, ok := m.base.Type().(*types.Named); ok && bn.TypeParams().Len() == 0 {
				return x.f.qualify(m.base) + ".$cast_" + x.f.t.helperKey(m.base)
			}
		}
		return ""
	}
	if !isStructType(n) {
		if _, isPtr := types.Unalias(tt).(*types.Pointer); isPtr {
			return ""
		}
		if x.f.boxedBy(tn) {
			return x.f.boxRef(tn) + ".$cast"
		}
		return ""
	}
	if c := x.f.t.classOf(tn); c != nil && n.Origin().TypeParams().Len() == 0 {
		return x.f.qualify(c.name) + ".$cast_" + x.f.t.helperKey(c.name)
	}
	return ""
}

// unbox extracts a typed value from an interface value known to hold it.
func (x *fn) unbox(v string, tt types.Type) string {
	if x.boxGeneric && isGenericPtr(tt) {
		return x.f.boxRefFor(tt) + ".$cast(" + v + ").v"
	}
	if c := x.castClass(tt); c != "" {
		if isBoxedNamed(x, tt) {
			return c + "(" + v + ").v"
		}
		return c + "(" + v + ")"
	}
	if isIfaceType(tt) {
		if t := x.f.tsType(tt); t != "$rt.GoObject | undefined" {
			if !x.ifaceReachable(tt) {
				// The classes behind tt are not importable from here.
				return "$rt.unsupportedConversion<" + t + ">(" + strconv.Quote(t) + ")"
			}
			return "(" + v + " as " + t + ")"
		}
		return v
	}
	if isStructType(tt) || isPtrToStruct(tt) {
		return "(" + v + " as " + x.f.tsType(tt) + ")"
	}
	if _, isTP := types.Unalias(tt).(*types.TypeParam); isTP {
		return "$rt.unboxAny<" + x.f.tsType(tt) + ">(" + v + ")"
	}
	if b, ok := under(tt).(*types.Basic); ok {
		switch basicKind(b) {
		case "string":
			return "$rt.checkString(true, " + v + ")"
		case "boolean":
			return "$rt.checkBool(true, " + v + ")"
		default:
			return "$rt.checkNumber(true, " + v + ")"
		}
	}
	if mentionsTypeParam(tt) {
		return "$rt.unboxAny<" + x.f.tsType(tt) + ">(" + v + ")"
	}
	return x.f.boxRefFor(tt) + ".$cast(" + v + ").v"
}

func isIfaceType(tt types.Type) bool {
	if _, ok := tt.(*types.TypeParam); ok {
		return false
	}
	_, ok := under(tt).(*types.Interface)
	return ok
}

var _ = constant.Bool

// ifaceClassesReachable reports whether every class an interface maps to is
// declared in a package this one depends on.
func (x *fn) ifaceClassesReachable(n *types.Named, it *types.Interface) bool {
	var m *ifaceMap
	if n != nil {
		m = x.f.t.ifaces[n.Origin().Obj()]
	}
	if m == nil {
		m = x.f.t.anonIfaces[types.TypeString(it, nil)]
	}
	if m == nil {
		return true
	}
	if m.base != nil && !x.f.dependsOn(m.base.Pkg()) {
		return false
	}
	for _, u := range m.union {
		var tn *types.TypeName
		if p, ok := u.(*types.Pointer); ok {
			tn = p.Elem().(*types.Named).Obj()
		} else {
			tn = u.(*types.Named).Obj()
		}
		if !x.f.dependsOn(tn.Pkg()) {
			return false
		}
	}
	return true
}

func isPtrToStruct(tt types.Type) bool {
	p, ok := types.Unalias(tt).(*types.Pointer)
	return ok && isStructType(p.Elem())
}

// isBoxedNamed reports whether values of tt live in interfaces inside a
// generated per-type box class (named non-struct types with methods).
func isBoxedNamed(x *fn, tt types.Type) bool {
	n, ok := types.Unalias(tt).(*types.Named)
	if !ok || isStructType(n) || isIfaceType(n) {
		return false
	}
	return x.f.t.translated(n.Obj().Pkg()) && x.f.boxedBy(n.Origin().Obj())
}

// writeBackCall handles a call statement that passes subslices s[a:b]: Go
// passes views, so writes by the callee show in s. The subslice is copied
// into a temporary and written back after the call.
func (x *fn) writeBackCall(call *ast.CallExpr) bool {
	type back struct {
		tmp, base, lo string
	}
	var backs []back
	for _, a := range call.Args {
		sl, ok := unparen(a).(*ast.SliceExpr)
		if !ok || sl.Slice3 || !simpleExpr(sl.X) {
			continue
		}
		if _, isSlice := under(x.info.TypeOf(sl.X)).(*types.Slice); !isSlice {
			continue
		}
		backs = append(backs, back{base: x.expr(sl.X)})
	}
	if len(backs) == 0 {
		return false
	}
	// Translate with the subslices replaced by temporaries.
	saved := map[ast.Expr]string{}
	i := 0
	for _, a := range call.Args {
		sl, ok := unparen(a).(*ast.SliceExpr)
		if !ok || sl.Slice3 || !simpleExpr(sl.X) {
			continue
		}
		if _, isSlice := under(x.info.TypeOf(sl.X)).(*types.Slice); !isSlice {
			continue
		}
		t := x.tmp()
		lo := "0"
		if sl.Low != nil {
			lo = x.expr(sl.Low)
		}
		x.line("const %s = %s;", t, x.expr(sl))
		backs[i].tmp, backs[i].lo = t, lo
		saved[a] = t
		i++
	}
	x.subst = saved
	e := x.expr(call)
	x.subst = nil
	x.flushPre()
	x.line("%s;", e)
	for _, b := range backs {
		x.line("$rt.copyAt(%s, %s, -1, %s);", b.base, b.lo, b.tmp)
	}
	return true
}

// ifaceReachable reports whether this module can import the classes that
// represent interface type tt.
func (x *fn) ifaceReachable(tt types.Type) bool {
	it, ok := tt.Underlying().(*types.Interface)
	if !ok {
		return true
	}
	var m *ifaceMap
	if n, ok := types.Unalias(tt).(*types.Named); ok {
		m = x.f.t.ifaces[n.Origin().Obj()]
	} else {
		m = x.f.t.anonIfaces[types.TypeString(it, nil)]
	}
	return m == nil || m.base == nil || x.f.dependsOn(m.base.Pkg())
}
