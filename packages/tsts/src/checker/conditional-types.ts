// Conditional construction, constraints, and normalization adapted from checker.go.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import { TypeFlags as F, ObjectFlags as O, ElementFlags as E } from './flags.js';
import { emptyType, TYPE_ID_STRIDE } from './arena.js';
import type { TypeArena, Mapper } from './arena.js';
import type { Signature } from './types.js';
import { SignatureInference } from './inference.js';

export class ConditionalTypes {
  private readonly instances = new Map<string, number>();
  private readonly scopes = new Map<number, Mapper>();
  private readonly inferredScopes = new Map<number, Mapper>();
  private readonly branches = new Map<number, number>();
  private readonly defaults = new Map<number, number>();
  private readonly distributions = new Map<number, number>();
  private readonly restrictions = new Map<number, number>();
  private readonly normalizations = new Map<number, number>();
  private readonly permissiveTypes = new Map<number, number>();
  private readonly restrictiveTypes = new Map<number, number>();
  private readonly identities = new Map<number, boolean>();
  private readonly identityActive = new Set<number>();
  private readonly workers: SignatureInference[] = [];
  private workerDepth = 0;
  private depth = 0;
  private wildcardType = -1;
  private related: (source: number, target: number) => boolean = () => {
    throw new Error('Missing conditional relation');
  };

  constructor(private readonly arena: TypeArena) {
    for (let i = 0; i < arena.types.length; i++) {
      const d = arena.types[i].data;
      if ((d.flags & F.Conditional) !== 0)
        this.instances.set(
          this.key(d.target >= 0 ? d.target : i, d.target >= 0 ? d.typeArguments : d.typeParameters, false),
          i,
        );
    }
  }

  setRelation(related: (source: number, target: number) => boolean): void {
    this.related = related;
  }
  resetRelations(): void {
    this.identities.clear();
  }
  root(id: number): number {
    return Number(this.arena.types[id].data.target >= 0 ? this.arena.types[id].data.target : id);
  }
  private key(root: number, args: number[], forConstraint: boolean): string {
    return root + ':' + args.join(',') + ':' + forConstraint;
  }

  parameter(id: number, mode: number): number {
    if (mode === 1) {
      if (this.wildcardType < 0) {
        this.wildcardType = this.arena.add(emptyType(F.Any));
        this.arena.types[this.wildcardType].wildcard = true;
      }
      return Number(this.wildcardType);
    }
    if (this.arena.types[id].constraint < 0) return Number(id);
    const previous = this.restrictions.get(id);
    if (previous !== undefined) return Number(previous);
    const result = this.arena.add({ ...this.arena.types[id].data, constraint: -1, defaultType: -1 });
    this.restrictions.set(id, result);
    this.restrictions.set(result, result);
    return Number(result);
  }

  permissive(id: number): number {
    const previous = this.permissiveTypes.get(id);
    if (previous !== undefined) return Number(previous);
    const result = this.arena.instantiate(Number(id), this.arena.mapper([], [], 1));
    this.permissiveTypes.set(id, result);
    return Number(result);
  }

  restrictive(id: number): number {
    const previous = this.restrictiveTypes.get(id);
    if (previous !== undefined) return Number(previous);
    const result = this.arena.instantiate(Number(id), this.arena.mapper([], [], 2));
    this.arena.types[result].restrictive = true;
    this.restrictiveTypes.set(id, result);
    this.restrictiveTypes.set(result, result);
    return Number(result);
  }

  scope(id: number): Mapper {
    this.prepare(Number(id));
    const result = this.scopes.get(id);
    if (result === undefined) throw new Error('Missing conditional scope');
    return result;
  }

  prepare(id: number): void {
    const type = this.arena.types[id];
    if (type.conditionalPrepared) return;
    type.conditionalPrepared = true;
    const root = this.arena.types[this.root(Number(id))];
    const sources = root.data.typeParameters.slice();
    const targets = type.data.target >= 0 ? type.data.typeArguments.slice() : sources.slice();
    const params: number[] = [];
    for (const param of root.data.conditionalInfer) {
      const clone =
        type.data.target >= 0
          ? this.arena.add({ ...this.arena.types[param].data, constraint: -1, defaultType: -1 })
          : param;
      params.push(clone);
      sources.push(param);
      targets.push(clone);
    }
    const mapper = this.arena.mapper(sources, targets);
    this.scopes.set(id, mapper);
    if (type.data.target >= 0) {
      type.data.conditionalInfer = params;
      for (let i = 0; i < params.length; i++) {
        const clone = this.arena.types[params[i]];
        clone.constraint = this.arena.instantiate(
          Number(this.arena.types[root.data.conditionalInfer[i]].constraint),
          mapper,
        );
        clone.data.constraint = clone.constraint;
      }
      type.data.conditionalCheck = this.arena.instantiate(Number(root.data.conditionalCheck), mapper);
      type.data.conditionalExtends = this.arena.instantiate(Number(root.data.conditionalExtends), mapper);
      type.data.conditionalDistributive = root.data.conditionalDistributive;
      type.data.conditionalTuples = root.data.conditionalTuples;
      type.data.conditionalDependent = root.data.conditionalDependent;
      type.data.conditionalAlias = root.data.conditionalAlias;
      type.data.conditionalNestedFalse = root.data.conditionalNestedFalse;
    }
  }

  instantiate(id: number, mapper: Mapper): number {
    const type = this.arena.types[id];
    const rootId = this.root(Number(id));
    const root = this.arena.types[rootId];
    const original = type.data.target >= 0 ? type.data.typeArguments : root.data.typeParameters;
    const args: number[] = [];
    let changed = false;
    for (const arg of original) {
      const value = this.arena.instantiate(Number(arg), mapper);
      args.push(value);
      if (value !== arg) changed = true;
    }
    if (!changed) return Number(id);
    const result = this.construct(Number(rootId), args, false);
    if (mapper.mode === 2) this.arena.types[result].restrictive = true;
    mapper.memo.set(id, result);
    return Number(result);
  }

  private construct(rootId: number, args: number[], forConstraint: boolean): number {
    const key = this.key(rootId, args, forConstraint);
    const previous = this.instances.get(key);
    if (previous !== undefined) return Number(previous);
    if (++this.depth > 100) {
      this.depth--;
      throw new Error('Conditional instantiation complexity limit exceeded');
    }
    try {
      const root = this.arena.types[rootId];
      const mapper = this.arena.mapper(root.data.typeParameters, args);
      const check = this.arena.instantiate(Number(root.data.conditionalCheck), mapper);
      if (
        root.data.conditionalDistributive &&
        check !== root.data.conditionalCheck &&
        (this.arena.types[check].flags & (F.Union | F.Never)) !== 0
      ) {
        const parts: number[] = [];
        if ((this.arena.types[check].flags & F.Union) !== 0)
          for (const part of this.arena.types[check].types) {
            const distributed = args.slice();
            for (let i = 0; i < root.data.typeParameters.length; i++)
              if (root.data.typeParameters[i] === root.data.conditionalCheck) distributed[i] = part;
            parts.push(this.construct(Number(rootId), distributed, forConstraint));
          }
        const result = this.arena.combine(parts, F.Union);
        this.instances.set(key, result);
        return Number(result);
      }
      const result = this.arena.add({
        ...root.data,
        target: rootId,
        typeParameters: [],
        typeArguments: args,
        conditionalInfer: [],
      });
      this.instances.set(key, result);
      this.prepare(Number(result));
      const evaluated = this.evaluate(Number(result), forConstraint);
      this.instances.set(key, evaluated);
      return Number(evaluated);
    } finally {
      this.depth--;
    }
  }

  private generic(id: number): boolean {
    const type = this.arena.types[id];
    if ((type.flags & (F.TemplateLiteral | F.StringMapping)) !== 0) return !this.arena.strings.pattern(Number(id));
    if ((type.flags & F.InstantiableNonPrimitive) !== 0) return true;
    if ((type.flags & F.Substitution) !== 0)
      return this.generic(Number(type.data.indexObject)) || this.generic(Number(type.constraint));
    if ((type.flags & F.UnionOrIntersection) !== 0) {
      for (const part of type.types) if (this.generic(Number(part))) return true;
    }
    if ((type.objectFlags & O.Mapped) !== 0) return this.arena.mapped.generic(Number(id));
    if ((type.objectFlags & O.Tuple) !== 0)
      for (const flag of type.tupleFlags) if ((flag & E.Variadic) !== 0) return true;
    return (type.flags & F.Index) !== 0;
  }

  private deferred(id: number, tuples: boolean): boolean {
    if (this.generic(Number(id))) return true;
    const type = this.arena.types[id];
    if (tuples && (type.objectFlags & O.Tuple) !== 0)
      for (const element of type.tupleElements) if (this.generic(Number(element))) return true;
    return false;
  }

  infer(source: number, target: number, params: number[], outer: Mapper): Mapper {
    if (this.workerDepth === this.workers.length)
      this.workers.push(new SignatureInference(this.arena, true, (s, t) => this.related(Number(s), Number(t))));
    const worker = this.workers[this.workerDepth++];
    try {
      return worker.conditional(Number(source), Number(target), params, outer);
    } finally {
      this.workerDepth--;
    }
  }

  private inferredScope(id: number): Mapper {
    const previous = this.inferredScopes.get(id);
    if (previous !== undefined) return previous;
    const scope = this.scope(Number(id));
    const d = this.arena.types[id].data;
    const inferred = this.infer(
      this.deferred(Number(d.conditionalCheck), d.conditionalTuples) ? -1 : Number(d.conditionalCheck),
      Number(d.conditionalExtends),
      d.conditionalInfer,
      scope,
    );
    this.inferredScopes.set(id, inferred);
    return inferred;
  }

  branch(id: number, whenTrue: boolean, inferred: boolean): number {
    const key = id * 4 + (whenTrue ? 2 : 0) + (inferred ? 1 : 0);
    const previous = this.branches.get(key);
    if (previous !== undefined) return Number(previous);
    const root = this.arena.types[this.root(Number(id))];
    const result = this.arena.instantiate(
      Number(whenTrue ? root.data.conditionalTrue : root.data.conditionalFalse),
      inferred && whenTrue ? this.inferredScope(Number(id)) : this.scope(Number(id)),
    );
    this.branches.set(key, result);
    return Number(result);
  }

  // Switch to an eligible branch's root without recursively constructing it.
  // Distribution over a changed union/never check must use ordinary construction.
  private tail(branch: number, mapper: Mapper, nestedFalse: boolean): number {
    const type = this.arena.types[branch];
    if ((type.flags & F.Conditional) === 0) return -1;
    const rootId = this.root(Number(branch));
    const root = this.arena.types[rootId];
    if (!nestedFalse && root.data.typeParameters.length === 0) return -1;
    const original = type.data.target >= 0 ? type.data.typeArguments : root.data.typeParameters;
    const args: number[] = [];
    for (const arg of original) args.push(this.arena.instantiate(Number(arg), mapper));
    if (!nestedFalse && root.data.conditionalDistributive) {
      const check = this.arena.instantiate(
        Number(root.data.conditionalCheck),
        this.arena.mapper(root.data.typeParameters, args),
      );
      if (check !== root.data.conditionalCheck && (this.arena.types[check].flags & (F.Union | F.Never)) !== 0)
        return -1;
    }
    // Only construct() caches the final result. Intermediate tail states can
    // have different accumulated true branches and must not enter that cache.
    const result = this.arena.add({
      ...root.data,
      target: rootId,
      typeParameters: [],
      typeArguments: args,
      conditionalInfer: [],
    });
    this.prepare(Number(result));
    return Number(result);
  }

  private evaluate(initial: number, forConstraint: boolean): number {
    let id = initial;
    let tailCount = 0;
    const extras: number[] = [];
    let result = initial;
    while (true) {
      if (tailCount === 1000) throw new Error('Conditional tail recursion limit exceeded (1000 steps)');
      const d = this.arena.types[id].data;
      const root = this.arena.types[this.root(Number(id))];
      let check = d.conditionalCheck;
      if ((this.arena.types[check].flags & F.Substitution) !== 0) check = this.arena.types[check].data.indexObject;
      const extendsType = this.arena.instantiate(Number(d.conditionalExtends), this.inferredScope(Number(id)));
      if (this.arena.types[check].wildcard || this.arena.types[extendsType].wildcard)
        return Number(this.parameter(Number(check), 1));
      if (
        this.deferred(Number(check), d.conditionalTuples) ||
        this.deferred(Number(extendsType), d.conditionalTuples)
      ) {
        result = id;
        break;
      }
      const any = (this.arena.types[check].flags & F.Any) !== 0;
      if (
        (this.arena.types[extendsType].flags & F.AnyOrUnknown) === 0 &&
        (any || !this.related(Number(this.permissive(Number(check))), Number(this.permissive(Number(extendsType)))))
      ) {
        let extra = any;
        if (forConstraint && (this.arena.types[extendsType].flags & F.Never) === 0) {
          const ext = this.arena.types[extendsType];
          for (const part of (ext.flags & F.Union) !== 0 ? ext.types : [extendsType])
            if (this.related(Number(this.permissive(Number(part))), Number(this.permissive(Number(check)))))
              extra = true;
        }
        if (extra) extras.push(this.branch(Number(id), true, true));
        const next = this.tail(Number(root.data.conditionalFalse), this.scope(Number(id)), d.conditionalNestedFalse);
        if (next >= 0) {
          if (!d.conditionalNestedFalse && this.arena.types[next].data.conditionalAlias) tailCount++;
          id = next;
          continue;
        }
        result = this.branch(Number(id), false, false);
        break;
      }
      if (
        (this.arena.types[extendsType].flags & F.AnyOrUnknown) !== 0 ||
        this.related(Number(this.restrictive(Number(check))), Number(this.restrictive(Number(extendsType))))
      ) {
        const next = this.tail(Number(root.data.conditionalTrue), this.inferredScope(Number(id)), false);
        if (next >= 0) {
          if (this.arena.types[next].data.conditionalAlias) tailCount++;
          id = next;
          continue;
        }
        result = this.branch(Number(id), true, true);
        break;
      }
      result = id;
      break;
    }
    if (extras.length === 0) return Number(result);
    extras.push(result);
    return Number(this.arena.combine(extras, F.Union));
  }

  defaultConstraint(id: number): number {
    const previous = this.defaults.get(id);
    if (previous !== undefined) return Number(previous);
    this.defaults.set(id, id);
    const yes = this.branch(Number(id), true, true);
    const no = this.branch(Number(id), false, false);
    const result =
      (this.arena.types[yes].flags & F.Any) !== 0
        ? no
        : (this.arena.types[no].flags & F.Any) !== 0
          ? yes
          : this.arena.combine([yes, no], F.Union);
    this.defaults.set(id, result);
    return Number(result);
  }

  distributiveConstraint(id: number): number {
    const previous = this.distributions.get(id);
    if (previous !== undefined) return Number(previous);
    this.distributions.set(id, -1);
    this.prepare(Number(id));
    const type = this.arena.types[id];
    if (!type.data.conditionalDistributive || type.restrictive) return -1;
    const check = type.data.conditionalCheck;
    const bound = this.arena.indexed.constraint(Number(check));
    if (bound < 0 || bound === check) return -1;
    const rootId = this.root(Number(id));
    const root = this.arena.types[rootId];
    const args = type.data.target >= 0 ? type.data.typeArguments.slice() : root.data.typeParameters.slice();
    for (let i = 0; i < root.data.typeParameters.length; i++)
      if (root.data.typeParameters[i] === root.data.conditionalCheck) args[i] = bound;
    const result = this.construct(Number(rootId), args, true);
    if ((this.arena.types[result].flags & F.Never) !== 0 || result === id) return -1;
    this.distributions.set(id, result);
    return Number(result);
  }

  constraint(id: number): number {
    const distributed = this.distributiveConstraint(Number(id));
    return Number(distributed >= 0 ? distributed : this.defaultConstraint(Number(id)));
  }

  // Conditional-to-conditional comparison requires identical extends types;
  // mutual assignability would equate distinct any/unknown and function shapes.
  identical(source: number, target: number): boolean {
    if (source < 0 || target < 0) return source === target;
    if (this.arena.isNoInfer(Number(source)))
      return this.identical(Number(this.arena.types[source].data.indexObject), Number(target));
    if (this.arena.isNoInfer(Number(target)))
      return this.identical(Number(source), Number(this.arena.types[target].data.indexObject));
    const s = this.arena.types[source];
    const t = this.arena.types[target];
    if (s.regularType >= 0 || t.regularType >= 0)
      return this.identical(
        Number(s.regularType >= 0 ? s.regularType : source),
        Number(t.regularType >= 0 ? t.regularType : target),
      );
    if (source === target) return true;
    if (s.flags !== t.flags) return false;
    if ((s.flags & (F.TypeParameter | F.UniqueESSymbol)) !== 0) return false;
    if ((s.flags & F.EnumLike) !== 0 && (s.flags & F.Union) === 0)
      return (
        s.data.enumOrigin === t.data.enumOrigin &&
        s.data.enumMemberName === t.data.enumMemberName &&
        s.value === t.value
      );
    if ((s.flags & F.Literal) !== 0) return s.value === t.value;
    if ((s.flags & F.Intrinsic) !== 0) return s.data.missing === t.data.missing;
    const key = source * TYPE_ID_STRIDE + target;
    const previous = this.identities.get(key);
    if (previous !== undefined) return previous;
    if (this.identityActive.has(key)) return true;
    if (this.identityActive.size >= 100) throw new Error('Conditional identity complexity limit exceeded');
    this.identityActive.add(key);
    let result = false;
    try {
      result = this.identicalWorker(Number(source), Number(target));
    } finally {
      this.identityActive.delete(key);
    }
    // Cache successes only outside a provisional recursive assumption.
    if (!result || this.identityActive.size === 0) this.identities.set(key, result);
    return result;
  }

  private identicalWorker(source: number, target: number): boolean {
    const s = this.arena.types[source];
    const t = this.arena.types[target];
    if ((s.flags & F.StringMapping) !== 0)
      return (
        s.data.stringMapping === t.data.stringMapping &&
        this.identical(Number(s.data.indexObject), Number(t.data.indexObject))
      );
    if ((s.flags & F.TemplateLiteral) !== 0) {
      if (s.data.templateTexts.join(':') !== t.data.templateTexts.join(':') || s.types.length !== t.types.length)
        return false;
      for (let i = 0; i < s.types.length; i++)
        if (!this.identical(Number(s.types[i]), Number(t.types[i]))) return false;
      return true;
    }
    if ((s.flags & F.UnionOrIntersection) !== 0) {
      if (s.types.length !== t.types.length) return false;
      for (const part of s.types) {
        let found = false;
        for (const other of t.types) if (this.identical(Number(part), Number(other))) found = true;
        if (!found) return false;
      }
      return true;
    }
    if ((s.flags & (F.Index | F.IndexedAccess | F.Substitution)) !== 0)
      return (
        this.identical(Number(s.data.indexObject), Number(t.data.indexObject)) &&
        this.identical(Number(s.data.indexKey), Number(t.data.indexKey)) &&
        ((s.flags & F.Substitution) === 0 || this.identical(Number(s.constraint), Number(t.constraint)))
      );
    if ((s.flags & F.Conditional) !== 0) {
      this.prepare(Number(source));
      this.prepare(Number(target));
      if (
        s.data.conditionalInfer.length !== t.data.conditionalInfer.length ||
        s.data.conditionalDistributive !== t.data.conditionalDistributive
      )
        return false;
      const mapper = this.arena.mapper(s.data.conditionalInfer, t.data.conditionalInfer);
      return (
        this.identical(Number(s.data.conditionalCheck), Number(t.data.conditionalCheck)) &&
        this.identical(
          Number(this.arena.instantiate(Number(s.data.conditionalExtends), mapper)),
          Number(t.data.conditionalExtends),
        ) &&
        this.identical(
          Number(this.arena.instantiate(Number(this.branch(Number(source), true, false)), mapper)),
          Number(this.branch(Number(target), true, false)),
        ) &&
        this.identical(
          Number(this.branch(Number(source), false, false)),
          Number(this.branch(Number(target), false, false)),
        )
      );
    }
    if ((s.flags & F.Object) === 0) return false;
    if (
      ((s.objectFlags | t.objectFlags) & O.Mapped) !== 0 &&
      (((s.objectFlags & O.Mapped) !== 0 && this.arena.mapped.generic(Number(source))) ||
        ((t.objectFlags & O.Mapped) !== 0 && this.arena.mapped.generic(Number(target))))
    ) {
      if ((s.objectFlags & t.objectFlags & O.Mapped) === 0) return false;
      this.arena.mapped.prepare(Number(source));
      this.arena.mapped.prepare(Number(target));
      if (
        s.data.mappedModifiers !== t.data.mappedModifiers ||
        !this.identical(Number(s.data.mappedConstraint), Number(t.data.mappedConstraint))
      )
        return false;
      const mapper = this.arena.mapper([s.data.mappedParameter], [t.data.mappedParameter]);
      return (
        this.identical(
          Number(
            this.arena.instantiate(
              Number(this.arena.mapped.name(Number(source), Number(s.data.mappedParameter))),
              mapper,
            ),
          ),
          Number(this.arena.mapped.name(Number(target), Number(t.data.mappedParameter))),
        ) &&
        this.identical(
          Number(
            this.arena.instantiate(
              Number(this.arena.mapped.value(Number(source), Number(s.data.mappedParameter))),
              mapper,
            ),
          ),
          Number(this.arena.mapped.value(Number(target), Number(t.data.mappedParameter))),
        )
      );
    }
    if (s.arrayElement >= 0 || t.arrayElement >= 0)
      return (
        s.arrayElement >= 0 &&
        t.arrayElement >= 0 &&
        s.readonly === t.readonly &&
        this.identical(Number(s.arrayElement), Number(t.arrayElement))
      );
    if (((s.objectFlags | t.objectFlags) & O.Tuple) !== 0) {
      if (
        (s.objectFlags & t.objectFlags & O.Tuple) === 0 ||
        s.readonly !== t.readonly ||
        s.tupleElements.length !== t.tupleElements.length
      )
        return false;
      for (let i = 0; i < s.tupleElements.length; i++)
        if (
          s.tupleFlags[i] !== t.tupleFlags[i] ||
          !this.identical(Number(s.tupleElements[i]), Number(t.tupleElements[i]))
        )
          return false;
      return true;
    }
    this.arena.resolve(s);
    this.arena.resolve(t);
    if (s.patternIndexes.length !== t.patternIndexes.length || s.indexReadonly !== t.indexReadonly) return false;
    for (const info of s.patternIndexes) {
      let found = false;
      for (const other of t.patternIndexes)
        if (
          info.readonly === other.readonly &&
          this.identical(Number(info.keyType), Number(other.keyType)) &&
          this.identical(Number(info.type), Number(other.type))
        )
          found = true;
      if (!found) return false;
    }
    if (
      s.properties.length !== t.properties.length ||
      s.calls.length !== t.calls.length ||
      s.constructs.length !== t.constructs.length
    )
      return false;
    for (const p of s.properties) {
      const index = t.propertyIndex.get(p.name);
      if (index === undefined) return false;
      const other = t.lookupProperties[index];
      if (
        p.optional !== other.optional ||
        p.readonly !== other.readonly ||
        p.privateOrigin !== other.privateOrigin ||
        !this.identical(Number(p.type), Number(other.type))
      )
        return false;
    }
    for (let i = 0; i < s.calls.length; i++) if (!this.signatureIdentical(s.calls[i], t.calls[i])) return false;
    for (let i = 0; i < s.constructs.length; i++)
      if (!this.signatureIdentical(s.constructs[i], t.constructs[i])) return false;
    return (
      this.identical(Number(s.stringIndex), Number(t.stringIndex)) &&
      this.identical(Number(s.numberIndex), Number(t.numberIndex)) &&
      this.identical(Number(s.symbolIndex), Number(t.symbolIndex))
    );
  }

  private signatureIdentical(source: Signature, target: Signature): boolean {
    if (
      source.parameters.length !== target.parameters.length ||
      source.minArgumentCount !== target.minArgumentCount ||
      source.nonArrayRest !== target.nonArrayRest ||
      source.restType >= 0 !== target.restType >= 0 ||
      source.typeParameters.length !== target.typeParameters.length
    )
      return false;
    if (source.typeParameters.length > 0) {
      const mapper = this.arena.mapper(source.typeParameters, target.typeParameters);
      const unknown = this.arena.intrinsic(F.Unknown);
      for (let i = 0; i < source.typeParameters.length; i++) {
        const s = this.arena.types[source.typeParameters[i]];
        const t = this.arena.types[target.typeParameters[i]];
        if (
          !this.identical(
            Number(this.arena.instantiate(Number(s.constraint >= 0 ? s.constraint : unknown), mapper)),
            Number(t.constraint >= 0 ? t.constraint : unknown),
          ) ||
          !this.identical(
            Number(this.arena.instantiate(Number(s.defaultType >= 0 ? s.defaultType : unknown), mapper)),
            Number(t.defaultType >= 0 ? t.defaultType : unknown),
          )
        )
          return false;
      }
      source = this.arena.signature(source, mapper, true);
    }
    for (let i = 0; i < source.parameters.length; i++)
      if (!this.identical(Number(source.parameters[i]), Number(target.parameters[i]))) return false;
    if (
      source.thisType >= 0 &&
      target.thisType >= 0 &&
      !this.identical(Number(source.thisType), Number(target.thisType))
    )
      return false;
    return (
      source.predicateKind === target.predicateKind &&
      source.predicateIndex === target.predicateIndex &&
      this.identical(Number(source.predicateType), Number(target.predicateType)) &&
      this.identical(Number(source.restType), Number(target.restType)) &&
      this.identical(Number(source.returnType), Number(target.returnType))
    );
  }

  simplify(id: number): number {
    const previous = this.normalizations.get(id);
    if (previous !== undefined) return Number(previous);
    this.normalizations.set(id, id);
    this.prepare(Number(id));
    const d = this.arena.types[id].data;
    const yes = this.branch(Number(id), true, false);
    const no = this.branch(Number(id), false, false);
    const actualYes =
      (this.arena.types[yes].flags & F.Substitution) !== 0 ? this.arena.types[yes].data.indexObject : yes;
    const actualNo = (this.arena.types[no].flags & F.Substitution) !== 0 ? this.arena.types[no].data.indexObject : no;
    let result = id;
    if ((this.arena.types[no].flags & F.Never) !== 0 && actualYes === d.conditionalCheck) {
      if (
        (this.arena.types[d.conditionalCheck].flags & F.Any) !== 0 ||
        this.related(
          Number(this.restrictive(Number(d.conditionalCheck))),
          Number(this.restrictive(Number(d.conditionalExtends))),
        )
      )
        result = yes;
      else if (
        (this.arena.types[this.arena.combine([d.conditionalCheck, d.conditionalExtends], F.Intersection)].flags &
          F.Never) !==
        0
      )
        result = this.arena.intrinsic(F.Never);
    } else if ((this.arena.types[yes].flags & F.Never) !== 0 && actualNo === d.conditionalCheck) {
      if (
        (this.arena.types[d.conditionalCheck].flags & F.Any) === 0 &&
        this.related(
          Number(this.restrictive(Number(d.conditionalCheck))),
          Number(this.restrictive(Number(d.conditionalExtends))),
        )
      )
        result = this.arena.intrinsic(F.Never);
      else if (
        (this.arena.types[d.conditionalCheck].flags & F.Any) !== 0 ||
        (this.arena.types[this.arena.combine([d.conditionalCheck, d.conditionalExtends], F.Intersection)].flags &
          F.Never) !==
          0
      )
        result = no;
    }
    this.normalizations.set(id, result);
    return Number(result);
  }
}
