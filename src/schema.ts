import { z } from "zod";

export const UDL_FORMAT_VERSION = 1 as const;

const snakeCasePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const camelCasePattern = /^[a-z][A-Za-z0-9]*$/;
const fieldPathPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;
const idPrefixPattern = /^[a-z]{2,8}$/;
const eventNamePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const udlSnakeCaseSchema = z
  .string()
  .regex(snakeCasePattern, "must be a snake_case identifier");
const udlVerbNameSchema = z
  .string()
  .regex(snakeCasePattern, "must be a snake_case verb identifier");
const udlFieldNameSchema = z
  .string()
  .regex(camelCasePattern, "must be a camelCase field name");

const nonEmptyTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const fieldPathSchema = z
  .string()
  .regex(fieldPathPattern, "must be a dot-separated camelCase field path");
const jsonObjectSchema = z.record(z.string(), z.json());
const stringMapSchema = z.record(nonEmptyTextSchema, nonEmptyTextSchema);

const udlDeclaredValuePolicySchema = z.enum(["required", "optional", "none"]);

const udlSubjectSchema = z.strictObject({
  declaredValue: udlDeclaredValuePolicySchema,
  kind: udlSnakeCaseSchema,
  schema: jsonObjectSchema,
  title: nonEmptyTextSchema,
  version: z.number().int().positive(),
});

const udlNounSubjectSchema = z.strictObject({
  kinds: z.array(udlSnakeCaseSchema).min(1),
});

const udlLifecycleTransitionSchema = z.strictObject({
  from: z.array(udlSnakeCaseSchema).min(1),
  to: udlSnakeCaseSchema,
});

const udlLifecycleSchema = z.strictObject({
  initial: udlSnakeCaseSchema,
  states: z.array(udlSnakeCaseSchema).min(1),
  transitions: z.record(udlVerbNameSchema, udlLifecycleTransitionSchema),
});

const udlUpdatePolicySchema = z.strictObject({
  fields: z.array(udlFieldNameSchema).min(1),
  states: z.array(udlSnakeCaseSchema).min(1),
});

const udlGateSchema = z.strictObject({
  /** Local field key <- referenced instance path; create verbs only. */
  bind: z.record(udlFieldNameSchema, fieldPathSchema).optional(),
  field: udlFieldNameSchema,
  /** Local instance path === referenced instance path at admission. */
  match: z.record(fieldPathSchema, fieldPathSchema).optional(),
  /** Opt-in over an optional reference field: absent passes, set is held to the clause. */
  optional: z.literal(true).optional(),
  statuses: z.array(udlSnakeCaseSchema).min(1),
  /** One dependent ever per referenced instance; create verbs only. */
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
  period: z.union([
    nonEmptyTextSchema,
    z.strictObject({
      calendar: z.enum(["gregorian", "hijri"]),
      months: z.number().int().positive(),
    }),
  ]),
  untilField: udlFieldNameSchema.optional(),
});

const udlDueParentStatusSchema = z.strictObject({
  nounId: udlSnakeCaseSchema,
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
  offset: nonEmptyTextSchema,
});

const udlUnwindPenaltySchema = z.strictObject({
  bps: z.number().int().min(0).max(9_999),
  withinOffset: nonEmptyTextSchema.optional(),
});

const udlUnwindSchema = z.strictObject({
  beforeField: udlFieldNameSchema.optional(),
  confirm: udlVerbNameSchema,
  penalty: z.array(udlUnwindPenaltySchema).min(1),
  quote: udlVerbNameSchema,
  refundableField: udlFieldNameSchema,
  refundDestinationField: udlFieldNameSchema,
});

const udlDecisionSchema = z.strictObject({
  capability: udlSnakeCaseSchema,
  deadlineMs: z.number().int().positive(),
  // A decision that never came back is not an approval. `approve` would let a
  // document release money because a counterparty went quiet, so the grammar
  // admits only the fail-closed answer. Every published document already
  // writes `decline`; widening later is additive, narrowing later would not
  // be.
  onTimeout: z.literal("decline"),
});

const udlExampleSchema = z.strictObject({
  input: jsonObjectSchema,
  name: nonEmptyTextSchema,
  output: z.json().optional(),
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
  nounId: udlSnakeCaseSchema.optional(),
  over: z.enum(["children", "siblings"]),
  refField: udlFieldNameSchema,
  statuses: z.array(udlSnakeCaseSchema).min(1),
});

// The tenant-backend decision port: the verb's caller asserts the acting
// party, checked at admission against the noun's party bindings for the
// allowed roles.
const udlPortSchema = z.strictObject({
  allowedParties: z
    .array(z.enum(["payer", "beneficiary", "subjectHolder"]))
    .min(1),
});

// A same-instance conservation law: the piece fields (money, minor units)
// must sum exactly to the total field; admission refuses a create whose
// pieces diverge.
const udlPartitionSchema = z.strictObject({
  pieceFields: z.array(udlFieldNameSchema).min(2),
  totalField: udlFieldNameSchema,
});

const udlVerbSchema = z.strictObject({
  deadline: udlDeadlineSchema.optional(),
  decision: udlDecisionSchema.optional(),
  description: nonEmptyTextSchema.optional(),
  due: udlDueSchema.optional(),
  earnable: z.boolean().optional(),
  eventName: z.string().regex(eventNamePattern).optional(),
  examples: z.array(udlExampleSchema).min(1).optional(),
  input: jsonObjectSchema.optional(),
  moves: z.array(udlMoveSchema).default([]),
  port: udlPortSchema.optional(),
  requiresAggregate: z.array(udlAggregateConditionSchema).min(1).optional(),
  requiresDrainedAccount: z.strictObject({ path: fieldPathSchema }).optional(),
  requiresRefs: z.array(udlGateSchema).min(1).optional(),
  setsAt: udlSetsAtSchema.optional(),
  steps: z.array(udlStepSchema),
  summary: nonEmptyTextSchema,
});

const udlAggregateBaseShape = {
  childNounId: udlSnakeCaseSchema,
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

const udlNounSchema = z.strictObject({
  aggregateInvariants: z.array(udlAggregateSchema).min(1).optional(),
  description: nonEmptyTextSchema.optional(),
  distinctParties: z.literal(true).optional(),
  fields: z.record(udlFieldNameSchema, jsonObjectSchema),
  id: udlSnakeCaseSchema,
  idPrefix: z
    .string()
    .regex(idPrefixPattern, "must contain 2 to 8 lowercase letters"),
  lifecycle: udlLifecycleSchema,
  parties: z
    .strictObject({
      beneficiary: udlFieldNameSchema.optional(),
      payer: udlFieldNameSchema.optional(),
      subjectHolder: udlFieldNameSchema.optional(),
    })
    .optional(),
  partitions: z.array(udlPartitionSchema).min(1).optional(),
  required: z.array(udlFieldNameSchema),
  subject: udlNounSubjectSchema.optional(),
  summary: nonEmptyTextSchema,
  title: nonEmptyTextSchema,
  unwind: udlUnwindSchema.optional(),
  update: udlUpdatePolicySchema.optional(),
  verbs: z.record(udlVerbNameSchema, udlVerbSchema),
});

export const udlDocumentSchema = z.strictObject({
  nouns: z.array(udlNounSchema).min(1),
  product: udlSnakeCaseSchema,
  subjects: z.array(udlSubjectSchema),
  title: nonEmptyTextSchema,
  udl: z.literal(UDL_FORMAT_VERSION),
  version: z.number().int().positive(),
});

export type UdlAggregate = z.infer<typeof udlAggregateSchema>;
export type UdlAggregateCondition = z.infer<typeof udlAggregateConditionSchema>;
export type UdlBinding = z.infer<typeof udlBindingSchema>;
export type UdlDeclaredValuePolicy = z.infer<
  typeof udlDeclaredValuePolicySchema
>;
export type UdlDecision = z.infer<typeof udlDecisionSchema>;
export type UdlDocument = z.infer<typeof udlDocumentSchema>;
export type UdlDue = z.infer<typeof udlDueSchema>;
export type UdlExample = z.infer<typeof udlExampleSchema>;
export type UdlGate = z.infer<typeof udlGateSchema>;
export type UdlKernelOperation = z.infer<typeof udlKernelOperationSchema>;
export type UdlLifecycle = z.infer<typeof udlLifecycleSchema>;
export type UdlLifecycleTransition = z.infer<
  typeof udlLifecycleTransitionSchema
>;
export type UdlNoun = z.infer<typeof udlNounSchema>;
export type UdlNounSubject = z.infer<typeof udlNounSubjectSchema>;
export type UdlMove = z.infer<typeof udlMoveSchema>;
export type UdlStep = z.infer<typeof udlStepSchema>;
export type UdlSubject = z.infer<typeof udlSubjectSchema>;
export type UdlUnwind = z.infer<typeof udlUnwindSchema>;
export type UdlVerb = z.infer<typeof udlVerbSchema>;
