import * as z from "zod";
import {
  udlActionSchema,
  udlCalculationSchema,
  udlFieldSchema,
  udlInstrumentSchema,
  udlObjectKindSchema,
  udlObjectAttachmentSchema,
  udlPartySchema,
  udlRequirementSchema,
  udlValueSchema,
  udlKernelOperationSchema,
  subjectPartyRoles,
} from "./schema.js";

const text = z.string();
export const cardinalitySchema = z.strictObject({
  min: z.number().int().nonnegative(),
  // null means the declarations supply no upper bound.
  max: z.number().int().nonnegative().nullable(),
});
export const semanticOwnerSchema = z.union([
  z.strictObject({ kind: z.literal("instrument"), instrument: text }),
  z.strictObject({ kind: z.literal("role"), role: z.enum(subjectPartyRoles) }),
  z.strictObject({ kind: z.literal("party"), party: text }),
  z.strictObject({ kind: z.literal("adapter"), adapter: text }),
]);
export const semanticAccountSchema = z.strictObject({
  path: text,
  scope: text,
  instrument: text,
  field: text,
  owner: semanticOwnerSchema,
  book: z.enum(["cash", "claim"]),
  key: text.optional(),
  contra: z.boolean(),
});
export const semanticRoleSchema = z.union([
  semanticOwnerSchema,
  z.strictObject({ kind: z.enum(["caller", "clock"]) }),
  z.strictObject({ kind: z.literal("parent"), instruments: z.array(text) }),
]);
export const semanticRelationshipSchema = z.strictObject({
  kind: z.enum(["reference", "child"]),
  via: z.enum(["field", "attachment", "invocation", "parent_actor"]),
  name: text,
  targetKind: z.enum(["instrument", "object"]),
  targets: z.array(text),
  cardinality: cardinalitySchema,
});
export const semanticMoneyEffectSchema = z.strictObject({
  key: text,
  operation: udlKernelOperationSchema,
  amount: udlValueSchema.nullable(),
  from: z.array(semanticAccountSchema),
  to: z.array(semanticAccountSchema),
  // Expressions describe declared effects, never a receipt or evaluated quote.
  disposition: z.enum(["held", "paid", "released", "claim", "unresolved"]),
  transfer: text.nullable(),
  reservations: z.array(
    z.strictObject({ instrument: text, action: text, key: text }),
  ),
});
export const semanticActionSchema = z.strictObject({
  name: text,
  alias: text.nullable(),
  title: text,
  actor: udlActionSchema.shape.actor,
  roles: z.array(semanticRoleSchema),
  from: z.array(text),
  to: text.nullable(),
  references: z.array(udlFieldSchema).optional(),
  invokedBy: z
    .array(
      z.strictObject({
        instrument: text,
        action: text,
        alias: text.nullable(),
        invocation: udlActionSchema.shape.invoke.unwrap().element,
      }),
    )
    .optional(),
  inputs: udlActionSchema.shape.input,
  subject: udlActionSchema.shape.subject,
  prerequisites: udlActionSchema.shape.requires,
  due: udlActionSchema.shape.due.unwrap().nullable(),
  deadline: udlActionSchema.shape.deadline.unwrap().nullable(),
  calculations: z.array(udlCalculationSchema),
  assignments: udlActionSchema.shape.set.unwrap(),
  moves: udlActionSchema.shape.moves,
  moneyEffects: z.array(semanticMoneyEffectSchema),
  invokes: udlActionSchema.shape.invoke.unwrap(),
});
export const semanticStructureSchema = z.enum([
  "stage_and_decisions",
  "payment_review",
  "held_funds",
  "reserved_payment",
  "payment_calendar",
  "funding_progress",
  "cancellation_review",
  "external_checks",
  "report_view",
]);
export const semanticInstrumentSchema = z.strictObject({
  id: text,
  title: text,
  subject: text.optional(),
  fields: z.array(udlFieldSchema),
  accounts: z.array(semanticAccountSchema),
  relationships: z.array(semanticRelationshipSchema),
  calculations: z.array(udlCalculationSchema),
  invariants: z.array(udlRequirementSchema),
  initialState: text,
  lifecycle: z.strictObject({
    initial: text,
    states: z.array(
      z.strictObject({ name: text, label: text, terminal: z.boolean() }),
    ),
    cancellationActions: z.array(text),
  }),
  actions: z.array(semanticActionSchema),
  reports: udlInstrumentSchema.shape.reports.unwrap(),
  structures: z.array(semanticStructureSchema),
});
export const documentSemanticsSchema = z.strictObject({
  currency: text,
  parties: z.record(text, udlPartySchema),
  objects: z.array(
    z.strictObject({
      ...udlObjectKindSchema.shape,
      attachments: z.array(
        z.strictObject({
          ...udlObjectAttachmentSchema.shape,
          cardinality: cardinalitySchema,
        }),
      ),
    }),
  ),
  instruments: z.array(semanticInstrumentSchema),
});
export type DocumentSemantics = z.infer<typeof documentSemanticsSchema>;
export type SemanticInstrument = z.infer<typeof semanticInstrumentSchema>;
export type SemanticAction = z.infer<typeof semanticActionSchema>;
export type SemanticAccount = z.infer<typeof semanticAccountSchema>;
export type SemanticOwner = z.infer<typeof semanticOwnerSchema>;
export type SemanticRelationship = z.infer<typeof semanticRelationshipSchema>;
export type SemanticMoneyEffect = z.infer<typeof semanticMoneyEffectSchema>;
