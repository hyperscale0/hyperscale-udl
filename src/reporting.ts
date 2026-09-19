import * as z from "zod";

const name = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]*$/)
  .max(80);
const path = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*$/)
  .max(240);
const integer = z.number().int().safe();
export const reportTypeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("money"),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  z.strictObject({ kind: z.enum(["text", "integer", "boolean", "date"]) }),
]);
export type ReportType = z.infer<typeof reportTypeSchema>;
const literal = z.union([z.string().max(2048), integer, z.boolean()]);
/** Ordered expressions form a finite typed graph. References only point backwards. */
export const reportExpressionSchema = z.discriminatedUnion("op", [
  z.strictObject({ id: name, op: z.literal("field"), path }),
  z.strictObject({
    id: name,
    op: z.literal("literal"),
    type: reportTypeSchema,
    value: literal,
  }),
  z.strictObject({
    id: name,
    op: z.literal("parameter"),
    name: z.enum(["periodStart", "periodEnd", "observationAt"]),
  }),
  z.strictObject({
    id: name,
    op: z.enum([
      "sum",
      "subtract",
      "minimum",
      "maximum",
      "equal",
      "less",
      "atMost",
      "and",
      "or",
      "daysBetween",
    ]),
    left: name,
    right: name,
  }),
  z.strictObject({ id: name, op: z.literal("not"), value: name }),
  z.strictObject({
    id: name,
    op: z.literal("choose"),
    condition: name,
    yes: name,
    no: name,
  }),
  z.strictObject({
    id: name,
    op: z.literal("bucket"),
    value: name,
    unit: z.enum(["month", "quarter"]),
  }),
  z.strictObject({
    id: name,
    op: z.literal("ratio"),
    numerator: name,
    denominator: name,
    scale: integer.min(1).max(1000000),
    rounding: z.enum(["floor", "halfUp"]),
    zero: z.enum(["refuse", "null"]),
  }),
]);
const column = z.strictObject({
  name,
  field: path,
  type: reportTypeSchema,
  required: z.boolean(),
});
const aggregate = z.strictObject({
  name,
  op: z.enum(["sum", "average", "count", "minimum", "maximum"]),
  rounding: z.enum(["floor", "halfUp"]).optional(),
  value: name.optional(),
});
export const reportDefinitionSchema = z.strictObject({
  identity: z.strictObject({
    id: name,
    version: integer.positive(),
    description: z.string().min(1).max(2048),
  }),
  scope: z.strictObject({
    kind: z.enum(["product", "company"]),
    classification: z.enum(["internal", "personal", "restricted"]),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  datasets: z
    .array(
      z.strictObject({
        id: name,
        source: z.enum(["instrument", "account", "identity", "operation"]),
        instruments: z
          .array(name.meta({ "x-udl-reference": "instrument" }))
          .max(32),
        rowKey: name,
        columns: z.array(column).min(1).max(64),
        expressions: z.array(reportExpressionSchema).max(128),
        selection: name.optional(),
      }),
    )
    .min(1)
    .max(16),
  time: z.strictObject({
    timezone: z.literal("Asia/Riyadh"),
    boundary: z.literal("startInclusiveEndExclusive"),
    observation: z.literal("periodEnd"),
    history: z.literal("retainedOnly"),
  }),
  selection: z.strictObject({ dataset: name, predicate: name.optional() }),
  calculation: z.strictObject({
    joins: z
      .array(
        z.strictObject({
          dataset: name,
          local: name,
          foreign: name,
          cardinality: z.enum(["one", "many"]),
          missing: z.enum(["refuse", "allow"]),
          aggregates: z.array(aggregate).max(32),
        }),
      )
      .max(16),
    expressions: z.array(reportExpressionSchema).max(128),
    groupBy: z.array(name).max(8),
    aggregates: z.array(aggregate).max(64),
    resultExpressions: z.array(reportExpressionSchema).max(64),
  }),
  validation: z.strictObject({
    empty: z.enum(["refuse", "noEligibleFacilities"]),
    required: z.array(name).max(64),
    rowReconcile: z.array(z.strictObject({ left: name, right: name })).max(16),
    reconcile: z.array(z.strictObject({ left: name, right: name })).max(16),
    unavailableFacts: z.array(z.string().min(1).max(240)).max(32),
    lockTimeoutMs: integer.min(1).max(2000),
    captureTimeoutMs: integer.min(1).max(10000),
    maxRows: integer.min(1).max(100000),
    maxJoinRows: integer.min(1).max(1000000),
    maxBytes: integer.min(1024).max(16777216),
  }),
  output: z.strictObject({
    profile: z.literal("internal.v1"),
    formats: z
      .array(z.enum(["json", "csv"]))
      .min(1)
      .max(2),
    columns: z
      .array(
        z.strictObject({
          name,
          label: z.string().min(1).max(120),
          type: reportTypeSchema,
        }),
      )
      .min(1)
      .max(64),
    sort: z.array(name).min(1).max(8),
  }),
  authority: z.strictObject({
    request: z.array(name).min(1).max(64),
    read: z.array(name).min(1).max(64),
    release: z.array(name).max(64),
    independentApproval: z.literal(true),
    retention: z.strictObject({ policy: name, years: integer.min(1).max(100) }),
  }),
});
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export type ReportExpression = z.infer<typeof reportExpressionSchema>;
