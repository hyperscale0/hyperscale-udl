import {
  Validator,
  type OutputUnit,
  type Schema,
  type ValidationResult,
} from "@cfworker/json-schema";
import { z } from "zod";

import {
  udlClauseVocabulary,
  quoteExpiresAtRefKey,
  quoteFrozenRefKey,
  quoteSeededRefKeys,
  udlDocumentSchema,
  type UdlAggregate,
  type UdlDocument,
  type UdlGate,
  type UdlMove,
  type UdlInstrument,
  type UdlStep,
  type UdlAction,
} from "./schema.js";
import { fixedIsoDurationMs } from "./duration.js";
import {
  analyzeInstrumentFinance,
  financeAdmissionProblem,
} from "./finance.js";
import { UDL_LIMITS } from "./limits.js";
import { deriveUdlActionEffects, udlEffectKinds } from "./effects.js";
import { issue, type UdlIssue, type UdlIssueCode } from "./diagnostics.js";

export type {
  UdlIssue,
  UdlIssueCategory,
  UdlIssueCode,
} from "./diagnostics.js";

export type UdlValidationResult =
  | { readonly ok: true; readonly value: UdlDocument }
  | { readonly issues: readonly UdlIssue[]; readonly ok: false };

export class UdlError extends Error {
  readonly issues: readonly UdlIssue[];

  constructor(issues: readonly UdlIssue[]) {
    const first = issues[0];
    super(
      first
        ? `Invalid UDL at ${first.path}: ${first.message}`
        : "Invalid UDL document",
    );
    this.name = "UdlError";
    this.issues = Object.freeze([...issues]);
  }
}

export function validateUdl(value: unknown): UdlValidationResult {
  const resourceIssue = structuralBudgetIssue(value);
  if (resourceIssue) return { issues: [resourceIssue], ok: false };

  const reconcileShapeIssues = reconcileExceptionRequiredFieldIssues(value);
  if (reconcileShapeIssues.length > 0)
    return { issues: reconcileShapeIssues, ok: false };

  const parsed = udlDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((entry) =>
        issue(shapeIssueCode(entry.path), jsonPath(entry.path), entry.message),
      ),
      ok: false,
    };
  }

  const references = openReferenceShapeBudget();
  const issues = semanticIssues(parsed.data, references);
  if (references.exhausted) {
    return {
      issues: [
        issue(
          "UDL1004",
          "$.instruments",
          `document exceeds ${UDL_LIMITS.maxSchemaProbes} reference-shape checks; declare fewer instruments, reference gates, or payout intents`,
        ),
      ],
      ok: false,
    };
  }
  return issues.length === 0
    ? { ok: true, value: parsed.data }
    : { issues, ok: false };
}

function shapeIssueCode(path: readonly PropertyKey[]): UdlIssueCode {
  if (path.includes("requiresExposure")) return "UDL5003";
  if (path.includes("requiresAggregate")) return "UDL5004";
  return "UDL1003";
}

function reconcileExceptionRequiredFieldIssues(value: unknown): UdlIssue[] {
  const issues: UdlIssue[] = [];
  const instruments = recordValue(value).instruments;
  if (!Array.isArray(instruments)) return issues;
  instruments.forEach((instrument, instrumentIndex) => {
    const actions = recordValue(instrument).actions;
    if (!actions || typeof actions !== "object" || Array.isArray(actions))
      return;
    for (const [action, definition] of Object.entries(actions)) {
      const reconciles = recordValue(definition).reconcile;
      if (!Array.isArray(reconciles)) continue;
      reconciles.forEach((reconcile, reconcileIndex) => {
        const exception = recordValue(recordValue(reconcile).exception);
        const base = jsonPath([
          "instruments",
          instrumentIndex,
          "actions",
          action,
          "reconcile",
          reconcileIndex,
          "exception",
        ]);
        if (!("amountField" in exception)) {
          issues.push(issue("UDL5009", `${base}.amountField`));
        }
        if (!("reasonField" in exception)) {
          issues.push(issue("UDL5011", `${base}.reasonField`));
        }
      });
    }
  });
  return issues;
}

export function assertValidUdl(value: unknown): UdlDocument {
  const result = validateUdl(value);
  if (!result.ok) throw new UdlError(result.issues);
  return result.value;
}

/**
 * Applies the sealed UDL JSON Schema subset to one value. Both inputs pass the
 * same deterministic admission budgets as a complete UDL document before the
 * standard validator or sealed format validators run.
 */
export function validateUdlSchemaValue(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
): ValidationResult {
  const schemaAdmission = structuralBudgetIssue(schema);
  if (schemaAdmission)
    return admissionValidationResult(schemaAdmission, "invalid_schema");
  const valueAdmission = structuralBudgetIssue(value);
  if (valueAdmission)
    return admissionValidationResult(valueAdmission, "invalid_value");

  const schemaErrors: OutputUnit[] = [];
  validateJsonSchema(schema, [], (path, message) => {
    schemaErrors.push({
      error: message,
      instanceLocation: "",
      keyword: "invalid_schema",
      keywordLocation: jsonPath(path),
    });
  });
  if (schemaErrors.length > 0) {
    return { errors: schemaErrors, valid: false };
  }

  const boundedSchema = structuredClone(schema) as Schema;
  const validator = new Validator(boundedSchema, "2020-12", false);
  const standard = validator.validate(value);
  const sealedErrors = sealedFormatErrors(value, boundedSchema);
  const errors = [...standard.errors, ...sealedErrors];
  return { errors, valid: errors.length === 0 };
}

/**
 * Validates one schema document against the sealed UDL JSON Schema subset
 * without applying it to a value. Frozen tenant contracts use this at their
 * persistence boundary so an unreadable schema cannot become immutable state.
 */
export function validateUdlJsonSchema(schema: unknown): readonly UdlIssue[] {
  const admissionIssue = structuralBudgetIssue(schema);
  if (admissionIssue) return [admissionIssue];
  if (!isRecord(schema)) {
    return [issue("UDL1003", "$", "JSON Schema must be an object")];
  }

  const issues: UdlIssue[] = [];
  validateJsonSchema(schema, [], (path, message) => {
    issues.push(issue("UDL6001", jsonPath(path), message));
  });
  return issues;
}

function admissionValidationResult(
  issue: UdlIssue,
  invalidKeyword: string,
): ValidationResult {
  return {
    errors: [
      {
        error: issue.message,
        instanceLocation: issue.path,
        keyword:
          issue.category === "resource_limit"
            ? "resource_limit"
            : invalidKeyword,
        keywordLocation: "$",
      },
    ],
    valid: false,
  };
}

type AddIssue = (
  path: readonly PropertyKey[],
  message: string,
  code: UdlIssueCode,
) => void;

const positiveMoneyPattern = "^[1-9][0-9]{0,17}$";
const nonNegativeMoneyPattern = "^(0|[1-9][0-9]{0,17})$";
const currencyPattern = "^[A-Z]{3}$";
const sealedDateTimeFormat = "hyperscale-date-time";
const jsonSchemaFormats = new Set([
  "hyperscale-date",
  sealedDateTimeFormat,
  "hyperscale-email",
  "hyperscale-uri",
]);
const jsonSchemaTypes = new Set([
  "array",
  "boolean",
  "integer",
  "object",
  "string",
]);
const jsonSchemaKeywords = new Set([
  "additionalProperties",
  "const",
  "description",
  "enum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
  "x-hyperscale-fee-collection-port",
  "x-hyperscale-reference-filter",
]);

function semanticIssues(
  document: UdlDocument,
  references: ReferenceShapeBudget,
): UdlIssue[] {
  const issues: UdlIssue[] = [];
  const add: AddIssue = (path, message, code) => {
    issues.push(issue(code, jsonPath(path), message));
  };

  document.instruments.forEach((instrument, instrumentIndex) => {
    const problem = financeAdmissionProblem(instrument);
    if (problem)
      add(["instruments", instrumentIndex, "lifecycle"], problem, "UDL1004");
  });
  if (issues.length > 0) return issues;

  validateDocumentSchemas(document, add);
  if (issues.length > 0) return issues;

  addDuplicateIssues(
    document.subjects.map((subject) => subject.kind),
    ["subjects"],
    "subject kind",
    add,
  );
  addDuplicateIssues(
    document.instruments.map((instrument) => instrument.id),
    ["instruments"],
    "instrument id",
    add,
  );
  addDuplicateIssues(
    document.instruments.map((instrument) => instrument.idPrefix),
    ["instruments"],
    "instrument idPrefix",
    add,
  );

  validateCompositionDials(document, add);

  const subjects = new Map(
    document.subjects.map((subject) => [subject.kind, subject] as const),
  );
  const instruments = new Map(
    document.instruments.map(
      (instrument) => [instrument.id, instrument] as const,
    ),
  );

  for (const [subjectIndex, subject] of document.subjects.entries()) {
    if (subject.schema.type !== "object") {
      add(
        ["subjects", subjectIndex, "schema", "type"],
        "a subject attribute schema must declare type object",
        "UDL2002",
      );
    }
  }

  for (const [instrumentIndex, instrument] of document.instruments.entries()) {
    for (const [actionName, action] of Object.entries(instrument.actions)) {
      if (!action.effects) continue;
      const expected = deriveUdlActionEffects(action, udlClauseVocabulary);
      for (const kind of udlEffectKinds) {
        const actualRows = action.effects[kind] ?? [];
        const expectedRows = expected[kind] ?? [];
        if (
          actualRows.length === expectedRows.length &&
          actualRows.every((row, index) => {
            const expectedRow = expectedRows[index];
            return (
              expectedRow !== undefined &&
              row.signature === expectedRow.signature &&
              row.source === expectedRow.source &&
              ("channel" in row ? row.channel : undefined) ===
                expectedRow.channel &&
              ("role" in row ? row.role : undefined) === expectedRow.role
            );
          })
        ) {
          continue;
        }
        add(
          [
            "instruments",
            instrumentIndex,
            "actions",
            actionName,
            "effects",
            kind,
          ],
          `derived ${kind} effects do not match the action clauses`,
          "UDL2005",
        );
      }
    }
    validateInstrument(
      instrument,
      instrumentIndex,
      instruments,
      subjects,
      references,
      add,
    );
  }
  return issues;
}

function structuralBudgetIssue(value: unknown): UdlIssue | undefined {
  let discovered = 1;
  let nodes = 0;
  let totalStringLength = 0;
  const pending: {
    readonly ancestors: ReadonlySet<object>;
    readonly countNode: boolean;
    readonly depth: number;
    readonly path: readonly PropertyKey[];
    readonly value: unknown;
  }[] = [{ ancestors: new Set(), countNode: true, depth: 1, path: [], value }];

  while (pending.length > 0) {
    const entry = pending.pop() as (typeof pending)[number];
    if (entry.countNode) nodes += 1;
    if (nodes > UDL_LIMITS.maxNodes) {
      return resourceIssue(
        entry.path,
        `UDL contains more than ${UDL_LIMITS.maxNodes} values`,
      );
    }
    if (entry.depth > UDL_LIMITS.maxDepth) {
      return resourceIssue(
        entry.path,
        `UDL nesting exceeds ${UDL_LIMITS.maxDepth} levels`,
      );
    }
    if (typeof entry.value === "string") {
      if (entry.value.length > UDL_LIMITS.maxStringLength) {
        return resourceIssue(
          entry.path,
          `UDL string exceeds ${UDL_LIMITS.maxStringLength} characters`,
        );
      }
      totalStringLength += entry.value.length;
      if (totalStringLength > UDL_LIMITS.maxTotalStringLength) {
        return resourceIssue(
          entry.path,
          `UDL strings exceed ${UDL_LIMITS.maxTotalStringLength} total characters`,
        );
      }
      continue;
    }
    if (entry.value === null || typeof entry.value === "boolean") continue;
    if (typeof entry.value === "number") {
      if (Number.isFinite(entry.value)) continue;
      return jsonValueIssue(entry.path);
    }
    if (typeof entry.value !== "object") {
      return jsonValueIssue(entry.path);
    }
    if (entry.ancestors.has(entry.value)) {
      return resourceIssue(entry.path, "UDL must not contain object cycles");
    }
    const childAncestors = new Set(entry.ancestors);
    childAncestors.add(entry.value);
    if (Array.isArray(entry.value)) {
      if (
        entry.countNode &&
        entry.value.length > UDL_LIMITS.maxNodes - discovered
      ) {
        return resourceIssue(
          entry.path,
          `UDL contains more than ${UDL_LIMITS.maxNodes} values`,
        );
      }
      if (entry.countNode) discovered += entry.value.length;
      for (let index = entry.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          ancestors: childAncestors,
          countNode: entry.countNode,
          depth: entry.depth + 1,
          path: [...entry.path, index],
          value: entry.value[index],
        });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(entry.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return jsonValueIssue(entry.path);
    }
    let childCount = 0;
    for (const key in entry.value) {
      if (!Object.hasOwn(entry.value, key)) continue;
      if (countsAsAuthoredNode(entry, key)) childCount += 1;
      if (childCount > UDL_LIMITS.maxNodes - discovered) {
        return resourceIssue(
          entry.path,
          `UDL contains more than ${UDL_LIMITS.maxNodes} values`,
        );
      }
      if (key.length > UDL_LIMITS.maxKeyLength) {
        return resourceIssue(
          [...entry.path, key],
          `UDL key exceeds ${UDL_LIMITS.maxKeyLength} characters`,
        );
      }
      totalStringLength += key.length;
      if (totalStringLength > UDL_LIMITS.maxTotalStringLength) {
        return resourceIssue(
          [...entry.path, key],
          `UDL strings exceed ${UDL_LIMITS.maxTotalStringLength} total characters`,
        );
      }
    }
    discovered += childCount;
    for (const key in entry.value) {
      if (!Object.hasOwn(entry.value, key)) continue;
      pending.push({
        ancestors: childAncestors,
        countNode: countsAsAuthoredNode(entry, key),
        depth: entry.depth + 1,
        path: [...entry.path, key],
        value: (entry.value as Record<string, unknown>)[key],
      });
    }
  }
  return undefined;
}

function countsAsAuthoredNode(
  entry: { readonly countNode: boolean; readonly path: readonly PropertyKey[] },
  key: string,
): boolean {
  return !(
    !entry.countNode ||
    (key === "effects" &&
      entry.path.length === 4 &&
      entry.path[0] === "instruments" &&
      typeof entry.path[1] === "number" &&
      entry.path[2] === "actions" &&
      typeof entry.path[3] === "string")
  );
}

function resourceIssue(
  path: readonly PropertyKey[],
  message: string,
): UdlIssue {
  return issue("UDL1004", jsonPath(path), message);
}

function jsonValueIssue(path: readonly PropertyKey[]): UdlIssue {
  return issue("UDL1003", jsonPath(path), "UDL must contain only JSON values");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDocumentSchemas(document: UdlDocument, add: AddIssue): void {
  const addSchemaIssue: AddIssue = (path, message) =>
    add(path, message, "UDL6001");
  document.subjects.forEach((subject, subjectIndex) =>
    validateJsonSchema(
      subject.schema,
      ["subjects", subjectIndex, "schema"],
      addSchemaIssue,
    ),
  );
  document.instruments.forEach((instrument, instrumentIndex) => {
    for (const [field, schema] of Object.entries(instrument.fields)) {
      validateJsonSchema(
        schema,
        ["instruments", instrumentIndex, "fields", field],
        addSchemaIssue,
      );
    }
    for (const [action, definition] of Object.entries(instrument.actions)) {
      if (definition.input) {
        validateJsonSchema(
          definition.input,
          ["instruments", instrumentIndex, "actions", action, "input"],
          addSchemaIssue,
        );
      }
    }
  });
}

function validateJsonSchema(
  schema: Record<string, unknown>,
  path: readonly PropertyKey[],
  add: AddIssue,
): void {
  for (const keyword of Object.keys(schema)) {
    if (!jsonSchemaKeywords.has(keyword)) {
      add(
        [...path, keyword],
        `JSON Schema keyword ${keyword} is not in the UDL schema subset`,
        "UDL6001",
      );
    }
  }

  if (typeof schema.type !== "string" || !jsonSchemaTypes.has(schema.type)) {
    add(
      [...path, "type"],
      `JSON Schema type must be one of ${[...jsonSchemaTypes].join(", ")}`,
      "UDL6001",
    );
  }
  for (const keyword of ["description", "title"] as const) {
    if (Object.hasOwn(schema, keyword) && typeof schema[keyword] !== "string") {
      add(
        [...path, keyword],
        `JSON Schema ${keyword} must be a string`,
        "UDL6001",
      );
    }
  }
  if (
    Object.hasOwn(schema, "enum") &&
    (!Array.isArray(schema.enum) || schema.enum.length === 0)
  ) {
    add(
      [...path, "enum"],
      "JSON Schema enum must be a non-empty array",
      "UDL6001",
    );
  }
  if (
    Object.hasOwn(schema, "properties") &&
    (!isRecord(schema.properties) || schema.type !== "object")
  ) {
    add(
      [...path, "properties"],
      "JSON Schema properties require an object schema and object value",
      "UDL6001",
    );
  }
  if (Object.hasOwn(schema, "required")) {
    if (schema.type !== "object") {
      add(
        [...path, "required"],
        "JSON Schema required is only valid on an object schema",
        "UDL6001",
      );
    } else if (
      !Array.isArray(schema.required) ||
      !schema.required.every((field) => typeof field === "string")
    ) {
      add(
        [...path, "required"],
        "JSON Schema required must be an array of property names",
        "UDL6001",
      );
    } else {
      const properties = recordValue(schema.properties);
      for (const field of schema.required) {
        if (!Object.hasOwn(properties, field)) {
          add(
            [...path, "required"],
            `JSON Schema required references undeclared property ${field}`,
            "UDL6001",
          );
        }
      }
    }
  }
  if (
    Object.hasOwn(schema, "items") &&
    (!isRecord(schema.items) || schema.type !== "array")
  ) {
    add(
      [...path, "items"],
      "JSON Schema items require an array schema and object value",
      "UDL6001",
    );
  }
  if (
    Object.hasOwn(schema, "additionalProperties") &&
    (schema.type !== "object" ||
      (typeof schema.additionalProperties !== "boolean" &&
        !isRecord(schema.additionalProperties)))
  ) {
    add(
      [...path, "additionalProperties"],
      "JSON Schema additionalProperties requires an object schema and a boolean or schema value",
      "UDL6001",
    );
  }
  for (const keyword of [
    "maxItems",
    "maxLength",
    "minItems",
    "minLength",
  ] as const) {
    const value = schema[keyword];
    if (
      Object.hasOwn(schema, keyword) &&
      ((keyword.endsWith("Items")
        ? schema.type !== "array"
        : schema.type !== "string") ||
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0)
    ) {
      add(
        [...path, keyword],
        `JSON Schema ${keyword} must be a non-negative integer on the matching schema type`,
        "UDL6001",
      );
    }
  }
  for (const keyword of ["maximum", "minimum"] as const) {
    const value = schema[keyword];
    if (
      Object.hasOwn(schema, keyword) &&
      (schema.type !== "integer" ||
        typeof value !== "number" ||
        !Number.isFinite(value))
    ) {
      add(
        [...path, keyword],
        `JSON Schema ${keyword} must be finite on an integer schema`,
        "UDL6001",
      );
    }
  }
  if (
    typeof schema.minLength === "number" &&
    typeof schema.maxLength === "number" &&
    schema.minLength > schema.maxLength
  ) {
    add(
      [...path, "maxLength"],
      "JSON Schema maxLength is below minLength",
      "UDL6001",
    );
  }
  if (
    typeof schema.minItems === "number" &&
    typeof schema.maxItems === "number" &&
    schema.minItems > schema.maxItems
  ) {
    add(
      [...path, "maxItems"],
      "JSON Schema maxItems is below minItems",
      "UDL6001",
    );
  }
  if (
    typeof schema.minimum === "number" &&
    typeof schema.maximum === "number" &&
    schema.minimum > schema.maximum
  ) {
    add(
      [...path, "maximum"],
      "JSON Schema maximum is below minimum",
      "UDL6001",
    );
  }
  if (Object.hasOwn(schema, "x-hyperscale-reference-filter")) {
    const filter = schema["x-hyperscale-reference-filter"];
    if (
      !isRecord(filter) ||
      schema.type !== "string" ||
      Object.keys(filter).some((key) => key !== "column" && key !== "values") ||
      typeof filter.column !== "string" ||
      !Array.isArray(filter.values) ||
      !filter.values.every((value) => typeof value === "string")
    ) {
      add(
        [...path, "x-hyperscale-reference-filter"],
        "x-hyperscale-reference-filter requires only string column and string-array values",
        "UDL6001",
      );
    }
  }
  if (
    Object.hasOwn(schema, "x-hyperscale-fee-collection-port") &&
    (schema.type !== "string" ||
      schema["x-hyperscale-fee-collection-port"] !== true)
  ) {
    add(
      [...path, "x-hyperscale-fee-collection-port"],
      "x-hyperscale-fee-collection-port must be true on a string schema",
      "UDL6001",
    );
  }
  if (Object.hasOwn(schema, "pattern")) {
    if (schema.type !== "string" || typeof schema.pattern !== "string") {
      add(
        [...path, "pattern"],
        "JSON Schema pattern must be a string",
        "UDL6001",
      );
    } else {
      const problem = regexProblem(schema.pattern);
      if (problem) add([...path, "pattern"], problem, "UDL6001");
    }
  }
  if (
    Object.hasOwn(schema, "format") &&
    (schema.type !== "string" ||
      typeof schema.format !== "string" ||
      !jsonSchemaFormats.has(schema.format))
  ) {
    add(
      [...path, "format"],
      `JSON Schema format must be one of ${[...jsonSchemaFormats].join(", ")}`,
      "UDL6001",
    );
  }

  const properties = recordValue(schema.properties);
  for (const [property, child] of Object.entries(properties)) {
    if (isRecord(child)) {
      validateJsonSchema(child, [...path, "properties", property], add);
    } else {
      add(
        [...path, "properties", property],
        "JSON Schema property must be a schema object",
        "UDL6001",
      );
    }
  }
  if (isRecord(schema.items)) {
    validateJsonSchema(schema.items, [...path, "items"], add);
  }
  if (isRecord(schema.additionalProperties)) {
    validateJsonSchema(
      schema.additionalProperties,
      [...path, "additionalProperties"],
      add,
    );
  }
}

/**
 * Admits a document-authored `pattern` only when its worst-case match cost is
 * bounded, by multiplying out the search space instead of guessing at which
 * shapes are dangerous.
 *
 * The sealed subset leaves exactly three ways to make one anchored match
 * attempt branch: an alternation group (as many ways as it has branches), an
 * optional atom (two), and a variable-width `{n,m}` (span many). Unbounded
 * quantifiers, group repetition, backreferences, lookaround and `.` are
 * refused, so every remaining branch point is a finite factor and their
 * product is an upper bound on the attempts the backtracking engine can be
 * made to explore. Cap that product and matching cost is at most the budget
 * times the pattern length — no ambiguity heuristic to out-think, because
 * catastrophic backtracking IS an unbounded product.
 */
function regexProblem(pattern: string): string | undefined {
  if (pattern.length > UDL_LIMITS.maxPatternLength) {
    return `JSON Schema pattern exceeds ${UDL_LIMITS.maxPatternLength} characters`;
  }
  if (
    !pattern.startsWith("^") ||
    !pattern.endsWith("$") ||
    isEscapedRegexToken(pattern, pattern.length - 1)
  ) {
    return "JSON Schema pattern must be explicitly anchored with ^ and $";
  }

  let paths = 1;
  const overBudget = (factor: number): boolean => {
    paths *= factor;
    return paths > UDL_LIMITS.maxPatternPaths;
  };
  const budgetProblem = `JSON Schema pattern may branch more than ${UDL_LIMITS.maxPatternPaths} ways`;

  const branches: number[] = [];
  let inClass = false;
  let escaped = false;
  let previous: "atom" | "group" | "quantifier" | undefined;
  for (let index = 0; index < pattern.length; index += 1) {
    const token = pattern[index] as string;
    if (escaped) {
      if (/[1-9k]/.test(token)) {
        return "JSON Schema pattern may not contain backreferences";
      }
      escaped = false;
      previous = "atom";
      continue;
    }
    if (token === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (token === "]") {
        inClass = false;
        previous = "atom";
      }
      continue;
    }
    if (token === "[") {
      inClass = true;
      continue;
    }
    if (token === ".") {
      return "JSON Schema pattern may not contain the unbounded wildcard .";
    }
    if (token === "(") {
      if (pattern[index + 1] === "?" && pattern[index + 2] !== ":") {
        return "JSON Schema pattern may not contain lookaround or inline flags";
      }
      branches.push(1);
      previous = undefined;
      continue;
    }
    if (token === ")") {
      const groupBranches = branches.pop();
      if (groupBranches === undefined) {
        return "JSON Schema pattern contains an unmatched closing group";
      }
      if (overBudget(groupBranches)) return budgetProblem;
      previous = "group";
      continue;
    }
    if (token === "|") {
      const enclosing = branches.length - 1;
      if (enclosing < 0) {
        return "JSON Schema pattern alternation must be enclosed in a group";
      }
      branches[enclosing] = (branches[enclosing] as number) + 1;
      previous = undefined;
      continue;
    }
    if (token === "*" || token === "+") {
      return "JSON Schema pattern may not contain unbounded quantifiers";
    }
    if (token === "?") {
      if (pattern[index - 1] === "(") continue;
      if (!previous || previous === "quantifier") {
        return "JSON Schema pattern contains an ambiguous quantifier";
      }
      if (overBudget(2)) return budgetProblem;
      previous = "quantifier";
      continue;
    }
    if (token === "{") {
      const end = pattern.indexOf("}", index + 1);
      const bounds = end < 0 ? "" : pattern.slice(index + 1, end);
      const match = /^(\d+)(?:,(\d+))?$/.exec(bounds);
      if (!match) {
        return "JSON Schema pattern quantifiers must have a finite upper bound";
      }
      if (previous === "group") {
        return "JSON Schema pattern may not repeat a group";
      }
      if (!previous || previous === "quantifier") {
        return "JSON Schema pattern contains an ambiguous quantifier";
      }
      const lower = Number(match[1]);
      const upper = Number(match[2] ?? match[1]);
      if (upper < lower || upper > UDL_LIMITS.maxStringLength) {
        return `JSON Schema pattern quantifier upper bound must not exceed ${UDL_LIMITS.maxStringLength}`;
      }
      if (overBudget(upper - lower + 1)) return budgetProblem;
      previous = "quantifier";
      index = end;
      continue;
    }
    if (token !== "^" && token !== "$" && token !== ":") previous = "atom";
  }
  if (escaped || inClass || branches.length !== 0) {
    return "JSON Schema pattern is not syntactically closed";
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    return "JSON Schema pattern is not valid ECMAScript syntax";
  }
  return undefined;
}

function isEscapedRegexToken(pattern: string, index: number): boolean {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && pattern[cursor] === "\\";
    cursor -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function validateInstrument(
  instrument: UdlInstrument,
  instrumentIndex: number,
  instruments: ReadonlyMap<string, UdlInstrument>,
  subjects: ReadonlyMap<string, unknown>,
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const base = ["instruments", instrumentIndex] as const;
  const states = new Set(instrument.lifecycle.states);
  const orderedActions = new Set(instrument.actionOrder);

  addDuplicateIssues(
    instrument.actionOrder,
    [...base, "actionOrder"],
    "action id",
    add,
  );
  instrument.actionOrder.forEach((action, actionIndex) => {
    if (!Object.hasOwn(instrument.actions, action)) {
      add(
        [...base, "actionOrder", actionIndex],
        `action order references unknown action ${action}`,
        "UDL3001",
      );
    }
  });
  for (const action of Object.keys(instrument.actions)) {
    if (!orderedActions.has(action)) {
      add(
        [...base, "actions", action],
        `action ${action} is missing from actionOrder`,
        "UDL3001",
      );
    }
  }

  addDuplicateIssues(
    instrument.lifecycle.states,
    [...base, "lifecycle", "states"],
    "lifecycle state",
    add,
  );
  if (!states.has(instrument.lifecycle.initial)) {
    add(
      [...base, "lifecycle", "initial"],
      `initial state ${instrument.lifecycle.initial} is not declared in lifecycle.states`,
      "UDL3001",
    );
  }
  if (!Object.hasOwn(instrument.actions, "create")) {
    add(
      [...base, "actions"],
      "every instrument must declare the create action",
      "UDL3001",
    );
  }
  if (Object.hasOwn(instrument.lifecycle.transitions, "create")) {
    add(
      [...base, "lifecycle", "transitions", "create"],
      "create lands on lifecycle.initial and must not declare a transition",
      "UDL3001",
    );
  }

  for (const [action, transition] of Object.entries(
    instrument.lifecycle.transitions,
  )) {
    if (!Object.hasOwn(instrument.actions, action)) {
      add(
        [...base, "lifecycle", "transitions", action],
        `transition ${action} has no matching action`,
        "UDL3001",
      );
    }
    addDuplicateIssues(
      transition.from,
      [...base, "lifecycle", "transitions", action, "from"],
      "source state",
      add,
    );
    transition.from.forEach((from, fromIndex) => {
      if (!states.has(from)) {
        add(
          [...base, "lifecycle", "transitions", action, "from", fromIndex],
          `source state ${from} is not declared in lifecycle.states`,
          "UDL3001",
        );
      }
    });
    if (!states.has(transition.to)) {
      add(
        [...base, "lifecycle", "transitions", action, "to"],
        `target state ${transition.to} is not declared in lifecycle.states`,
        "UDL3001",
      );
    }
  }

  for (const action of Object.keys(instrument.actions)) {
    if (
      action !== "create" &&
      !Object.hasOwn(instrument.lifecycle.transitions, action)
    ) {
      add(
        [...base, "actions", action],
        `action ${action} must declare a lifecycle transition`,
        "UDL3001",
      );
    }
  }
  validateReachability(instrument, base, add);

  const reservedFields = new Set([
    "createdAt",
    "id",
    "metadata",
    "refs",
    "status",
  ]);
  for (const field of Object.keys(instrument.fields)) {
    if (reservedFields.has(field)) {
      add(
        [...base, "fields", field],
        `${field} is an envelope field and cannot be authored`,
        "UDL2002",
      );
    }
  }
  addDuplicateIssues(
    instrument.required,
    [...base, "required"],
    "required field",
    add,
  );
  instrument.required.forEach((field, fieldIndex) => {
    if (!Object.hasOwn(instrument.fields, field)) {
      add(
        [...base, "required", fieldIndex],
        `required references unknown field ${field}`,
        "UDL2002",
      );
    }
  });

  if (instrument.subject) {
    addDuplicateIssues(
      instrument.subject.kinds,
      [...base, "subject", "kinds"],
      "subject kind",
      add,
    );
    instrument.subject.kinds.forEach((kind, kindIndex) => {
      if (!subjects.has(kind)) {
        add(
          [...base, "subject", "kinds", kindIndex],
          `instrument subject references unknown kind ${kind}`,
          "UDL2002",
        );
      }
    });
  }

  validateParties(instrument, base, references, add);
  validateUpdate(instrument, base, states, add);
  validateDials(instrument, base, add);
  validateCallerParkedStates(instrument, base, states, add);
  validateFeeRules(instrument, base, references, add);
  validateSetsAt(instrument, base, add);
  validateActions(instrument, base, instruments, references, add);
  validateQuoteCommit(instrument, base, references, add);
  for (const issue of analyzeInstrumentFinance(instrument)) {
    add([...base, ...issue.path], issue.message, issue.code);
  }
  validateAggregates(instrument, base, instruments, references, add);
}

function validateFeeRules(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const feeRules = instrument.feeRules ?? [];
  if (feeRules.length === 0) return;
  if (Object.keys(instrument.fields).length > 24) {
    add(
      [...base, "fields"],
      "fee-bearing instruments must not declare more than 24 fields",
      "UDL4001",
    );
  }
  addDuplicateIssues(
    feeRules.map((fee) => fee.amountField),
    [...base, "feeRules"],
    "fee amount field",
    add,
  );

  const currencyFields = Object.entries(instrument.fields)
    .filter(([, schema]) => isCurrencySchema(schema))
    .map(([field]) => field);
  const instrumentCurrency =
    currencyFields.length === 1 ? currencyFields[0] : undefined;
  const mutableFields = new Set(instrument.update?.fields ?? []);
  const partitions = instrument.partitions ?? [];

  feeRules.forEach((fee, feeIndex) => {
    const feeBase = [...base, "feeRules", feeIndex] as const;
    const amountSchema = instrument.fields[fee.amountField];
    const baseSchema = instrument.fields[fee.baseField];
    if (!amountSchema || !isMoneySchema(amountSchema)) {
      add(
        [...feeBase, "amountField"],
        `fee amount ${fee.amountField} must be a declared money field`,
        "UDL4001",
      );
    }
    if (!baseSchema || !isMoneySchema(baseSchema)) {
      add(
        [...feeBase, "baseField"],
        `fee base ${fee.baseField} must be a declared money field`,
        "UDL4001",
      );
    }
    if (!instrument.required.includes(fee.baseField)) {
      add(
        [...feeBase, "baseField"],
        `fee base ${fee.baseField} must be required`,
        "UDL4001",
      );
    }
    if (mutableFields.has(fee.baseField)) {
      add(
        [...feeBase, "baseField"],
        `fee base ${fee.baseField} cannot be mutable`,
        "UDL4001",
      );
    }
    const bearerSchema = instrument.fields[fee.bearerField];
    if (!bearerSchema || !references.accepts(bearerSchema, "acct")) {
      add(
        [...feeBase, "bearerField"],
        `fee bearer ${fee.bearerField} must be a declared account-id field`,
        "UDL4001",
      );
    } else if (!instrument.required.includes(fee.bearerField)) {
      add(
        [...feeBase, "bearerField"],
        `fee bearer ${fee.bearerField} must be required`,
        "UDL4001",
      );
    }

    const validateExact = (
      rule: { readonly field: string; readonly currencyField: string },
      rulePath: readonly PropertyKey[],
      direct: boolean,
    ): void => {
      if (direct && rule.field !== fee.amountField) {
        add(
          [...rulePath, "field"],
          `exact fee field ${rule.field} must equal amountField ${fee.amountField}`,
          "UDL4001",
        );
      }
      if (!direct && rule.field === fee.amountField) {
        add(
          [...rulePath, "field"],
          `tiered fee output ${fee.amountField} must differ from exact source ${rule.field}`,
          "UDL4001",
        );
      }
      const exactSchema = instrument.fields[rule.field];
      if (!exactSchema || !isMoneySchema(exactSchema)) {
        add(
          [...rulePath, "field"],
          `exact fee field ${rule.field} must be a declared money field`,
          "UDL4001",
        );
      }
      if (!instrument.required.includes(rule.field)) {
        add(
          [...rulePath, "field"],
          `exact fee field ${rule.field} must be required`,
          "UDL4001",
        );
      }
      if (mutableFields.has(rule.field)) {
        add(
          [...rulePath, "field"],
          `exact fee field ${rule.field} cannot be mutable`,
          "UDL4001",
        );
      }
      if (
        instrumentCurrency === undefined ||
        rule.currencyField !== instrumentCurrency
      ) {
        add(
          [...rulePath, "currencyField"],
          `exact fee currency ${rule.currencyField} must equal the fee base currency field`,
          "UDL4001",
        );
      }
    };

    if (fee.rule.kind === "exact") {
      validateExact(fee.rule, [...feeBase, "rule"], true);
    } else {
      if (instrument.required.includes(fee.amountField)) {
        add(
          [...feeBase, "amountField"],
          `computed fee amount ${fee.amountField} must not be required at create`,
          "UDL4001",
        );
      }
      if (fee.rule.kind === "tiered") {
        const tiers = fee.rule.tiers;
        const openEnded = tiers.filter(
          (tier) => tier.toExclusive === undefined,
        ).length;
        if (openEnded !== 1) {
          add(
            [...feeBase, "rule", "tiers"],
            `tiered fee must declare exactly one open-ended tier; found ${openEnded}`,
            "UDL4001",
          );
        }
        tiers.forEach((tier, tierIndex) => {
          const tierPath = [...feeBase, "rule", "tiers", tierIndex] as const;
          const from = BigInt(tier.fromInclusive);
          if (tierIndex === 0 && from !== 0n) {
            add(
              [...tierPath, "fromInclusive"],
              "tiered fee coverage must start at 0",
              "UDL4001",
            );
          }
          if (tier.toExclusive !== undefined) {
            const to = BigInt(tier.toExclusive);
            if (to <= from) {
              add(
                [...tierPath, "toExclusive"],
                "tier upper bound must be greater than its lower bound",
                "UDL4001",
              );
            }
          } else if (tierIndex !== tiers.length - 1) {
            add(
              [...tierPath, "toExclusive"],
              "only the final fee tier may be open-ended",
              "UDL4001",
            );
          }
          if (tierIndex > 0) {
            const previous = tiers[tierIndex - 1];
            if (previous?.toExclusive === undefined) {
              add(
                [...tierPath, "fromInclusive"],
                "a fee tier cannot follow an open-ended tier",
                "UDL4001",
              );
            } else {
              const previousEnd = BigInt(previous.toExclusive);
              if (from > previousEnd) {
                add(
                  [...tierPath, "fromInclusive"],
                  `fee tiers have a gap before ${tier.fromInclusive}`,
                  "UDL4001",
                );
              } else if (from < previousEnd) {
                add(
                  [...tierPath, "fromInclusive"],
                  `fee tiers overlap at ${tier.fromInclusive}`,
                  "UDL4001",
                );
              }
            }
          }
          if (tier.rule.kind === "exact") {
            validateExact(tier.rule, [...tierPath, "rule"], false);
          }
        });
      }
    }

    const basePartitions = partitions.filter(
      (partition) => partition.totalField === fee.baseField,
    );
    const direct = basePartitions.some((partition) =>
      partition.pieceFields.includes(fee.amountField),
    );
    const nested = partitions.filter(
      (partition) =>
        partition.totalField === fee.amountField &&
        basePartitions.some((basePartition) =>
          partition.pieceFields.every((piece) =>
            basePartition.pieceFields.includes(piece),
          ),
        ),
    );
    const carvedInsideBase = direct || nested.length === 1;
    if (fee.position === "carved" && !carvedInsideBase) {
      add(
        [...feeBase, "position"],
        `carved fee ${fee.amountField} must form part of a partition of ${fee.baseField}`,
        "UDL4001",
      );
    }
    if (fee.position === "on_top" && carvedInsideBase) {
      add(
        [...feeBase, "position"],
        `on-top fee ${fee.amountField} must stay outside the partition of ${fee.baseField}`,
        "UDL4001",
      );
    }
  });
}

function validateSetsAt(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  const writers = new Map<string, string[]>();
  const markerFields = new Set<string>();
  for (const [actionName, action] of Object.entries(instrument.actions)) {
    if (!action.setsAt) continue;
    const path = [...base, "actions", actionName, "setsAt"] as const;
    const { field, marker, offset } = action.setsAt;
    if (marker) markerFields.add(field);
    if (actionName === "create") {
      add(
        path,
        "setsAt requires a lifecycle transition and cannot run on create",
        "UDL3001",
      );
    }
    const fieldWriters = writers.get(field) ?? [];
    if (fieldWriters.length > 0) {
      const alternatives = [...fieldWriters, actionName];
      const targets = new Set(
        alternatives.map(
          (writer) => instrument.lifecycle.transitions[writer]?.to,
        ),
      );
      const reentrant = alternatives.some((writer) => {
        const transition = instrument.lifecycle.transitions[writer];
        return transition?.from.includes(transition.to) === true;
      });
      if (targets.size !== 1 || targets.has(undefined) || reentrant) {
        add(
          [...path, "field"],
          `${field} has multiple writers without one shared one-way destination`,
          "UDL3001",
        );
      }
    }
    writers.set(field, [...fieldWriters, actionName]);

    const schema = instrument.fields[field];
    if (!schema) {
      add(
        [...path, "field"],
        `setsAt references unknown field ${field}`,
        "UDL3001",
      );
    } else if (schema.type !== "string" || !isDateTimeFormat(schema.format)) {
      add(
        [...path, "field"],
        "setsAt must target a date-time field",
        "UDL3001",
      );
    }
    if (instrument.required.includes(field)) {
      add(
        [...path, "field"],
        "setsAt target must be optional at create",
        "UDL3001",
      );
    }
    if (instrument.update?.fields.includes(field)) {
      add(
        [...path, "field"],
        "setsAt target cannot also be mutable",
        "UDL3001",
      );
    }
    const offsetMs = fixedIsoDurationMs(offset);
    if (offsetMs === null || offsetMs <= 0) {
      add(
        [...path, "offset"],
        "setsAt.offset must be a positive fixed ISO-8601 duration",
        "UDL3001",
      );
    }

    const readers = Object.entries(instrument.actions).filter(
      ([, candidate]) =>
        candidate.due?.field === field || candidate.deadline?.field === field,
    );
    if (marker) {
      if (readers.length > 0) {
        add(
          path,
          `setsAt marker field ${field} cannot drive a due condition or deadline`,
          "UDL3001",
        );
      }
      continue;
    }
    if (readers.length === 0) {
      add(
        path,
        `setsAt field ${field} must anchor at least one due condition or deadline`,
        "UDL3001",
      );
      continue;
    }
  }
  for (const [field, fieldWriters] of writers) {
    if (markerFields.has(field)) continue;
    const readers = Object.entries(instrument.actions).filter(
      ([, candidate]) =>
        candidate.due?.field === field || candidate.deadline?.field === field,
    );
    for (const [readerName] of readers) {
      if (!actionGroupDominatesReader(instrument, fieldWriters, readerName)) {
        add(
          [...base, "actions", readerName],
          `action ${readerName} can read ${field} before writers ${fieldWriters.join(" or ")}`,
          "UDL3001",
        );
      }
    }
  }
}

function actionGroupDominatesReader(
  instrument: UdlInstrument,
  writers: readonly string[],
  reader: string,
): boolean {
  if (writers.length === 0) return false;
  const readerTransition = instrument.lifecycle.transitions[reader];
  if (!readerTransition) return false;
  const removed = new Set(writers);
  const reachable = new Set([instrument.lifecycle.initial]);
  const pending = [instrument.lifecycle.initial];
  while (pending.length > 0) {
    const state = pending.shift() as string;
    for (const [action, transition] of Object.entries(
      instrument.lifecycle.transitions,
    )) {
      if (
        removed.has(action) ||
        !transition.from.includes(state) ||
        reachable.has(transition.to)
      ) {
        continue;
      }
      reachable.add(transition.to);
      pending.push(transition.to);
    }
  }
  return readerTransition.from.every((state) => !reachable.has(state));
}

function validateReachability(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  const reachable = new Set([instrument.lifecycle.initial]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const transition of Object.values(instrument.lifecycle.transitions)) {
      if (
        transition.from.some((state) => reachable.has(state)) &&
        !reachable.has(transition.to)
      ) {
        reachable.add(transition.to);
        changed = true;
      }
    }
  }
  instrument.lifecycle.states.forEach((state, stateIndex) => {
    if (!reachable.has(state)) {
      add(
        [...base, "lifecycle", "states", stateIndex],
        `lifecycle state ${state} is unreachable from ${instrument.lifecycle.initial}`,
        "UDL3001",
      );
    }
  });
}

function validateParties(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  if (!instrument.parties) return;
  const entries = Object.entries(instrument.parties).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (entries.length === 0) {
    add(
      [...base, "parties"],
      "parties must contain at least one declaration",
      "UDL2002",
    );
    return;
  }
  if (instrument.distinctParties && entries.length < 2) {
    add(
      [...base, "distinctParties"],
      "distinctParties requires at least two declared party roles",
      "UDL2002",
    );
  }
  addDuplicateIssues(
    entries.map(([, field]) => field),
    [...base, "parties"],
    "party field",
    add,
  );
  for (const [role, field] of entries) {
    const schema = instrument.fields[field];
    if (!schema) {
      add(
        [...base, "parties", role],
        `party role ${role} references unknown field ${field}`,
        "UDL2002",
      );
    } else if (!references.accepts(schema, "acct")) {
      add(
        [...base, "parties", role],
        `party role ${role} must reference an account-id field`,
        "UDL2002",
      );
    }
  }
}

function validateUpdate(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  states: ReadonlySet<string>,
  add: AddIssue,
): void {
  if (!instrument.update) return;
  addDuplicateIssues(
    instrument.update.fields,
    [...base, "update", "fields"],
    "field",
    add,
  );
  addDuplicateIssues(
    instrument.update.states,
    [...base, "update", "states"],
    "state",
    add,
  );
  instrument.update.fields.forEach((field, index) => {
    if (!Object.hasOwn(instrument.fields, field)) {
      add(
        [...base, "update", "fields", index],
        `update references unknown field ${field}`,
        "UDL2002",
      );
    }
  });
  instrument.update.states.forEach((state, index) => {
    if (!states.has(state)) {
      add(
        [...base, "update", "states", index],
        `update references unknown state ${state}`,
        "UDL2002",
      );
    }
  });
  if (instrument.update.examples) {
    addDuplicateIssues(
      instrument.update.examples.map((example) => example.name),
      [...base, "update", "examples"],
      "example name",
      add,
    );
    const schema: Schema = {
      additionalProperties: false,
      properties: Object.fromEntries(
        instrument.update.fields.flatMap((field) => {
          const fieldSchema = instrument.fields[field];
          return fieldSchema ? [[field, fieldSchema]] : [];
        }),
      ),
      type: "object",
    };
    instrument.update.examples.forEach((example, exampleIndex) => {
      const input = exampleInputForUdlValidation(instrument, example.input);
      for (const error of validateUdlSchemaValue(schema, input).errors) {
        add(
          [...base, "update", "examples", exampleIndex, "input"],
          `example ${example.name} input ${error.error} at ${error.instanceLocation || "/"}`,
          "UDL2002",
        );
      }
    });
  }
}

function validateCallerParkedStates(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  states: ReadonlySet<string>,
  add: AddIssue,
): void {
  const parked = instrument.callerParkedStates;
  if (parked === undefined) return;
  const exitsByState = new Map(
    instrument.lifecycle.states.map((state) => [state, [] as string[]]),
  );
  for (const [action, transition] of Object.entries(
    instrument.lifecycle.transitions,
  )) {
    const stationary =
      instrument.actions[action]?.due?.every !== undefined &&
      transition.from.includes(transition.to);
    if (stationary) continue;
    for (const state of transition.from) {
      if (state !== transition.to) exitsByState.get(state)?.push(action);
    }
  }
  const isUnconditionallyTimeDriven = (action: string): boolean => {
    const due = instrument.actions[action]?.due;
    if (!due || !isDateTimeFormat(instrument.fields[due.field]?.format)) {
      return false;
    }
    if (instrument.required.includes(due.field)) return true;
    const writers = Object.entries(instrument.actions).flatMap(
      ([writer, definition]) =>
        definition.setsAt?.field === due.field ? [writer] : [],
    );
    return actionGroupDominatesReader(instrument, writers, action);
  };
  for (const state of Object.keys(parked)) {
    const stateBase = [...base, "callerParkedStates", state] as const;
    if (!states.has(state)) {
      add(
        stateBase,
        `callerParkedStates references unknown state ${state}`,
        "UDL3001",
      );
      continue;
    }
    const exits = exitsByState.get(state) ?? [];
    if (exits.length === 0) {
      add(
        stateBase,
        `terminal state ${state} cannot be caller-parked`,
        "UDL3001",
      );
    } else if (exits.some(isUnconditionallyTimeDriven)) {
      add(
        stateBase,
        `caller-parked state ${state} has a time-driven exit`,
        "UDL3001",
      );
    }
  }
  for (const [state, exits] of exitsByState) {
    if (
      exits.length > 0 &&
      !exits.some(isUnconditionallyTimeDriven) &&
      !Object.hasOwn(parked, state)
    ) {
      add(
        [...base, "callerParkedStates"],
        `state ${state} has only caller-driven exits and needs a caller-parked reason`,
        "UDL3001",
      );
    }
  }
}

/**
 * Composition dials sit on the document, not on an instrument: a confirmation
 * threshold is a property of the whole product. Keys are unique across the
 * document the same way instrument dial keys are unique within an instrument.
 */
function validateCompositionDials(document: UdlDocument, add: AddIssue): void {
  const dials = document.dials ?? [];
  addDuplicateIssues(
    dials.map((dial) => dial.key),
    ["dials"],
    "composition dial key",
    add,
  );
  const kinds = new Map<string, number>();
  dials.forEach((dial, dialIndex) => {
    const prior = kinds.get(dial.kind);
    if (prior !== undefined) {
      add(
        ["dials", dialIndex, "kind"],
        `composition dial kind ${dial.kind} duplicates dials[${prior}]`,
        "UDL2001",
      );
      return;
    }
    kinds.set(dial.kind, dialIndex);
  });
}

function validateDials(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  const dials = instrument.dials ?? [];
  addDuplicateIssues(
    dials.map((dial) => dial.key),
    [...base, "dials"],
    "dial key",
    add,
  );
  const targets = new Map<string, number>();
  dials.forEach((dial, dialIndex) => {
    const dialBase = [...base, "dials", dialIndex] as const;
    const target =
      dial.kind === "window"
        ? `window:${dial.field}`
        : dial.kind === "decision_deadline_ms"
          ? `decision:${dial.action}`
          : dial.kind === "reconcile_tolerance"
            ? `reconcile_tolerance:${dial.key}`
            : "unwind_penalty";
    const prior = targets.get(target);
    if (prior !== undefined) {
      add(
        [...dialBase, "key"],
        `dial target ${target} duplicates dials[${prior}]`,
        "UDL5008",
      );
    } else {
      targets.set(target, dialIndex);
    }

    if (dial.kind === "window") {
      const anchorsAction = Object.values(instrument.actions).some(
        (definition) =>
          definition.due?.field === dial.field ||
          definition.deadline?.field === dial.field,
      );
      if (!anchorsAction) {
        add(
          [...dialBase, "field"],
          `window dial field ${dial.field} anchors no action deadline or due condition`,
          "UDL5008",
        );
      }
      const min =
        dial.minOffset === undefined
          ? undefined
          : fixedIsoDurationMs(dial.minOffset);
      const max =
        dial.maxOffset === undefined
          ? undefined
          : fixedIsoDurationMs(dial.maxOffset);
      if (dial.minOffset !== undefined && min === null) {
        add(
          [...dialBase, "minOffset"],
          "dial minOffset must be a fixed ISO-8601 duration",
          "UDL5008",
        );
      }
      if (dial.maxOffset !== undefined && max === null) {
        add(
          [...dialBase, "maxOffset"],
          "dial maxOffset must be a fixed ISO-8601 duration",
          "UDL5008",
        );
      }
      if (
        min !== undefined &&
        min !== null &&
        max !== undefined &&
        max !== null &&
        min > max
      ) {
        add(
          [...dialBase, "maxOffset"],
          "dial minOffset exceeds maxOffset",
          "UDL5008",
        );
      }
      return;
    }
    if (dial.kind === "decision_deadline_ms") {
      if (!instrument.actions[dial.action]?.decision) {
        add(
          [...dialBase, "action"],
          `decision deadline dial action ${dial.action} declares no decision`,
          "UDL5008",
        );
      }
      if (
        dial.minMs !== undefined &&
        dial.maxMs !== undefined &&
        dial.minMs > dial.maxMs
      ) {
        add([...dialBase, "maxMs"], "dial minMs exceeds maxMs", "UDL5008");
      }
      return;
    }
    if (dial.kind === "reconcile_tolerance") {
      const forgives = Object.values(instrument.actions).some((action) =>
        (action.reconcile ?? []).some(
          (reconcile) =>
            reconcile.match.law === "tolerance" &&
            reconcile.match.dial === dial.key,
        ),
      );
      if (!forgives) {
        add(
          dialBase,
          `reconcile tolerance dial ${dial.key} bounds no reconcile`,
          "UDL5008",
        );
      }
      return;
    }
    if (!Object.values(instrument.actions).some((action) => action.quote)) {
      add(dialBase, "unwind penalty dial requires a quoting action", "UDL5008");
    }
  });
}

function validateActionUpdates(
  instrument: UdlInstrument,
  action: string,
  definition: UdlAction,
  actionBase: readonly PropertyKey[],
  add: AddIssue,
): void {
  if (!definition.updates) return;
  if (action === "create") {
    add([...actionBase, "updates"], "create cannot declare updates", "UDL5008");
  }
  addDuplicateIssues(
    definition.updates,
    [...actionBase, "updates"],
    "updated field",
    add,
  );
  const inputFields = recordValue(definition.input?.properties);
  const stepBoundFields = new Set(
    Object.values(instrument.actions).flatMap((candidate) =>
      [...candidate.steps, ...candidate.moves].flatMap((step) =>
        Object.values(step.bind).flatMap((binding) =>
          binding.from === "instance" && binding.path.startsWith("fields.")
            ? [binding.path.slice("fields.".length)]
            : [],
        ),
      ),
    ),
  );
  const setsAtFields = new Set(
    Object.values(instrument.actions).flatMap((candidate) =>
      candidate.setsAt ? [candidate.setsAt.field] : [],
    ),
  );
  const partitionFields = new Set(
    (instrument.partitions ?? []).flatMap((partition) => [
      partition.totalField,
      ...partition.pieceFields,
    ]),
  );
  const aggregateFields = new Set(
    (instrument.aggregateInvariants ?? []).map(
      (invariant) => invariant.parentField,
    ),
  );
  definition.updates.forEach((field, fieldIndex) => {
    const fieldPath = [...actionBase, "updates", fieldIndex] as const;
    if (!Object.hasOwn(inputFields, field)) {
      add(
        fieldPath,
        `updated field ${field} is not declared by action input`,
        "UDL5008",
      );
    }
    if (!Object.hasOwn(instrument.fields, field)) {
      add(
        fieldPath,
        `updated field ${field} is not an instrument field`,
        "UDL5008",
      );
    }
    if (stepBoundFields.has(field)) {
      add(
        fieldPath,
        `updated field ${field} is bound by a kernel step`,
        "UDL5008",
      );
    }
    if (setsAtFields.has(field)) {
      add(fieldPath, `updated field ${field} is owned by setsAt`, "UDL5008");
    }
    if (partitionFields.has(field)) {
      add(
        fieldPath,
        `updated field ${field} participates in a partition`,
        "UDL5008",
      );
    }
    if (aggregateFields.has(field)) {
      add(fieldPath, `updated field ${field} is an aggregate cap`, "UDL5008");
    }
  });
  if (definition.moves.length > 0) {
    add(
      [...actionBase, "updates"],
      "an action cannot update fields while moving money",
      "UDL5008",
    );
  }
}

function validateCheckRequirements(
  instrument: UdlInstrument,
  definition: UdlAction,
  actionBase: readonly PropertyKey[],
  add: AddIssue,
): void {
  const checks = definition.requiresChecks ?? [];
  addDuplicateIssues(
    checks.map((check) => `${check.family}:${check.checkKind}`),
    [...actionBase, "requiresChecks"],
    "check requirement",
    add,
  );
  checks.forEach((check, checkIndex) => {
    const checkBase = [...actionBase, "requiresChecks", checkIndex] as const;
    if (!Object.hasOwn(instrument.fields, check.subjectField)) {
      add(
        [...checkBase, "subjectField"],
        `check subjectField ${check.subjectField} is not declared`,
        "UDL5002",
      );
    }
    addDuplicateIssues(
      check.statuses,
      [...checkBase, "statuses"],
      "accepted check status",
      add,
    );
    if (check.maxAge && fixedIsoDurationMs(check.maxAge) === null) {
      add(
        [...checkBase, "maxAge"],
        "check maxAge must be a fixed ISO-8601 duration",
        "UDL5002",
      );
    }
  });
}

function validateRemainder(
  instrument: UdlInstrument,
  action: string,
  definition: UdlAction,
  actionBase: readonly PropertyKey[],
  instruments: ReadonlyMap<string, UdlInstrument>,
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const remainder = definition.remainder;
  if (!remainder) return;
  const remainderBase = [...actionBase, "remainder"] as const;
  if (action === "create") {
    add(remainderBase, "create cannot declare remainder", "UDL4001");
  }
  if (definition.distribute || definition.signedSum) {
    add(
      remainderBase,
      "remainder cannot combine with distribute or signedSum",
      "UDL4001",
    );
  }
  if (
    remainder.accumulateRef !== undefined &&
    remainder.accumulateRef === remainder.amountRef
  ) {
    add(
      [...remainderBase, "accumulateRef"],
      "remainder accumulateRef must differ from amountRef",
      "UDL4001",
    );
  }
  const [totalRoot, totalKey] = remainder.totalPath.split(".");
  const totalDeclared =
    (totalRoot === "fields" &&
      totalKey !== undefined &&
      isMoneySchema(instrument.fields[totalKey] ?? {})) ||
    (totalRoot === "refs" &&
      totalKey !== undefined &&
      Object.values(instrument.actions).some(
        (candidate) => candidate.remainder?.accumulateRef === totalKey,
      ));
  if (!totalDeclared) {
    add(
      [...remainderBase, "totalPath"],
      `remainder total ${remainder.totalPath} is not declared money`,
      "UDL4001",
    );
  }
  if (
    remainder.inputKey !== undefined &&
    !Object.hasOwn(
      recordValue(definition.input?.properties),
      remainder.inputKey,
    )
  ) {
    add(
      [...remainderBase, "inputKey"],
      `remainder inputKey ${remainder.inputKey} is not declared by action input`,
      "UDL4001",
    );
  }
  const transfers = definition.moves.filter(
    (move) =>
      move.operation === "internal_transfer.create" &&
      move.bind.amount?.from === "instance" &&
      move.bind.amount.path === `refs.${remainder.amountRef}`,
  );
  if (transfers.length !== 1) {
    add(
      remainderBase,
      `remainder requires exactly one internal transfer whose amount is refs.${remainder.amountRef}`,
      "UDL4001",
    );
  }
  (remainder.collected ?? []).forEach((collected, collectedIndex) => {
    const collectedBase = [
      ...remainderBase,
      "collected",
      collectedIndex,
    ] as const;
    addDuplicateIssues(
      collected.statuses,
      [...collectedBase, "statuses"],
      "collected status",
      add,
    );
    const child = instruments.get(collected.instrumentId);
    if (!child) {
      add(
        [...collectedBase, "instrumentId"],
        `remainder references unknown instrument ${collected.instrumentId}`,
        "UDL4001",
      );
      return;
    }
    const refSchema = child.fields[collected.refField];
    if (!refSchema || !references.accepts(refSchema, instrument.idPrefix)) {
      add(
        [...collectedBase, "refField"],
        `${child.id}.${collected.refField} must reference ${instrument.id}`,
        "UDL4001",
      );
    }
    const amountDeclared =
      collected.path === "refs"
        ? Object.values(child.actions).some(
            (candidate) =>
              candidate.remainder?.amountRef === collected.amountField ||
              candidate.remainder?.accumulateRef === collected.amountField,
          )
        : isMoneySchema(child.fields[collected.amountField] ?? {});
    if (!amountDeclared) {
      add(
        [...collectedBase, "amountField"],
        `${child.id}.${collected.amountField} is not declared money`,
        "UDL4001",
      );
    }
    if (
      collected.path !== "refs" &&
      !(instrument.aggregateInvariants ?? []).some(
        (invariant) =>
          invariant.childInstrumentId === collected.instrumentId &&
          invariant.childRefField === collected.refField &&
          "childField" in invariant &&
          invariant.childField === collected.amountField,
      )
    ) {
      add(
        collectedBase,
        `remainder collection ${collected.instrumentId}.${collected.amountField} has no congruent aggregate invariant`,
        "UDL4001",
      );
    }
    collected.statuses.forEach((status, statusIndex) => {
      if (!child.lifecycle.states.includes(status)) {
        add(
          [...collectedBase, "statuses", statusIndex],
          `remainder status ${status} is not declared by ${child.id}`,
          "UDL4001",
        );
      }
    });
  });
}

function validateActions(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  instruments: ReadonlyMap<string, UdlInstrument>,
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  validatePayoutsAndSettlement(instrument, base, instruments, references, add);
  for (const [action, definition] of Object.entries(instrument.actions)) {
    const actionBase = [...base, "actions", action] as const;
    if (action === "create" && definition.input) {
      add(
        [...actionBase, "input"],
        "create already consumes instrument fields and must not declare input",
        "UDL5008",
      );
    }
    if (definition.input && definition.input.type !== "object") {
      add(
        [...actionBase, "input", "type"],
        "action input must declare an object-shaped JSON Schema",
        "UDL5008",
      );
    }
    const inputFields = recordValue(definition.input?.properties);
    for (const [refKey, inputKey] of Object.entries(
      definition.captureInput ?? {},
    )) {
      if (!Object.hasOwn(inputFields, inputKey)) {
        add(
          [...actionBase, "captureInput", refKey],
          `captured receipt input references undeclared action input field ${inputKey}`,
          "UDL5008",
        );
      }
    }

    validateDecidedAmount(instrument, action, actionBase, add);
    validateActionUpdates(instrument, action, definition, actionBase, add);
    validateCheckRequirements(instrument, definition, actionBase, add);
    validateRemainder(
      instrument,
      action,
      definition,
      actionBase,
      instruments,
      references,
      add,
    );

    addDuplicateIssues(
      definition.moves.map((move) => move.key),
      [...actionBase, "moves"],
      "move key",
      add,
    );
    if (definition.earnable && definition.moves.length === 0) {
      add(actionBase, "earnable requires a money move", "UDL5008");
    }
    definition.steps.forEach((step, stepIndex) =>
      validateStep(
        instrument,
        definition,
        step,
        [...actionBase, "steps", stepIndex],
        add,
      ),
    );
    definition.moves.forEach((move, moveIndex) =>
      validateStep(
        instrument,
        definition,
        move,
        [...actionBase, "moves", moveIndex],
        add,
      ),
    );

    if (definition.requiresRefs) {
      addDuplicateIssues(
        definition.requiresRefs.map((gate) => gate.field),
        [...actionBase, "requiresRefs"],
        "gate field",
        add,
      );
      definition.requiresRefs.forEach((gate, gateIndex) => {
        addDuplicateIssues(
          gate.statuses,
          [...actionBase, "requiresRefs", gateIndex, "statuses"],
          "gate status",
          add,
        );
        const schema = instrument.fields[gate.field];
        if (!schema) {
          add(
            [...actionBase, "requiresRefs", gateIndex, "field"],
            `gate references unknown field ${gate.field}`,
            "UDL5001",
          );
          return;
        }
        const targets = [...instruments.values()].filter((target) =>
          references.accepts(schema, target.idPrefix),
        );
        if (targets.length !== 1) {
          add(
            [...actionBase, "requiresRefs", gateIndex, "field"],
            `gate field ${gate.field} must identify exactly one instrument (found ${targets.length})`,
            "UDL5001",
          );
          return;
        }
        const target = targets[0] as UdlInstrument;
        gate.statuses.forEach((status, statusIndex) => {
          if (!target.lifecycle.states.includes(status)) {
            add(
              [
                ...actionBase,
                "requiresRefs",
                gateIndex,
                "statuses",
                statusIndex,
              ],
              `gate status ${status} is not declared by ${target.id}`,
              "UDL5008",
            );
          }
        });
        validateGateShape(
          instrument,
          action,
          gate,
          target,
          [...actionBase, "requiresRefs", gateIndex],
          add,
        );
      });
    }

    if (definition.requiresDrainedAccount) {
      const drainBase = [...actionBase, "requiresDrainedAccount"] as const;
      if (action === "create") {
        add(
          [...drainBase],
          "requiresDrainedAccount cannot gate create: no account exists yet",
          "UDL5008",
        );
      }
      const path = definition.requiresDrainedAccount.path;
      const declared =
        (path.startsWith("fields.") &&
          Object.hasOwn(instrument.fields, path.slice("fields.".length))) ||
        (path.startsWith("refs.") &&
          declaredRefKeys(instrument).has(path.slice("refs.".length)));
      if (!declared) {
        add(
          [...drainBase, "path"],
          `requiresDrainedAccount reads ${path}, which is not declared`,
          "UDL5008",
        );
      }
    }

    if (definition.signedSum) {
      const sumBase = [...actionBase, "signedSum"] as const;
      if (action === "create") {
        add(
          sumBase,
          "signedSum cannot run on create: no parent row exists yet",
          "UDL5008",
        );
      }
      const generatedRefs = [
        {
          key: definition.signedSum.amountRef,
          path: [...sumBase, "amountRef"] as const,
        },
        ...definition.signedSum.sources.map((source, sourceIndex) => ({
          key: source.subtotalRef,
          path: [...sumBase, "sources", sourceIndex, "subtotalRef"] as const,
        })),
      ];
      addDuplicateIssues(
        generatedRefs.map((ref) => ref.key),
        sumBase,
        "signed sum ref",
        add,
      );
      const existingRefs = new Set([
        ...Object.entries(instrument.actions).flatMap(
          ([candidateAction, candidate]) => [
            ...Object.keys(candidate.captureInput ?? {}),
            ...[...candidate.steps, ...candidate.moves].flatMap((step) =>
              Object.keys(step.capture ?? {}),
            ),
            ...(candidateAction !== action && candidate.signedSum
              ? [
                  candidate.signedSum.amountRef,
                  ...candidate.signedSum.sources.map(
                    (source) => source.subtotalRef,
                  ),
                ]
              : []),
          ],
        ),
        ...quoteRefKeys(instrument),
        ...(instrument.subject ? ["subject"] : []),
      ]);
      for (const ref of generatedRefs) {
        if (existingRefs.has(ref.key)) {
          add(
            ref.path,
            `signed sum ref ${ref.key} collides with an existing instrument ref key`,
            "UDL5008",
          );
        }
      }
      if (
        !definition.signedSum.sources.some((source) => source.sign === "add")
      ) {
        add(
          [...sumBase, "sources"],
          "signedSum needs at least one add source",
          "UDL5008",
        );
      }
      const parentCurrencies = Object.entries(instrument.fields).filter(
        ([, schema]) => isCurrencySchema(schema),
      );
      if (parentCurrencies.length !== 1) {
        add(
          sumBase,
          `signedSum parent ${instrument.id} needs exactly one currency field`,
          "UDL5008",
        );
      }
      const sourceKeys = definition.signedSum.sources.map(
        (source) =>
          `${source.instrumentId}:${source.refField}:${source.amountField}:${source.sign}:${[...source.statuses].sort().join(",")}`,
      );
      addDuplicateIssues(
        sourceKeys,
        [...sumBase, "sources"],
        "signed sum source",
        add,
      );
      definition.signedSum.sources.forEach((source, sourceIndex) => {
        for (let priorIndex = 0; priorIndex < sourceIndex; priorIndex += 1) {
          const prior = definition.signedSum?.sources[priorIndex];
          if (
            !prior ||
            prior.instrumentId !== source.instrumentId ||
            prior.refField !== source.refField ||
            prior.amountField !== source.amountField ||
            prior.sign !== source.sign
          ) {
            continue;
          }
          const priorStatuses = new Set(prior.statuses);
          const overlap = source.statuses.filter((status) =>
            priorStatuses.has(status),
          );
          if (overlap.length === 0) continue;
          add(
            [...sumBase, "sources", sourceIndex, "statuses"],
            `signed sum source overlaps source ${priorIndex} on statuses ${overlap.join(", ")}`,
            "UDL5008",
          );
        }
      });
      definition.signedSum.sources.forEach((source, sourceIndex) => {
        const sourceBase = [...sumBase, "sources", sourceIndex] as const;
        const child = instruments.get(source.instrumentId);
        if (!child) {
          add(
            [...sourceBase, "instrumentId"],
            `signedSum references unknown instrument ${source.instrumentId}`,
            "UDL5008",
          );
          return;
        }
        const refSchema = child.fields[source.refField];
        if (!refSchema || !references.accepts(refSchema, instrument.idPrefix)) {
          add(
            [...sourceBase, "refField"],
            `${source.instrumentId}.${source.refField} must reference ${instrument.id}`,
            "UDL5008",
          );
        }
        const amountSchema = child.fields[source.amountField];
        if (!amountSchema || !isMoneySchema(amountSchema)) {
          add(
            [...sourceBase, "amountField"],
            `${source.instrumentId}.${source.amountField} must be a money field`,
            "UDL5008",
          );
        }
        const childCurrencies = Object.entries(child.fields).filter(
          ([, schema]) => isCurrencySchema(schema),
        );
        if (childCurrencies.length !== 1) {
          add(
            [...sourceBase, "instrumentId"],
            `signedSum source ${source.instrumentId} needs exactly one currency field`,
            "UDL5008",
          );
        }
        addDuplicateIssues(
          source.statuses,
          [...sourceBase, "statuses"],
          "signed sum status",
          add,
        );
        source.statuses.forEach((status, statusIndex) => {
          if (!child.lifecycle.states.includes(status)) {
            add(
              [...sourceBase, "statuses", statusIndex],
              `signedSum status ${status} is not declared by ${source.instrumentId}`,
              "UDL5008",
            );
          }
        });
      });
      const amountPath = `refs.${definition.signedSum.amountRef}`;
      const payoutMoves = Object.values(instrument.actions).flatMap(
        (candidate) =>
          candidate.moves.filter(
            (move) =>
              move.operation === "internal_transfer.create" &&
              move.bind.amount?.from === "instance" &&
              move.bind.amount.path === amountPath,
          ),
      );
      const payouts = Object.values(instrument.actions).filter(
        (candidate) => candidate.payout?.amount === amountPath,
      );
      if (payoutMoves.length + payouts.length !== 1) {
        add(
          sumBase,
          `signedSum requires exactly one payout or instrument transfer whose amount is ${amountPath}`,
          "UDL5008",
        );
      }
    }

    if (definition.due) {
      if (definition.publicAction) {
        add(
          [...actionBase, "publicAction"],
          "a system due action cannot declare a public action",
          "UDL3001",
        );
      }
      const transition = instrument.lifecycle.transitions[action];
      if (definition.due.every) {
        const serialLiability = definition.due.every.liability === "one_open";
        if (
          !transition ||
          (serialLiability
            ? transition.from.includes(transition.to)
            : !transition.from.includes(transition.to))
        ) {
          add(
            [...actionBase, "due"],
            serialLiability
              ? "a one-open recurring due action must leave its source states while the period liability is open"
              : "a recurring due action must be stationary: its transition's to must name one of its from states",
            "UDL5008",
          );
        }
      } else if (!transition || transition.from.includes(transition.to)) {
        add(
          [...actionBase, "due"],
          "a due action must leave every source state so the maintenance loop fires its anchor exactly once",
          "UDL3001",
        );
      }
      const schema = instrument.fields[definition.due.field];
      if (!schema) {
        add(
          [...actionBase, "due", "field"],
          `due condition references unknown field ${definition.due.field}`,
          "UDL3001",
        );
      } else if (!isDateTimeFormat(schema.format)) {
        add(
          [...actionBase, "due", "field"],
          "due field must be a date-time field",
          "UDL5008",
        );
      }
      if (
        definition.due.offset &&
        fixedIsoDurationMs(definition.due.offset) === null
      ) {
        add(
          [...actionBase, "due", "offset"],
          "due.offset must be a fixed ISO-8601 duration using weeks, days, hours, minutes, or seconds",
          "UDL3001",
        );
      }
      validateDueRecurrence(instrument, action, actionBase, add);
    }

    if (definition.deadline) {
      if (definition.due) {
        add(
          [...actionBase, "deadline"],
          "a action cannot declare both a due condition and a deadline",
          "UDL3001",
        );
      }
      const schema = instrument.fields[definition.deadline.field];
      if (!schema) {
        add(
          [...actionBase, "deadline", "field"],
          `deadline references unknown field ${definition.deadline.field}`,
          "UDL3001",
        );
      } else if (!isDateTimeFormat(schema.format)) {
        add(
          [...actionBase, "deadline", "field"],
          "deadline field must be a date-time field",
          "UDL5008",
        );
      }
      if (
        definition.deadline.offset &&
        fixedIsoDurationMs(definition.deadline.offset) === null
      ) {
        add(
          [...actionBase, "deadline", "offset"],
          "deadline.offset must be a fixed ISO-8601 duration using weeks, days, hours, minutes, or seconds",
          "UDL3001",
        );
      }
    }

    if (definition.examples) {
      addDuplicateIssues(
        definition.examples.map((example) => example.name),
        [...actionBase, "examples"],
        "example name",
        add,
      );
      const inputSchema = exampleInputSchema(instrument, action, definition);
      definition.examples.forEach((example, exampleIndex) => {
        const input = exampleInputForUdlValidation(instrument, example.input);
        for (const error of validateUdlSchemaValue(inputSchema, input).errors) {
          add(
            [...actionBase, "examples", exampleIndex, "input"],
            `example ${example.name} input ${error.error} at ${error.instanceLocation || "/"}`,
            "UDL5008",
          );
        }
      });
    }
  }
  validateRecurringLiabilityOverlap(instrument, base, add);
}

function validateDueRecurrence(
  instrument: UdlInstrument,
  action: string,
  actionBase: readonly PropertyKey[],
  add: AddIssue,
): void {
  const definition = instrument.actions[action];
  const every = definition?.due?.every;
  if (!definition || !every) return;

  const recurrenceBase = [...actionBase, "due", "every"] as const;
  if (
    typeof every.period === "string" &&
    fixedIsoDurationMs(every.period) === null
  ) {
    add(
      [...recurrenceBase, "period"],
      "recurrence period must be a fixed ISO-8601 duration using weeks, days, hours, minutes, or seconds",
      "UDL3001",
    );
  }

  const terminations = [
    every.countField === undefined ? undefined : "countField",
    every.untilField === undefined ? undefined : "untilField",
    every.untilAction === undefined ? undefined : "untilAction",
  ].filter((value): value is string => value !== undefined);
  if (terminations.length === 0) {
    add(
      recurrenceBase,
      "recurrence must declare a termination using countField, untilField, or untilAction",
      "UDL3001",
    );
  } else if (terminations.length > 1) {
    add(
      recurrenceBase,
      `recurrence termination is ambiguous: ${terminations.join(", ")}`,
      "UDL3001",
    );
  }
  if (
    (every.untilField !== undefined || every.untilAction !== undefined) &&
    every.liability !== "one_open"
  ) {
    add(
      [...recurrenceBase, "liability"],
      "open-ended recurrence must declare liability one_open",
      "UDL3001",
    );
  }
  if (every.liability === "one_open" && every.delinquency !== "parent_policy") {
    add(
      [...recurrenceBase, "delinquency"],
      "one-open recurrence must reuse delinquency parent_policy",
      "UDL3001",
    );
  }
  if (
    (every.untilField !== undefined || every.untilAction !== undefined) &&
    every.drainAction === undefined
  ) {
    add(
      [...recurrenceBase, "drainAction"],
      "open-ended recurrence must declare its drain action",
      "UDL3001",
    );
  }

  if (every.countField) {
    const count = instrument.fields[every.countField];
    if (!count) {
      add(
        [...recurrenceBase, "countField"],
        `recurrence count references unknown field ${every.countField}`,
        "UDL3001",
      );
    } else if (count.type !== "integer") {
      add(
        [...recurrenceBase, "countField"],
        "recurrence count field must be an integer field",
        "UDL3001",
      );
    } else if (!instrument.required.includes(every.countField)) {
      add(
        [...recurrenceBase, "countField"],
        "recurrence count field must be required",
        "UDL3001",
      );
    } else if (instrument.update?.fields.includes(every.countField)) {
      add(
        [...recurrenceBase, "countField"],
        "recurrence count field cannot be mutable",
        "UDL3001",
      );
    }
  }

  if (every.untilField) {
    const until = instrument.fields[every.untilField];
    if (!until) {
      add(
        [...recurrenceBase, "untilField"],
        `recurrence termination references unknown field ${every.untilField}`,
        "UDL3001",
      );
    } else if (!isDateTimeFormat(until.format)) {
      add(
        [...recurrenceBase, "untilField"],
        "recurrence termination field must be a date-time field",
        "UDL3001",
      );
    } else if (!instrument.required.includes(every.untilField)) {
      add(
        [...recurrenceBase, "untilField"],
        "recurrence termination field must be required",
        "UDL3001",
      );
    } else if (instrument.update?.fields.includes(every.untilField)) {
      add(
        [...recurrenceBase, "untilField"],
        "recurrence termination field cannot be mutable",
        "UDL3001",
      );
    }
  }

  if (
    every.liability === "one_open" &&
    (definition.moves.length > 0 || definition.payout !== undefined)
  ) {
    add(
      [...actionBase, "moves"],
      "a recurring due action cannot move money; it may only open one period or invoke a declared system action",
      "UDL3001",
    );
  }

  if (every.untilAction) {
    if (every.drainAction && every.drainAction !== every.untilAction) {
      add(
        [...recurrenceBase, "drainAction"],
        "port recurrence termination must use untilAction as its drainAction",
        "UDL3001",
      );
    }
    validateRecurrenceTerminationAction(
      instrument,
      action,
      every.untilAction,
      recurrenceBase,
      add,
    );
  } else if (every.untilField) {
    const drainAction = every.drainAction;
    const drainDefinition = drainAction
      ? instrument.actions[drainAction]
      : undefined;
    if (
      drainAction &&
      (!drainDefinition ||
        drainDefinition.due?.every !== undefined ||
        drainDefinition.due?.field !== every.untilField ||
        !recurrenceActionExits(instrument, action, drainAction))
    ) {
      add(
        [...recurrenceBase, "drainAction"],
        `stored-date recurrence drain action ${drainAction} must be a one-shot due action on ${every.untilField} that exits every recurring state`,
        "UDL3001",
      );
    } else if (
      drainAction &&
      drainDefinition &&
      instrumentOwnsReservation(instrument) &&
      !actionDrains(drainDefinition)
    ) {
      add(
        [...actionPath(recurrenceBase, drainAction), "moves"],
        `recurrence termination action ${drainAction} must drain its reserved money`,
        "UDL3001",
      );
    }
    if (
      drainAction &&
      drainDefinition &&
      (drainDefinition.payout !== undefined ||
        drainDefinition.moves.some(
          (move) => move.operation !== "internal_transfer.void",
        ))
    ) {
      add(
        [...actionPath(recurrenceBase, drainAction), "moves"],
        "a stored-date recurrence termination may only void reserved money; no timeout creates, reserves, posts, or pays out money",
        "UDL3001",
      );
    }
  }
}

function validateRecurrenceTerminationAction(
  instrument: UdlInstrument,
  recurringAction: string,
  terminationAction: string,
  recurrenceBase: readonly PropertyKey[],
  add: AddIssue,
): void {
  const definition = instrument.actions[terminationAction];
  const terminationPath = actionPath(recurrenceBase, terminationAction);
  if (!definition) {
    add(
      [...recurrenceBase, "untilAction"],
      `recurrence termination references unknown action ${terminationAction}`,
      "UDL3001",
    );
    return;
  }
  if (!definition.port) {
    add(
      [...recurrenceBase, "untilAction"],
      `recurrence termination action ${terminationAction} must declare a port`,
      "UDL3001",
    );
  }
  if (!recurrenceActionExits(instrument, recurringAction, terminationAction)) {
    add(
      [...recurrenceBase, "untilAction"],
      `recurrence termination action ${terminationAction} must exit every recurring source state`,
      "UDL3001",
    );
  }
  if (instrumentOwnsReservation(instrument) && !actionDrains(definition)) {
    add(
      [...terminationPath, "moves"],
      `recurrence termination action ${terminationAction} must drain its reserved money`,
      "UDL3001",
    );
  }
}

function actionPath(
  recurrenceBase: readonly PropertyKey[],
  action: string,
): readonly PropertyKey[] {
  return [...recurrenceBase.slice(0, -3), action];
}

function recurrenceActionExits(
  instrument: UdlInstrument,
  recurringAction: string,
  terminationAction: string,
): boolean {
  const recurring = instrument.lifecycle.transitions[recurringAction];
  const termination = instrument.lifecycle.transitions[terminationAction];
  if (!recurring || !termination) return false;
  const recurringStates = new Set([...recurring.from, recurring.to]);
  return (
    [...recurringStates].every((state) => termination.from.includes(state)) &&
    !recurringStates.has(termination.to)
  );
}

function actionDrains(definition: UdlAction): boolean {
  return (
    definition.requiresDrainedAccount !== undefined ||
    definition.moves.some((move) => move.operation === "internal_transfer.void")
  );
}

function instrumentOwnsReservation(instrument: UdlInstrument): boolean {
  return Object.values(instrument.actions).some((definition) =>
    definition.moves.some(
      (move) => move.operation === "internal_transfer.reserve",
    ),
  );
}

function validateRecurringLiabilityOverlap(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  const recurring = Object.entries(instrument.actions).filter(
    ([, definition]) => definition.due?.every?.liability === "one_open",
  );
  for (const [index, [action, definition]] of recurring.entries()) {
    const transition = instrument.lifecycle.transitions[action];
    if (!transition || !definition.due) continue;
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      const [priorAction, priorDefinition] = recurring[
        priorIndex
      ] as (typeof recurring)[number];
      const priorTransition = instrument.lifecycle.transitions[priorAction];
      if (
        !priorTransition ||
        priorDefinition.due?.field !== definition.due.field
      ) {
        continue;
      }
      const priorStates = new Set(priorTransition.from);
      const overlap = transition.from.filter((state) => priorStates.has(state));
      if (overlap.length === 0) continue;
      add(
        [...base, "actions", action, "due", "every"],
        `recurring due actions ${priorAction} and ${action} overlap period liability in states ${overlap.join(", ")}`,
        "UDL3001",
      );
    }
  }
}

function validateDecidedAmount(
  instrument: UdlInstrument,
  action: string,
  actionBase: readonly PropertyKey[],
  add: AddIssue,
): void {
  const definition = instrument.actions[action];
  const clause = definition?.decidedAmount;
  if (!definition || !clause) return;

  const clauseBase = [...actionBase, "decidedAmount"] as const;
  const inputField = recordValue(definition.input?.properties)[clause.field];
  if (!inputField || !isMoneySchema(recordValue(inputField))) {
    add(
      [...clauseBase, "field"],
      `decided amount field ${clause.field} must be a declared action input money field`,
      "UDL4001",
    );
  }
  const inputRequired = definition.input?.required;
  if (!Array.isArray(inputRequired) || !inputRequired.includes(clause.field)) {
    add(
      [...clauseBase, "field"],
      `decided amount field ${clause.field} must be required by the action input`,
      "UDL2002",
    );
  }

  const boundSchema = instrument.fields[clause.boundField];
  if (!boundSchema || !isMoneySchema(boundSchema)) {
    add(
      [...clauseBase, "boundField"],
      `decided amount bound ${clause.boundField} must be a declared instrument money field`,
      "UDL4001",
    );
  }
  if (!instrument.required.includes(clause.boundField)) {
    add(
      [...clauseBase, "boundField"],
      `decided amount bound ${clause.boundField} must be required`,
      "UDL2002",
    );
  }
  if (instrument.update?.fields.includes(clause.boundField)) {
    add(
      [...clauseBase, "boundField"],
      `decided amount bound ${clause.boundField} cannot be mutable`,
      "UDL5008",
    );
  }

  const decidedMoves = definition.moves.filter(
    (move) =>
      move.operation === "internal_transfer.post" &&
      move.bind.amount?.from === "input" &&
      move.bind.amount.path === clause.field,
  );
  if (decidedMoves.length !== 1) {
    add(
      [...clauseBase, "field"],
      `decided amount field ${clause.field} must fund exactly one internal_transfer.post move`,
      "UDL4001",
    );
  }
  const decidedMove = decidedMoves.length === 1 ? decidedMoves[0] : undefined;
  if (decidedMove) {
    const moveIndex = definition.moves.indexOf(decidedMove);
    const postMode = decidedMove.bind.postMode;
    if (postMode?.from !== "const" || postMode.value !== "partial_only") {
      add(
        [...actionBase, "moves", moveIndex, "bind", "postMode"],
        "decided amount post must use partial_only so the remainder stays reserved",
        "UDL5008",
      );
    }
    const currencyFields = Object.entries(instrument.fields).filter(
      ([, schema]) => isCurrencySchema(schema),
    );
    const currency = decidedMove.bind.currency;
    if (
      currencyFields.length !== 1 ||
      currency?.from !== "instance" ||
      currency.path !== `fields.${currencyFields[0]?.[0]}`
    ) {
      add(
        [...actionBase, "moves", moveIndex, "bind", "currency"],
        "decided amount post must bind the instrument currency",
        "UDL5008",
      );
    }
  }

  const remainderMoves = definition.moves.filter(
    (move) => move.key === "remainder",
  );
  if (remainderMoves.length !== 1) {
    add(
      [...actionBase, "moves"],
      `decided amount action must declare exactly one remainder move; found ${remainderMoves.length}`,
      "UDL5008",
    );
  }
  const remainderMove =
    remainderMoves.length === 1 ? remainderMoves[0] : undefined;
  if (remainderMove && remainderMove.operation !== "internal_transfer.void") {
    add(
      [
        ...actionBase,
        "moves",
        definition.moves.indexOf(remainderMove),
        "operation",
      ],
      "decided amount remainder move must drain the reservation with internal_transfer.void",
      "UDL4001",
    );
  }

  const remainderDefinition = instrument.actions[clause.remainderAction];
  if (!remainderDefinition) {
    add(
      [...clauseBase, "remainderAction"],
      `decided amount remainder action ${clause.remainderAction} is not declared`,
      "UDL4001",
    );
    return;
  }
  if (clause.remainderAction === action) {
    add(
      [...clauseBase, "remainderAction"],
      "decided amount remainder action must be a distinct action",
      "UDL4001",
    );
  }

  const transition = instrument.lifecycle.transitions[action];
  const remainderTransition =
    instrument.lifecycle.transitions[clause.remainderAction];
  if (
    transition &&
    remainderTransition &&
    (transition.from.length !== remainderTransition.from.length ||
      transition.from.some(
        (state) => !remainderTransition.from.includes(state),
      ))
  ) {
    add(
      [...clauseBase, "remainderAction"],
      `decided amount remainder action ${clause.remainderAction} must start from the same lifecycle states as ${action}`,
      "UDL4001",
    );
  }

  const namedDrains = remainderDefinition.moves.filter(
    (move) => move.operation === "internal_transfer.void",
  );
  if (namedDrains.length !== 1 || remainderDefinition.moves.length !== 1) {
    add(
      [...actionBase.slice(0, -1), clause.remainderAction, "moves"],
      `decided amount remainder action ${clause.remainderAction} must declare exactly one reservation drain; found ${namedDrains.length}`,
      "UDL4001",
    );
  }
  const namedDrain =
    namedDrains.length === 1 && remainderDefinition.moves.length === 1
      ? namedDrains[0]
      : undefined;
  if (!remainderMove || !namedDrain) return;

  const decidedTransfer = decidedMove?.bind.transferId;
  const remainderTransfer = remainderMove.bind.transferId;
  const namedTransfer = namedDrain.bind.transferId;
  if (
    !sameInstanceBinding(decidedTransfer, remainderTransfer) ||
    !sameInstanceBinding(remainderTransfer, namedTransfer)
  ) {
    add(
      [...clauseBase, "remainderAction"],
      `decided amount and remainder action ${clause.remainderAction} must drain the same reservation`,
      "UDL4001",
    );
  }
}

function sameInstanceBinding(
  left: UdlMove["bind"][string] | undefined,
  right: UdlMove["bind"][string] | undefined,
): boolean {
  return (
    left?.from === "instance" &&
    right?.from === "instance" &&
    left.path.startsWith("refs.") &&
    left.path === right.path
  );
}

function validatePayoutsAndSettlement(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  instruments: ReadonlyMap<string, UdlInstrument>,
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const payoutEntries = Object.entries(instrument.actions).filter(
    ([, definition]) => definition.payout !== undefined,
  );
  const reconcilingEntries = Object.entries(instrument.actions).filter(
    ([, definition]) => definition.reconcile !== undefined,
  );
  if (payoutEntries.length > 0 && reconcilingEntries.length !== 1) {
    add(
      [...base, "actions"],
      `payout-owning instrument must declare exactly one reconciling action; found ${reconcilingEntries.length}`,
      "UDL5005",
    );
  }
  if (payoutEntries.length > 0) {
    // The bank's own line is the only evidence that a payout left the estate.
    // A provider confirmation is our row read back to us, and a credit is
    // money arriving, so neither closes a payout. The match law stays the
    // author's call.
    for (const [action, definition] of reconcilingEntries) {
      (definition.reconcile ?? []).forEach((reconcile, index) => {
        if (
          reconcile.evidence === "statement_line" &&
          reconcile.direction === "debit"
        ) {
          return;
        }
        add(
          [...base, "actions", action, "reconcile", index, "evidence"],
          `payout-owning instrument ${instrument.id} action ${action} must reconcile against a debit statement_line; found ${reconcile.direction} ${reconcile.evidence}`,
          "UDL5005",
        );
      });
    }
  }
  const soleReconciles =
    reconcilingEntries.length === 1
      ? reconcilingEntries[0]?.[1].reconcile
      : undefined;
  if (soleReconciles) {
    const expected = new Set(
      soleReconciles.map((reconcile) => reconcile.counterpartyRef),
    );
    for (const [action, definition] of payoutEntries) {
      if (definition.payout && expected.has(definition.payout.capture)) {
        continue;
      }
      add(
        [...base, "actions", action, "payout", "capture"],
        `action ${action} payout capture ${definition.payout?.capture} is expected by no reconcile`,
        "UDL5005",
      );
    }
  }

  const reservedRefs = new Set([
    ...Object.values(instrument.actions).flatMap((action) =>
      Object.keys(action.captureInput ?? {}),
    ),
    ...Object.values(instrument.actions).flatMap((action) =>
      [...action.steps, ...action.moves].flatMap((step) =>
        Object.keys(step.capture ?? {}),
      ),
    ),
    ...Object.values(instrument.actions).flatMap((action) =>
      action.signedSum
        ? [
            action.signedSum.amountRef,
            ...action.signedSum.sources.map((source) => source.subtotalRef),
          ]
        : [],
    ),
    ...Object.values(instrument.actions).flatMap((action) =>
      action.distribute ? [action.distribute.amountRef] : [],
    ),
    ...Object.values(instrument.actions).flatMap((action) =>
      action.remainder
        ? [
            action.remainder.amountRef,
            ...(action.remainder.accumulateRef
              ? [action.remainder.accumulateRef]
              : []),
          ]
        : [],
    ),
    ...quoteRefKeys(instrument),
    ...(instrument.subject ? ["subject"] : []),
  ]);
  const moneyWriters = moneyRefWriters(instrument);
  const payoutWriters = new Map<string, string[]>();
  for (const [action, definition] of Object.entries(instrument.actions)) {
    if (!definition.payout) continue;
    const payout = definition.payout;
    const payoutBase = [...base, "actions", action, "payout"] as const;
    if (action === "create") {
      add(payoutBase, "create cannot declare a payout intent", "UDL5005");
    }
    if (definition.steps.length > 0 || definition.moves.length > 0) {
      add(
        payoutBase,
        `action ${action} payout intent cannot combine with kernel steps or moves`,
        "UDL5005",
      );
    }
    const prior = payoutWriters.get(payout.capture) ?? [];
    if (reservedRefs.has(payout.capture) || prior.length > 0) {
      add(
        [...payoutBase, "capture"],
        `payout capture ${payout.capture} collides with an existing instrument ref key`,
        "UDL5005",
      );
    }
    payoutWriters.set(payout.capture, [...prior, action]);

    const amount = payout.amount;
    const [scope, key] = amount.split(".") as [string, string];
    const amountWriters = moneyWriters.get(key) ?? [];
    const amountDeclared =
      scope === "fields"
        ? isMoneySchema(instrument.fields[key] ?? {})
        : scope === "refs" && amountWriters.length > 0;
    if (!amountDeclared) {
      add(
        [...payoutBase, "amount"],
        `payout amount ${amount} must name a declared money field or money ref`,
        "UDL5005",
      );
    } else if (
      scope === "refs" &&
      !amountWriters.includes(action) &&
      !amountWriters.includes("create") &&
      !actionGroupDominatesReader(instrument, amountWriters, action)
    ) {
      add(
        [...payoutBase, "amount"],
        `payout amount ${amount} can be read before money writers ${amountWriters.join(" or ")}`,
        "UDL5005",
      );
    }

    const currency = instrument.fields[payout.currencyField];
    if (!currency || !isCurrencySchema(currency)) {
      add(
        [...payoutBase, "currencyField"],
        `payout currencyField ${payout.currencyField} must name a currency field`,
        "UDL5005",
      );
    }
    const source = instrument.fields[payout.sourceAccountField];
    if (!source || !references.accepts(source, "acct")) {
      add(
        [...payoutBase, "sourceAccountField"],
        `payout sourceAccountField ${payout.sourceAccountField} must name an account-id field`,
        "UDL5005",
      );
    }
    const beneficiary = instrument.fields[payout.beneficiaryField];
    if (!beneficiary || !references.accepts(beneficiary, "ben")) {
      add(
        [...payoutBase, "beneficiaryField"],
        `payout beneficiaryField ${payout.beneficiaryField} must name a beneficiary-id field`,
        "UDL5005",
      );
    }
    const beneficiaryPartyField = instrument.parties?.beneficiary;
    if (!beneficiaryPartyField) {
      add(
        [...payoutBase, "beneficiaryPartyField"],
        "payout requires parties.beneficiary to bind its destination party",
        "UDL5005",
      );
    } else if (payout.beneficiaryPartyField !== beneficiaryPartyField) {
      add(
        [...payoutBase, "beneficiaryPartyField"],
        `payout beneficiaryPartyField ${payout.beneficiaryPartyField} must equal parties.beneficiary ${beneficiaryPartyField}`,
        "UDL5005",
      );
    }
  }

  validateReconciles(
    instrument,
    base,
    instruments,
    reservedRefs,
    payoutWriters,
    moneyWriters,
    references,
    add,
  );
}

/**
 * The five reconcile laws. An expectation names money the instrument can
 * describe but cannot yet see, so every part of it has to be checkable before
 * an instance exists: the expected fields carry money, one source answers one
 * counterparty row, the window closes under a sweep that is actually declared,
 * the forgiveness is bounded by a dial, and the unmatched case has a capped
 * child to land in.
 */
function validateReconciles(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  instruments: ReadonlyMap<string, UdlInstrument>,
  reservedRefs: ReadonlySet<string>,
  payoutWriters: ReadonlyMap<string, string[]>,
  moneyWriters: ReadonlyMap<string, string[]>,
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const captures = new Set<string>();
  for (const [action, definition] of Object.entries(instrument.actions)) {
    if (!definition.reconcile) continue;
    const counterparties = new Set<string>();
    definition.reconcile.forEach((reconcile, index) => {
      const path = [...base, "actions", action, "reconcile", index] as const;

      // Law: the expectation is money this instrument can already describe,
      // read the same way a payout intent reads its amount.
      const [amountScope, amountKey] = reconcile.amount.split(".") as [
        string,
        string,
      ];
      const amountDeclared =
        amountScope === "fields"
          ? isMoneySchema(instrument.fields[amountKey] ?? {})
          : amountScope === "refs" &&
            (moneyWriters.get(amountKey) ?? []).length > 0;
      if (!amountDeclared) {
        add(
          [...path, "amount"],
          `reconcile amount ${reconcile.amount} must name a declared money field or money ref`,
          "UDL5005",
        );
      }
      const currency = instrument.fields[reconcile.currencyField];
      if (!currency) {
        add(
          [...path, "currencyField"],
          `reconcile expects unknown field ${reconcile.currencyField}`,
          "UDL5005",
        );
      } else if (
        currency.type !== "string" ||
        !instrument.required.includes(reconcile.currencyField)
      ) {
        add(
          [...path, "currencyField"],
          `${instrument.id}.${reconcile.currencyField} must be a required text field to carry the expected currency`,
          "UDL5005",
        );
      }

      // Law: one evidence source answers one counterparty row. Two
      // expectations over the same row would match the same money twice.
      if (counterparties.has(reconcile.counterpartyRef)) {
        add(
          [...path, "counterpartyRef"],
          `action ${action} expects ${reconcile.counterpartyRef} twice; one counterparty row answers one reconcile`,
          "UDL5005",
        );
      }
      counterparties.add(reconcile.counterpartyRef);
      const writers = payoutWriters.get(reconcile.counterpartyRef) ?? [];
      if (reconcile.evidence === "statement_line") {
        if (writers.length === 0) {
          add(
            [...path, "counterpartyRef"],
            `reconcile counterpartyRef ${reconcile.counterpartyRef} is not captured by a payout intent`,
            "UDL5005",
          );
        } else if (!actionGroupDominatesReader(instrument, writers, action)) {
          add(
            path,
            `reconcile can read ${reconcile.counterpartyRef} before payout writers ${writers.join(" or ")}`,
            "UDL5005",
          );
        }
      }

      // Law: the window is a fixed duration or a stored deadline, and the due
      // sweep that closes it is declared on the same action. A window nothing
      // fires is a wait with no end.
      const due = definition.due;
      if ("offset" in reconcile.within) {
        const offset = reconcile.within.offset;
        if (fixedIsoDurationMs(offset) === null) {
          add(
            [...path, "within", "offset"],
            `reconcile window ${offset} is not a fixed ISO-8601 duration`,
            "UDL5005",
          );
        } else if (!due || due.offset !== offset) {
          add(
            [...path, "within", "offset"],
            `reconcile window ${offset} is closed by no due condition on ${action}`,
            "UDL5005",
          );
        }
      } else {
        const deadline = instrument.fields[reconcile.within.field];
        if (!deadline || !isDateTimeFormat(deadline.format)) {
          add(
            [...path, "within", "field"],
            `reconcile window ${reconcile.within.field} must be a stored date-time field`,
            "UDL5005",
          );
        } else if (
          !due ||
          due.field !== reconcile.within.field ||
          due.offset !== undefined
        ) {
          add(
            [...path, "within", "field"],
            `reconcile window ${reconcile.within.field} is closed by no due condition on ${action}`,
            "UDL5005",
          );
        }
      }

      // Law: tolerance never exceeds its dial. The authored number is the
      // forgiveness; the dial is the ceiling a tenant may not raise past.
      const match = reconcile.match;
      if (match.law === "tolerance") {
        const dial = instrument.dials?.find(
          (candidate) => candidate.key === match.dial,
        );
        if (!dial || dial.kind !== "reconcile_tolerance") {
          add(
            [...path, "match", "dial"],
            `reconcile tolerance names no reconcile_tolerance dial ${match.dial}`,
            "UDL5005",
          );
        } else if (match.minorUnits > dial.maxMinorUnits) {
          add(
            [...path, "match", "minorUnits"],
            `reconcile tolerance ${match.minorUnits} exceeds dial ${dial.key} ceiling ${dial.maxMinorUnits}`,
            "UDL5005",
          );
        }
      }

      // Law: matched or exception. The break lands in a child of this
      // instrument that points back at it, never in a status nobody reads.
      const child = instruments.get(reconcile.exception.childInstrumentId);
      if (!child) {
        add(
          [...path, "exception", "childInstrumentId"],
          `reconcile raises unknown exception instrument ${reconcile.exception.childInstrumentId}`,
          "UDL5007",
        );
      } else {
        const exception = reconcile.exception as typeof reconcile.exception & {
          readonly amountField: string;
          readonly reasonField: string;
        };
        for (const problem of reconcileExceptionChildProblems(
          instrument.idPrefix,
          child,
          exception,
          references,
        )) {
          const field =
            problem === "UDL5009" || problem === "UDL5010"
              ? "amountField"
              : problem === "UDL5011" || problem === "UDL5012"
                ? "reasonField"
                : "refField";
          add(
            [...path, "exception", field],
            reconcileExceptionProblemMessage(
              problem,
              instrument,
              child,
              exception,
            ),
            problem,
          );
        }
      }

      if (
        reservedRefs.has(reconcile.capture) ||
        payoutWriters.has(reconcile.capture) ||
        captures.has(reconcile.capture)
      ) {
        add(
          [...path, "capture"],
          `reconcile capture ${reconcile.capture} collides with an existing instrument ref key`,
          "UDL5005",
        );
      }
      captures.add(reconcile.capture);
    });

    if (!instrument.lifecycle.transitions[action]) {
      add(
        [...base, "actions", action, "reconcile"],
        "a reconciling action needs a lifecycle transition and cannot run on create",
        "UDL5005",
      );
    }
    const callerFacets = [
      definition.port ? "port" : undefined,
      definition.publicAction ? "publicAction" : undefined,
      definition.input ? "input" : undefined,
      definition.captureInput ? "captureInput" : undefined,
      definition.deadline ? "deadline" : undefined,
    ].filter((facet): facet is string => facet !== undefined);
    for (const facet of callerFacets) {
      add(
        [...base, "actions", action, facet],
        `a reconciling action is system-only and cannot declare ${facet}`,
        "UDL5005",
      );
    }
    if (definition.steps.length > 0) {
      add(
        [...base, "actions", action, "steps"],
        "a reconciling action cannot add kernel steps",
        "UDL5005",
      );
    }
    if (definition.moves.length > 0) {
      add(
        [...base, "actions", action, "moves"],
        "a reconciling action cannot move money",
        "UDL5005",
      );
    }
  }
}

function moneyRefWriters(
  instrument: UdlInstrument,
): ReadonlyMap<string, string[]> {
  const writers = new Map<string, string[]>();
  for (const [actionName, action] of Object.entries(instrument.actions)) {
    const refs = [
      ...(action.signedSum
        ? [
            action.signedSum.amountRef,
            ...action.signedSum.sources.map((source) => source.subtotalRef),
          ]
        : []),
      ...[...action.steps, ...action.moves].flatMap((step) =>
        Object.entries(step.capture ?? {}).flatMap(([ref, output]) =>
          output === "postedAmount" ? [ref] : [],
        ),
      ),
    ];
    for (const ref of refs) {
      writers.set(ref, [...(writers.get(ref) ?? []), actionName]);
    }
  }
  return writers;
}

/**
 * Shape rules for one resolved reference gate: derived bindings and the
 * uniqueness claim are create-only, bind keys must be declared immutable
 * fields, and every referenced path must name declared target structure. The
 * exact mirror of the Hyperscale contract registry's rules, so a document that loads
 * open-grammar clean also loads registry clean.
 */
function validateGateShape(
  instrument: UdlInstrument,
  action: string,
  gate: UdlGate,
  target: UdlInstrument,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  if (gate.unique && action !== "create") {
    add([...base, "unique"], "unique is a create admission gate", "UDL5001");
  }
  if (gate.bind && action !== "create") {
    add([...base, "bind"], "bind derives fields at create only", "UDL5001");
  }
  if (gate.bind && Object.keys(gate.bind).length === 0) {
    add([...base, "bind"], "bind must not be empty", "UDL5001");
  }
  if (gate.match && Object.keys(gate.match).length === 0) {
    add([...base, "match"], "match must not be empty", "UDL5001");
  }
  if (gate.optional && instrument.required.includes(gate.field)) {
    add(
      [...base, "optional"],
      `optional declares an opt-out on ${gate.field}, which required lists`,
      "UDL5001",
    );
  }
  for (const [key, path] of Object.entries(gate.bind ?? {})) {
    if (gate.optional && instrument.required.includes(key)) {
      add(
        [...base, "bind", key],
        `an optional reference can only bind optional fields; required lists ${key}`,
        "UDL5001",
      );
    }
    if (!Object.hasOwn(instrument.fields, key)) {
      add(
        [...base, "bind", key],
        `bind targets unknown field ${key}`,
        "UDL5001",
      );
    }
    if (key === gate.field) {
      add(
        [...base, "bind", key],
        "bind cannot target the gate field itself",
        "UDL5001",
      );
    }
    if (instrument.update?.fields.includes(key)) {
      add(
        [...base, "bind", key],
        `bind targets ${key}, which update declares mutable`,
        "UDL5001",
      );
    }
    if (path === "instrumentInstanceId") {
      add(
        [...base, "bind", key],
        "the gate field already carries the referenced id",
        "UDL5001",
      );
    } else if (!referencedPathDeclared(target, path)) {
      add(
        [...base, "bind", key],
        `bind reads ${path}, which ${target.id} does not declare`,
        "UDL5001",
      );
    }
  }
  for (const [localPath, path] of Object.entries(gate.match ?? {})) {
    const localOk =
      action === "create"
        ? localPath.startsWith("fields.") &&
          Object.hasOwn(instrument.fields, localPath.slice("fields.".length))
        : localPath === "instrumentInstanceId" ||
          (localPath.startsWith("fields.") &&
            Object.hasOwn(
              instrument.fields,
              localPath.slice("fields.".length),
            )) ||
          (localPath.startsWith("refs.") &&
            declaredRefKeys(instrument).has(localPath.slice("refs.".length)));
    if (!localOk) {
      add(
        [...base, "match", localPath],
        action === "create"
          ? "a create match may only read the instrument's own declared fields"
          : `match reads unknown local path ${localPath}`,
        "UDL5001",
      );
    }
    if (!referencedPathDeclared(target, path)) {
      add(
        [...base, "match", localPath],
        `match reads ${path}, which ${target.id} does not declare`,
        "UDL5001",
      );
    }
  }
}

/** Every `refs.<key>` a instrument's instances can legitimately carry. */
function declaredRefKeys(instrument: UdlInstrument): ReadonlySet<string> {
  return new Set([
    ...Object.values(instrument.actions).flatMap((action) =>
      action.payout ? [action.payout.capture] : [],
    ),
    ...Object.values(instrument.actions).flatMap((action) =>
      (action.reconcile ?? []).map((reconcile) => reconcile.capture),
    ),
    ...Object.values(instrument.actions).flatMap((action) =>
      Object.keys(action.captureInput ?? {}),
    ),
    ...Object.values(instrument.actions).flatMap((action) =>
      [...action.steps, ...action.moves].flatMap((step) =>
        Object.keys(step.capture ?? {}),
      ),
    ),
    ...Object.values(instrument.actions).flatMap((action) =>
      action.signedSum
        ? [
            action.signedSum.amountRef,
            ...action.signedSum.sources.map((source) => source.subtotalRef),
          ]
        : [],
    ),
    ...quoteRefKeys(instrument),
    ...(instrument.subject ? ["subject"] : []),
  ]);
}

/** Whether a bind/match referenced path names declared target structure. */
function referencedPathDeclared(target: UdlInstrument, path: string): boolean {
  if (path === "instrumentInstanceId") return true;
  if (path.startsWith("fields.")) {
    return Object.hasOwn(target.fields, path.slice("fields.".length));
  }
  if (path.startsWith("refs.")) {
    return declaredRefKeys(target).has(path.slice("refs.".length));
  }
  return false;
}

function validateStep(
  instrument: UdlInstrument,
  action: UdlAction,
  step: UdlStep | UdlMove,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  if (Object.keys(step.bind).length === 0) {
    add(
      [...base, "bind"],
      "a kernel step must bind at least one value",
      "UDL5008",
    );
  }
  if (step.capture && Object.keys(step.capture).length === 0) {
    add([...base, "capture"], "capture must not be empty", "UDL5008");
  }
  const inputFields = recordValue(action.input?.properties);
  for (const [field, binding] of Object.entries(step.bind)) {
    if (binding.from === "const") continue;
    if (binding.from === "input") {
      const root = binding.path.split(".")[0] as string;
      if (!Object.hasOwn(inputFields, root)) {
        add(
          [...base, "bind", field, "path"],
          `input binding references undeclared action input field ${root}`,
          "UDL5008",
        );
      }
      continue;
    }
    if (binding.path.startsWith("fields.")) {
      const root = binding.path.split(".")[1] as string;
      if (!Object.hasOwn(instrument.fields, root)) {
        add(
          [...base, "bind", field, "path"],
          `instance binding references unknown instrument field ${root}`,
          "UDL5008",
        );
      }
      continue;
    }
    if (
      binding.path !== "instrumentInstanceId" &&
      binding.path !== "productId" &&
      !binding.path.startsWith("refs.")
    ) {
      add(
        [...base, "bind", field, "path"],
        `instance binding path ${binding.path} must read instrumentInstanceId, productId, fields.*, or refs.*`,
        "UDL5008",
      );
    }
  }
  if (
    step.operation === "account.freeze" ||
    step.operation === "account.unfreeze"
  ) {
    // Freeze steps act on an account the instance already carries and move no
    // money: the account must come from instance state, never caller input,
    // and a monetary leg on a freeze step is a contradiction in terms.
    const accountId = step.bind.accountId;
    if (!accountId || accountId.from !== "instance") {
      add(
        [...base, "bind", "accountId"],
        `${step.operation} must bind accountId from an instance path`,
        "UDL5008",
      );
    }
    for (const monetary of ["amount", "currency"] as const) {
      if (Object.hasOwn(step.bind, monetary)) {
        add(
          [...base, "bind", monetary],
          `${step.operation} must not bind ${monetary}`,
          "UDL5008",
        );
      }
    }
  }
  if (
    step.operation === "internal_transfer.create" ||
    step.operation === "internal_transfer.reserve"
  ) {
    const source = step.bind.sourceAccountId;
    const destination = step.bind.destinationAccountId;
    if (
      source?.from === "instance" &&
      destination?.from === "instance" &&
      source.path === destination.path
    ) {
      add(
        [...base, "bind", "destinationAccountId"],
        "transfer source and destination must be different accounts",
        "UDL4001",
      );
    }
  }
}

/**
 * Every ref a quoting action seeds: the charge and the net the author named,
 * plus the expiry and fingerprint the machinery derives from the net ref.
 */
function quoteRefKeys(instrument: UdlInstrument): readonly string[] {
  return Object.values(instrument.actions).flatMap((action) =>
    action.quote ? quoteSeededRefKeys(action.quote) : [],
  );
}

function validateQuoteCommit(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const quotingActions = Object.entries(instrument.actions).filter(
    ([, action]) => action.quote,
  );
  for (const [actionName, action] of quotingActions) {
    const quote = action.quote;
    if (!quote) continue;
    const quoteBase = [...base, "actions", actionName, "quote"] as const;
    if (action.earnable) {
      add(
        [...base, "actions", actionName, "earnable"],
        `quoting action ${actionName} prices a refund and cannot be earnable`,
        "UDL5006",
      );
    }
    for (const [slot, field] of [
      ["baseField", quote.baseField],
      ["netDestinationField", quote.netDestinationField],
      ...quote.fixes.map((fixed, index) => [`fixes.${index}`, fixed] as const),
    ] as const) {
      if (Object.hasOwn(instrument.fields, field)) continue;
      add(
        [...quoteBase, slot],
        `quote references unknown field ${field}`,
        "UDL5006",
      );
    }
    const priced = instrument.fields[quote.baseField];
    if (priced && !isMoneySchema(priced)) {
      add(
        [...quoteBase, "baseField"],
        "baseField must be a money field",
        "UDL5006",
      );
    }
    const destination = instrument.fields[quote.netDestinationField];
    if (destination && !references.accepts(destination, "acct")) {
      add(
        [...quoteBase, "netDestinationField"],
        "netDestinationField must be an account-id field",
        "UDL5006",
      );
    }
    for (const [slot, label, field] of [
      ["baseField", "base field", quote.baseField],
      [
        "netDestinationField",
        "net destination field",
        quote.netDestinationField,
      ],
    ] as const) {
      if (quote.fixes.includes(field)) continue;
      add(
        [...quoteBase, slot],
        `quoting action ${actionName} must freeze its ${label} ${field}`,
        "UDL5006",
      );
    }
    for (const field of action.updates ?? []) {
      if (!quote.fixes.includes(field)) continue;
      add(
        [...base, "actions", actionName, "updates"],
        `quoting action ${actionName} freezes ${field} and writes it in the same action`,
        "UDL5006",
      );
    }
    if (quote.anchorField !== undefined) {
      const anchor = instrument.fields[quote.anchorField];
      if (!anchor) {
        add(
          [...quoteBase, "anchorField"],
          `quote references unknown field ${quote.anchorField}`,
          "UDL5006",
        );
      } else if (!isDateTimeFormat(anchor.format)) {
        add(
          [...quoteBase, "anchorField"],
          "anchorField must be a date-time field",
          "UDL5006",
        );
      } else if (!instrument.required.includes(quote.anchorField)) {
        add(
          [...quoteBase, "anchorField"],
          "anchorField must be required",
          "UDL5006",
        );
      }
    }
    if ("offset" in quote.expires) {
      if (fixedIsoDurationMs(quote.expires.offset) === null) {
        add(
          [...quoteBase, "expires", "offset"],
          "the offer's life must be a fixed ISO-8601 duration using weeks, days, hours, minutes, or seconds",
          "UDL5006",
        );
      }
    } else {
      const deadline = instrument.fields[quote.expires.field];
      if (!deadline) {
        add(
          [...quoteBase, "expires", "field"],
          `quote references unknown field ${quote.expires.field}`,
          "UDL5006",
        );
      } else if (!isDateTimeFormat(deadline.format)) {
        add(
          [...quoteBase, "expires", "field"],
          "the offer's deadline field must be a date-time field",
          "UDL5006",
        );
      } else if (!instrument.required.includes(quote.expires.field)) {
        add(
          [...quoteBase, "expires", "field"],
          "the offer's deadline field must be required",
          "UDL5006",
        );
      }
    }
    addDuplicateIssues(
      quote.fixes,
      [...quoteBase, "fixes"],
      "frozen field",
      add,
    );
    const offsets = quote.charges.flatMap((tier) =>
      tier.withinOffset ? [tier.withinOffset] : [],
    );
    addDuplicateIssues(
      offsets,
      [...quoteBase, "charges"],
      "charge offset",
      add,
    );
    if (
      quote.charges.filter((tier) => tier.withinOffset === undefined).length > 1
    ) {
      add(
        [...quoteBase, "charges"],
        "a quote may declare at most one floor tier",
        "UDL5006",
      );
    }
    quote.charges.forEach((tier, index) => {
      if (tier.withinOffset && fixedIsoDurationMs(tier.withinOffset) === null) {
        add(
          [...quoteBase, "charges", index, "withinOffset"],
          "withinOffset must be a fixed ISO-8601 duration using weeks, days, hours, minutes, or seconds",
          "UDL5006",
        );
      }
    });
    const committing = Object.entries(instrument.actions).filter(
      ([, candidate]) => candidate.commit === actionName,
    );
    if (committing.length !== 1) {
      add(
        [...quoteBase],
        `quoting action ${actionName} must be committed by exactly one action, not ${committing.length}`,
        "UDL5006",
      );
    }
  }

  const seededBy = new Map<string, string>();
  for (const [actionName, action] of quotingActions) {
    const quote = action.quote;
    if (!quote) continue;
    const quoteBase = [...base, "actions", actionName, "quote"] as const;
    for (const [slot, label, key] of [
      ["chargeRef", "charge", quote.chargeRef],
      ["netRef", "net", quote.netRef],
      ["netRef", "expiry stamp", quoteExpiresAtRefKey(quote)],
      ["netRef", "frozen fingerprint", quoteFrozenRefKey(quote)],
    ] as const) {
      const owner = seededBy.get(key);
      if (owner === undefined) {
        seededBy.set(key, `${actionName} ${label}`);
        continue;
      }
      add(
        [...quoteBase, slot],
        `quote ref ${key} is seeded twice: ${owner} and ${actionName} ${label}`,
        "UDL5006",
      );
    }
  }

  for (const [actionName, action] of Object.entries(instrument.actions)) {
    const quotingName = action.commit;
    if (quotingName === undefined) continue;
    const commitBase = [...base, "actions", actionName, "commit"] as const;
    if (quotingName === actionName) {
      add(commitBase, "an action cannot commit its own quote", "UDL5006");
      continue;
    }
    const quoting = instrument.actions[quotingName];
    if (!quoting) {
      add(
        commitBase,
        `commit references unknown action ${quotingName}`,
        "UDL5006",
      );
      continue;
    }
    const quote = quoting.quote;
    if (!quote) {
      add(
        commitBase,
        `action ${quotingName} declares no quote to commit`,
        "UDL5006",
      );
      continue;
    }
    if (action.earnable) {
      add(
        [...base, "actions", actionName, "earnable"],
        `commit action ${actionName} spends a quoted refund and cannot be earnable`,
        "UDL5006",
      );
    }
    const transfers = action.moves.filter(
      (move) => move.operation === "internal_transfer.create",
    );
    const net = transfers[0];
    const amount = net?.bind.amount;
    const sourceBinding = net?.bind.sourceAccountId;
    const destinationBinding = net?.bind.destinationAccountId;
    if (
      transfers.length !== 1 ||
      amount?.from !== "instance" ||
      amount.path !== `refs.${quote.netRef}` ||
      sourceBinding?.from !== "instance" ||
      destinationBinding?.from !== "instance" ||
      destinationBinding.path !== `fields.${quote.netDestinationField}`
    ) {
      add(
        [...base, "actions", actionName, "moves"],
        `commit action ${actionName} must contain exactly one internal transfer whose source comes from the instrument instance, amount is refs.${quote.netRef}, and destination is fields.${quote.netDestinationField}`,
        "UDL5006",
      );
    }
  }
}

function validateAggregates(
  instrument: UdlInstrument,
  base: readonly PropertyKey[],
  instruments: ReadonlyMap<string, UdlInstrument>,
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const aggregates = instrument.aggregateInvariants;
  if (!aggregates) return;
  addDuplicateIssues(
    aggregates.map(
      (aggregate) =>
        `${aggregate.childInstrumentId}:${aggregate.childRefField}:${aggregateMeasureKey(aggregate)}:${aggregate.parentField}`,
    ),
    [...base, "aggregateInvariants"],
    "aggregate invariant",
    add,
  );
  aggregates.forEach((aggregate, aggregateIndex) => {
    const aggregateBase = [
      ...base,
      "aggregateInvariants",
      aggregateIndex,
    ] as const;
    const sum = "childField" in aggregate ? aggregate : undefined;
    const parentField = instrument.fields[aggregate.parentField];
    if (!parentField) {
      add(
        [...aggregateBase, "parentField"],
        `aggregate references unknown parent field ${aggregate.parentField}`,
        "UDL5004",
      );
    } else if (sum && !isMoneySchema(parentField)) {
      add(
        [...aggregateBase, "parentField"],
        `${instrument.id}.${aggregate.parentField} must be a money field`,
        "UDL5004",
      );
    } else if (
      !sum &&
      (parentField.type !== "integer" ||
        !instrument.required.includes(aggregate.parentField))
    ) {
      add(
        [...aggregateBase, "parentField"],
        `${instrument.id}.${aggregate.parentField} must be a required integer field to cap a count`,
        "UDL5004",
      );
    } else if (instrument.update?.fields.includes(aggregate.parentField)) {
      add(
        [...aggregateBase, "parentField"],
        `${instrument.id}.${aggregate.parentField} cannot be updateable while it caps an aggregate`,
        "UDL5004",
      );
    }
    const child = instruments.get(aggregate.childInstrumentId);
    if (!child) {
      add(
        [...aggregateBase, "childInstrumentId"],
        `aggregate references unknown child instrument ${aggregate.childInstrumentId}`,
        "UDL5004",
      );
      return;
    }
    if (sum) {
      const childField = child.fields[sum.childField];
      if (!childField) {
        add(
          [...aggregateBase, "childField"],
          `aggregate references unknown child field ${sum.childField}`,
          "UDL5004",
        );
      } else if (!isMoneySchema(childField)) {
        add(
          [...aggregateBase, "childField"],
          `${child.id}.${sum.childField} must be a money field`,
          "UDL5004",
        );
      } else if (child.update?.fields.includes(sum.childField)) {
        add(
          [...aggregateBase, "childField"],
          `${child.id}.${sum.childField} cannot be updateable while it contributes to an aggregate`,
          "UDL5004",
        );
      }
    }
    const window = "count" in aggregate ? aggregate.window : undefined;
    if (window) {
      const windowField = child.fields[window.field];
      if (!windowField) {
        add(
          [...aggregateBase, "window", "field"],
          `aggregate window references unknown child field ${window.field}`,
          "UDL5004",
        );
      } else if (
        !isDateTimeFormat(windowField.format) ||
        !child.required.includes(window.field)
      ) {
        add(
          [...aggregateBase, "window", "field"],
          `${child.id}.${window.field} must be a required date-time field to window a count`,
          "UDL5004",
        );
      } else if (child.update?.fields.includes(window.field)) {
        add(
          [...aggregateBase, "window", "field"],
          `${child.id}.${window.field} cannot be updateable while it windows an aggregate`,
          "UDL5004",
        );
      }
    }
    const refField = child.fields[aggregate.childRefField];
    if (!refField) {
      add(
        [...aggregateBase, "childRefField"],
        `aggregate references unknown child ref field ${aggregate.childRefField}`,
        "UDL5004",
      );
    } else if (!references.accepts(refField, instrument.idPrefix)) {
      add(
        [...aggregateBase, "childRefField"],
        `${child.id}.${aggregate.childRefField} must reference ${instrument.id}`,
        "UDL5004",
      );
    } else if (child.update?.fields.includes(aggregate.childRefField)) {
      add(
        [...aggregateBase, "childRefField"],
        `${child.id}.${aggregate.childRefField} cannot be updateable while it links an aggregate`,
        "UDL5004",
      );
    }
    addDuplicateIssues(
      aggregate.childStatuses,
      [...aggregateBase, "childStatuses"],
      "child status",
      add,
    );
    aggregate.childStatuses.forEach((status, statusIndex) => {
      if (!child.lifecycle.states.includes(status)) {
        add(
          [...aggregateBase, "childStatuses", statusIndex],
          `aggregate consumes unknown ${child.id} status ${status}`,
          "UDL5004",
        );
      }
    });
  });
}

function exampleInputSchema(
  instrument: UdlInstrument,
  action: string,
  definition: UdlAction,
): Schema {
  if (action !== "create") {
    return (definition.input ?? {
      additionalProperties: false,
      properties: {},
      type: "object",
    }) as Schema;
  }
  // Derived and machine-computed fields leave the authorable create surface:
  // the runtime writes them from referenced instances or lifecycle events.
  const boundKeys = new Set([
    ...(definition.requiresRefs ?? []).flatMap((gate) =>
      Object.keys(gate.bind ?? {}),
    ),
    ...Object.values(instrument.actions).flatMap((candidate) =>
      candidate.setsAt ? [candidate.setsAt.field] : [],
    ),
    ...(instrument.derivedAmounts ?? []).map((amount) => amount.field),
    ...(instrument.feeRules ?? []).flatMap((fee) =>
      fee.rule.kind === "exact" ? [] : [fee.amountField],
    ),
  ]);
  const properties: Record<string, unknown> = Object.fromEntries(
    Object.entries(instrument.fields).filter(([key]) => !boundKeys.has(key)),
  );
  const required = instrument.required.filter((key) => !boundKeys.has(key));
  if (instrument.subject) {
    properties.subject = { minLength: 1, type: "string" };
    required.push("subject");
  }
  return {
    additionalProperties: false,
    properties,
    required,
    type: "object",
  } as Schema;
}

function exampleInputForUdlValidation(
  instrument: UdlInstrument,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const camelId = instrument.id.replaceAll(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
  const envelopeKeys = new Set([
    "actorAccountId",
    "tenantId",
    "productId",
    `${camelId}Id`,
  ]);
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !envelopeKeys.has(key)),
  );
}

/** The measure half of an aggregate's identity: summed field, or count(+window). */
function aggregateMeasureKey(aggregate: UdlAggregate): string {
  return "childField" in aggregate
    ? aggregate.childField
    : `count${aggregate.window ? `[${aggregate.window.field} per ${aggregate.window.days}d]` : ""}`;
}

function isMoneySchema(schema: Readonly<Record<string, unknown>>): boolean {
  return (
    schema.pattern === positiveMoneyPattern ||
    schema.pattern === nonNegativeMoneyPattern
  );
}

function isCurrencySchema(schema: Readonly<Record<string, unknown>>): boolean {
  return schema.pattern === currencyPattern;
}

/**
 * One budget's worth of reference-shape classification: the memo of the answers
 * already bought and what is left of the probe budget. What is guaranteed is
 * that separate opens are independent — each {@link openReferenceShapeBudget}
 * call returns its own memo and its own counter, and nothing resets either
 * afterwards. Sharing is the caller's call, and both choices are made today:
 * `validateUdl` opens one budget for its semantic pass, while the engine's
 * `checkComposerDocument` deliberately runs its instrument-composition and
 * gate-deadlock passes on a single shared budget.
 */
export interface ReferenceShapeBudget {
  /**
   * Does this field schema identify exactly one instrument family, by accepting that
   * family's scoped id and refusing a foreign one? Answering compiles two JSON
   * Schema validators, and the question is asked once per declared instrument per
   * reference gate — a product a document controls both factors of. The answer
   * is pure in (schema, prefix), so each pair is paid for once per budget.
   *
   * Once {@link UDL_LIMITS.maxSchemaProbes} answers have been bought this
   * budget stops buying: {@link exhausted} is true from that moment on, and a
   * pair not already in the memo answers "no" without being asked (memoized
   * pairs go on answering truthfully). Nothing in this type forces
   * a caller to notice that: reading {@link exhausted} and refusing instead of
   * trusting a dropped "no" is a convention each consumer keeps by hand. The
   * two that exist keep it — `validateUdl` below, and the engine's
   * `checkComposerDocument` — and a third would have to be written to.
   */
  accepts(schema: Readonly<Record<string, unknown>>, prefix: string): boolean;
  /**
   * True once the probe budget is spent — which is the moment the last answer
   * is bought, before any answer has been dropped. A consumer that refuses
   * here refuses a document that fit the budget exactly.
   */
  readonly exhausted: boolean;
}

/** Whether a reconcile exception child owns a reference back to its parent. */
export function reconcileExceptionChildProblems(
  parentIdPrefix: string,
  child: {
    readonly fields: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    readonly required: readonly string[];
  },
  exception: {
    readonly amountField: string;
    readonly reasonField: string;
    readonly refField: string;
  },
  references: ReferenceShapeBudget,
): readonly UdlIssueCode[] {
  const problems: UdlIssueCode[] = [];
  const refSchema = child.fields[exception.refField];
  if (refSchema === undefined || !references.accepts(refSchema, parentIdPrefix))
    problems.push("UDL5007");
  const amountSchema = child.fields[exception.amountField];
  if (
    amountSchema === undefined ||
    !child.required.includes(exception.amountField)
  )
    problems.push("UDL5009");
  else if (!isMoneySchema(amountSchema)) problems.push("UDL5010");
  const reasonSchema = child.fields[exception.reasonField];
  if (
    reasonSchema === undefined ||
    !child.required.includes(exception.reasonField)
  )
    problems.push("UDL5011");
  else if (
    reasonSchema.type !== "string" ||
    isMoneySchema(reasonSchema) ||
    "pattern" in reasonSchema ||
    "format" in reasonSchema ||
    "enum" in reasonSchema
  )
    problems.push("UDL5012");
  return problems;
}

export function isReconcileExceptionChild(
  parentIdPrefix: string,
  child: {
    readonly fields: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    readonly required: readonly string[];
  },
  exception: {
    readonly amountField: string;
    readonly reasonField: string;
    readonly refField: string;
  },
  references: ReferenceShapeBudget,
): boolean {
  return (
    reconcileExceptionChildProblems(
      parentIdPrefix,
      child,
      exception,
      references,
    ).length === 0
  );
}

function reconcileExceptionProblemMessage(
  code: UdlIssueCode,
  parent: UdlInstrument,
  child: UdlInstrument,
  exception: {
    readonly amountField: string;
    readonly reasonField: string;
    readonly refField: string;
  },
): string {
  switch (code) {
    case "UDL5007":
      return `${child.id}.${exception.refField} must reference ${parent.id} to carry its breaks`;
    case "UDL5009":
      return `${child.id}.${exception.amountField} must be a required child money field`;
    case "UDL5010":
      return `${child.id}.${exception.amountField} must be a money field`;
    case "UDL5011":
      return `${child.id}.${exception.reasonField} must be a required child text field`;
    case "UDL5012":
      return `${child.id}.${exception.reasonField} must be a text field`;
    default:
      return "reconcile exception child is invalid";
  }
}

/**
 * One sample id per prefix, built here and nowhere else. The probe below asks
 * a schema two questions and the answers are only comparable while both
 * samples differ in the prefix alone, so the environment segment and the body
 * are written once. The value is disposable: no document ever carries it, and
 * a host's real id grammar stays the host's business.
 */
const probeIdFor = (prefix: string): string =>
  `${prefix}_sandbox_0123456789abcdef`;

/** A prefix no host mints, so a schema that accepts it accepts anything. */
const UNCLAIMED_PREFIX = "zzzz";

export function openReferenceShapeBudget(): ReferenceShapeBudget {
  const answers = new WeakMap<object, Map<string, boolean>>();
  let probes = 0;
  return {
    accepts(schema, prefix) {
      const seen = answers.get(schema);
      const cached = seen?.get(prefix);
      if (cached !== undefined) return cached;
      if (probes >= UDL_LIMITS.maxSchemaProbes) return false;
      probes += 1;

      const answer =
        validateUdlSchemaValue(schema, probeIdFor(prefix)).errors.length ===
          0 &&
        validateUdlSchemaValue(schema, probeIdFor(UNCLAIMED_PREFIX)).errors
          .length > 0;
      if (seen) seen.set(prefix, answer);
      else answers.set(schema, new Map([[prefix, answer]]));
      return answer;
    },
    get exhausted() {
      return probes >= UDL_LIMITS.maxSchemaProbes;
    },
  };
}

const sealedFormatValidators: Readonly<
  Record<string, (value: string) => boolean>
> = {
  "hyperscale-date": (value) => z.iso.date().safeParse(value).success,
  "hyperscale-date-time": (value) => z.iso.datetime().safeParse(value).success,
  "hyperscale-email": (value) => z.email().safeParse(value).success,
  "hyperscale-uri": (value) => z.url().safeParse(value).success,
};

function sealedFormatErrors(
  instance: unknown,
  schema: Schema,
  instanceLocation = "",
  schemaLocation = "",
): readonly OutputUnit[] {
  const errors: OutputUnit[] = [];
  const format =
    typeof schema.format === "string"
      ? sealedFormatValidators[schema.format]
      : undefined;
  if (format && typeof instance === "string" && !format(instance)) {
    errors.push({
      error: `String does not match format "${schema.format}".`,
      instanceLocation,
      keyword: "format",
      keywordLocation: `${schemaLocation}/format`,
    });
  }
  if (
    schema.properties &&
    instance !== null &&
    typeof instance === "object" &&
    !Array.isArray(instance)
  ) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (
        childSchema === false ||
        childSchema === true ||
        !Object.hasOwn(instance, key)
      ) {
        continue;
      }
      errors.push(
        ...sealedFormatErrors(
          (instance as Readonly<Record<string, unknown>>)[key],
          childSchema,
          `${instanceLocation}/${jsonPointerSegment(key)}`,
          `${schemaLocation}/properties/${jsonPointerSegment(key)}`,
        ),
      );
    }
  }
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object" &&
    !Array.isArray(schema.additionalProperties) &&
    instance !== null &&
    typeof instance === "object" &&
    !Array.isArray(instance)
  ) {
    const declared = new Set(Object.keys(schema.properties ?? {}));
    for (const [key, value] of Object.entries(instance)) {
      if (declared.has(key)) continue;
      errors.push(
        ...sealedFormatErrors(
          value,
          schema.additionalProperties,
          `${instanceLocation}/${jsonPointerSegment(key)}`,
          `${schemaLocation}/additionalProperties`,
        ),
      );
    }
  }
  const itemSchema = schema.items;
  if (
    itemSchema !== undefined &&
    typeof itemSchema === "object" &&
    !Array.isArray(itemSchema) &&
    Array.isArray(instance)
  ) {
    instance.forEach((value, index) => {
      errors.push(
        ...sealedFormatErrors(
          value,
          itemSchema,
          `${instanceLocation}/${index}`,
          `${schemaLocation}/items`,
        ),
      );
    });
  }
  return errors;
}

function isDateTimeFormat(format: unknown): boolean {
  return format === sealedDateTimeFormat;
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function addDuplicateIssues(
  values: readonly string[],
  path: readonly PropertyKey[],
  label: string,
  add: AddIssue,
): void {
  const firstIndex = new Map<string, number>();
  values.forEach((value, index) => {
    const previous = firstIndex.get(value);
    if (previous === undefined) firstIndex.set(value, index);
    else
      add(
        [...path, index],
        `duplicate ${label} ${value}; first declared at index ${previous}`,
        "UDL2001",
      );
  });
}

function jsonPath(path: readonly PropertyKey[]): string {
  let result = "$";
  for (const segment of path) {
    if (typeof segment === "number") result += `[${segment}]`;
    else if (
      typeof segment === "string" &&
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
    ) {
      result += `.${segment}`;
    } else result += `[${JSON.stringify(String(segment))}]`;
  }
  return result;
}
