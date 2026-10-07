// Contextual signature inference adapted from internal/checker/inference.go
// and instantiateSignatureInContextOf in checker.go.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import { TypeFlags as F, ObjectFlags as O, ElementFlags as E, MappedTypeModifiers as M } from './flags.js';
import { TypeArena, TYPE_ID_STRIDE, emptyType, type Mapper } from './arena.js';
import type { Signature, Property, Type } from './types.js';
import { RelationCache } from './relation-cache.js';

class Inference {
  readonly covariant: number[] = [];
  readonly contravariant: number[] = [];
  priority = 7;
  topLevel = true;
}

export class SignatureInference {
  private readonly inferenceParameters: number[] = [];
  private readonly inferences: Inference[] = [];
  private readonly visited = new RelationCache();
  private readonly inferenceTargets = new Map<number, boolean>();
  private readonly activeTargets = new Set<number>();
  private readonly reversed = new Map<string, number>();
  private readonly reverseWorkers: SignatureInference[] = [];
  private readonly conditionalDepth = new Map<number, number>();
  private reverseDepth = 0;
  private depth = 0;
  private noConstraints = false;
  constructor(
    private readonly arena: TypeArena,
    private readonly strictFunctionTypes: boolean,
    private readonly related: (source: number, target: number) => boolean,
  ) {}

  instantiate(source: Signature, target: Signature): Signature {
    this.noConstraints = false;
    this.visited.clear();
    this.inferenceTargets.clear();
    this.depth = 0;
    this.inferenceParameters.length = source.typeParameters.length;
    for (let i = 0; i < source.typeParameters.length; i++) {
      this.inferenceParameters[i] = source.typeParameters[i];
      if (i >= this.inferences.length) this.inferences.push(new Inference());
      const info = this.inferences[i];
      info.covariant.length = 0;
      info.contravariant.length = 0;
      info.priority = 7;
      info.topLevel = true;
    }
    this.parameters(target, source, false, 0, true);
    if (
      source.predicateKind >= 0 &&
      source.predicateKind === target.predicateKind &&
      source.predicateType >= 0 &&
      target.predicateType >= 0
    ) {
      this.infer(Number(target.predicateType), Number(source.predicateType), false, 5, true);
    } else this.infer(Number(target.returnType), Number(source.returnType), false, 5, true);
    const args: number[] = [];
    const fallbacks: number[] = [];
    // Pick candidates first so forward constraint references can see all
    // inferred parameters. Defaults are instantiated in declaration order.
    for (const param of source.typeParameters) {
      const info = this.findInference(Number(param));
      if (info === undefined) throw new Error('Missing type inference');
      const data = this.arena.types[param];
      const prefix = this.arena.mapper(source.typeParameters.slice(0, args.length), args);
      let co = -1;
      let contra = -1;
      if (info.covariant.length > 0) {
        const candidates: number[] = [];
        const constraint = data.constraint;
        const primitiveConstraint = constraint >= 0 && this.hasPrimitiveConstraint(constraint);
        const widen = !primitiveConstraint && info.topLevel && !this.returnContains(source.returnType, param, 0);
        for (const id of info.covariant) candidates.push(widen ? this.widen(id) : id);
        co = this.common(candidates, false);
      }
      if (info.contravariant.length > 0) contra = this.common(info.contravariant, true);
      let inferred = co;
      let fallback = contra;
      if (
        contra >= 0 &&
        (co < 0 ||
          (this.arena.types[co].flags & (F.Never | F.Any)) !== 0 ||
          !info.contravariant.some((id) => this.related(Number(co), Number(id))))
      ) {
        inferred = contra;
        fallback = co;
      }
      if (inferred < 0)
        inferred =
          data.defaultType >= 0
            ? this.arena.instantiate(Number(data.defaultType), prefix)
            : this.arena.intrinsic(F.Unknown);
      args.push(inferred);
      fallbacks.push(fallback);
    }
    for (let pass = 0; pass <= args.length; pass++) {
      let changed = false;
      for (let i = 0; i < args.length; i++) {
        const data = this.arena.types[source.typeParameters[i]];
        if (data.constraint < 0) continue;
        const mapper = this.arena.mapper(source.typeParameters, args);
        const constraint = this.arena.instantiate(Number(data.constraint), mapper);
        if (!this.related(Number(args[i]), Number(constraint))) {
          const fallback = fallbacks[i];
          const replacement =
            fallback >= 0 && this.related(Number(fallback), Number(constraint)) ? fallback : constraint;
          if (replacement !== args[i]) {
            args[i] = replacement;
            changed = true;
          }
        }
      }
      if (!changed) break;
      if (pass === args.length) throw new Error('Unsupported cyclic inference constraints');
    }
    return this.arena.signature(source, this.arena.mapper(source.typeParameters, args), true);
  }

  conditional(source: number, target: number, params: number[], outer: Mapper): Mapper {
    this.visited.clear();
    this.depth = 0;
    this.noConstraints = true;
    this.inferenceTargets.clear();
    this.inferenceParameters.length = params.length;
    for (let i = 0; i < params.length; i++) {
      this.inferenceParameters[i] = params[i];
      if (i >= this.inferences.length) this.inferences.push(new Inference());
      const info = this.inferences[i];
      info.covariant.length = 0;
      info.contravariant.length = 0;
      info.priority = 7;
      info.topLevel = true;
    }
    if (source >= 0) this.infer(Number(source), Number(target), false, 0, true);
    const args: number[] = [];
    for (let i = 0; i < params.length; i++) {
      const info = this.inferences[i];
      args.push(
        info.covariant.length > 0
          ? this.arena.combine(info.covariant, F.Union)
          : info.contravariant.length > 0
            ? this.arena.combine(info.contravariant, F.Intersection)
            : this.arena.intrinsic(F.Unknown),
      );
    }
    for (let i = 0; i < params.length; i++) {
      const constraint = this.arena.types[params[i]].constraint;
      if (constraint < 0) continue;
      const bound = this.arena.instantiate(Number(constraint), this.arena.mapper(params, args));
      if (!this.related(Number(args[i]), Number(bound))) args[i] = bound;
    }
    const inference = this.arena.mapper(params, args);
    const sources = outer.sources.concat(params);
    const targets: number[] = [];
    for (const id of outer.targets) targets.push(this.arena.instantiate(Number(id), inference));
    for (const id of args) targets.push(id);
    return this.arena.mapper(sources, targets, outer.mode);
  }

  private findInference(id: number): Inference | undefined {
    // Upstream also scans the signature's usually short parameter list.
    for (let i = 0; i < this.inferenceParameters.length; i++)
      if (this.inferenceParameters[i] === id) return this.inferences[i];
    return undefined;
  }

  // A conservative, inference-local form of couldContainTypeVariables. Resolved
  // tuples/arrays, unions, and templates cannot infer a signature parameter when
  // none of their components references that parameter. Other object and
  // instantiable forms may expose variables through lazy members or reduction.
  private canInferTo(id: number): boolean {
    if (this.findInference(Number(id)) !== undefined) return true;
    const previous = this.inferenceTargets.get(id);
    if (previous !== undefined) return previous;
    const type = this.arena.types[id];
    if ((type.flags & F.TypeParameter) !== 0) return false;
    if ((type.flags & F.StructuredOrInstantiable) === 0) return false;
    if (this.activeTargets.has(id) || this.activeTargets.size >= 100) return true;
    this.activeTargets.add(id);
    let result = true;
    try {
      if ((type.flags & (F.UnionOrIntersection | F.TemplateLiteral)) !== 0) {
        result = false;
        for (const part of type.types)
          if (this.canInferTo(Number(part))) {
            result = true;
            break;
          }
      } else if ((type.objectFlags & O.Tuple) !== 0) {
        result = false;
        for (const part of type.tupleElements)
          if (this.canInferTo(Number(part))) {
            result = true;
            break;
          }
      } else if (type.arrayElement >= 0) result = this.canInferTo(Number(type.arrayElement));
    } finally {
      this.activeTargets.delete(id);
    }
    this.inferenceTargets.set(id, result);
    return result;
  }

  private parameters(source: Signature, target: Signature, contra: boolean, priority: number, topLevel: boolean): void {
    if (source.thisType >= 0 && target.thisType >= 0)
      this.infer(Number(source.thisType), Number(target.thisType), contra, priority, topLevel);
    const count =
      target.restType >= 0
        ? target.parameters.length
        : Math.min(source.parameters.length + (source.restType >= 0 ? 1 : 0), target.parameters.length);
    for (let i = 0; i < count; i++) {
      const s = i < source.parameters.length ? source.parameters[i] : source.restType;
      if (s >= 0) this.infer(Number(s), Number(target.parameters[i]), contra, priority, topLevel);
    }
    if (target.restType >= 0) {
      const pos = target.parameters.length;
      // Infer ordinary rest element types without constructing a tuple tail.
      if (!target.nonArrayRest) {
        for (let i = pos; i < source.parameters.length; i++)
          this.infer(Number(source.parameters[i]), Number(target.restType), contra, priority, topLevel);
        if (source.restType >= 0)
          this.infer(Number(source.restType), Number(target.restType), contra, priority, topLevel);
      } else
        this.infer(
          Number(this.arena.restTail(source, Number(pos))),
          Number(this.arena.restTail(target, Number(pos))),
          contra,
          priority,
          topLevel,
        );
    }
  }

  private infer(sourceId: number, targetId: number, contra: boolean, priority: number, topLevel: boolean): void {
    if (sourceId < 0 || targetId < 0) return;
    const targetType = this.arena.types[targetId];
    if ((targetType.flags & F.Substitution) !== 0 && this.arena.isNoInfer(Number(targetId))) return;
    if ((targetType.flags & F.Substitution) !== 0 && targetType.unsupported.length === 0) {
      this.infer(Number(sourceId), Number(targetType.data.indexObject), contra, priority, topLevel);
      return;
    }
    const info = this.findInference(Number(targetId));
    if (info !== undefined) {
      if (priority > info.priority) return;
      if (priority < info.priority) {
        info.covariant.length = 0;
        info.contravariant.length = 0;
        info.priority = priority;
        info.topLevel = true;
      }
      const list = contra ? info.contravariant : info.covariant;
      if (!list.includes(sourceId)) list.push(sourceId);
      info.topLevel = info.topLevel && topLevel;
      return;
    }
    if (sourceId === targetId) return;
    if (!this.canInferTo(Number(targetId))) return;
    const key = (sourceId * TYPE_ID_STRIDE + targetId) * 16 + (contra ? 8 : 0) + priority;
    if (this.visited.get(key) !== 2) return;
    this.visited.set(key, -1);
    if (++this.depth > 100) throw new Error('Type inference complexity limit exceeded');
    try {
      let source = this.arena.types[sourceId];
      const target = this.arena.types[targetId];
      if (target.unsupported.length > 0) throw new Error('Unsupported inference type: ' + target.unsupported);
      if ((source.flags & F.Substitution) !== 0 && source.unsupported.length === 0) {
        this.infer(Number(source.data.indexObject), Number(targetId), contra, priority, topLevel);
        return;
      }
      const simpleSource =
        (source.flags & (F.Index | F.IndexedAccess)) !== 0 ? this.arena.indexed.simplify(Number(sourceId)) : sourceId;
      const simpleTarget =
        (target.flags & (F.Index | F.IndexedAccess)) !== 0 ? this.arena.indexed.simplify(Number(targetId)) : targetId;
      if (simpleSource >= 0 && simpleTarget >= 0 && (simpleSource !== sourceId || simpleTarget !== targetId)) {
        this.infer(Number(simpleSource), Number(simpleTarget), contra, priority, topLevel);
        return;
      }
      if ((source.flags & target.flags & F.Index) !== 0) {
        this.infer(Number(source.data.indexObject), Number(target.data.indexObject), !contra, priority, false);
        return;
      }
      if ((target.flags & F.Index) !== 0 && this.literalKeys(Number(sourceId))) {
        this.infer(
          Number(this.arena.indexed.emptyObjectForKeys(Number(sourceId))),
          Number(target.data.indexObject),
          !contra,
          Math.max(priority, 6),
          false,
        );
        return;
      }
      if ((source.flags & target.flags & F.IndexedAccess) !== 0) {
        this.infer(Number(source.data.indexObject), Number(target.data.indexObject), contra, priority, false);
        this.infer(Number(source.data.indexKey), Number(target.data.indexKey), contra, priority, false);
        return;
      }
      if ((source.flags & target.flags & F.StringMapping) !== 0) {
        if (source.data.stringMapping === target.data.stringMapping)
          this.infer(Number(source.data.indexObject), Number(target.data.indexObject), contra, priority, false);
        return;
      }
      if ((target.flags & F.Conditional) !== 0) {
        const conditionalRoot = this.arena.conditional.root(Number(targetId));
        const conditionalDepth = this.conditionalDepth.get(conditionalRoot) ?? 0;
        if (conditionalDepth >= 2) return;
        this.conditionalDepth.set(conditionalRoot, conditionalDepth + 1);
        try {
          this.arena.conditional.prepare(Number(targetId));
          if ((source.flags & F.Conditional) !== 0) {
            this.arena.conditional.prepare(Number(sourceId));
            this.infer(
              Number(source.data.conditionalCheck),
              Number(target.data.conditionalCheck),
              contra,
              priority,
              false,
            );
            this.infer(
              Number(source.data.conditionalExtends),
              Number(target.data.conditionalExtends),
              contra,
              priority,
              false,
            );
            this.infer(
              Number(this.arena.conditional.branch(Number(sourceId), true, false)),
              Number(this.arena.conditional.branch(Number(targetId), true, false)),
              contra,
              priority,
              false,
            );
            this.infer(
              Number(this.arena.conditional.branch(Number(sourceId), false, false)),
              Number(this.arena.conditional.branch(Number(targetId), false, false)),
              contra,
              priority,
              false,
            );
          } else {
            const conditionalPriority = contra ? Math.max(priority, 4) : priority;
            this.infer(
              Number(sourceId),
              Number(this.arena.conditional.branch(Number(targetId), true, false)),
              contra,
              conditionalPriority,
              false,
            );
            this.infer(
              Number(sourceId),
              Number(this.arena.conditional.branch(Number(targetId), false, false)),
              contra,
              conditionalPriority,
              false,
            );
          }
        } finally {
          if (conditionalDepth === 0) this.conditionalDepth.delete(conditionalRoot);
          else this.conditionalDepth.set(conditionalRoot, conditionalDepth);
        }
        return;
      }
      if ((target.flags & F.UnionOrIntersection) !== 0) {
        const targets = target.types;
        const sources = (source.flags & F.UnionOrIntersection) !== 0 ? source.types : [sourceId];
        const unmatched: number[] = [];
        for (const s of sources) {
          let matched = false;
          // Prefer instantiations of the same declaration/tuple shape before
          // structural fallback, as inferFromMatchingTypes does upstream. A
          // tuple must not also feed an array branch when its own branch matches.
          for (const t of targets)
            if (this.findInference(Number(t)) === undefined && this.closelyMatched(Number(s), Number(t))) {
              this.infer(Number(s), Number(t), contra, priority, topLevel);
              matched = true;
            }
          if (!matched)
            for (const t of targets)
              if (
                this.findInference(Number(t)) === undefined &&
                (this.related(Number(s), Number(t)) || this.sameShape(Number(s), Number(t)))
              ) {
                this.infer(Number(s), Number(t), contra, priority, topLevel);
                matched = true;
              }
          if (!matched) unmatched.push(s);
        }
        for (const t of targets)
          if (this.findInference(Number(t)) !== undefined && unmatched.length > 0)
            this.infer(Number(this.arena.combine(unmatched, F.Union)), Number(t), contra, priority, topLevel);
        return;
      }
      if ((source.flags & F.UnionOrIntersection) !== 0) {
        for (const s of source.types) this.infer(Number(s), Number(targetId), contra, priority, topLevel);
        return;
      }
      if ((target.flags & F.TemplateLiteral) !== 0) {
        const matches = this.arena.strings.infer(Number(sourceId), Number(targetId));
        let empty = true;
        for (const text of target.data.templateTexts) if (text !== '') empty = false;
        if (matches.length > 0 || empty)
          for (let i = 0; i < target.types.length; i++) {
            let captured = matches.length > 0 ? matches[i] : this.arena.intrinsic(F.Never);
            const param = this.arena.types[target.types[i]];
            if (
              (param.flags & F.TypeVariable) !== 0 &&
              this.findInference(Number(param.id)) !== undefined &&
              param.constraint >= 0
            )
              captured = this.arena.strings.constrained(Number(captured), Number(param.constraint));
            this.infer(Number(captured), Number(target.types[i]), contra, priority, false);
          }
        return;
      }
      if (!this.noConstraints && (source.flags & F.TypeParameter) !== 0 && source.constraint >= 0) {
        sourceId = source.constraint;
        source = this.arena.types[sourceId];
      }
      if (
        (!this.noConstraints || (source.flags & (F.Intersection | F.Instantiable)) === 0) &&
        source.apparentType >= 0
      ) {
        sourceId = source.apparentType;
        source = this.arena.types[sourceId];
      }
      if ((target.objectFlags & O.Mapped) !== 0 && (source.flags & (F.Object | F.Intersection)) !== 0) {
        this.arena.mapped.prepare(Number(targetId));
        if (
          (source.objectFlags & O.Mapped) !== 0 &&
          this.arena.mapped.generic(Number(sourceId)) &&
          this.arena.mapped.generic(Number(targetId))
        ) {
          this.arena.mapped.prepare(Number(sourceId));
          this.infer(
            Number(source.data.mappedConstraint),
            Number(target.data.mappedConstraint),
            contra,
            priority,
            false,
          );
          this.infer(
            Number(this.arena.mapped.value(Number(sourceId), Number(source.data.mappedParameter))),
            Number(this.arena.mapped.value(Number(targetId), Number(target.data.mappedParameter))),
            contra,
            priority,
            false,
          );
          if (source.data.mappedName >= 0 && target.data.mappedName >= 0)
            this.infer(
              Number(this.arena.mapped.name(Number(sourceId), Number(source.data.mappedParameter))),
              Number(this.arena.mapped.name(Number(targetId), Number(target.data.mappedParameter))),
              contra,
              priority,
              false,
            );
        }
        if (
          target.data.mappedName < 0 &&
          this.inferMapped(Number(sourceId), Number(targetId), Number(target.data.mappedConstraint), contra, priority)
        )
          return;
      }
      if (target.arrayElement >= 0) {
        if (source.arrayElement >= 0)
          this.infer(Number(source.arrayElement), Number(target.arrayElement), contra, priority, false);
        else if ((source.objectFlags & O.Tuple) !== 0)
          this.infer(
            Number(this.arena.tuples.elementSlice(Number(sourceId), 0, 0)),
            Number(target.arrayElement),
            contra,
            priority,
            false,
          );
        return;
      }
      if ((target.objectFlags & O.Tuple) !== 0 && (source.arrayElement >= 0 || (source.objectFlags & O.Tuple) !== 0)) {
        this.inferTuple(source, target, contra, priority);
        return;
      }
      if ((source.flags & (F.Object | F.Intersection)) === 0 || (target.flags & F.Object) === 0) return;
      this.arena.resolve(source);
      this.arena.resolve(target);
      for (const p of target.properties) {
        const index = source.propertyIndex.get(p.name);
        if (index !== undefined)
          this.infer(Number(source.lookupProperties[index].type), Number(p.type), contra, priority, false);
      }
      this.signatures(source.calls, target.calls, contra, priority);
      this.signatures(source.constructs, target.constructs, contra, priority);
      if (source.patternIndexes.length > 0 || target.patternIndexes.length > 0) {
        this.inferIndexSignatures(source, target, contra, priority);
        return;
      }
      if (source.stringIndex >= 0 && target.stringIndex >= 0)
        this.infer(Number(source.stringIndex), Number(target.stringIndex), contra, priority, false);
      if (source.numberIndex >= 0 && target.numberIndex >= 0)
        this.infer(Number(source.numberIndex), Number(target.numberIndex), contra, priority, false);
      if (source.symbolIndex >= 0 && target.symbolIndex >= 0)
        this.infer(Number(source.symbolIndex), Number(target.symbolIndex), contra, priority, false);
    } finally {
      this.depth--;
    }
  }

  private inferIndexSignatures(source: Type, target: Type, contra: boolean, priority: number): void {
    const indexPriority = (source.objectFlags & target.objectFlags & O.Mapped) !== 0 ? Math.max(priority, 2) : priority;
    const sourceInfos = this.arena.indexes.all(source);
    for (const targetInfo of this.arena.indexes.all(target)) {
      if (this.arena.indexes.inferable(source)) {
        const values: number[] = [];
        for (const p of source.properties)
          if (this.arena.indexes.applicable(Number(p.keyType), Number(targetInfo.keyType)))
            values.push(p.optional ? this.arena.removeOptional(Number(p.type), false) : p.type);
        for (const info of sourceInfos)
          if (this.arena.indexes.applicable(Number(info.keyType), Number(targetInfo.keyType))) values.push(info.type);
        if (values.length > 0)
          this.infer(
            Number(this.arena.combine(values, F.Union)),
            Number(targetInfo.type),
            contra,
            indexPriority,
            false,
          );
      }
      const found = this.arena.indexes.find(source, Number(targetInfo.keyType));
      if (found !== undefined) this.infer(Number(found.type), Number(targetInfo.type), contra, indexPriority, false);
    }
  }

  // Match fixed ends before inferring a variadic slice. Two generic spreads
  // require expression-call implied arity, which resolved signatures lack.
  private inferTuple(source: Type, target: Type, contra: boolean, priority: number): void {
    const array = source.arrayElement >= 0;
    const sourceArity = array ? 1 : source.tupleElements.length;
    const targetArity = target.tupleElements.length;
    let matching = !array && sourceArity === targetArity;
    if (matching)
      for (let i = 0; i < targetArity; i++)
        if ((source.tupleFlags[i] & E.Variable) !== (target.tupleFlags[i] & E.Variable)) matching = false;
    if (matching) {
      for (let i = 0; i < targetArity; i++)
        this.infer(Number(source.tupleElements[i]), Number(target.tupleElements[i]), contra, priority, false);
      return;
    }
    const start = array
      ? 0
      : Math.min(this.arena.tuples.fixed(Number(source.id)), this.arena.tuples.fixed(Number(target.id)));
    const end =
      !array && this.arena.tuples.variable(Number(target.id))
        ? Math.min(this.arena.tuples.end(Number(source.id)), this.arena.tuples.end(Number(target.id)))
        : 0;
    for (let i = 0; i < start; i++)
      this.infer(Number(source.tupleElements[i]), Number(target.tupleElements[i]), contra, priority, false);
    if (array || (sourceArity - start - end === 1 && (source.tupleFlags[start] & E.Rest) !== 0)) {
      const rest = array ? source.arrayElement : source.tupleElements[start];
      for (let i = start; i < targetArity - end; i++)
        this.infer(
          Number((target.tupleFlags[i] & E.Variadic) !== 0 ? this.arena.array(Number(rest), false) : rest),
          Number(target.tupleElements[i]),
          contra,
          priority,
          false,
        );
    } else {
      const middle = targetArity - start - end;
      if (middle === 1 && (target.tupleFlags[start] & E.Variadic) !== 0) {
        const speculative = (target.tupleFlags[targetArity - 1] & E.Optional) !== 0 ? Math.max(priority, 1) : priority;
        this.infer(
          Number(this.arena.tuples.slice(Number(source.id), Number(start), Number(end))),
          Number(target.tupleElements[start]),
          contra,
          speculative,
          false,
        );
      } else if (middle === 1 && (target.tupleFlags[start] & E.Rest) !== 0) {
        if (start < sourceArity - end)
          this.infer(
            Number(this.arena.tuples.elementSlice(Number(source.id), Number(start), Number(end))),
            Number(target.tupleElements[start]),
            contra,
            priority,
            false,
          );
      } else if (middle === 2) {
        const first = target.tupleFlags[start];
        const second = target.tupleFlags[start + 1];
        const spread =
          (first & E.Variadic) !== 0 && (second & E.Rest) !== 0
            ? start
            : (first & E.Rest) !== 0 && (second & E.Variadic) !== 0
              ? start + 1
              : -1;
        if (spread >= 0 && this.findInference(Number(target.tupleElements[spread])) !== undefined) {
          const bound = this.arena.indexed.constraint(Number(target.tupleElements[spread]));
          if (
            bound >= 0 &&
            (this.arena.types[bound].objectFlags & O.Tuple) !== 0 &&
            !this.arena.tuples.variable(Number(bound))
          ) {
            const arity = this.arena.tuples.fixed(Number(bound));
            if (spread === start) {
              this.infer(
                Number(this.arena.tuples.slice(Number(source.id), Number(start), Number(sourceArity - start - arity))),
                Number(target.tupleElements[start]),
                contra,
                priority,
                false,
              );
              if (start + arity < sourceArity - end)
                this.infer(
                  Number(this.arena.tuples.elementSlice(Number(source.id), Number(start + arity), Number(end))),
                  Number(target.tupleElements[start + 1]),
                  contra,
                  priority,
                  false,
                );
            } else {
              const endIndex = sourceArity - this.arena.tuples.end(Number(target.id));
              const startIndex = endIndex - arity;
              if (startIndex >= start) {
                if (start < sourceArity - end - arity)
                  this.infer(
                    Number(this.arena.tuples.elementSlice(Number(source.id), Number(start), Number(end + arity))),
                    Number(target.tupleElements[start]),
                    contra,
                    priority,
                    false,
                  );
                this.infer(
                  Number(
                    this.arena.tuple(
                      source.tupleElements.slice(startIndex, endIndex),
                      source.tupleFlags.slice(startIndex, endIndex),
                      false,
                    ),
                  ),
                  Number(target.tupleElements[start + 1]),
                  contra,
                  priority,
                  false,
                );
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < end; i++)
      this.infer(
        Number(source.tupleElements[sourceArity - i - 1]),
        Number(target.tupleElements[targetArity - i - 1]),
        contra,
        priority,
        false,
      );
  }

  private inferMapped(
    sourceId: number,
    targetId: number,
    constraintId: number,
    contra: boolean,
    priority: number,
  ): boolean {
    const constraint = this.arena.types[constraintId];
    if ((constraint.flags & F.UnionOrIntersection) !== 0) {
      let inferred = false;
      for (const part of constraint.types)
        if (this.inferMapped(Number(sourceId), Number(targetId), Number(part), contra, priority)) inferred = true;
      return inferred;
    }
    if ((constraint.flags & F.Index) !== 0) {
      if (this.findInference(Number(constraint.data.indexObject)) !== undefined) {
        const reversed = this.reverseObject(Number(sourceId), Number(targetId), Number(constraintId));
        if (reversed >= 0)
          this.infer(Number(reversed), Number(constraint.data.indexObject), contra, Math.max(priority, 2), false);
      }
      return true;
    }
    if ((constraint.flags & F.TypeParameter) !== 0) {
      this.infer(
        Number(this.arena.indexed.keyof(Number(sourceId), 0)),
        Number(constraintId),
        contra,
        Math.max(priority, 3),
        false,
      );
      if (
        constraint.constraint >= 0 &&
        this.inferMapped(Number(sourceId), Number(targetId), Number(constraint.constraint), contra, priority)
      )
        return true;
      const source = this.arena.types[sourceId];
      this.arena.resolve(source);
      const values: number[] = [];
      for (const p of source.properties) values.push(p.type);
      if (source.stringIndex >= 0) values.push(source.stringIndex);
      if (source.numberIndex >= 0) values.push(source.numberIndex);
      if (source.symbolIndex >= 0) values.push(source.symbolIndex);
      for (const info of source.patternIndexes) values.push(info.type);
      this.infer(
        Number(this.arena.combine(values, F.Union)),
        Number(this.arena.mapped.value(Number(targetId), Number(this.arena.types[targetId].data.mappedParameter))),
        contra,
        priority,
        false,
      );
      return true;
    }
    return false;
  }

  private reverseObject(sourceId: number, targetId: number, constraintId: number): number {
    const key = sourceId + ':' + targetId + ':' + constraintId;
    const previous = this.reversed.get(key);
    if (previous !== undefined) return Number(previous);
    this.reversed.set(key, -1);
    const source = this.arena.types[sourceId];
    this.arena.resolve(source);
    if (
      source.properties.length === 0 &&
      source.stringIndex < 0 &&
      source.arrayElement < 0 &&
      source.tupleElements.length === 0
    )
      return -1;
    const modifiers = this.arena.types[targetId].data.mappedModifiers;
    let result = -1;
    if (source.arrayElement >= 0)
      result = this.arena.array(
        Number(this.reverseValue(Number(source.arrayElement), Number(targetId), Number(constraintId))),
        source.readonly,
      );
    else if ((source.objectFlags & O.Tuple) !== 0) {
      const elements: number[] = [];
      const flags: number[] = [];
      for (let i = 0; i < source.tupleElements.length; i++) {
        elements.push(this.reverseValue(Number(source.tupleElements[i]), Number(targetId), Number(constraintId)));
        flags.push(
          (modifiers & M.IncludeOptional) !== 0 && (source.tupleFlags[i] & E.Optional) !== 0
            ? E.Required
            : source.tupleFlags[i],
        );
      }
      result = this.arena.tuple(elements, flags, source.readonly);
    } else {
      const data = emptyType(F.Object);
      data.objectFlags = O.Anonymous | O.ReverseMapped;
      const properties: Property[] = [];
      for (const p of source.properties)
        if (p !== undefined)
          properties.push({
            ...p,
            type: this.reverseValue(Number(p.type), Number(targetId), Number(constraintId)),
            optional: (modifiers & M.IncludeOptional) === 0 && p.optional,
            readonly: (modifiers & M.IncludeReadonly) === 0 && p.readonly,
          });
      data.properties = properties;
      if (source.stringIndex >= 0)
        data.stringIndex = this.reverseValue(Number(source.stringIndex), Number(targetId), Number(constraintId));
      result = this.arena.add(data);
      this.arena.types[result].inferableIndex = true;
    }
    this.reversed.set(key, result);
    return Number(result);
  }

  private reverseValue(sourceId: number, targetId: number, constraintId: number): number {
    const iterator = this.arena.types[targetId].data.mappedParameter;
    const variable = this.arena.indexed.access(
      Number(this.arena.types[constraintId].data.indexObject),
      Number(iterator),
      0,
    );
    const template = this.arena.mapped.value(Number(targetId), Number(iterator));
    if (this.reverseDepth >= 100) throw new Error('Reverse mapped inference complexity limit exceeded');
    if (this.reverseDepth >= this.reverseWorkers.length)
      this.reverseWorkers.push(new SignatureInference(this.arena, this.strictFunctionTypes, this.related));
    const worker = this.reverseWorkers[this.reverseDepth++];
    try {
      return Number(worker.inferValue(Number(sourceId), Number(template), Number(variable)));
    } finally {
      this.reverseDepth--;
    }
  }

  private inferValue(source: number, template: number, variable: number): number {
    this.visited.clear();
    this.inferenceTargets.clear();
    this.depth = 0;
    this.inferenceParameters.length = 1;
    this.inferenceParameters[0] = variable;
    if (this.inferences.length === 0) this.inferences.push(new Inference());
    const info = this.inferences[0];
    info.covariant.length = 0;
    info.contravariant.length = 0;
    info.priority = 7;
    info.topLevel = true;
    this.infer(Number(source), Number(template), false, 0, true);
    if (info.covariant.length > 0) return Number(this.arena.combine(info.covariant, F.Union));
    if (info.contravariant.length > 0) return Number(this.arena.combine(info.contravariant, F.Intersection));
    return Number(this.arena.intrinsic(F.Unknown));
  }

  private literalKeys(id: number): boolean {
    const type = this.arena.types[id];
    if ((type.flags & F.Union) !== 0) {
      for (const part of type.types) if (!this.literalKeys(Number(part))) return false;
      return true;
    }
    return (type.flags & (F.Literal | F.String)) !== 0;
  }

  private signatures(sources: Signature[], targets: Signature[], contra: boolean, priority: number): void {
    if (sources.length === 0) return;
    for (let i = 0; i < targets.length; i++) {
      const source = this.arena.erase(sources[Math.max(sources.length - targets.length + i, 0)]);
      // Preserve the outer inference parameters in nested target signatures.
      const target = this.arena.erase(targets[i]);
      this.parameters(
        source,
        target,
        this.strictFunctionTypes && !target.bivariant ? !contra : contra,
        priority,
        false,
      );
      this.infer(Number(source.returnType), Number(target.returnType), contra, priority, false);
    }
  }

  private sameShape(sourceId: number, targetId: number): boolean {
    const source = this.arena.types[sourceId];
    const target = this.arena.types[targetId];
    if ((target.flags & F.TemplateLiteral) !== 0)
      return this.arena.strings.infer(Number(sourceId), Number(targetId)).length > 0;
    if (target.arrayElement >= 0) return source.arrayElement >= 0 || (source.objectFlags & O.Tuple) !== 0;
    if ((target.objectFlags & O.Tuple) !== 0) return (source.objectFlags & O.Tuple) !== 0;
    return (source.flags & target.flags & F.Object) !== 0;
  }

  private closelyMatched(sourceId: number, targetId: number): boolean {
    if (sourceId === targetId) return true;
    const source = this.arena.types[sourceId];
    const target = this.arena.types[targetId];
    if ((source.objectFlags & target.objectFlags & O.Tuple) !== 0) {
      if (source.readonly !== target.readonly || source.tupleFlags.length !== target.tupleFlags.length) return false;
      for (let i = 0; i < source.tupleFlags.length; i++)
        if (source.tupleFlags[i] !== target.tupleFlags[i]) return false;
      return true;
    }
    return (
      source.data.target >= 0 &&
      source.data.target === target.data.target &&
      (source.objectFlags & target.objectFlags & O.Reference) !== 0
    );
  }

  private hasPrimitiveConstraint(id: number): boolean {
    const type = this.arena.types[id];
    if ((type.flags & F.Primitive) !== 0) return true;
    if ((type.flags & F.UnionOrIntersection) !== 0)
      for (const part of type.types) if (this.hasPrimitiveConstraint(Number(part))) return true;
    return false;
  }

  private returnContains(id: number, param: number, depth: number): boolean {
    if (id === param) return true;
    if (depth >= 3) return false;
    const type = this.arena.types[id];
    if ((type.flags & F.UnionOrIntersection) !== 0)
      for (const part of type.types) if (this.returnContains(Number(part), Number(param), depth + 1)) return true;
    if ((type.flags & F.Conditional) !== 0)
      return (
        this.returnContains(Number(this.arena.conditional.branch(Number(id), true, false)), Number(param), depth + 1) ||
        this.returnContains(Number(this.arena.conditional.branch(Number(id), false, false)), Number(param), depth + 1)
      );
    return false;
  }

  private widen(id: number): number {
    const type = this.arena.types[id];
    // Go widens fresh literals only; literal annotations remain precise.
    if (type.regularType >= 0) {
      if ((type.flags & F.EnumLike) !== 0 && type.data.enumOrigin >= 0) return Number(type.data.enumOrigin);
      if ((type.flags & F.StringLiteral) !== 0) return this.arena.intrinsic(F.String);
      if ((type.flags & F.NumberLiteral) !== 0) return this.arena.intrinsic(F.Number);
      if ((type.flags & F.BigIntLiteral) !== 0) return this.arena.intrinsic(F.BigInt);
      if ((type.flags & F.BooleanLiteral) !== 0) return this.arena.intrinsic(F.Boolean);
    }
    if ((type.flags & F.Union) !== 0) {
      const parts: number[] = [];
      for (const part of type.types) parts.push(this.widen(Number(part)));
      return Number(this.arena.combine(parts, F.Union));
    }
    return Number(id);
  }

  private common(ids: number[], contra: boolean): number {
    let base = 0;
    let allLiterals = !contra;
    for (const id of ids) {
      const type = this.arena.types[id];
      const flags = type.flags;
      if ((flags & F.Never) !== 0) continue;
      const primitive =
        (flags & F.StringLiteral) !== 0
          ? F.String
          : (flags & F.NumberLiteral) !== 0
            ? F.Number
            : (flags & F.BigIntLiteral) !== 0
              ? F.BigInt
              : (flags & F.BooleanLiteral) !== 0
                ? F.Boolean
                : 0;
      // Distinguish primitive categories from individual enum declarations
      // without looking up an intrinsic type for every inference candidate.
      const enumLike = (flags & F.EnumLike) !== 0;
      const b = enumLike ? type.data.enumOrigin + 1 : -primitive;
      if (b === 0 || (enumLike && type.data.enumOrigin === id) || (base !== 0 && base !== b)) allLiterals = false;
      base = b;
    }
    if (allLiterals) return Number(this.arena.combine(ids, F.Union));
    let candidate = ids[0];
    for (let i = 1; i < ids.length; i++)
      if (contra ? this.related(Number(ids[i]), Number(candidate)) : this.related(Number(candidate), Number(ids[i])))
        candidate = ids[i];
    return Number(candidate);
  }
}
