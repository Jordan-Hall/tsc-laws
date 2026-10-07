// Test-only instrumentation copied into upstream/internal/checker by build-oracle.mjs.
// The relater executable never imports or links this Go code.
package checker

import (
	"encoding/base64"
	"fmt"
	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/jsnum"
	"math"
)

type RelaterProperty struct {
	Name          string `json:"name"`
	Numeric       bool   `json:"numeric"`
	NumericName   string `json:"numericName"`
	KeyType       int    `json:"keyType"`
	Type          int    `json:"type"`
	Optional      bool   `json:"optional"`
	Readonly      bool   `json:"readonly"`
	PrivateOrigin int    `json:"privateOrigin"`
}
type RelaterSignature struct {
	ID               int    `json:"id"`
	TypeParameters   []int  `json:"typeParameters"`
	TailTypes        []int  `json:"tailTypes"`
	NonArrayRest     bool   `json:"nonArrayRest"`
	Parameters       []int  `json:"parameters"`
	MinArgumentCount int    `json:"minArgumentCount"`
	RestType         int    `json:"restType"`
	EffectiveRest    int    `json:"effectiveRest"`
	ReturnType       int    `json:"returnType"`
	ThisType         int    `json:"thisType"`
	Bivariant        bool   `json:"bivariant"`
	Generic          bool   `json:"generic"`
	Abstract         bool   `json:"abstract"`
	PredicateKind    int    `json:"predicateKind"`
	PredicateIndex   int    `json:"predicateIndex"`
	PredicateType    int    `json:"predicateType"`
	Unsupported      string `json:"unsupported"`
}
type RelaterEnumMember struct {
	Name  string `json:"name"`
	Kind  int    `json:"kind"`
	Value string `json:"value"`
}
type RelaterIndexInfo struct {
	KeyType  int  `json:"keyType"`
	Type     int  `json:"type"`
	Readonly bool `json:"readonly"`
}
type RelaterType struct {
	Flags                   TypeFlags           `json:"flags"`
	SymbolFlags             ast.SymbolFlags     `json:"symbolFlags"`
	ObjectFlags             ObjectFlags         `json:"objectFlags"`
	Name                    string              `json:"name"`
	Value                   string              `json:"value"`
	RegularType             int                 `json:"regularType"`
	ApparentType            int                 `json:"apparentType"`
	Target                  int                 `json:"target"`
	TypeParameters          []int               `json:"typeParameters"`
	TypeArguments           []int               `json:"typeArguments"`
	ThisTypeParameter       int                 `json:"thisTypeParameter"`
	DefaultType             int                 `json:"defaultType"`
	VarianceAnnotation      int                 `json:"varianceAnnotation"`
	IndexObject             int                 `json:"indexObject"`
	IndexKey                int                 `json:"indexKey"`
	IndexFlags              IndexFlags          `json:"indexFlags"`
	AccessFlags             AccessFlags         `json:"accessFlags"`
	NumericKey              bool                `json:"numericKey"`
	NumericString           bool                `json:"numericString"`
	TemplateTexts           []string            `json:"templateTexts"`
	StringMapping           int                 `json:"stringMapping"`
	TupleIndex              float64             `json:"tupleIndex"`
	Types                   []int               `json:"types"`
	Properties              []RelaterProperty   `json:"properties"`
	FallbackProperties      []RelaterProperty   `json:"fallbackProperties"`
	Calls                   []RelaterSignature  `json:"calls"`
	Constructs              []RelaterSignature  `json:"constructs"`
	StringIndex             int                 `json:"stringIndex"`
	NumberIndex             int                 `json:"numberIndex"`
	SymbolIndex             int                 `json:"symbolIndex"`
	IndexReadonly           int                 `json:"indexReadonly"`
	PatternIndexes          []RelaterIndexInfo  `json:"patternIndexes"`
	ArrayElement            int                 `json:"arrayElement"`
	TupleElements           []int               `json:"tupleElements"`
	TupleFlags              []ElementFlags      `json:"tupleFlags"`
	Readonly                bool                `json:"readonly"`
	Constraint              int                 `json:"constraint"`
	Unsupported             string              `json:"unsupported"`
	KeyName                 string              `json:"keyName"`
	NumericName             string              `json:"numericName"`
	Missing                 bool                `json:"missing"`
	MappedParameter         int                 `json:"mappedParameter"`
	MappedConstraint        int                 `json:"mappedConstraint"`
	MappedTemplate          int                 `json:"mappedTemplate"`
	MappedName              int                 `json:"mappedName"`
	MappedModifiers         MappedTypeModifiers `json:"mappedModifiers"`
	MappedModifiersType     int                 `json:"mappedModifiersType"`
	MappedHomomorphic       int                 `json:"mappedHomomorphic"`
	MappedKeyof             bool                `json:"mappedKeyof"`
	ConditionalCheck        int                 `json:"conditionalCheck"`
	ConditionalExtends      int                 `json:"conditionalExtends"`
	ConditionalTrue         int                 `json:"conditionalTrue"`
	ConditionalFalse        int                 `json:"conditionalFalse"`
	ConditionalInfer        []int               `json:"conditionalInfer"`
	ConditionalDistributive bool                `json:"conditionalDistributive"`
	ConditionalTuples       bool                `json:"conditionalTuples"`
	ConditionalDependent    bool                `json:"conditionalDependent"`
	ConditionalAlias        bool                `json:"conditionalAlias"`
	ConditionalNestedFalse  bool                `json:"conditionalNestedFalse"`
	EnumOrigin              int                 `json:"enumOrigin"`
	EnumName                string              `json:"enumName"`
	EnumMemberName          string              `json:"enumMemberName"`
	EnumRegular             bool                `json:"enumRegular"`
	EnumMembers             []RelaterEnumMember `json:"enumMembers"`
	EnumNumberIndex         bool                `json:"enumNumberIndex"`
}

type RelaterExporter struct {
	Checker      *Checker
	Types        []*RelaterType
	ids          map[*Type]int
	privateIDs   map[*ast.Node]int
	signatureIDs map[*Signature]int
}

func RelaterNewExporter(c *Checker) *RelaterExporter {
	return &RelaterExporter{Checker: c, Types: []*RelaterType{}, ids: make(map[*Type]int), privateIDs: make(map[*ast.Node]int), signatureIDs: make(map[*Signature]int)}
}
func (e *RelaterExporter) AddRuntimeDeclarations() {
	e.Add(e.Checker.globalArrayType)
	e.Add(e.Checker.globalReadonlyArrayType)
}
func (e *RelaterExporter) property(sym *ast.Symbol, privateID int) RelaterProperty {
	numeric := isNumericLiteralName(sym.Name)
	numericName := ""
	if numeric {
		numericName = sym.Name
	}
	return RelaterProperty{Name: base64.StdEncoding.EncodeToString([]byte(sym.Name)), Numeric: numeric, NumericName: numericName, KeyType: e.Add(e.Checker.getLiteralTypeFromProperty(sym, TypeFlagsStringOrNumberLiteralOrUnique, false)), Type: e.Add(e.Checker.getNonMissingTypeOfSymbol(sym)), Optional: sym.Flags&ast.SymbolFlagsOptional != 0, Readonly: e.Checker.isReadonlySymbol(sym), PrivateOrigin: privateID}
}
func (e *RelaterExporter) signature(sig *Signature) RelaterSignature {
	c := e.Checker
	id, ok := e.signatureIDs[sig]
	if !ok {
		id = len(e.signatureIDs)
		e.signatureIDs[sig] = id
	}
	result := RelaterSignature{ID: id, TypeParameters: []int{}, TailTypes: []int{}, Parameters: []int{}, MinArgumentCount: c.getMinArgumentCount(sig), RestType: -1, EffectiveRest: e.Add(c.getEffectiveRestType(sig)), ReturnType: e.Add(c.getReturnTypeOfSignature(sig)), ThisType: -1, Generic: len(sig.typeParameters) > 0, PredicateKind: -1, PredicateIndex: -1, PredicateType: -1, NonArrayRest: c.getNonArrayRestType(sig) != nil}
	for _, t := range sig.typeParameters {
		result.TypeParameters = append(result.TypeParameters, e.Add(t))
	}
	result.Abstract = sig.flags&SignatureFlagsAbstract != 0
	if p := c.getTypePredicateOfSignature(sig); p != nil {
		result.PredicateKind = int(p.kind)
		result.PredicateIndex = int(p.parameterIndex)
		result.PredicateType = e.Add(p.t)
	}
	if sig.declaration != nil {
		kind := sig.declaration.Kind
		result.Bivariant = kind == ast.KindMethodDeclaration || kind == ast.KindMethodSignature || kind == ast.KindConstructor
	}
	if this := c.getThisTypeOfSignature(sig); this != nil {
		result.ThisType = e.Add(this)
	}
	count := c.getParameterCount(sig)
	// Export the effective rest template only. Fixed-parameter tails are built
	// by relater on demand; eagerly exporting them creates an infinite sequence
	// of tuple methods whose signatures contain further tuple tails.
	for i := 0; i < count; i++ {
		result.TailTypes = append(result.TailTypes, -1)
	}
	if c.hasEffectiveRestParameter(sig) {
		count--
		result.TailTypes[count] = e.Add(c.getEffectiveRestType(sig))
		result.RestType = e.Add(c.tryGetTypeAtPosition(sig, count))
	}
	for i := 0; i < count; i++ {
		result.Parameters = append(result.Parameters, e.Add(c.tryGetTypeAtPosition(sig, i)))
	}
	return result
}

func (e *RelaterExporter) objectFallbacks(t *Type, d *RelaterType) {
	c := e.Checker
	names := []string{}
	for _, sym := range c.getPropertiesOfType(c.globalObjectType) {
		names = append(names, sym.Name)
	}
	if c.typeHasCallOrConstructSignatures(t) {
		names = append(names, "call", "apply", "bind", "length", "name", "prototype", "arguments", "caller")
	}
	for _, name := range names {
		encodedName := base64.StdEncoding.EncodeToString([]byte(name))
		present := false
		for _, prop := range d.Properties {
			if prop.Name == encodedName {
				present = true
				break
			}
		}
		if !present {
			if sym := c.getPropertyOfType(t, name); sym != nil {
				d.FallbackProperties = append(d.FallbackProperties, e.property(sym, -1))
			}
		}
	}
}
func (e *RelaterExporter) Add(t *Type) int {
	if t == nil {
		return -1
	}
	if id, ok := e.ids[t]; ok {
		return id
	}
	if len(e.Types) > 100000 {
		panic("oracle type graph exceeds 100000 nodes")
	}
	id := len(e.Types)
	e.ids[t] = id
	d := &RelaterType{Flags: t.flags, ObjectFlags: t.objectFlags, Name: e.Checker.TypeToString(t), RegularType: -1, ApparentType: -1, Target: -1, ThisTypeParameter: -1, DefaultType: -1, VarianceAnnotation: -1, IndexObject: -1, IndexKey: -1, TypeParameters: []int{}, TypeArguments: []int{}, Types: []int{}, Properties: []RelaterProperty{}, FallbackProperties: []RelaterProperty{}, Calls: []RelaterSignature{}, Constructs: []RelaterSignature{}, StringIndex: -1, NumberIndex: -1, SymbolIndex: -1, ArrayElement: -1, TupleElements: []int{}, TupleFlags: []ElementFlags{}, Constraint: -1}
	e.Types = append(e.Types, d)
	d.TupleIndex = -1
	d.MappedParameter = -1
	d.MappedConstraint = -1
	d.MappedTemplate = -1
	d.MappedName = -1
	d.MappedModifiersType = -1
	d.MappedHomomorphic = -1
	d.ConditionalCheck = -1
	d.ConditionalExtends = -1
	d.ConditionalTrue = -1
	d.ConditionalFalse = -1
	d.ConditionalInfer = []int{}
	d.EnumOrigin = -1
	d.EnumMembers = []RelaterEnumMember{}
	d.TemplateTexts = []string{}
	d.PatternIndexes = []RelaterIndexInfo{}
	c := e.Checker
	d.Missing = t == c.missingType
	if isTypeUsableAsPropertyName(t) {
		name := getPropertyNameFromType(t)
		d.KeyName = base64.StdEncoding.EncodeToString([]byte(name))
		if isNumericLiteralName(name) {
			d.NumericName = name
		}
	}
	if t.symbol != nil {
		d.SymbolFlags = t.symbol.Flags
	}
	if t.flags&TypeFlagsEnumLike != 0 && t.symbol != nil {
		parent := t.symbol
		if parent.Flags&ast.SymbolFlagsEnumMember != 0 {
			parent = c.getParentOfSymbol(parent)
		}
		d.EnumOrigin = e.Add(c.getDeclaredTypeOfSymbol(parent))
		d.EnumName = base64.StdEncoding.EncodeToString([]byte(parent.Name))
		d.EnumMemberName = base64.StdEncoding.EncodeToString([]byte(t.symbol.Name))
		d.EnumRegular = parent.Flags&ast.SymbolFlagsRegularEnum != 0
		if d.EnumOrigin == id {
			for _, member := range c.getPropertiesOfType(c.getTypeOfSymbol(parent)) {
				if member.Flags&ast.SymbolFlagsEnumMember == 0 {
					continue
				}
				data := RelaterEnumMember{Name: base64.StdEncoding.EncodeToString([]byte(member.Name))}
				value := c.getEnumMemberValue(ast.GetDeclarationOfKind(member, ast.KindEnumMember)).Value
				if str, ok := value.(string); ok {
					data.Kind = 2
					data.Value = base64.StdEncoding.EncodeToString([]byte(str))
				} else if value != nil {
					data.Kind = 1
					data.Value = fmt.Sprint(value)
				}
				d.EnumMembers = append(d.EnumMembers, data)
			}
		}
	}
	if t.flags&TypeFlagsLiteral != 0 {
		d.Value = fmt.Sprint(t.AsLiteralType().Value())
		if t.flags&TypeFlagsBigIntLiteral != 0 || t.flags&TypeFlagsNumberLiteral != 0 {
			d.Value = c.getTemplateStringForType(t)
		}
		if t.flags&TypeFlagsNumberLiteral != 0 || t.flags&TypeFlagsStringLiteral != 0 && isNumericLiteralName(d.Value) {
			index := float64(jsnum.FromString(d.Value))
			if index >= 0 && !math.IsInf(index, 0) && math.Trunc(index) == index {
				d.TupleIndex = index
			}
		}
		if t.flags&TypeFlagsStringLiteral != 0 {
			d.NumericKey = isNumericLiteralName(d.Value)
			d.NumericString = isValidNumberString(d.Value, false)
			d.Value = base64.StdEncoding.EncodeToString([]byte(d.Value))
		}
	}
	if t.flags&TypeFlagsFreshable != 0 {
		regular := t.AsLiteralType().regularType
		if regular != nil && regular != t {
			d.RegularType = e.Add(regular)
		}
	}
	if t.flags&TypeFlagsSubstitution != 0 {
		d.IndexObject = e.Add(t.AsSubstitutionType().baseType)
		d.Constraint = e.Add(t.AsSubstitutionType().constraint)
		return id
	}
	if t.flags&TypeFlagsTemplateLiteral != 0 {
		d.NumericString = t == c.numericStringType
		for _, text := range t.AsTemplateLiteralType().texts {
			d.TemplateTexts = append(d.TemplateTexts, base64.StdEncoding.EncodeToString([]byte(text)))
		}
		for _, part := range t.Types() {
			d.Types = append(d.Types, e.Add(part))
		}
		e.Add(c.stringType)
		d.ApparentType = e.Add(c.getApparentType(t))
		return id
	}
	if t.flags&TypeFlagsConditional != 0 {
		conditional := t.AsConditionalType()
		root := conditional.root
		declaration := c.getTypeFromConditionalTypeNode(root.node.AsNode())
		if declaration != t {
			d.Target = e.Add(declaration)
			for _, param := range root.outerTypeParameters {
				d.TypeArguments = append(d.TypeArguments, e.Add(c.instantiateType(param, conditional.mapper)))
			}
			return id
		}
		for _, param := range root.outerTypeParameters {
			d.TypeParameters = append(d.TypeParameters, e.Add(param))
		}
		for _, param := range root.inferTypeParameters {
			d.ConditionalInfer = append(d.ConditionalInfer, e.Add(param))
		}
		d.ConditionalCheck = e.Add(root.checkType)
		d.ConditionalExtends = e.Add(root.extendsType)
		d.ConditionalTrue = e.Add(c.getTypeFromTypeNode(root.node.TrueType))
		falseType := c.getTypeFromTypeNode(root.node.FalseType)
		d.ConditionalFalse = e.Add(falseType)
		d.ConditionalDistributive = root.isDistributive
		d.ConditionalDependent = c.isDistributionDependent(root)
		d.ConditionalAlias = root.alias != nil
		if falseType.flags&TypeFlagsConditional != 0 {
			falseRoot := falseType.AsConditionalType().root
			d.ConditionalNestedFalse = falseRoot.node.Parent == root.node.AsNode() && (!falseRoot.isDistributive || falseRoot.checkType == root.checkType)
		}
		checkNode := ast.SkipTypeParentheses(root.node.CheckType)
		extendsNode := ast.SkipTypeParentheses(root.node.ExtendsType)
		d.ConditionalTuples = c.isSimpleTupleType(checkNode) && c.isSimpleTupleType(extendsNode) && len(checkNode.Elements()) == len(extendsNode.Elements())
		return id
	}
	if t.flags&TypeFlagsStringMapping != 0 {
		d.StringMapping = int(intrinsicTypeKinds[t.symbol.Name])
		d.IndexObject = e.Add(t.AsStringMappingType().target)
		e.Add(c.stringType)
		d.ApparentType = e.Add(c.getApparentType(t))
		return id
	}
	if t.flags&TypeFlagsIndex != 0 {
		d.IndexObject = e.Add(t.AsIndexType().target)
		d.IndexFlags = t.AsIndexType().indexFlags
		return id
	}
	if t.flags&TypeFlagsIndexedAccess != 0 {
		d.IndexObject = e.Add(t.AsIndexedAccessType().objectType)
		d.IndexKey = e.Add(t.AsIndexedAccessType().indexType)
		d.AccessFlags = t.AsIndexedAccessType().accessFlags
		return id
	}
	if t.flags&(TypeFlagsStringLike|TypeFlagsNumberLike|TypeFlagsBigIntLike|TypeFlagsBooleanLike|TypeFlagsESSymbolLike|TypeFlagsNonPrimitive|TypeFlagsUnknown) != 0 {
		if apparent := c.getApparentType(t); apparent != t {
			d.ApparentType = e.Add(apparent)
		}
	}
	if t.flags&TypeFlagsTypeParameter != 0 {
		modifiers := c.getTypeParameterModifiers(t)
		if modifiers&ast.ModifierFlagsOut != 0 {
			d.VarianceAnnotation = int(VarianceFlagsCovariant)
			if modifiers&ast.ModifierFlagsIn != 0 {
				d.VarianceAnnotation = int(VarianceFlagsInvariant)
			}
		} else if modifiers&ast.ModifierFlagsIn != 0 {
			d.VarianceAnnotation = int(VarianceFlagsContravariant)
		}
		d.Constraint = e.Add(c.getConstraintOfTypeParameter(t))
		d.DefaultType = e.Add(c.getDefaultFromTypeParameter(t))
		return id
	}
	if t.flags&TypeFlagsUnionOrIntersection != 0 {
		for _, part := range t.Types() {
			d.Types = append(d.Types, e.Add(part))
		}
	}
	if t.flags&(TypeFlagsObject|TypeFlagsIntersection) == 0 {
		return id
	}
	if t.objectFlags&ObjectFlagsMapped != 0 {
		mapped := t.AsMappedType()
		if mapped.target != nil && mapped.target != t {
			d.Target = e.Add(mapped.target)
			for _, param := range c.getOuterTypeParameters(mapped.target.AsMappedType().declaration.AsNode(), true) {
				d.TypeArguments = append(d.TypeArguments, e.Add(c.instantiateType(param, mapped.mapper)))
			}
			return id
		}
		for _, param := range c.getOuterTypeParameters(mapped.declaration.AsNode(), true) {
			d.TypeParameters = append(d.TypeParameters, e.Add(param))
		}
		d.MappedParameter = e.Add(c.getTypeParameterFromMappedType(t))
		d.MappedConstraint = e.Add(c.getConstraintTypeFromMappedType(t))
		d.MappedTemplate = e.Add(c.getTemplateTypeFromMappedType(t))
		d.MappedName = e.Add(c.getNameTypeFromMappedType(t))
		d.MappedModifiers = getMappedTypeModifiers(t)
		d.MappedModifiersType = e.Add(c.getModifiersTypeFromMappedType(t))
		d.MappedHomomorphic = e.Add(c.getHomomorphicTypeVariable(t))
		d.MappedKeyof = c.isMappedTypeWithKeyofConstraintDeclaration(t)
		return id
	}
	// Native tuple members use the Array/ReadonlyArray declaration templates.
	// Keep only the shape and element arguments, including generic spreads.
	if isTupleType(t) {
		d.ObjectFlags |= ObjectFlagsTuple
		target := t.TargetTupleType()
		d.Readonly = target.readonly
		for i, part := range c.getElementTypes(t) {
			d.TupleElements = append(d.TupleElements, e.Add(part))
			d.TupleFlags = append(d.TupleFlags, target.elementInfos[i].flags)
		}
		if info := c.getIndexInfoOfType(t, c.numberType); info != nil {
			d.NumberIndex = e.Add(info.valueType)
			if info.isReadonly {
				d.IndexReadonly |= 2
			}
		}
		return id
	}
	if t.flags&TypeFlagsObject != 0 && t.objectFlags&ObjectFlagsReference != 0 {
		target := t.Target()
		if target != nil && target != t {
			d.Target = e.Add(target)
			for _, arg := range c.getTypeArguments(t) {
				d.TypeArguments = append(d.TypeArguments, e.Add(arg))
			}
			if c.isArrayType(t) || c.isReadonlyArrayType(t) {
				d.ArrayElement = e.Add(c.getTypeArguments(t)[0])
				d.NumberIndex = d.ArrayElement
				d.Readonly = c.isReadonlyArrayType(t)
				if d.Readonly {
					d.IndexReadonly |= 2
				}
			}
			return id
		}
		for _, param := range t.AsInterfaceType().TypeParameters() {
			d.TypeParameters = append(d.TypeParameters, e.Add(param))
		}
		d.ThisTypeParameter = e.Add(t.AsInterfaceType().thisType)
	}
	if c.isArrayType(t) || c.isReadonlyArrayType(t) {
		d.ArrayElement = e.Add(c.getTypeArguments(t)[0])
		d.Readonly = c.isReadonlyArrayType(t)
		d.NumberIndex = d.ArrayElement
		if c.isReadonlyArrayType(t) {
			d.IndexReadonly |= 2
		}
		// Preserve the declaration's polymorphic this parameter. Apparent
		// properties substitute it with Array<T>, losing tuple sort's return.
		declaration := c.getTypeWithThisArgument(t, t.AsInterfaceType().thisType, false)
		for _, sym := range c.getPropertiesOfObjectType(declaration) {
			d.Properties = append(d.Properties, e.property(sym, -1))
		}
		e.objectFallbacks(t, d)
		return id
	}
	for _, sym := range c.getPropertiesOfType(t) {
		flags := getDeclarationModifierFlagsFromSymbol(sym)
		privateID := -1
		if flags&ast.ModifierFlagsProtected != 0 {
			d.Unsupported = "protected member"
		}
		if flags&ast.ModifierFlagsPrivate != 0 {
			var ok bool
			privateID, ok = e.privateIDs[sym.ValueDeclaration]
			if !ok {
				privateID = len(e.privateIDs)
				e.privateIDs[sym.ValueDeclaration] = privateID
			}
		}
		d.Properties = append(d.Properties, e.property(sym, privateID))
	}
	for _, sig := range c.getSignaturesOfType(t, SignatureKindCall) {
		d.Calls = append(d.Calls, e.signature(sig))
	}
	for _, sig := range c.getSignaturesOfType(t, SignatureKindConstruct) {
		d.Constructs = append(d.Constructs, e.signature(sig))
	}
	e.objectFallbacks(t, d)
	for _, info := range c.getIndexInfosOfType(t) {
		if info.keyType.flags&(TypeFlagsString|TypeFlagsNumber|TypeFlagsESSymbol) == 0 {
			d.PatternIndexes = append(d.PatternIndexes, RelaterIndexInfo{KeyType: e.Add(info.keyType), Type: e.Add(info.valueType), Readonly: info.isReadonly})
		}
	}
	if info := c.getIndexInfoOfType(t, c.stringType); info != nil {
		d.StringIndex = e.Add(info.valueType)
		if info.isReadonly {
			d.IndexReadonly |= 1
		}
	}
	if info := c.getIndexInfoOfType(t, c.numberType); info != nil {
		d.NumberIndex = e.Add(info.valueType)
		d.EnumNumberIndex = info == c.enumNumberIndexInfo
		if info.isReadonly {
			d.IndexReadonly |= 2
		}
	}
	if info := c.getIndexInfoOfType(t, c.esSymbolType); info != nil {
		d.SymbolIndex = e.Add(info.valueType)
		if info.isReadonly {
			d.IndexReadonly |= 4
		}
	}
	return id
}

// Keep type construction, parsing, and binding out of relation timing.
func RelaterResetRelations(c *Checker) {
	clear(c.assignableRelation.results)
	clear(c.identityRelation.results)
	clear(c.subtypeRelation.results)
	clear(c.strictSubtypeRelation.results)
	clear(c.comparableRelation.results)
}
