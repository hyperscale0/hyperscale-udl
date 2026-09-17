import * as z from "zod";

export const UDL_FORMAT_VERSION = 3 as const;
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

/** Currency belongs to the document. Accounts and amounts cannot override it. */
export const udlPartySchema = z.strictObject({
  kind: z.enum(["person", "business", "staff"]),
  role: name.optional(),
});

const fieldBase = {
  name,
  optional: z.literal(true).optional(),
  description: text.optional(),
};
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
    external: z.literal(true).optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("ref"),
    target: z.union([instrumentId, z.array(instrumentId).min(1).max(16)]),
  }),
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
    maxLength: integer.positive().max(2048).optional(),
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
  z.strictObject({
    ...fieldBase,
    type: z.literal("list"),
    item: z.enum(["money", "date", "text", "integer", "ref"]),
    target: instrumentId.optional(),
    maxItems: integer.min(1).max(366),
  }),
]);

/** Values are constants or resolved typed paths, never executable strings. */
export const udlValueSchema = z.union([
  z.strictObject({ literal: scalar }),
  z.strictObject({ field: path }),
]);
const value = udlValueSchema;
const values = z.array(value).min(1).max(256);

const selection = z.strictObject({
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
  z.strictObject({
    kind: z.literal("compare"),
    left: value,
    operator: z.enum(["==", "!=", "<", "<=", ">", ">="]),
    right: value,
  }),
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
    kind: z.literal("approval"),
    target: path.default("self"),
    party: name,
    action: name.optional(),
    decision: z.enum(["approved", "declined"]),
  }),
  z.strictObject({
    kind: z.literal("evidence"),
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
const clock = z.strictObject({ at: path, offset: integer.optional() });
export const udlActionSchema = z.strictObject({
  summary: text,
  publicAction: name.optional(),
  event: text,
  actor: z.union([
    z.literal("caller"),
    z.literal("clock"),
    z.strictObject({ party: name }),
    z.strictObject({ parent: instrumentId }),
  ]),
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
        }),
        z.strictObject({
          reference: path,
          action: name,
          input: z.record(name, value),
        }),
        z.strictObject({
          selection,
          action: name,
          input: z.record(name, value),
        }),
      ]),
    )
    .max(16)
    .optional(),
  approval: z
    .strictObject({
      target: path,
      action: name,
      party: name,
      expires: path,
      input: z.record(name, value),
      decision: z.enum(["approved", "declined"]),
    })
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
  id: instrumentId,
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
  instruments: z.array(udlInstrumentSchema).min(1).max(256),
});

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
