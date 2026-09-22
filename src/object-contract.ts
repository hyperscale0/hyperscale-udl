import * as z from "zod";
import { udlFieldValueSchema } from "./field-value.js";
import {
  projectDocumentSemantics,
  presentationLabel,
} from "./object-semantics.js";
import type { DocumentSemantics } from "./object-semantics-schema.js";
export * from "./object-semantics-schema.js";
export {
  projectDocumentSemantics,
  presentationLabel,
} from "./object-semantics.js";
import {
  udlExternalIdSchema,
  type UdlDocument,
  type UdlObjectField,
  type UdlObjectKind,
  type UdlSubjectRequirement,
  type UdlValue,
  type UdlInstrument,
} from "./schema.js";

export const requestAttributionSchema = z.union([
  z.strictObject({
    kind: z.literal("human"),
    principalId: z.string().min(1),
    humanId: z.string().min(1),
    source: z.enum(["staff_session", "customer_session"]),
  }),
  z.strictObject({
    kind: z.literal("machine"),
    principalId: z.string().min(1),
    source: z.enum(["api_key", "system"]),
  }),
  z.strictObject({
    kind: z.literal("machine"),
    principalId: z.string().min(1),
    humanId: z.string().min(1),
    source: z.literal("api_key_delegate"),
  }),
]);
export type RequestAttribution = z.infer<typeof requestAttributionSchema>;

export type JsonSchemaDocument = z.core.JSONSchema.BaseSchema;

export interface ObjectKindDiscovery {
  productBuildId: string;
  digest: string;
  creation: true;
  kind: string;
  title: string;
  fields: readonly UdlObjectField[];
  authoredFields: readonly string[];
  columns: readonly string[];
  filters: readonly {
    field: string;
    type: "text" | "enum" | "date" | "boolean" | "integer";
  }[];
  createSchema: JsonSchemaDocument;
  actions: readonly ObjectActionDiscovery[];
}
export function objectKindFilters(
  kind: UdlObjectKind,
): ObjectKindDiscovery["filters"] {
  return kind.columns.flatMap((column) => {
    const field = kind.fields.find((item) => item.name === column);
    return field &&
      !field.sensitive &&
      ["text", "enum", "date", "boolean", "integer"].includes(field.type)
      ? [
          {
            field: column,
            type: field.type as ObjectKindDiscovery["filters"][number]["type"],
          },
        ]
      : [];
  });
}
export type ObjectActionTarget =
  | { kind: "attachment"; attachment: string }
  | { kind: "instance"; attachment: string; instanceId: string };
export interface ObjectActionContext {
  productBuildId: string;
  digest: string;
  target: ObjectActionTarget;
}
export interface ObjectActionDiscovery extends ObjectActionContext {
  summary: string;
  name: string;
  title: string;
  instrument: string;
  action: string;
  requirements: readonly UdlObjectField[];
  requirementConditions?: Record<
    string,
    NonNullable<UdlSubjectRequirement["when"]>
  >;
  creationRequirements?: readonly UdlObjectField[];
  creationOnlyNames?: readonly string[];
  inputSchema: JsonSchemaDocument;
  fieldsSchema: JsonSchemaDocument;
  availability: ObjectActionAvailability;
}
export type ObjectActionBlockerCode =
  | "permission_required"
  | "state_changed"
  | "not_due"
  | "deadline_passed"
  | "clock_pending"
  | "condition_not_met"
  | "already_used"
  | "evidence_required"
  | "account_unavailable"
  | "insufficient_money"
  | "setup_required"
  | "invalid_input"
  | "operation_pending";
export type ObjectActionAvailability =
  | { status: "available" }
  | {
      status: "requires_input";
      subjectFields: readonly string[];
      actionInputs: readonly string[];
      parties: readonly string[];
      reason: string;
    }
  | {
      status: "unavailable";
      blockers: readonly {
        code: ObjectActionBlockerCode;
        reason: string;
        recheckAt?: string;
      }[];
    }
  | { status: "unknown"; reason: string };

export type EvidenceState =
  | "missing"
  | "pending"
  | "satisfied"
  | "refused"
  | "stale";

export interface ObjectEvidenceSummary {
  requirementId: string;
  subjectId: string;
  protectedInputDigest: string;
  adapter: string;
  declarationDigest: string;
  productBuildId: string;
  state: EvidenceState;
  reference?: string;
  observedAt?: string;
  reasonCode?: string;
}

export interface ObjectActionState extends ObjectActionDiscovery {
  requiredNow: readonly string[];
  evidence?: readonly ObjectEvidenceSummary[];
}
/** GET /v1/products/{productId}/objects. Core supplies the frozen Build identity. */
export type RetainedObjectKind = Pick<
  ObjectKindDiscovery,
  "kind" | "title" | "fields" | "authoredFields" | "columns" | "filters"
> & {
  productBuildId: string;
  digest: string;
  creation: false;
};
export interface ObjectDiscovery {
  semantics: DocumentSemantics;
  navigation: readonly { kind: string; title: string; creation: boolean }[];
  retainedKinds: readonly RetainedObjectKind[];
  productBuildId: string;
  digest: string;
  kinds: readonly ObjectKindDiscovery[];
}
export interface ObjectActionsResponse {
  objectId: string;
  revision: number;
  actions: readonly ObjectActionState[];
  evidence: readonly ObjectEvidenceSummary[];
  nextCursor?: string;
}
export interface ObjectInstance {
  objectId: string;
  kind: string;
  revision: number;
  externalId?: string;
  fields: Record<string, unknown>;
  productBuildId: string;
}
export interface ObjectListResponse {
  items: ObjectInstance[];
  nextCursor?: string;
  total: number;
  facets: Record<string, Record<string, number>>;
}
export interface ObjectActionResponse {
  object: ObjectInstance;
  outcome: { instrument: string; instanceId: string; state: string } | null;
  evidence: readonly ObjectEvidenceSummary[];
}

/** Creation accepts the full metadata union, with every value optional. */
export function objectCreateSchema(kind: UdlObjectKind): z.ZodObject {
  return z.strictObject({
    externalId: udlExternalIdSchema.optional(),
    fields: z
      .strictObject(
        Object.fromEntries(
          kind.fields.map((field) => [
            field.name,
            udlFieldValueSchema(field).optional(),
          ]),
        ),
      )
      .optional(),
  });
}

/** Canonical UDL supplies meaning; core adds authority, instance state and readiness. */
export function projectObjectDiscovery(
  document: UdlDocument,
  build: Pick<ObjectDiscovery, "productBuildId" | "digest">,
): ObjectDiscovery {
  const semantics = projectDocumentSemantics(document);
  return {
    ...build,
    semantics,
    navigation: document.objects.map((kind) => ({
      kind: kind.id,
      title: kind.title,
      creation: true,
    })),
    retainedKinds: [],
    kinds: semantics.objects.map((kind) => ({
      ...build,
      creation: true,
      kind: kind.id,
      title: kind.title,
      fields: kind.fields,
      authoredFields: kind.authoredFields,
      columns: kind.columns,
      filters: objectKindFilters(kind),
      createSchema: z.toJSONSchema(objectCreateSchema(kind), { io: "input" }),
      actions: document.instruments
        .filter((instrument) => instrument.subject === kind.id)
        .flatMap((instrument) => {
          const createHidden =
            !!instrument.actions.create &&
            !instrument.actions.create.publicAction;
          const attachmentRefListFields = instrument.fields.filter(
            (field) =>
              field.type === "list" &&
              field.item === "ref" &&
              field.targetKind !== "object",
          );
          return instrument.actionOrder.flatMap((name) => {
            const action = instrument.actions[name]!;
            if (!action.publicAction) return [];
            const transition = instrument.lifecycle.transitions[name];
            const canStartFromInitial = Boolean(
              transition?.from.includes(instrument.lifecycle.initial),
            );
            const isCreationAction =
              name === "create" || (createHidden && canStartFromInitial);

            const rawCreateReqs: UdlSubjectRequirement[] = isCreationAction
              ? [
                  ...(instrument.actions.create?.subject?.requirements ?? []),
                  ...attachmentRefListFields.map((field) => ({
                    field: field as UdlObjectField,
                  })),
                ]
              : [];
            const actionReqs = action.subject?.requirements ?? [];
            const actionReqNames = new Set(
              actionReqs.map((r) => r.objectField ?? r.field.name),
            );
            const mergedReqs: UdlSubjectRequirement[] = actionReqs.map(
              (requirement) => ({ ...requirement }),
            );
            for (const req of rawCreateReqs) {
              const reqName = req.objectField ?? req.field.name;
              const existing = mergedReqs.find(
                (r) => (r.objectField ?? r.field.name) === reqName,
              );
              if (!existing) mergedReqs.push({ ...req });
              else if (!req.when) delete existing.when;
              else if (existing.when)
                existing.when = [...existing.when, ...req.when];
            }
            const requirementConditions = Object.fromEntries(
              mergedReqs.flatMap((req) =>
                req.when ? [[req.objectField ?? req.field.name, req.when]] : [],
              ),
            );
            const unbound = [
              ...(action.subject?.adapters ?? []),
              ...(isCreationAction
                ? (instrument.actions.create?.subject?.adapters ?? [])
                : []),
            ].find((adapter) => adapter.snapshot === null);
            const seenCreation = new Set<string>();
            const creationRequirements: UdlObjectField[] = [];
            for (const requirement of rawCreateReqs) {
              const name = requirement.objectField ?? requirement.field.name;
              if (!seenCreation.has(name)) {
                seenCreation.add(name);
                creationRequirements.push({
                  ...requirement.field,
                  name,
                } as UdlObjectField);
              }
            }
            const creationOnlyNames = creationRequirements
              .map((field) => field.name)
              .filter((name) => !actionReqNames.has(name));
            return [
              {
                ...build,
                target: {
                  kind: "attachment" as const,
                  attachment: kind.attachments.find(
                    (attachment) => attachment.instrument === instrument.id,
                  )!.name,
                },
                name: action.publicAction,
                title: action.title ?? presentationLabel(action.publicAction),
                summary: action.summary,
                instrument: instrument.id,
                action: name,
                requirements: mergedReqs.map(
                  (requirement) =>
                    ({
                      ...requirement.field,
                      name: requirement.objectField ?? requirement.field.name,
                    }) as UdlObjectField,
                ),
                ...(Object.keys(requirementConditions).length
                  ? { requirementConditions }
                  : {}),
                ...(creationRequirements.length > 0
                  ? { creationRequirements }
                  : {}),
                ...(creationRequirements.length > 0
                  ? { creationOnlyNames }
                  : {}),
                fieldsSchema: z.toJSONSchema(
                  z.strictObject(
                    Object.fromEntries(
                      mergedReqs.map((requirement) => [
                        requirement.objectField ?? requirement.field.name,
                        udlFieldValueSchema(requirement.field).optional(),
                      ]),
                    ),
                  ),
                  { io: "input" },
                ),
                inputSchema: z.toJSONSchema(
                  z.strictObject(
                    Object.fromEntries(
                      action.input.map((field) => [
                        field.name,
                        field.optional
                          ? udlFieldValueSchema(field).optional()
                          : udlFieldValueSchema(field),
                      ]),
                    ),
                  ),
                  { io: "input" },
                ),
                availability: unbound
                  ? {
                      status: "unavailable" as const,
                      blockers: [
                        {
                          code: "setup_required" as const,
                          reason:
                            "A required external check has not been set up.",
                        },
                      ],
                    }
                  : { status: "available" as const },
              },
            ];
          });
        }),
    })),
  };
}

/** Values overwritten before invocation cannot decide a guard during discovery. */
export function objectActionSelf(
  instrument: UdlInstrument,
  actionName: string,
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const action = instrument.actions[actionName]!;
  const known = {
    ...Object.fromEntries(
      instrument.fields.flatMap((field) =>
        "value" in field ? [[field.name, field.value]] : [],
      ),
    ),
    ...fields,
  };
  for (const calculation of [
    ...instrument.calculate,
    ...(action.calculate ?? []),
  ])
    delete known[calculation.target];
  for (const name of Object.keys(action.set ?? {})) delete known[name];
  return known;
}

export interface ObjectActionStateOptions {
  attached?: boolean;
  self?: Readonly<Record<string, unknown>>;
  input?: Readonly<Record<string, unknown>>;
}

/** Unknown invocation state remains possible; a known false guard suppresses a prompt. */
function requirementPossible(
  paths: NonNullable<UdlSubjectRequirement["when"]>,
  action: ObjectActionDiscovery,
  fields: Readonly<Record<string, unknown>>,
  options: ObjectActionStateOptions,
): boolean {
  return paths.some((path) =>
    path.every((condition) => {
      const read = (value: UdlValue): unknown => {
        if ("literal" in value) return value.literal;
        const [root, name, ...tail] = value.field.split(".");
        if (!name || tail.length) return undefined;
        if (root === "subject") return fields[name];
        if (
          condition.instrument !== action.instrument ||
          condition.action !== action.action
        )
          return undefined;
        if (root === "self") return options.self?.[name];
        if (root === "input") return options.input?.[name];
        return undefined;
      };
      let left = read(condition.guard.left);
      let right = read(condition.guard.right);
      if (left === undefined || right === undefined) return true;
      try {
        if (condition.valueType === "money") {
          left = BigInt(String(left));
          right = BigInt(String(right));
        } else if (condition.valueType === "date") {
          left = Date.parse(String(left));
          right = Date.parse(String(right));
          if (!Number.isFinite(left) || !Number.isFinite(right)) return true;
        }
      } catch {
        return true;
      }
      if (
        typeof left !== typeof right ||
        !["string", "number", "boolean", "bigint"].includes(typeof left)
      )
        return true;
      const a = left as string | number | bigint;
      const b = right as string | number | bigint;
      switch (condition.guard.operator) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
      }
    }),
  );
}

/** Object-specific values determine missing fields; global discovery cannot. */
export function objectActionState(
  action: ObjectActionDiscovery,
  fields: Readonly<Record<string, unknown>>,
  options?: ObjectActionStateOptions | boolean,
): ObjectActionState {
  const attached =
    typeof options === "boolean" ? options : (options?.attached ?? false);
  const creationFilter = new Set(action.creationOnlyNames ?? []);
  return {
    ...action,
    requiredNow: action.requirements
      .filter((field) => {
        const conditions =
          action.requirementConditions &&
          Object.hasOwn(action.requirementConditions, field.name)
            ? action.requirementConditions[field.name]
            : undefined;
        if (
          conditions &&
          !requirementPossible(
            conditions,
            action,
            fields,
            typeof options === "object" ? options : {},
          )
        )
          return false;
        const value = fields[field.name];
        const optional =
          field.optional || (attached && creationFilter.has(field.name));
        return (
          !(optional && value === undefined) &&
          !udlFieldValueSchema(field).safeParse(value).success
        );
      })
      .map((field) => field.name),
  };
}
export interface SubjectRequirementIssue {
  code:
    | "subject_requirement_missing"
    | "subject_field_unknown"
    | "subject_adapter_unbound";
  action: string;
  field?: string;
  origin: string;
  message: string;
}

/** Check merged metadata before dispatch. Runtime guards add their active child requirements. */
export function validateObjectActionSubject(
  action: ObjectActionDiscovery,
  storedFields: Readonly<Record<string, unknown>>,
  submittedFields: Readonly<Record<string, unknown>>,
  options?: ObjectActionStateOptions | boolean,
): readonly SubjectRequirementIssue[] {
  const origin = `${action.instrument}.${action.action}.subject`;
  const issues: SubjectRequirementIssue[] = [];
  if (
    action.availability.status === "unavailable" &&
    action.availability.blockers.some(
      (blocker) => blocker.code === "setup_required",
    )
  ) {
    issues.push({
      code: "subject_adapter_unbound",
      action: action.name,
      origin,
      message: "A required external check has not been set up.",
    });
  }
  const admitted = new Set(action.requirements.map((field) => field.name));
  for (const field of Object.keys(submittedFields)) {
    if (!admitted.has(field))
      issues.push({
        code: "subject_field_unknown",
        action: action.name,
        field,
        origin,
        message: `${field} is not admitted by ${action.name}`,
      });
  }
  for (const field of objectActionState(
    action,
    {
      ...storedFields,
      ...submittedFields,
    },
    options,
  ).requiredNow) {
    issues.push({
      code: "subject_requirement_missing",
      action: action.name,
      field,
      origin: `${origin}.${field}`,
      message: `${action.name} requires a valid ${field}`,
    });
  }
  return issues;
}
