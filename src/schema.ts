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

export const udlPublicIntentSchema = z
  .string()
  .regex(camelCasePattern, "must be a camelCase public intent name");

const nonEmptyTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
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
  marker: z.literal(true).optional(),
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

const udlExposureRequirementSchema = z.strictObject({
  amountField: udlFieldNameSchema,
  anchorField: udlFieldNameSchema,
  capField: udlFieldNameSchema,
  capOnAnchor: z.literal(true).optional(),
  childNounId: udlSnakeCaseSchema,
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

const udlPayoutSchema = z.strictObject({
  amount: instanceValuePathSchema,
  beneficiaryField: udlFieldNameSchema,
  beneficiaryPartyField: udlFieldNameSchema,
  capture: udlFieldNameSchema,
  currencyField: udlFieldNameSchema,
  sourceAccountField: udlFieldNameSchema,
  speed: z.literal("standard"),
});

const udlRequiresSettlementSchema = z.strictObject({
  capture: udlFieldNameSchema,
  payoutRef: udlFieldNameSchema,
});

const udlSignedSumSourceSchema = z.strictObject({
  amountField: udlFieldNameSchema,
  nounId: udlSnakeCaseSchema,
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

// A same-instance conservation law: the piece fields (money, minor units)
// must sum exactly to the total field; admission refuses a create whose
// pieces diverge.
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

const udlVerbSchema = z.strictObject({
  captureInput: z.record(udlFieldNameSchema, udlFieldNameSchema).optional(),
  deadline: udlDeadlineSchema.optional(),
  decision: udlDecisionSchema.optional(),
  distribute: udlDistributeSchema.optional(),
  description: nonEmptyTextSchema.optional(),
  due: udlDueSchema.optional(),
  earnable: z.boolean().optional(),
  eventName: z.string().regex(eventNamePattern).optional(),
  examples: z.array(udlExampleSchema).min(1).optional(),
  input: jsonObjectSchema.optional(),
  moves: z.array(udlMoveSchema).default([]),
  payout: udlPayoutSchema.optional(),
  port: udlPortSchema.optional(),
  publicIntent: udlPublicIntentSchema
    .optional()
    .describe(
      "Author-approved public intent name; the containing verb key remains the lifecycle and execution identity",
    ),
  requiresAggregate: z.array(udlAggregateConditionSchema).min(1).optional(),
  requiresDrainedAccount: z.strictObject({ path: fieldPathSchema }).optional(),
  requiresExposure: z.array(udlExposureRequirementSchema).min(1).optional(),
  requiresRefs: z.array(udlGateSchema).min(1).optional(),
  requiresSettlement: udlRequiresSettlementSchema.optional(),
  setsAt: udlSetsAtSchema.optional(),
  signedSum: udlSignedSumSchema.optional(),
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
  computedMoneyRefs: z.array(udlFieldNameSchema).min(1).optional(),
  description: nonEmptyTextSchema.optional(),
  distinctParties: z.literal(true).optional(),
  derivedAmounts: z.array(udlDerivedAmountSchema).min(1).max(4).optional(),
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

const udlDocumentShapeSchema = z.strictObject({
  nouns: z.array(udlNounSchema).min(1),
  product: udlSnakeCaseSchema,
  subjects: z.array(udlSubjectSchema),
  title: nonEmptyTextSchema,
  udl: z.literal(UDL_FORMAT_VERSION),
  version: z.number().int().positive(),
});

type ParsedNoun = z.infer<typeof udlNounSchema>;

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
  nouns: readonly ParsedNoun[],
): readonly ParsedNoun[] {
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
  return nouns.filter((noun) => noun.idPrefix === prefix);
}

function declaredMoneyRefKeys(noun: ParsedNoun): ReadonlySet<string> {
  return new Set([
    ...(noun.computedMoneyRefs ?? []),
    ...Object.values(noun.verbs).flatMap((verb) => [
      ...(verb.signedSum
        ? [
            verb.signedSum.amountRef,
            ...verb.signedSum.sources.map((source) => source.subtotalRef),
          ]
        : []),
      ...(verb.distribute ? [verb.distribute.amountRef] : []),
    ]),
    ...(noun.unwind ? ["unwindRefund", "unwindPenalty"] : []),
  ]);
}

export const udlDocumentSchema = udlDocumentShapeSchema.superRefine(
  (document, context) => {
    document.nouns.forEach((noun, nounIndex) => {
      noun.derivedAmounts?.forEach((amount, amountIndex) => {
        const base = [
          "nouns",
          nounIndex,
          "derivedAmounts",
          amountIndex,
        ] as const;
        if (!isMoneyField(noun.fields[amount.field])) {
          context.addIssue({
            code: "custom",
            message: `derived amount target ${amount.field} must be a declared money field`,
            path: [...base, "field"],
          });
        }
        if (!isMoneyField(noun.fields[amount.sourceField])) {
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

      Object.entries(noun.verbs).forEach(([verbName, verb]) => {
        const distribute = verb.distribute;
        if (!distribute) return;
        const base = [
          "nouns",
          nounIndex,
          "verbs",
          verbName,
          "distribute",
        ] as const;
        const refSchema = noun.fields[distribute.refField];
        const parents = refSchema
          ? referenceTargets(refSchema, document.nouns)
          : [];
        if (parents.length !== 1) {
          context.addIssue({
            code: "custom",
            message: `distribute refField ${distribute.refField} must identify exactly one parent noun`,
            path: [...base, "refField"],
          });
        }

        if (!isMoneyField(noun.fields[distribute.weightField])) {
          context.addIssue({
            code: "custom",
            message: `distribute weightField ${distribute.weightField} must be a declared money field`,
            path: [...base, "weightField"],
          });
        }

        distribute.statuses.forEach((status, statusIndex) => {
          if (noun.lifecycle.states.includes(status)) return;
          context.addIssue({
            code: "custom",
            message: `distribute status ${status} is not declared by ${noun.id}`,
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
export type UdlPayout = z.infer<typeof udlPayoutSchema>;
export type UdlRequiresSettlement = z.infer<typeof udlRequiresSettlementSchema>;
export type UdlStep = z.infer<typeof udlStepSchema>;
export type UdlSubject = z.infer<typeof udlSubjectSchema>;
export type UdlUnwind = z.infer<typeof udlUnwindSchema>;
export type UdlVerb = z.infer<typeof udlVerbSchema>;
