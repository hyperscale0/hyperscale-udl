export const UDL_LIMITS = Object.freeze({
  financeAccounts: 16,
  financeEffects: 128,
  financePathVariants: 256,
  financeStates: 32,
  financeTransitionEdges: 128,
  financeTransitions: 64,
  financeActions: 64,
  financeWork: 4_096,
  maxActionExpansion: 256,
  maxActionLeaves: 256,
  maxDepth: 24,
  maxKeyLength: 128,
  maxNodes: 20_000,
  maxPatternLength: 320,
  /**
   * Upper bound on the match attempts a document-authored `pattern` can force
   * the backtracking engine to explore at its single anchored start position.
   * Every admitted pattern's search space is multiplied out at admission
   * (alternation branches x optional atoms x variable-quantifier spans), so
   * worst-case matching cost is this budget times the pattern length, not an
   * exponential in the document author's choice of grammar.
   */
  maxPatternPaths: 4_096,
  /**
   * Reference-shape classifications one `ReferenceShapeBudget` may buy. Each
   * one classifies canonical reference pattern text without compiling a validator.
   * This safety net covers a catalogue plus hundreds of authored instruments.
   */
  maxSchemaProbes: 131_072,
  maxSourceBytes: 1_024 * 1_024,
  maxStringLength: 2_048,
  maxTotalStringLength: 512 * 1_024,
});
