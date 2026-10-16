// The lazily computed state of types and signatures with side state (`ObjectFlags.SideState`,
// `SignatureFlags.SideState`): a checker keeps it in holders of its own, by id, and the type or
// signature itself is never written after it is created.
import type { Checker } from './checker.js';
import {
  ConditionalType,
  EvolvingArrayType,
  InstantiationExpressionType,
  InterfaceType,
  IntersectionType,
  LiteralType,
  MappedType,
  ObjectFlags,
  ObjectType,
  ReverseMappedType,
  Signature,
  SignatureFlags,
  StructuredType,
  TupleType,
  Type,
  TypeParameter,
  TypeReference,
  UnionType,
  emptySymbols,
  emptyTypes,
} from './checker-types.js';

/**
 * The object that holds the lazily computed state of `t`: `t` itself, or for a type with side
 * state the checker's holder of it, an object of the same class created on first use. The holder's
 * identity fields are copies or unset: nothing may use it as a type, only as a holder of state.
 */
export function sideOf<T extends Type>(c: Checker, t: T): T {
  // Small enough to inline: the holder is found out of line.
  return (t.objectFlags & ObjectFlags.SideState) === 0 ? t : (sideHolder(c, t) as T);
}

function sideHolder(c: Checker, t: Type): Type {
  let holder = c.sideHolders.get(t.id);
  if (holder === undefined) {
    holder = newSideHolder(t);
    holder.objectFlags = ObjectFlags.None;
    holder.symbol = t.symbol;
    c.sideHolders.set(t.id, holder);
  }
  return holder;
}

/** The holder of `t`'s state if `t` has side state and its checker created one, else `t`. */
export function sideOfIfAny<T extends Type>(c: Checker, t: T): T | undefined {
  if ((t.objectFlags & ObjectFlags.SideState) === 0) return t;
  return c.sideHolders.get(t.id) as T | undefined;
}

/** The `objectFlags` of `t` that are computed lazily (resolution state and memo bits). */
export function lazyObjectFlags(c: Checker, t: Type): ObjectFlags {
  const flags = t.objectFlags;
  return (flags & ObjectFlags.SideState) === 0 ? flags : sideHolderFlags(c, t);
}

function sideHolderFlags(c: Checker, t: Type): ObjectFlags {
  const holder = c.sideHolders.get(t.id);
  return holder !== undefined ? holder.objectFlags : ObjectFlags.None;
}

function newSideHolder(t: Type): Type {
  const id = t.id;
  const symbol = t.symbol;
  if (t instanceof TupleType) return new TupleType(ObjectFlags.None, id);
  if (t instanceof InterfaceType) return new InterfaceType(ObjectFlags.None, id, symbol);
  if (t instanceof TypeReference) return new TypeReference(ObjectFlags.None, id, symbol);
  if (t instanceof MappedType) return new MappedType(ObjectFlags.None, id, symbol);
  if (t instanceof ReverseMappedType) return new ReverseMappedType(ObjectFlags.None, id);
  if (t instanceof EvolvingArrayType) return new EvolvingArrayType(ObjectFlags.None, id);
  if (t instanceof InstantiationExpressionType) return new InstantiationExpressionType(ObjectFlags.None, id, symbol);
  if (t instanceof ObjectType) return new ObjectType(ObjectFlags.None, id, symbol);
  if (t instanceof UnionType) return new UnionType(ObjectFlags.None, id, emptyTypes);
  if (t instanceof IntersectionType) return new IntersectionType(ObjectFlags.None, id, emptyTypes);
  if (t instanceof StructuredType) return new StructuredType(t.flags, ObjectFlags.None, id, symbol);
  if (t instanceof LiteralType) return new LiteralType(t.flags, id, symbol, '', 0);
  if (t instanceof TypeParameter) return new TypeParameter(id, symbol);
  if (t instanceof ConditionalType) {
    const conditional = t as ConditionalType;
    return new ConditionalType(
      id,
      conditional.root,
      conditional.checkType,
      conditional.extendsType,
      undefined,
      undefined,
    );
  }
  return new Type(t.flags, ObjectFlags.None, id, symbol);
}

/** Like `sideOf`, for a signature with side state. */
export function signatureSideOf(c: Checker, s: Signature): Signature {
  return (s.flags & SignatureFlags.SideState) === 0 ? s : signatureSideHolder(c, s);
}

function signatureSideHolder(c: Checker, s: Signature): Signature {
  let holder = c.signatureSideHolders.get(s.id);
  if (holder === undefined) {
    holder = new Signature(
      s.id,
      SignatureFlags.None,
      undefined,
      emptyTypes,
      undefined,
      emptySymbols,
      undefined,
      undefined,
      0,
    );
    c.signatureSideHolders.set(s.id, holder);
  }
  return holder;
}

/** The resolved return type of `s`: set when it was created, or resolved since (`getReturnTypeOfSignature`). */
export function resolvedReturnTypeOf(c: Checker, s: Signature): Type | undefined {
  if (s.resolvedReturnType !== undefined || (s.flags & SignatureFlags.SideState) === 0) return s.resolvedReturnType;
  const holder = c.signatureSideHolders.get(s.id);
  return holder !== undefined ? holder.resolvedReturnType : undefined;
}
