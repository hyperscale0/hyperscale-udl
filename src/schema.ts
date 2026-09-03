import { z } from "zod";

import { udlCheckEvidenceProfiles } from "./check-profiles.js";
import type { UdlEffectKind } from "./effects.js";

export const UDL_FORMAT_VERSION = 1 as const;

const snakeCasePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const camelCasePattern = /^[a-z][A-Za-z0-9]*$/;
const fieldPathPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;
const idPrefixPattern = /^[a-z]{2,8}$/;
const eventNamePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const udlSnakeCaseSchema = z
  .string()
  .regex(snakeCasePattern, "must be a snake_case identifier");
const udlActionNameSchema = z
  .string()
  .regex(snakeCasePattern, "must be a snake_case action identifier");
const udlFieldNameSchema = z
  .string()
  .regex(camelCasePattern, "must be a camelCase field name");

export const udlPublicActionSchema = z
  .string()
  .regex(camelCasePattern, "must be a camelCase public action name");

export const udlInstrumentActionIdSchema = z
  .string()
  .max(160)
  .regex(
    /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
    "must name an instrument action as instrument_id.action_key",
  );

const nonEmptyTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
// Agent-facing presentation prose. Every MCP tool description an agent reads is
// this string, so it is capped: a 400-character ceiling keeps a 60-tool surface
// under the token budget a client spends before it can pick a tool.
const udlAgentDescriptionSchema = nonEmptyTextSchema.max(400);
const fieldPathSchema = z
  .string()
  .regex(fieldPathPattern, "must be a dot-separated camelCase field path");
const instanceValuePathSchema = z
  .string()
  .regex(
    /^(?:fields|refs)\.[a-z][A-Za-z0-9]*$/,
    "must name one declared fields.* or refs.* value",
  );
const jsonObjectSchema = z.record(z.string(), z.json());
const stringMapSchema = z.record(nonEmptyTextSchema, nonEmptyTextSchema);

const providerFamilyIds = [
  "accounts_ledger_first_party",
  "identity_verification",
  "national_identity",
  "credit_bureau",
  "sanctions_screening",
  "enforcement_instrument",
  "credit_servicing",
  "collections_agency",
  "settlement_ingestion",
  "payouts",
  "banking_or_card_issuing",
  "insurance_carrier",
  "insurance_claims_adjuster",
  "air_carrier",
  "lodging_supplier",
  "email_or_notification",
] as const;
export const udlProviderFamilyIdSchema = z.enum(providerFamilyIds);

const udlDeclaredValuePolicySchema = z.enum(["required", "optional", "none"]);

const udlSubjectSchema = z.strictObject({
  declaredValue: udlDeclaredValuePolicySchema,
  kind: udlSnakeCaseSchema,
  schema: jsonObjectSchema,
  title: nonEmptyTextSchema,
  version: z.number().int().positive(),
});

const udlInstrumentSubjectSchema = z.strictObject({
  extensible: z.boolean().optional(),
  kinds: z.array(udlSnakeCaseSchema).min(1),
});

const udlExampleSchema = z.strictObject({
  input: jsonObjectSchema,
  name: nonEmptyTextSchema,
  output: z.json().optional(),
});

const udlLifecycleTransitionSchema = z.strictObject({
  from: z.array(udlSnakeCaseSchema).min(1),
  to: udlSnakeCaseSchema,
});

const udlLifecycleSchema = z.strictObject({
  initial: udlSnakeCaseSchema,
  states: z.array(udlSnakeCaseSchema).min(1),
  transitions: z.record(udlActionNameSchema, udlLifecycleTransitionSchema),
});

const udlUpdatePolicySchema = z.strictObject({
  examples: z.array(udlExampleSchema).optional(),
  fields: z.array(udlFieldNameSchema).min(1),
  states: z.array(udlSnakeCaseSchema).min(1),
});

const udlGateSchema = z.strictObject({
  /** Local field key <- referenced instance path; create actions only. */
  bind: z.record(udlFieldNameSchema, fieldPathSchema).optional(),
  field: udlFieldNameSchema,
  /** Local instance path === referenced instance path at admission. */
  match: z.record(fieldPathSchema, fieldPathSchema).optional(),
  /** Opt-in over an optional reference field: absent passes, set is held to the clause. */
  optional: z.literal(true).optional(),
  statuses: z.array(udlSnakeCaseSchema).min(1),
  /** One dependent ever per referenced instance; create actions only. */
  unique: z.literal(true).optional(),
});

const udlBindingSchema = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("const"), value: z.string() }),
  z.strictObject({ from: z.literal("instance"), path: fieldPathSchema }),
  z.strictObject({ from: z.literal("input"), path: fieldPathSchema }),
]);

const udlStepOperationSchema = z.enum([
  "account.escrow.provision",
  "account.freeze",
  "account.unfreeze",
]);

const udlMoveOperationSchema = z.enum([
  "internal_transfer.create",
  "internal_transfer.reserve",
  "internal_transfer.post",
  "internal_transfer.void",
]);

export const udlKernelOperationSchema = z.enum([
  ...udlStepOperationSchema.options,
  ...udlMoveOperationSchema.options,
]);

const udlStepSchema = z.strictObject({
  bind: z.record(fieldPathSchema, udlBindingSchema),
  capture: stringMapSchema.optional(),
  operation: udlStepOperationSchema,
});

const udlMoveSchema = z.strictObject({
  bind: z.record(fieldPathSchema, udlBindingSchema),
  capture: stringMapSchema.optional(),
  key: udlSnakeCaseSchema,
  operation: udlMoveOperationSchema,
});

const udlDueRecurrenceSchema = z.strictObject({
  countField: udlFieldNameSchema.optional(),
  delinquency: z.literal("parent_policy").optional(),
  drainAction: udlActionNameSchema.optional(),
  period: z.union([
    nonEmptyTextSchema,
    z.strictObject({
      calendar: z.enum(["gregorian", "hijri"]),
      monthEnd: z.literal("clamp_to_last_day"),
      months: z.number().int().positive(),
    }),
  ]),
  liability: z.literal("one_open").optional(),
  untilAction: udlActionNameSchema.optional(),
  untilField: udlFieldNameSchema.optional(),
});

const udlDueParentStatusSchema = z.strictObject({
  instrumentId: udlSnakeCaseSchema,
  refField: udlFieldNameSchema,
  statuses: z.array(udlSnakeCaseSchema).min(1),
});

const udlDueSchema = z.strictObject({
  every: udlDueRecurrenceSchema.optional(),
  field: udlFieldNameSchema,
  offset: nonEmptyTextSchema.optional(),
  whenParentStatus: udlDueParentStatusSchema.optional(),
});

const udlDeadlineSchema = z.strictObject({
  field: udlFieldNameSchema,
  offset: nonEmptyTextSchema.optional(),
});

const udlSetsAtSchema = z.strictObject({
  field: udlFieldNameSchema,
  marker: z.literal(true).optional(),
  offset: nonEmptyTextSchema,
});

const udlQuoteChargeSchema = z.strictObject({
  bps: z.number().int().min(0).max(9_999),
  withinOffset: nonEmptyTextSchema.optional(),
});

// A priced, expiring offer. The quoting action splits `baseField` into a charge
// and a net at its own clock, freezes the fields the price was read from, and
// stamps an expiry. Only the paired `commit` action may spend the offer, and
// only while it is unexpired and its frozen fields still hold.
const udlQuoteShape = {
  /** Date-time whose remaining time picks the charge tier; omit for elapsed age. */
  anchorField: udlFieldNameSchema.optional(),
  baseField: udlFieldNameSchema,
  chargeRef: udlFieldNameSchema,
  charges: z.array(udlQuoteChargeSchema).min(1),
  /** Fixed ISO-8601 duration from the quoting action, or a stored deadline. */
  expires: z.union([
    z.strictObject({ field: udlFieldNameSchema }),
    z.strictObject({ offset: nonEmptyTextSchema }),
  ]),
  fixes: z.array(udlFieldNameSchema).min(1),
  netDestinationField: udlFieldNameSchema,
  netRef: udlFieldNameSchema,
};
const udlQuoteSchema = z.strictObject(udlQuoteShape);

/**
 * Where a quoting action stamps the instant its offer stops being committable.
 * Derived from the author's net ref rather than a fixed name, so two offers on
 * one instrument never share the slot.
 */
export function quoteExpiresAtRefKey(quote: {
  readonly netRef: string;
}): string {
  return `${quote.netRef}ExpiresAt`;
}

/**
 * Where a quoting action stamps the fingerprint of the field values it froze.
 * The committing action recomputes it against the live fields, which is how an
 * offer priced on one set of terms refuses to pay out against another.
 */
export function quoteFrozenRefKey(quote: { readonly netRef: string }): string {
  return `${quote.netRef}Frozen`;
}

/**
 * Every ref key one quote seeds: the charge and the net the author named, plus
 * the two the machinery derives to hold the offer itself. One derivation, read
 * by the validator, the compiler, and the runtime alike.
 */
export function quoteSeededRefKeys(quote: {
  readonly chargeRef: string;
  readonly netRef: string;
}): readonly string[] {
  return [
    quote.chargeRef,
    quote.netRef,
    quoteExpiresAtRefKey(quote),
    quoteFrozenRefKey(quote),
  ];
}

const udlDecisionSchema = z.strictObject({
  capability: udlProviderFamilyIdSchema,
  deadlineMs: z.number().int().positive().max(15_000),
  // A decision that never came back is not an approval. `approve` would let a
  // document release money because a counterparty went quiet, so the grammar
  // admits only the fail-closed answer. Every published document already
  // writes `decline`; widening later is additive, narrowing later would not
  // be.
  onTimeout: z.literal("decline"),
});

const udlAggregateCheckSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    amountField: udlFieldNameSchema,
    kind: z.literal("sum_at_least"),
    targetField: udlFieldNameSchema,
  }),
  z.strictObject({
    amountField: udlFieldNameSchema,
    kind: z.literal("sum_below"),
    targetField: udlFieldNameSchema,
  }),
  z.strictObject({
    amountField: udlFieldNameSchema,
    kind: z.literal("sum_exactly"),
    targetField: udlFieldNameSchema,
  }),
  // Siblings summed against a cap read from the LOCKED anchor row's
  // machinery-seeded ref (never a stored field on the counted rows).
  z.strictObject({
    amountField: udlFieldNameSchema,
    anchorRef: udlFieldNameSchema,
    kind: z.literal("sum_within_anchor_ref"),
  }),
  z.strictObject({
    kind: z.literal("count_at_least"),
    targetField: udlFieldNameSchema,
  }),
  z.strictObject({ kind: z.literal("all_in") }),
  z.strictObject({
    field: udlFieldNameSchema,
    kind: z.literal("count_equals_field"),
  }),
]);

const udlAggregateConditionSchema = z.strictObject({
  check: udlAggregateCheckSchema,
  instrumentId: udlSnakeCaseSchema.optional(),
  over: z.enum(["children", "siblings"]),
  refField: udlFieldNameSchema,
  statuses: z.array(udlSnakeCaseSchema).min(1),
});

const udlExposureRequirementSchema = z.strictObject({
  amountField: udlFieldNameSchema,
  anchorField: udlFieldNameSchema,
  capField: udlFieldNameSchema,
  capOnAnchor: z.literal(true).optional(),
  childInstrumentId: udlSnakeCaseSchema,
  statuses: z.array(udlSnakeCaseSchema).min(1),
});

// The tenant-backend decision port: the action's caller asserts the acting
// party, checked at admission against the instrument's party bindings for the
// allowed roles.
const udlPortSchema = z.strictObject({
  allowedParties: z
    .array(z.enum(["payer", "beneficiary", "subjectHolder"]))
    .min(1),
});

const udlPayoutSchema = z.strictObject({
  amount: instanceValuePathSchema,
  beneficiaryField: udlFieldNameSchema,
  beneficiaryPartyField: udlFieldNameSchema,
  capture: udlFieldNameSchema,
  currencyField: udlFieldNameSchema,
  sourceAccountField: udlFieldNameSchema,
  speed: z.literal("standard"),
});

/**
 * One expectation an action asserts about money it cannot see yet: how much,
 * in which currency, which way, and against whose provider-side row. Evidence
 * that lands later either matches under the declared law or the expectation
 * breaks: past the window the kernel raises the declared exception child, binds
 * the unmatched amount and the break reason onto it, and spends the due
 * occurrence. There is no third outcome and no silent wait.
 */
const udlReconcileSchema = z.strictObject({
  /** `fields.<name>` or `refs.<name>`: the money this action says will land. */
  amount: instanceValuePathSchema,
  /** Where the matched evidence id lands in refs. */
  capture: udlFieldNameSchema,
  /** The ref naming the provider-side row the evidence must cite. */
  counterpartyRef: udlFieldNameSchema,
  currencyField: udlFieldNameSchema,
  direction: z.enum(["credit", "debit"]),
  /** Exactly one source. A reconcile never reads two ledgers at once. */
  evidence: z.enum(["movement", "provider_confirmation", "statement_line"]),
  /**
   * Where an expectation that never matched lands. The named child instrument
   * carries the break, and `maxOpen` caps how many of them one instance may
   * hold open at once, the same count measure the aggregate invariants use.
   */
  exception: z.strictObject({
    amountField: udlFieldNameSchema,
    childInstrumentId: udlSnakeCaseSchema,
    maxOpen: z.number().int().min(1).max(1_000),
    reasonField: udlFieldNameSchema,
    refField: udlFieldNameSchema,
  }),
  /**
   * How a candidate becomes the match. `exact` demands equal minor units,
   * `tolerance` allows a bounded difference, `window` drops the amount test
   * for a source that nets several items into one line.
   */
  match: z.discriminatedUnion("law", [
    z.strictObject({ law: z.literal("exact") }),
    z.strictObject({
      dial: udlSnakeCaseSchema,
      law: z.literal("tolerance"),
      minorUnits: z.number().int().positive(),
    }),
    z.strictObject({ law: z.literal("window") }),
  ]),
  /** Fixed ISO-8601 duration from the expecting action, or a stored deadline. */
  within: z.union([
    z.strictObject({ field: udlFieldNameSchema }),
    z.strictObject({ offset: nonEmptyTextSchema }),
  ]),
});

const udlSignedSumSourceSchema = z.strictObject({
  amountField: udlFieldNameSchema,
  instrumentId: udlSnakeCaseSchema,
  refField: udlFieldNameSchema,
  sign: z.enum(["add", "subtract"]),
  statuses: z.array(udlSnakeCaseSchema).min(1),
  subtotalRef: udlFieldNameSchema,
});

const udlSignedSumSchema = z.strictObject({
  amountRef: udlFieldNameSchema,
  onNegative: z.literal("refuse"),
  onZero: z.enum(["refuse", "skip_steps"]),
  sources: z.array(udlSignedSumSourceSchema).min(1),
});

const udlDistributeSchema = z.strictObject({
  amountRef: udlFieldNameSchema,
  onZero: z.enum(["refuse", "skip_steps"]),
  pool: z.strictObject({
    from: z.literal("parent"),
    path: fieldPathSchema,
  }),
  refField: udlFieldNameSchema,
  statuses: z.array(udlSnakeCaseSchema).min(1),
  weightField: udlFieldNameSchema,
});

const udlRemainderCollectedSchema = z.strictObject({
  amountField: udlFieldNameSchema,
  instrumentId: udlSnakeCaseSchema,
  path: z.literal("refs").optional(),
  refField: udlFieldNameSchema,
  statuses: z.array(udlSnakeCaseSchema).min(1),
});

const udlRemainderSchema = z.strictObject({
  accumulateRef: udlFieldNameSchema.optional(),
  amountRef: udlFieldNameSchema,
  collected: z.array(udlRemainderCollectedSchema).optional(),
  inputKey: udlFieldNameSchema.optional(),
  onZero: z.enum(["refuse", "skip_steps"]),
  totalPath: instanceValuePathSchema,
});

type UdlCheckRequirementShape = {
  checkKind: string;
  family: z.infer<typeof udlProviderFamilyIdSchema>;
  maxAge?: string;
  statuses: string[];
  subjectField: string;
};

const udlCheckRequirementVariants = udlCheckEvidenceProfiles.map((profile) =>
  z.strictObject({
    checkKind: z.literal(profile.checkKind),
    family: z.literal(profile.family),
    maxAge: nonEmptyTextSchema.optional(),
    statuses: z.array(z.enum(profile.statuses)).min(1),
    subjectField: udlFieldNameSchema,
  }),
) as unknown as readonly [
  z.ZodType<UdlCheckRequirementShape>,
  z.ZodType<UdlCheckRequirementShape>,
  ...z.ZodType<UdlCheckRequirementShape>[],
];

const udlCheckRequirementSchema = z.union(udlCheckRequirementVariants);

const udlDialSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    field: udlFieldNameSchema,
    key: udlSnakeCaseSchema,
    kind: z.literal("window"),
    maxOffset: nonEmptyTextSchema.optional(),
    minOffset: nonEmptyTextSchema.optional(),
    summary: nonEmptyTextSchema,
    title: nonEmptyTextSchema,
  }),
  z.strictObject({
    action: udlActionNameSchema,
    key: udlSnakeCaseSchema,
    kind: z.literal("decision_deadline_ms"),
    maxMs: z.number().int().positive().max(15_000).optional(),
    minMs: z.number().int().positive().max(15_000).optional(),
    summary: nonEmptyTextSchema,
    title: nonEmptyTextSchema,
  }),
  z.strictObject({
    key: udlSnakeCaseSchema,
    kind: z.literal("reconcile_tolerance"),
    /** Ceiling on the minor units any reconcile may forgive under this dial. */
    maxMinorUnits: z.number().int().positive().max(1_000_000),
    summary: nonEmptyTextSchema,
    title: nonEmptyTextSchema,
  }),
  z.strictObject({
    key: udlSnakeCaseSchema,
    kind: z.literal("unwind_penalty"),
    summary: nonEmptyTextSchema,
    title: nonEmptyTextSchema,
  }),
]);

// A same-instance conservation law: the piece fields (money, minor units)
// must sum exactly to the total field; admission refuses a create whose
// pieces diverge.
// A composition-level dial. Instrument dials tune one instrument's frozen slots;
// this one is a property of the whole product, so it hangs off the document.
// `confirmation_threshold` carries minor units of the kernel currency: a
// money-moving tool call whose declared money inputs sum below the configured
// value skips the explicit confirmation argument.
const udlCompositionDialSchema = z.strictObject({
  key: udlSnakeCaseSchema,
  kind: z.literal("confirmation_threshold"),
  maxMinor: z.number().int().positive().max(1_000_000_000_000).optional(),
  summary: nonEmptyTextSchema,
  title: nonEmptyTextSchema,
});

const udlPartitionSchema = z.strictObject({
  pieceFields: z.array(udlFieldNameSchema).min(2),
  totalField: udlFieldNameSchema,
});

const udlDerivedAmountSchema = z.strictObject({
  field: udlFieldNameSchema,
  rounding: z.literal("floor"),
  rule: z.strictObject({
    bps: z.number().int().min(1).max(9_999),
    kind: z.literal("percentage_of"),
  }),
  sourceField: udlFieldNameSchema,
});

const udlFeeLeafRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    bps: z.number().int().min(1).max(9_999),
    kind: z.literal("bps"),
  }),
  z.strictObject({
    currencyField: udlFieldNameSchema,
    field: udlFieldNameSchema,
    kind: z.literal("exact"),
  }),
]);

const nonNegativeDecimalIntegerSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "must be a nonnegative decimal integer");

const udlFeeRuleSchema = z.strictObject({
  amountField: udlFieldNameSchema,
  baseField: udlFieldNameSchema,
  bearerField: udlFieldNameSchema,
  position: z.enum(["carved", "on_top"]),
  rule: z.discriminatedUnion("kind", [
    ...udlFeeLeafRuleSchema.options,
    z.strictObject({
      kind: z.literal("tiered"),
      tiers: z
        .array(
          z.strictObject({
            fromInclusive: nonNegativeDecimalIntegerSchema,
            rule: udlFeeLeafRuleSchema,
            toExclusive: nonNegativeDecimalIntegerSchema.optional(),
          }),
        )
        .min(1)
        .max(16),
    }),
  ]),
});

const udlDecidedAmountSchema = z.strictObject({
  boundField: udlFieldNameSchema,
  field: udlFieldNameSchema,
  remainderAction: udlActionNameSchema,
});

const udlEffectRowSchema = z.strictObject({
  signature: nonEmptyTextSchema,
  source: nonEmptyTextSchema,
});

const udlNotifyEffectSchema = z.strictObject({
  channel: udlSnakeCaseSchema,
  role: udlSnakeCaseSchema,
  signature: nonEmptyTextSchema,
  source: nonEmptyTextSchema,
});

const udlEffectsShape = {
  decides: z.array(udlEffectRowSchema).min(1).optional(),
  holds: z.array(udlEffectRowSchema).min(1).optional(),
  moves: z.array(udlEffectRowSchema).min(1).optional(),
  notifies: z.array(udlNotifyEffectSchema).min(1).optional(),
  reads: z.array(udlEffectRowSchema).min(1).optional(),
  schedules: z.array(udlEffectRowSchema).min(1).optional(),
} satisfies Record<UdlEffectKind, z.ZodType>;
const udlEffectsSchema = z.strictObject(udlEffectsShape);

const udlActionShape = {
  agentDescription: udlAgentDescriptionSchema.optional(),
  captureInput: z.record(udlFieldNameSchema, udlFieldNameSchema).optional(),
  /** Names the quoting action whose offer this action spends. */
  commit: udlActionNameSchema.optional(),
  decidedAmount: udlDecidedAmountSchema.optional(),
  deadline: udlDeadlineSchema.optional(),
  decision: udlDecisionSchema.optional(),
  distribute: udlDistributeSchema.optional(),
  description: nonEmptyTextSchema.optional(),
  due: udlDueSchema.optional(),
  earnable: z.boolean().optional(),
  effects: udlEffectsSchema.optional(),
  eventName: z.string().regex(eventNamePattern).optional(),
  examples: z.array(udlExampleSchema).min(1).optional(),
  input: jsonObjectSchema.optional(),
  moves: z.array(udlMoveSchema).default([]),
  payout: udlPayoutSchema.optional(),
  port: udlPortSchema.optional(),
  quote: udlQuoteSchema.optional(),
  publicAction: udlPublicActionSchema
    .optional()
    .describe(
      "Author-approved public action name; the containing action key remains the lifecycle and execution identity",
    ),
  principal: z.literal("user_session").optional(),
  reconcile: z.array(udlReconcileSchema).min(1).optional(),
  remainder: udlRemainderSchema.optional(),
  requiresAggregate: z.array(udlAggregateConditionSchema).min(1).optional(),
  requiresChecks: z.array(udlCheckRequirementSchema).optional(),
  requiresDrainedAccount: z.strictObject({ path: fieldPathSchema }).optional(),
  requiresExposure: z.array(udlExposureRequirementSchema).min(1).optional(),
  requiresRefs: z.array(udlGateSchema).min(1).optional(),
  sandboxFailurePoint: z.enum(["funding", "release"]).optional(),
  setsAt: udlSetsAtSchema.optional(),
  signedSum: udlSignedSumSchema.optional(),
  steps: z.array(udlStepSchema),
  summary: nonEmptyTextSchema,
  updates: z.array(udlFieldNameSchema).min(1).optional(),
};
const udlActionSchema = z.strictObject(udlActionShape);

const udlAggregateBaseShape = {
  childInstrumentId: udlSnakeCaseSchema,
  childRefField: udlFieldNameSchema,
  childStatuses: z.array(udlSnakeCaseSchema).min(1),
  parentField: udlFieldNameSchema,
};

// Two measures, mutually exclusive by strictness: a sum cap over a child money
// field, or a count cap (optionally windowed to the rolling `days` ending at
// the child's own as-written date-time value).
const udlAggregateSchema = z.union([
  z.strictObject({
    ...udlAggregateBaseShape,
    childField: udlFieldNameSchema,
  }),
  z.strictObject({
    ...udlAggregateBaseShape,
    count: z.literal(true),
    window: z
      .strictObject({
        field: udlFieldNameSchema,
        days: z.number().int().min(1).max(3650),
      })
      .optional(),
  }),
]);

const udlInstrumentShape = {
  actionOrder: z.array(udlActionNameSchema).min(1),
  agentDescription: udlAgentDescriptionSchema.optional(),
  aggregateInvariants: z.array(udlAggregateSchema).min(1).optional(),
  callerParkedStates: z
    .record(udlSnakeCaseSchema, nonEmptyTextSchema)
    .optional(),
  description: nonEmptyTextSchema.optional(),
  dials: z.array(udlDialSchema).optional(),
  distinctParties: z.literal(true).optional(),
  derivedAmounts: z.array(udlDerivedAmountSchema).min(1).max(4).optional(),
  feeRules: z.array(udlFeeRuleSchema).min(1).max(4).optional(),
  fields: z.record(udlFieldNameSchema, jsonObjectSchema),
  id: udlSnakeCaseSchema,
  idPrefix: z
    .string()
    .regex(idPrefixPattern, "must contain 2 to 8 lowercase letters"),
  lifecycle: udlLifecycleSchema,
  nav: z.array(nonEmptyTextSchema).min(1).optional(),
  parties: z
    .strictObject({
      beneficiary: udlFieldNameSchema.optional(),
      payer: udlFieldNameSchema.optional(),
      subjectHolder: udlFieldNameSchema.optional(),
    })
    .optional(),
  partitions: z.array(udlPartitionSchema).min(1).optional(),
  required: z.array(udlFieldNameSchema),
  subject: udlInstrumentSubjectSchema.optional(),
  summary: nonEmptyTextSchema,
  surfaceVisibility: z.enum(["internal", "public", "system"]).optional(),
  templateId: udlSnakeCaseSchema.optional(),
  title: nonEmptyTextSchema,
  update: udlUpdatePolicySchema.optional(),
  actions: z.record(udlActionNameSchema, udlActionSchema),
};
const udlInstrumentSchema = z.strictObject(udlInstrumentShape);

type UdlActionClauseTarget = keyof typeof udlActionShape;
type UdlInstrumentClauseTarget = keyof typeof udlInstrumentShape;
type UdlActionNestedClauseTarget = `effects.${keyof typeof udlEffectsShape}`;

export type UdlClauseCardinality = "one" | "many";

export interface UdlClauseEffect {
  readonly kind: UdlEffectKind;
  readonly per: "clause" | "element";
  readonly signature:
    | { readonly fixed: string }
    | { readonly fromField: string }
    | { readonly movementClass: true };
}

interface UdlClauseVocabularyMetadata {
  readonly cardinality?: UdlClauseCardinality;
  readonly effects?: readonly UdlClauseEffect[];
  readonly linearOutputs?: readonly string[];
  readonly linearSink?: true;
  readonly spelling: string;
}

export type UdlClauseVocabularyEntry = UdlClauseVocabularyMetadata &
  (
    | {
        readonly scope: "action";
        readonly target: UdlActionClauseTarget | UdlActionNestedClauseTarget;
      }
    | {
        readonly scope: "instrument";
        readonly target: UdlInstrumentClauseTarget;
      }
  );

export const udlClauseVocabulary = [
  {
    cardinality: "one",
    scope: "action",
    spelling: "agent description",
    target: "agentDescription",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "capture input",
    target: "captureInput",
  },
  {
    cardinality: "one",
    // The committing action consumes the quote through its priced moves.
    // An extra row here would bill the same movement twice.
    effects: [],
    scope: "action",
    spelling: "commit",
    target: "commit",
  },
  {
    cardinality: "one",
    effects: [
      {
        kind: "holds",
        per: "clause",
        signature: { fixed: "quote" },
      },
      {
        kind: "schedules",
        per: "clause",
        signature: { fixed: "expiry" },
      },
    ],
    linearOutputs: ["netRef"],
    scope: "action",
    spelling: "quote",
    target: "quote",
  },
  {
    cardinality: "one",
    linearOutputs: ["field"],
    scope: "action",
    spelling: "decided amount",
    target: "decidedAmount",
  },
  {
    cardinality: "one",
    effects: [
      {
        kind: "schedules",
        per: "clause",
        signature: { fixed: "deadline" },
      },
    ],
    scope: "action",
    spelling: "deadline",
    target: "deadline",
  },
  {
    cardinality: "one",
    effects: [
      {
        kind: "decides",
        per: "clause",
        signature: { fromField: "capability" },
      },
    ],
    scope: "action",
    spelling: "decision",
    target: "decision",
  },
  {
    cardinality: "one",
    linearOutputs: ["amountRef"],
    scope: "action",
    spelling: "computes distribute",
    target: "distribute",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "description",
    target: "description",
  },
  {
    cardinality: "one",
    effects: [
      {
        kind: "schedules",
        per: "clause",
        signature: { fixed: "due" },
      },
    ],
    scope: "action",
    spelling: "due",
    target: "due",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "earnable",
    target: "earnable",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "event name",
    target: "eventName",
  },
  {
    cardinality: "many",
    scope: "action",
    spelling: "examples",
    target: "examples",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "input",
    target: "input",
  },
  {
    cardinality: "many",
    effects: [
      {
        kind: "moves",
        per: "element",
        signature: { movementClass: true },
      },
      {
        kind: "holds",
        per: "element",
        signature: { fixed: "reserve" },
      },
    ],
    linearSink: true,
    scope: "action",
    spelling: "moves",
    target: "moves",
  },
  {
    cardinality: "one",
    effects: [
      {
        kind: "moves",
        per: "clause",
        signature: { fixed: "payout.external" },
      },
    ],
    linearSink: true,
    scope: "action",
    spelling: "payout",
    target: "payout",
  },
  {
    cardinality: "one",
    effects: [
      {
        kind: "decides",
        per: "clause",
        signature: { fixed: "tenant_port" },
      },
    ],
    scope: "action",
    spelling: "port",
    target: "port",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "principal",
    target: "principal",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "public action",
    target: "publicAction",
  },
  {
    cardinality: "many",
    effects: [
      {
        kind: "reads",
        per: "element",
        signature: { fixed: "reconcile" },
      },
    ],
    scope: "action",
    spelling: "reconcile",
    target: "reconcile",
  },
  {
    cardinality: "one",
    linearOutputs: ["amountRef"],
    scope: "action",
    spelling: "computes remainder",
    target: "remainder",
  },
  {
    cardinality: "many",
    effects: [
      {
        kind: "reads",
        per: "clause",
        signature: { fixed: "requires_aggregate" },
      },
    ],
    scope: "action",
    spelling: "requires aggregate",
    target: "requiresAggregate",
  },
  {
    cardinality: "many",
    effects: [
      {
        kind: "reads",
        per: "clause",
        signature: { fixed: "requires_checks" },
      },
    ],
    scope: "action",
    spelling: "requires checks",
    target: "requiresChecks",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "requires drained",
    target: "requiresDrainedAccount",
  },
  {
    cardinality: "many",
    scope: "action",
    spelling: "requires exposure",
    target: "requiresExposure",
  },
  {
    cardinality: "many",
    effects: [
      {
        kind: "reads",
        per: "clause",
        signature: { fixed: "requires_refs" },
      },
    ],
    scope: "action",
    spelling: "requires refs",
    target: "requiresRefs",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "sandbox failure point",
    target: "sandboxFailurePoint",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "sets at",
    target: "setsAt",
  },
  {
    cardinality: "one",
    linearOutputs: ["amountRef"],
    scope: "action",
    spelling: "computes signed_sum",
    target: "signedSum",
  },
  {
    cardinality: "many",
    linearSink: true,
    scope: "action",
    spelling: "steps",
    target: "steps",
  },
  {
    cardinality: "one",
    scope: "action",
    spelling: "summary",
    target: "summary",
  },
  {
    cardinality: "many",
    scope: "action",
    spelling: "updates",
    target: "updates",
  },
  {
    cardinality: "many",
    effects: [
      {
        kind: "notifies",
        per: "element",
        signature: { fromField: "channel" },
      },
    ],
    scope: "action",
    spelling: "notify",
    target: "effects.notifies",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "agent description",
    target: "agentDescription",
  },
  {
    cardinality: "many",
    scope: "instrument",
    spelling: "aggregate invariants",
    target: "aggregateInvariants",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "caller parked states",
    target: "callerParkedStates",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "description",
    target: "description",
  },
  {
    cardinality: "many",
    scope: "instrument",
    spelling: "dials",
    target: "dials",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "distinct parties",
    target: "distinctParties",
  },
  {
    cardinality: "many",
    scope: "instrument",
    spelling: "computes derived",
    target: "derivedAmounts",
  },
  {
    cardinality: "many",
    scope: "instrument",
    spelling: "computes fees",
    target: "feeRules",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "id prefix",
    target: "idPrefix",
  },
  {
    cardinality: "many",
    scope: "instrument",
    spelling: "nav",
    target: "nav",
  },
  {
    cardinality: "many",
    scope: "instrument",
    spelling: "partitions",
    target: "partitions",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "subject",
    target: "subject",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "summary",
    target: "summary",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "surface visibility",
    target: "surfaceVisibility",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "template id",
    target: "templateId",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "title",
    target: "title",
  },
  {
    cardinality: "one",
    scope: "instrument",
    spelling: "update",
    target: "update",
  },
] as const satisfies readonly UdlClauseVocabularyEntry[];

const udlDocumentShapeSchema = z.strictObject({
  dials: z.array(udlCompositionDialSchema).min(1).optional(),
  instruments: z.array(udlInstrumentSchema).min(1),
  product: udlSnakeCaseSchema,
  subjects: z.array(udlSubjectSchema),
  title: nonEmptyTextSchema,
  udl: z.literal(UDL_FORMAT_VERSION),
  version: z.number().int().positive(),
});

type ParsedInstrument = z.infer<typeof udlInstrumentSchema>;

const moneyPatterns = new Set(["^[1-9][0-9]{0,17}$", "^(0|[1-9][0-9]{0,17})$"]);

function isMoneyField(
  schema: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return (
    typeof schema?.pattern === "string" && moneyPatterns.has(schema.pattern)
  );
}

function referenceTargets(
  schema: Readonly<Record<string, unknown>>,
  instruments: readonly ParsedInstrument[],
): readonly ParsedInstrument[] {
  if (schema.type !== "string" || typeof schema.pattern !== "string") return [];
  // Parse the scoped-ID pattern. Executing an author regex here would bypass
  // the semantic validator's branch and quantifier budgets.
  const match = /^\^([a-z]{2,8})_\(sandbox\|live\)_\[a-z0-9\]\{8,64\}\$$/.exec(
    schema.pattern,
  );
  if (!match) return [];
  const prefix = match[1] as string;
  const probe = `${prefix}_sandbox_0123456789abcdef`;
  if (typeof schema.const === "string" && schema.const !== probe) return [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(probe)) return [];
  if (typeof schema.minLength === "number" && probe.length < schema.minLength) {
    return [];
  }
  if (typeof schema.maxLength === "number" && probe.length > schema.maxLength) {
    return [];
  }
  return instruments.filter((instrument) => instrument.idPrefix === prefix);
}

function declaredMoneyRefKeys(
  instrument: ParsedInstrument,
): ReadonlySet<string> {
  return new Set([
    ...Object.values(instrument.actions).flatMap((action) => [
      ...(action.remainder
        ? [
            action.remainder.amountRef,
            ...(action.remainder.accumulateRef
              ? [action.remainder.accumulateRef]
              : []),
          ]
        : []),
      ...(action.signedSum
        ? [
            action.signedSum.amountRef,
            ...action.signedSum.sources.map((source) => source.subtotalRef),
          ]
        : []),
      ...(action.distribute ? [action.distribute.amountRef] : []),
      ...(action.quote ? [action.quote.chargeRef, action.quote.netRef] : []),
    ]),
  ]);
}

export const udlDocumentSchema = udlDocumentShapeSchema.superRefine(
  (document, context) => {
    document.instruments.forEach((instrument, instrumentIndex) => {
      instrument.derivedAmounts?.forEach((amount, amountIndex) => {
        const base = [
          "instruments",
          instrumentIndex,
          "derivedAmounts",
          amountIndex,
        ] as const;
        if (!isMoneyField(instrument.fields[amount.field])) {
          context.addIssue({
            code: "custom",
            message: `derived amount target ${amount.field} must be a declared money field`,
            path: [...base, "field"],
          });
        }
        if (!isMoneyField(instrument.fields[amount.sourceField])) {
          context.addIssue({
            code: "custom",
            message: `derived amount source ${amount.sourceField} must be a declared money field`,
            path: [...base, "sourceField"],
          });
        }
        if (amount.field === amount.sourceField) {
          context.addIssue({
            code: "custom",
            message: "a derived amount cannot derive from itself",
            path: [...base, "sourceField"],
          });
        }
      });

      Object.entries(instrument.actions).forEach(([actionName, action]) => {
        const distribute = action.distribute;
        if (!distribute) return;
        const base = [
          "instruments",
          instrumentIndex,
          "actions",
          actionName,
          "distribute",
        ] as const;
        const refSchema = instrument.fields[distribute.refField];
        const parents = refSchema
          ? referenceTargets(refSchema, document.instruments)
          : [];
        if (parents.length !== 1) {
          context.addIssue({
            code: "custom",
            message: `distribute refField ${distribute.refField} must identify exactly one parent instrument`,
            path: [...base, "refField"],
          });
        }

        if (!isMoneyField(instrument.fields[distribute.weightField])) {
          context.addIssue({
            code: "custom",
            message: `distribute weightField ${distribute.weightField} must be a declared money field`,
            path: [...base, "weightField"],
          });
        }

        distribute.statuses.forEach((status, statusIndex) => {
          if (instrument.lifecycle.states.includes(status)) return;
          context.addIssue({
            code: "custom",
            message: `distribute status ${status} is not declared by ${instrument.id}`,
            path: [...base, "statuses", statusIndex],
          });
        });

        const parent = parents[0];
        if (!parent) return;
        const poolMatch = /^(fields|refs)\.([a-z][A-Za-z0-9]*)$/.exec(
          distribute.pool.path,
        );
        const root = poolMatch?.[1];
        const key = poolMatch?.[2];
        const poolDeclared =
          root === "fields"
            ? isMoneyField(parent.fields[key ?? ""])
            : root === "refs"
              ? declaredMoneyRefKeys(parent).has(key ?? "")
              : false;
        if (!poolDeclared) {
          context.addIssue({
            code: "custom",
            message: `distribute pool ${distribute.pool.path} must be a declared money field or ref of ${parent.id}`,
            path: [...base, "pool", "path"],
          });
        }
      });
    });
  },
);

export type UdlAggregate = z.infer<typeof udlAggregateSchema>;
export type UdlAggregateCondition = z.infer<typeof udlAggregateConditionSchema>;
export type UdlBinding = z.infer<typeof udlBindingSchema>;
export type UdlDeclaredValuePolicy = z.infer<
  typeof udlDeclaredValuePolicySchema
>;
export type UdlDecision = z.infer<typeof udlDecisionSchema>;
export type UdlCompositionDial = z.infer<typeof udlCompositionDialSchema>;
export type UdlDial = z.infer<typeof udlDialSchema>;
export type UdlDocument = z.infer<typeof udlDocumentSchema>;
export type UdlDue = z.infer<typeof udlDueSchema>;
export type UdlEffects = z.infer<typeof udlEffectsSchema>;
export type UdlExample = z.infer<typeof udlExampleSchema>;
export type UdlGate = z.infer<typeof udlGateSchema>;
export type UdlKernelOperation = z.infer<typeof udlKernelOperationSchema>;
export type UdlLifecycle = z.infer<typeof udlLifecycleSchema>;
export type UdlLifecycleTransition = z.infer<
  typeof udlLifecycleTransitionSchema
>;
export type UdlInstrument = z.infer<typeof udlInstrumentSchema>;
export type UdlInstrumentSubject = z.infer<typeof udlInstrumentSubjectSchema>;
export type UdlMove = z.infer<typeof udlMoveSchema>;
export type UdlPayout = z.infer<typeof udlPayoutSchema>;
export type UdlQuote = z.infer<typeof udlQuoteSchema>;
export type UdlProviderFamilyId = z.infer<typeof udlProviderFamilyIdSchema>;
export type UdlCheckRequirement = z.infer<typeof udlCheckRequirementSchema>;
export type UdlReconcile = z.infer<typeof udlReconcileSchema>;
export type UdlRemainder = z.infer<typeof udlRemainderSchema>;
export type UdlStep = z.infer<typeof udlStepSchema>;
export type UdlSubject = z.infer<typeof udlSubjectSchema>;
export type UdlAction = z.infer<typeof udlActionSchema>;
