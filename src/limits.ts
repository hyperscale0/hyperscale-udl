export const UDL_LIMITS = Object.freeze({
  financeAccounts: 16,
  financeEffects: 128,
  financePathVariants: 256,
  financeStates: 32,
  financeTransitionEdges: 128,
  financeTransitions: 64,
  financeActions: 64,
  financeWork: 4_096,
  maxDepth: 24,
  maxKeyLength: 128,
  // The 33-instrument catalog includes its executable authored journeys.
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
   * one compiles a JSON Schema validator, and a document controls both factors
   * of the instruments x gate-fields product that asks for them.
   */
  maxSchemaProbes: 2_048,
  // The complete catalog now carries executable authored journeys beside the
  // instrument mechanics, so its bounded source and string budgets include
  // that contract-owned corpus.
  maxSourceBytes: 1_024 * 1_024,
  maxStringLength: 2_048,
  maxTotalStringLength: 512 * 1_024,
});
