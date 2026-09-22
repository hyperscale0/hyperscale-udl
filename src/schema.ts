import * as z from "zod";
import { reportDefinitionSchema } from "./reporting.js";

export const UDL_FORMAT_VERSION = 4 as const;
/** Counts the root and every nested invocation, including selected and ranged children. */
export const MAX_ACTION_EXPANSION = 4096;
const name = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]*$/)
  .max(80);
const text = z.string().min(1).max(2048);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const integer = z.number().int().safe();
const scalar = z.union([z.string(), integer, z.boolean()]);
const path = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*$/)
  .max(240);
const instrumentId = name.meta({ "x-udl-reference": "instrument" });
const objectKindId = name.meta({ "x-udl-reference": "object" });

export const udlPartyNameSchema = name;

export const udlObjectIdSchema = z.string().min(1).max(160);
export const udlExternalIdSchema = z.string().min(1).max(2048);
export const udlObjectRevisionSchema = integer.positive();

/** Currency belongs to the document. Accounts and amounts cannot override it. */
export const udlPartySchema = z.strictObject({
  kind: z.enum(["person", "business", "staff"]),
  role: name.optional(),
});

export const udlFamilySchema = z.strictObject({
  module: name,
  exportPath: path,
  revision: integer.positive(),
});

const fieldBase = {
  name,
  optional: z.literal(true).optional(),
  description: text.optional(),
  sensitive: z.literal(true).optional(),
};

const referenceField = z.strictObject({
  ...fieldBase,
  type: z.literal("ref"),
  targetKind: z.enum(["instrument", "object"]),
  targetFamily: udlFamilySchema.optional(),
  target: z.union([name, z.array(name).min(1).max(16)]),
});

const listField = z.strictObject({
  ...fieldBase,
  type: z.literal("list"),
  item: z.enum(["money", "date", "text", "integer", "ref"]),
  targetKind: z.enum(["instrument", "object"]).optional(),
  targetFamily: udlFamilySchema.optional(),
  target: name.optional(),
  maxItems: integer.min(1).max(366),
});

export const udlFieldSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...fieldBase,
    type: z.literal("money"),
    value: amount.optional(),
    minimum: amount.optional(),
    maximum: amount.optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("account"),
    owner: name,
    key: name.optional(),
    book: z.enum(["cash", "claim"]).default("cash"),
    contra: z.literal(true).optional(),
  }),
  referenceField,
  z.strictObject({
    ...fieldBase,
    type: z.literal("date"),
    value: z.iso.datetime({ offset: true }).optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("duration"),
    value: integer.positive().optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("text"),
    value: text.optional(),
    minLength: integer.positive().max(2048).optional(),
    maxLength: integer.positive().max(2048).optional(),
    // One anchored ASCII character class and a fixed repetition. No executable patterns.
    pattern: z
      .string()
      .regex(/^\^\[[A-Za-z0-9-]+\]\{[1-9][0-9]{0,3}\}\$$/)
      .optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("integer"),
    value: integer.optional(),
    minimum: integer.optional(),
    maximum: integer.optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("percent"),
    value: integer.min(0).max(10000).optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("boolean"),
    value: z.boolean().optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("enum"),
    values: z.array(name).min(1).max(64),
    value: name.optional(),
  }),
  listField,
]);

const [
  moneyField,
  ,
  refField,
  dateField,
  durationField,
  textField,
  integerField,
  percentField,
  booleanField,
  enumField,
  boundedListField,
] = udlFieldSchema.options;

export const udlObjectFieldSchema = z.discriminatedUnion("type", [
  moneyField,
  refField,
  dateField,
  durationField,
  textField,
  integerField,
  percentField,
  booleanField,
  enumField,
  boundedListField,
]);

/** Values are constants or resolved typed paths, never executable strings. */
export const udlValueSchema = z.union([
  z.strictObject({ literal: scalar }),
  z.strictObject({ field: path }),
]);
const value = udlValueSchema;

const comparisonRequirement = z.strictObject({
  kind: z.literal("compare"),
  left: value,
  operator: z.enum(["==", "!=", "<", "<=", ">", ">="]),
  right: value,
});

// Alternatives are OR; each invocation path is a conjunction of scoped guards.
export const udlSubjectConditionsSchema = z
  .array(
    z
      .array(
        z.strictObject({
          instrument: instrumentId,
          action: name,
          guard: comparisonRequirement,
          valueType: z.enum(["money", "date"]).optional(),
        }),
      )
      .min(1)
      .max(32),
  )
  .min(1)
  .max(128);

export const udlSubjectRequirementSchema = z.strictObject({
  field: udlObjectFieldSchema,
  // Present only for an authored rename.
  objectField: name.optional(),
  when: udlSubjectConditionsSchema.optional(),
});

export const adapterSubjectSnapshotSchema = z.strictObject({
  provider: text,
  capability: text,
  operation: text,
  declarationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requirements: z.array(udlObjectFieldSchema).max(128),
});

export const udlActionSubjectSchema = z.strictObject({
  requirements: z.array(udlSubjectRequirementSchema).max(128),
  adapters: z
    .array(
      z.strictObject({
        binding: name,
        // null means unavailable, never "no requirements".
        snapshot: adapterSubjectSnapshotSchema.nullable(),
        renames: z.record(name, name).optional(),
      }),
    )
    .max(16),
});

export const subjectPartyRoles = ["owner", "actor", "operator"] as const;
export const attachmentPartyBindingSchema = z.union([
  z.strictObject({ role: z.enum(subjectPartyRoles) }),
  z.strictObject({ party: name }),
]);
export type AttachmentPartyBinding = z.infer<
  typeof attachmentPartyBindingSchema
>;
export const udlObjectAttachmentSchema = z.strictObject({
  name,
  parent: name.optional(),
  instrument: instrumentId,
  parties: z.record(name, attachmentPartyBindingSchema),
});
export type SubjectPartyRole = (typeof subjectPartyRoles)[number];
export type UdlObjectAttachment = z.infer<typeof udlObjectAttachmentSchema>;

export const udlObjectKindSchema = z.strictObject({
  id: objectKindId,
  title: text,
  authoredFields: z.array(name).max(256),
  attachments: z.array(udlObjectAttachmentSchema).max(256),
  fields: z.array(udlObjectFieldSchema).max(256),
  columns: z.array(name).max(8),
});

const values = z.array(value).min(1).max(256);

const selection = z.strictObject({
  family: udlFamilySchema.optional(),
  instrument: z.union([instrumentId, z.array(instrumentId).min(1).max(16)]),
  reference: name,
  anchor: path,
  states: z.array(name).min(1).max(64),
  limit: integer.min(1).max(366),
  order: z.array(path).min(1).max(4).optional(),
  window: z
    .strictObject({ field: name, milliseconds: integer.positive() })
    .optional(),
  where: z
    .record(path, value)
    .refine(
      (filters) => Object.keys(filters).length <= 8,
      "at most eight selection filters",
    )
    .meta({ maxProperties: 8 })
    .optional(),
});

/** A finite, ordered calculation graph. Every result is a declared field. */
export const udlCalculationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    target: name,
    op: z.literal("at"),
    list: path,
    position: value,
  }),
  z.strictObject({
    target: name,
    op: z.literal("aggregate"),
    selection,
    measure: z.union([z.literal("count"), z.strictObject({ sum: path })]),
  }),
  z.strictObject({
    target: name,
    op: z.literal("ratio"),
    amount: value,
    numerator: value,
    denominator: value,
    rounding: z.literal("floor"),
  }),
  z.strictObject({ target: name, op: z.literal("sum"), values }),
  z.strictObject({
    target: name,
    op: z.literal("subtract"),
    base: value,
    subtract: values,
  }),
  z.strictObject({
    target: name,
    op: z.literal("rate"),
    base: value,
    bps: value,
    rounding: z.literal("floor"),
  }),
  z.strictObject({ target: name, op: z.literal("minimum"), values }),
  z.strictObject({
    target: name,
    op: z.literal("multiply"),
    amount: value,
    units: value,
  }),
  z.strictObject({
    target: name,
    op: z.literal("divide"),
    amount: value,
    divisor: value,
    rounding: z.literal("floor"),
  }),
  z.strictObject({
    target: name,
    op: z.literal("shift"),
    date: value,
    milliseconds: value,
    direction: z.enum(["before", "after"]),
  }),
]);

export const udlRequirementSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("hours"),
    at: path,
    start: integer.min(0).max(23),
    end: integer.min(0).max(23),
    timezone: text,
  }),
  comparisonRequirement,
  z.strictObject({
    kind: z.literal("state"),
    reference: path,
    states: z.array(name).min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("unique"),
    namespace: name,
    fields: z.array(path).min(1).max(8),
  }),
  z.strictObject({
    kind: z.literal("aggregate"),
    selection,
    measure: z.union([z.literal("count"), z.strictObject({ sum: path })]),
    operator: z.enum(["==", "<=", ">=", "<", ">"]),
    value,
  }),
  z.strictObject({
    kind: z.literal("evidence"),
    instruction: path.optional(),
    subject: path,
    family: name,
    check: name,
    result: name,
    maxAge: integer.positive(),
  }),
]);

export const udlKernelOperationSchema = z.enum([
  "internal_transfer.create",
  "internal_transfer.reserve",
  "internal_transfer.post",
  "internal_transfer.void",
]);
export const udlMoveSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    key: name,
    operation: z.literal("internal_transfer.create"),
    capture: name.optional(),
    amount: value,
    from: path,
    to: path,
  }),
  z.strictObject({
    key: name,
    operation: z.literal("internal_transfer.reserve"),
    boundary: z.strictObject({ adapter: name }).optional(),
    amount: value,
    from: path,
    to: path,
    capture: name,
  }),
  z.strictObject({
    key: name,
    operation: z.literal("internal_transfer.post"),
    capture: name.optional(),
    transfer: path,
  }),
  z.strictObject({
    key: name,
    operation: z.literal("internal_transfer.void"),
    capture: name.optional(),
    transfer: path,
  }),
]);
const clock = z.strictObject({
  at: path,
  offset: integer.optional(),
  localDay: z
    .strictObject({
      days: integer.min(0).max(366),
      direction: z.enum(["before", "after"]),
      hour: integer.min(0).max(23),
      timezone: text,
    })
    .optional(),
});
export const udlActionSchema = z.strictObject({
  allowZero: z.literal(true).optional(),
  summary: text,
  publicAction: name.optional(),
  expansionLimit: z.literal(8192).optional(),
  reminder: z
    .strictObject({
      installment: path,
      recipient: path,
      dueAt: path,
      channel: z.literal("email"),
      template: z.literal("payment_reminder"),
      beforeDays: integer.min(0).max(366),
      overdueDays: integer.min(1).max(366),
      maxPerDay: integer.min(1).max(10),
      startHour: integer.min(0).max(23),
      endHour: integer.min(1).max(24),
      timezone: text,
    })
    .optional(),
  event: text,
  actor: z.union([
    z.literal("caller"),
    z.literal("clock"),
    z.strictObject({ party: name }),
    z.strictObject({
      parent: z.union([instrumentId, z.array(instrumentId).min(1).max(16)]),
    }),
  ]),
  subject: udlActionSubjectSchema.optional(),
  input: z.array(udlFieldSchema).max(128),
  requires: z.array(udlRequirementSchema).max(128),
  due: clock.optional(),
  deadline: clock.optional(),
  set: z.record(name, value).optional(),
  calculate: z.array(udlCalculationSchema).max(128).optional(),
  moves: z.array(udlMoveSchema).max(256),
  invoke: z
    .array(
      z.union([
        z.strictObject({
          instrument: instrumentId,
          action: z.literal("create"),
          input: z.record(name, value),
          guard: comparisonRequirement.optional(),
          range: z
            .strictObject({
              count: value,
              maximum: integer.min(1).max(366),
              bind: name,
            })
            .optional(),
        }),
        z.strictObject({
          reference: path,
          action: name,
          input: z.record(name, value),
          guard: comparisonRequirement.optional(),
        }),
        z.strictObject({
          selection,
          action: name,
          input: z.record(name, value),
          guard: comparisonRequirement.optional(),
        }),
      ]),
    )
    .max(16)
    .optional(),
});
export const udlLifecycleSchema = z.strictObject({
  states: z.array(name).min(1).max(64),
  initial: name,
  transitions: z.record(
    name,
    z.strictObject({ from: z.array(name).min(1).max(64), to: name }),
  ),
});
export const udlInstrumentSchema = z.strictObject({
  reports: z.array(reportDefinitionSchema).max(16).optional(),
  revisioned: z.literal(true).optional(),
  family: udlFamilySchema.optional(),
  id: instrumentId,
  subject: objectKindId.optional(),
  title: text,
  summary: text,
  fields: z.array(udlFieldSchema).max(256),
  calculate: z.array(udlCalculationSchema).max(128),
  lifecycle: udlLifecycleSchema,
  actions: z.record(name, udlActionSchema),
  actionOrder: z.array(name).min(1).max(128),
  invariants: z.array(udlRequirementSchema).max(128).optional(),
  examples: z
    .array(z.strictObject({ name: text, input: z.json() }))
    .max(16)
    .optional(),
});
export const udlDocumentSchema = z.strictObject({
  udl: z.literal(UDL_FORMAT_VERSION),
  version: integer.positive(),
  product: name,
  title: text,
  currency: z.literal("SAR"),
  parties: z.record(name, udlPartySchema),
  objects: z.array(udlObjectKindSchema).max(256),
  instruments: z.array(udlInstrumentSchema).max(256),
});

export type UdlFamily = z.infer<typeof udlFamilySchema>;
export type UdlDocument = z.infer<typeof udlDocumentSchema>;
export type UdlInstrument = z.infer<typeof udlInstrumentSchema>;
export type UdlField = z.infer<typeof udlFieldSchema>;
export type UdlParty = z.infer<typeof udlPartySchema>;
export type UdlValue = z.infer<typeof udlValueSchema>;
export type UdlCalculation = z.infer<typeof udlCalculationSchema>;
export type UdlRequirement = z.infer<typeof udlRequirementSchema>;
export type UdlAction = z.infer<typeof udlActionSchema>;
export type UdlMove = z.infer<typeof udlMoveSchema>;
export type UdlLifecycle = z.infer<typeof udlLifecycleSchema>;
export type UdlKernelOperation = z.infer<typeof udlKernelOperationSchema>;

export type UdlSelection = z.infer<typeof selection>;

export type UdlObjectField = z.infer<typeof udlObjectFieldSchema>;
export type UdlObjectKind = z.infer<typeof udlObjectKindSchema>;
export type UdlActionSubject = z.infer<typeof udlActionSubjectSchema>;
export type UdlSubjectRequirement = z.infer<typeof udlSubjectRequirementSchema>;
export type UdlAdapterSubjectSnapshot = z.infer<
  typeof adapterSubjectSnapshotSchema
>;

/** Names and display text may differ; executable constraints must match. */
export function sameObjectField(
  left: UdlObjectField,
  right: UdlObjectField,
): boolean {
  const signature = (field: UdlObjectField) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(field)
          .filter(
            ([key, value]) =>
              !["name", "description", "optional"].includes(key) &&
              value !== undefined,
          )
          .sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
      ),
    );
  return signature(left) === signature(right);
}
