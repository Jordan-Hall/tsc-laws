package packagejson

// This file is added to TypeScript-Go's packagejson package when translating.
// Parse decodes package.json without the reflection-based JSON library: it
// reads a generic value tree, then fills in the fields tsgo uses.

import (
	"errors"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/microsoft/typescript-go/internal/collections"
)

func Parse(data []byte) (Fields, error) {
	d := &jsonDecoder{data: data}
	d.space()
	root, err := d.value()
	if err != nil {
		return Fields{}, err
	}
	d.space()
	if d.pos != len(d.data) {
		return Fields{}, errors.New("invalid character after top-level value")
	}
	obj, ok := root.(*jsonObject)
	if !ok {
		return Fields{}, errors.New("package.json is not an object")
	}
	var f Fields
	f.Name = expectedString(obj, "name")
	f.Version = expectedString(obj, "version")
	f.Type = expectedString(obj, "type")
	f.TSConfig = expectedString(obj, "tsconfig")
	f.Main = expectedString(obj, "main")
	f.Types = expectedString(obj, "types")
	f.Typings = expectedString(obj, "typings")
	if v, ok := obj.get("typesVersions"); ok {
		f.TypesVersions = toJSONValue(v)
	}
	if v, ok := obj.get("imports"); ok {
		f.Imports = toExportsOrImports(v)
	}
	if v, ok := obj.get("exports"); ok {
		f.Exports = toExportsOrImports(v)
	}
	f.Dependencies = expectedStringMap(obj, "dependencies")
	f.DevDependencies = expectedStringMap(obj, "devDependencies")
	f.PeerDependencies = expectedStringMap(obj, "peerDependencies")
	f.OptionalDependencies = expectedStringMap(obj, "optionalDependencies")
	return f, nil
}

// Values: nil, bool, float64, string, []any, *jsonObject.

type jsonObject struct {
	keys   []string
	values map[string]any
}

func (o *jsonObject) get(key string) (any, bool) {
	v, ok := o.values[key]
	return v, ok
}

func (o *jsonObject) set(key string, v any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = v
}

func jsonKind(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case *jsonObject:
		return "object"
	}
	return "number"
}

func expectedString(o *jsonObject, key string) Expected[string] {
	var e Expected[string]
	if v, ok := o.get(key); ok {
		e.actualJSONType = jsonKind(v)
		e.Null = v == nil
		if s, ok := v.(string); ok {
			e.Value, e.Valid = s, true
		}
	}
	return e
}

func expectedBool(o *jsonObject, key string) Expected[bool] {
	var e Expected[bool]
	if v, ok := o.get(key); ok {
		e.actualJSONType = jsonKind(v)
		e.Null = v == nil
		if b, ok := v.(bool); ok {
			e.Value, e.Valid = b, true
		}
	}
	return e
}

func expectedStrings(o *jsonObject, key string) Expected[[]string] {
	var e Expected[[]string]
	if v, ok := o.get(key); ok {
		e.actualJSONType = jsonKind(v)
		e.Null = v == nil
		if list, ok := v.([]any); ok {
			out := make([]string, 0, len(list))
			for _, item := range list {
				s, ok := item.(string)
				if !ok {
					return e
				}
				out = append(out, s)
			}
			e.Value, e.Valid = out, true
		}
	}
	return e
}

func expectedStringMap(o *jsonObject, key string) Expected[map[string]string] {
	var e Expected[map[string]string]
	if v, ok := o.get(key); ok {
		e.actualJSONType = jsonKind(v)
		e.Null = v == nil
		if obj, ok := v.(*jsonObject); ok {
			out := make(map[string]string, len(obj.keys))
			for _, k := range obj.keys {
				s, ok := obj.values[k].(string)
				if !ok {
					return e
				}
				out[k] = s
			}
			e.Value, e.Valid = out, true
		}
	}
	return e
}

func toJSONValue(v any) JSONValue {
	switch x := v.(type) {
	case nil:
		return JSONValue{Type: JSONValueTypeNull}
	case string:
		return JSONValue{Type: JSONValueTypeString, Value: x}
	case bool:
		return JSONValue{Type: JSONValueTypeBoolean, Value: x}
	case float64:
		return JSONValue{Type: JSONValueTypeNumber, Value: x}
	case []any:
		elements := make([]JSONValue, len(x))
		for i, item := range x {
			elements[i] = toJSONValue(item)
		}
		return JSONValue{Type: JSONValueTypeArray, Value: elements}
	case *jsonObject:
		m := &collections.OrderedMap[string, JSONValue]{}
		for _, k := range x.keys {
			m.Set(k, toJSONValue(x.values[k]))
		}
		return JSONValue{Type: JSONValueTypeObject, Value: m}
	}
	return JSONValue{}
}

func toExportsOrImports(v any) ExportsOrImports {
	switch x := v.(type) {
	case []any:
		elements := make([]ExportsOrImports, len(x))
		for i, item := range x {
			elements[i] = toExportsOrImports(item)
		}
		return ExportsOrImports{JSONValue: JSONValue{Type: JSONValueTypeArray, Value: elements}}
	case *jsonObject:
		m := &collections.OrderedMap[string, ExportsOrImports]{}
		for _, k := range x.keys {
			m.Set(k, toExportsOrImports(x.values[k]))
		}
		return ExportsOrImports{JSONValue: JSONValue{Type: JSONValueTypeObject, Value: m}}
	}
	return ExportsOrImports{JSONValue: toJSONValue(v)}
}

type jsonDecoder struct {
	data []byte
	pos  int
}

var errSyntax = errors.New("invalid JSON in package.json")

func (d *jsonDecoder) space() {
	for d.pos < len(d.data) {
		switch d.data[d.pos] {
		case ' ', '\t', '\n', '\r':
			d.pos++
		default:
			return
		}
	}
}

func (d *jsonDecoder) value() (any, error) {
	if d.pos >= len(d.data) {
		return nil, errSyntax
	}
	switch c := d.data[d.pos]; {
	case c == '{':
		return d.object()
	case c == '[':
		return d.array()
	case c == '"':
		return d.str()
	case c == 't':
		return true, d.literal("true")
	case c == 'f':
		return false, d.literal("false")
	case c == 'n':
		return nil, d.literal("null")
	case c == '-' || c >= '0' && c <= '9':
		return d.number()
	}
	return nil, errSyntax
}

func (d *jsonDecoder) literal(word string) error {
	if d.pos+len(word) > len(d.data) || string(d.data[d.pos:d.pos+len(word)]) != word {
		return errSyntax
	}
	d.pos += len(word)
	return nil
}

func (d *jsonDecoder) object() (any, error) {
	d.pos++
	obj := &jsonObject{values: map[string]any{}}
	d.space()
	if d.pos < len(d.data) && d.data[d.pos] == '}' {
		d.pos++
		return obj, nil
	}
	for {
		d.space()
		if d.pos >= len(d.data) || d.data[d.pos] != '"' {
			return nil, errSyntax
		}
		key, err := d.str()
		if err != nil {
			return nil, err
		}
		d.space()
		if d.pos >= len(d.data) || d.data[d.pos] != ':' {
			return nil, errSyntax
		}
		d.pos++
		d.space()
		v, err := d.value()
		if err != nil {
			return nil, err
		}
		obj.set(key, v)
		d.space()
		if d.pos >= len(d.data) {
			return nil, errSyntax
		}
		if d.data[d.pos] == ',' {
			d.pos++
			continue
		}
		if d.data[d.pos] == '}' {
			d.pos++
			return obj, nil
		}
		return nil, errSyntax
	}
}

func (d *jsonDecoder) array() (any, error) {
	d.pos++
	var out []any
	d.space()
	if d.pos < len(d.data) && d.data[d.pos] == ']' {
		d.pos++
		return []any{}, nil
	}
	for {
		d.space()
		v, err := d.value()
		if err != nil {
			return nil, err
		}
		out = append(out, v)
		d.space()
		if d.pos >= len(d.data) {
			return nil, errSyntax
		}
		if d.data[d.pos] == ',' {
			d.pos++
			continue
		}
		if d.data[d.pos] == ']' {
			d.pos++
			return out, nil
		}
		return nil, errSyntax
	}
}

func (d *jsonDecoder) number() (any, error) {
	start := d.pos
	for d.pos < len(d.data) {
		c := d.data[d.pos]
		if c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' || c >= '0' && c <= '9' {
			d.pos++
			continue
		}
		break
	}
	f, err := strconv.ParseFloat(string(d.data[start:d.pos]), 64)
	if err != nil {
		return nil, errSyntax
	}
	return f, nil
}

func (d *jsonDecoder) str() (string, error) {
	d.pos++
	var out []byte
	for d.pos < len(d.data) {
		c := d.data[d.pos]
		switch {
		case c == '"':
			d.pos++
			return string(out), nil
		case c == '\\':
			if d.pos+1 >= len(d.data) {
				return "", errSyntax
			}
			e := d.data[d.pos+1]
			d.pos += 2
			switch e {
			case '"', '\\', '/':
				out = append(out, e)
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'u':
				r, ok := d.hex4()
				if !ok {
					return "", errSyntax
				}
				if utf16.IsSurrogate(r) {
					if d.pos+1 < len(d.data) && d.data[d.pos] == '\\' && d.data[d.pos+1] == 'u' {
						d.pos += 2
						r2, ok := d.hex4()
						if !ok {
							return "", errSyntax
						}
						r = utf16.DecodeRune(r, r2)
					} else {
						r = utf8.RuneError
					}
				}
				out = utf8.AppendRune(out, r)
			default:
				return "", errSyntax
			}
		default:
			out = append(out, c)
			d.pos++
		}
	}
	return "", errSyntax
}

func (d *jsonDecoder) hex4() (rune, bool) {
	if d.pos+4 > len(d.data) {
		return 0, false
	}
	v, err := strconv.ParseUint(string(d.data[d.pos:d.pos+4]), 16, 32)
	if err != nil {
		return 0, false
	}
	d.pos += 4
	return rune(v), true
}
