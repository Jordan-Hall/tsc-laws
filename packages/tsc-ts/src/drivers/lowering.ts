// Constructs the binder's classes once, so scriptc lowers the AST fields that refer to them in
// drivers that never bind.
import { FlowFlags, FlowNode } from '../compiler/flow.js';
import { Symbol, SymbolFlags } from '../compiler/symbol.js';

export const loweredFlowNode = new FlowNode(FlowFlags.None, undefined, undefined);
export const loweredSymbol = new Symbol(SymbolFlags.None, '');
