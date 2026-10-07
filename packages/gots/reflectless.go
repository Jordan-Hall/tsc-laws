package main

import (
	"fmt"
	"go/types"
	"reflect"
	"strings"

	"golang.org/x/tools/go/packages"
)

// Reflection-free replacements: TypeScript-Go merges compiler options with
// reflect, which the translation doesn't support. This generates the same
// field-by-field merge from the CompilerOptions declaration.

const mergeReflect = `	targetValue := reflect.ValueOf(targetOptions).Elem()
	sourceValue := reflect.ValueOf(sourceOptions).Elem()
	targetType := targetValue.Type()

	for i := range targetValue.NumField() {
		targetField := targetValue.Field(i)
		sourceField := sourceValue.Field(i)

		// Get the JSON field name for this struct field and check if it's explicitly null
		if jsonTag := targetType.Field(i).Tag.Get("json"); jsonTag != "" {
			if jsonFieldName, _, _ := strings.Cut(jsonTag, ","); jsonFieldName != "" && explicitNullFields.Has(jsonFieldName) {
				targetField.SetZero()
				continue
			}
		}

		// Normal merge behavior: copy non-zero fields
		if !sourceField.IsZero() {
			targetField.Set(sourceField)
		}
	}
`

func mergeCompilerOptionsCode(upstream string, env []string, buildFlags []string) string {
	pkgs, err := packages.Load(&packages.Config{Mode: packages.NeedTypes, Dir: upstream, Env: env, BuildFlags: buildFlags}, modulePrefix+"core")
	if err != nil || len(pkgs) != 1 || pkgs[0].Types == nil {
		fatal(fmt.Errorf("loading core for CompilerOptions: %v", err))
	}
	st := pkgs[0].Types.Scope().Lookup("CompilerOptions").Type().Underlying().(*types.Struct)
	var b strings.Builder
	for i := 0; i < st.NumFields(); i++ {
		fl := st.Field(i)
		if fl.Name() == "_" {
			continue
		}
		name, _, _ := strings.Cut(reflect.StructTag(st.Tag(i)).Get("json"), ",")
		zero := zeroLiteral(fl.Type())
		if name != "" {
			fmt.Fprintf(&b, "\tif explicitNullFields.Has(%q) {\n\t\ttargetOptions.%s = %s\n\t} else ", name, fl.Name(), zero)
		} else {
			b.WriteString("\t")
		}
		fmt.Fprintf(&b, "if sourceOptions.%s != %s {\n\t\ttargetOptions.%s = sourceOptions.%s\n\t}\n", fl.Name(), zero, fl.Name(), fl.Name())
	}
	return b.String()
}

func zeroLiteral(tt types.Type) string {
	switch u := tt.Underlying().(type) {
	case *types.Basic:
		switch {
		case u.Info()&types.IsString != 0:
			return `""`
		case u.Info()&types.IsBoolean != 0:
			return "false"
		}
		return "0"
	case *types.Pointer, *types.Slice, *types.Map, *types.Interface, *types.Signature, *types.Chan:
		return "nil"
	}
	fatal(fmt.Errorf("no zero literal for CompilerOptions field type %s", tt))
	return ""
}
