import {
  Validator,
  type OutputUnit,
  type Schema,
  type ValidationResult,
} from "@cfworker/json-schema";
import { z } from "zod";

import {
  udlDocumentSchema,
  type UdlAggregate,
  type UdlDocument,
  type UdlGate,
  type UdlMove,
  type UdlNoun,
  type UdlStep,
  type UdlVerb,
} from "./schema.js";
import { fixedIsoDurationMs } from "./duration.js";
import { analyzeNounFinance, financeAdmissionProblem } from "./finance.js";
import { UDL_LIMITS } from "./limits.js";

export type UdlIssueCode =
  | "invalid_json"
  | "invalid_semantics"
  | "invalid_shape"
  | "invalid_utf8"
  | "resource_limit";

export interface UdlIssue {
  readonly code: UdlIssueCode;
  readonly message: string;
  readonly path: string;
}

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

  const parsed = udlDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        code: "invalid_shape" as const,
        message: issue.message,
        path: jsonPath(issue.path),
      })),
      ok: false,
    };
  }

  const references = openReferenceShapeBudget();
  const issues = semanticIssues(parsed.data, references);
  if (references.exhausted) {
    return {
      issues: [
        {
          code: "resource_limit",
          message: `document exceeds ${UDL_LIMITS.maxSchemaProbes} reference-shape checks; declare fewer nouns or fewer reference gates`,
          path: "$.nouns",
        },
      ],
      ok: false,
    };
  }
  return issues.length === 0
    ? { ok: true, value: parsed.data }
    : { issues, ok: false };
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
          issue.code === "resource_limit" ? "resource_limit" : invalidKeyword,
        keywordLocation: "$",
      },
    ],
    valid: false,
  };
}

type AddIssue = (path: readonly PropertyKey[], message: string) => void;

const positiveMoneyPattern = "^[1-9][0-9]{0,17}$";
const nonNegativeMoneyPattern = "^(0|[1-9][0-9]{0,17})$";
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
  const add: AddIssue = (path, message) => {
    issues.push({ code: "invalid_semantics", message, path: jsonPath(path) });
  };

  document.nouns.forEach((noun, nounIndex) => {
    const problem = financeAdmissionProblem(noun);
    if (problem) add(["nouns", nounIndex, "lifecycle"], problem);
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
    document.nouns.map((noun) => noun.id),
    ["nouns"],
    "noun id",
    add,
  );
  addDuplicateIssues(
    document.nouns.map((noun) => noun.idPrefix),
    ["nouns"],
    "noun idPrefix",
    add,
  );

  const subjects = new Map(
    document.subjects.map((subject) => [subject.kind, subject] as const),
  );
  const nouns = new Map(document.nouns.map((noun) => [noun.id, noun] as const));

  for (const [subjectIndex, subject] of document.subjects.entries()) {
    if (subject.schema.type !== "object") {
      add(
        ["subjects", subjectIndex, "schema", "type"],
        "a subject attribute schema must declare type object",
      );
    }
  }

  for (const [nounIndex, noun] of document.nouns.entries()) {
    validateNoun(noun, nounIndex, nouns, subjects, references, add);
  }
  return issues;
}

function structuralBudgetIssue(value: unknown): UdlIssue | undefined {
  let discovered = 1;
  let nodes = 0;
  let totalStringLength = 0;
  const pending: {
    readonly ancestors: ReadonlySet<object>;
    readonly depth: number;
    readonly path: readonly PropertyKey[];
    readonly value: unknown;
  }[] = [{ ancestors: new Set(), depth: 1, path: [], value }];

  while (pending.length > 0) {
    const entry = pending.pop() as (typeof pending)[number];
    nodes += 1;
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
      if (entry.value.length > UDL_LIMITS.maxNodes - discovered) {
        return resourceIssue(
          entry.path,
          `UDL contains more than ${UDL_LIMITS.maxNodes} values`,
        );
      }
      discovered += entry.value.length;
      for (let index = entry.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          ancestors: childAncestors,
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
      childCount += 1;
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
        depth: entry.depth + 1,
        path: [...entry.path, key],
        value: (entry.value as Record<string, unknown>)[key],
      });
    }
  }
  return undefined;
}

function resourceIssue(
  path: readonly PropertyKey[],
  message: string,
): UdlIssue {
  return { code: "resource_limit", message, path: jsonPath(path) };
}

function jsonValueIssue(path: readonly PropertyKey[]): UdlIssue {
  return {
    code: "invalid_shape",
    message: "UDL must contain only JSON values",
    path: jsonPath(path),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDocumentSchemas(document: UdlDocument, add: AddIssue): void {
  document.subjects.forEach((subject, subjectIndex) =>
    validateJsonSchema(
      subject.schema,
      ["subjects", subjectIndex, "schema"],
      add,
    ),
  );
  document.nouns.forEach((noun, nounIndex) => {
    for (const [field, schema] of Object.entries(noun.fields)) {
      validateJsonSchema(schema, ["nouns", nounIndex, "fields", field], add);
    }
    for (const [verb, definition] of Object.entries(noun.verbs)) {
      if (definition.input) {
        validateJsonSchema(
          definition.input,
          ["nouns", nounIndex, "verbs", verb, "input"],
          add,
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
      );
    }
  }

  if (typeof schema.type !== "string" || !jsonSchemaTypes.has(schema.type)) {
    add(
      [...path, "type"],
      `JSON Schema type must be one of ${[...jsonSchemaTypes].join(", ")}`,
    );
  }
  for (const keyword of ["description", "title"] as const) {
    if (Object.hasOwn(schema, keyword) && typeof schema[keyword] !== "string") {
      add([...path, keyword], `JSON Schema ${keyword} must be a string`);
    }
  }
  if (
    Object.hasOwn(schema, "enum") &&
    (!Array.isArray(schema.enum) || schema.enum.length === 0)
  ) {
    add([...path, "enum"], "JSON Schema enum must be a non-empty array");
  }
  if (
    Object.hasOwn(schema, "properties") &&
    (!isRecord(schema.properties) || schema.type !== "object")
  ) {
    add(
      [...path, "properties"],
      "JSON Schema properties require an object schema and object value",
    );
  }
  if (Object.hasOwn(schema, "required")) {
    if (schema.type !== "object") {
      add(
        [...path, "required"],
        "JSON Schema required is only valid on an object schema",
      );
    } else if (
      !Array.isArray(schema.required) ||
      !schema.required.every((field) => typeof field === "string")
    ) {
      add(
        [...path, "required"],
        "JSON Schema required must be an array of property names",
      );
    } else {
      const properties = recordValue(schema.properties);
      for (const field of schema.required) {
        if (!Object.hasOwn(properties, field)) {
          add(
            [...path, "required"],
            `JSON Schema required references undeclared property ${field}`,
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
      );
    }
  }
  if (
    typeof schema.minLength === "number" &&
    typeof schema.maxLength === "number" &&
    schema.minLength > schema.maxLength
  ) {
    add([...path, "maxLength"], "JSON Schema maxLength is below minLength");
  }
  if (
    typeof schema.minItems === "number" &&
    typeof schema.maxItems === "number" &&
    schema.minItems > schema.maxItems
  ) {
    add([...path, "maxItems"], "JSON Schema maxItems is below minItems");
  }
  if (
    typeof schema.minimum === "number" &&
    typeof schema.maximum === "number" &&
    schema.minimum > schema.maximum
  ) {
    add([...path, "maximum"], "JSON Schema maximum is below minimum");
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
    );
  }
  if (Object.hasOwn(schema, "pattern")) {
    if (schema.type !== "string" || typeof schema.pattern !== "string") {
      add([...path, "pattern"], "JSON Schema pattern must be a string");
    } else {
      const problem = regexProblem(schema.pattern);
      if (problem) add([...path, "pattern"], problem);
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

function validateNoun(
  noun: UdlNoun,
  nounIndex: number,
  nouns: ReadonlyMap<string, UdlNoun>,
  subjects: ReadonlyMap<string, unknown>,
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const base = ["nouns", nounIndex] as const;
  const states = new Set(noun.lifecycle.states);

  addDuplicateIssues(
    noun.lifecycle.states,
    [...base, "lifecycle", "states"],
    "lifecycle state",
    add,
  );
  if (!states.has(noun.lifecycle.initial)) {
    add(
      [...base, "lifecycle", "initial"],
      `initial state ${noun.lifecycle.initial} is not declared in lifecycle.states`,
    );
  }
  if (!Object.hasOwn(noun.verbs, "create")) {
    add([...base, "verbs"], "every noun must declare the create verb");
  }
  if (Object.hasOwn(noun.lifecycle.transitions, "create")) {
    add(
      [...base, "lifecycle", "transitions", "create"],
      "create lands on lifecycle.initial and must not declare a transition",
    );
  }

  for (const [verb, transition] of Object.entries(noun.lifecycle.transitions)) {
    if (!Object.hasOwn(noun.verbs, verb)) {
      add(
        [...base, "lifecycle", "transitions", verb],
        `transition ${verb} has no matching verb`,
      );
    }
    addDuplicateIssues(
      transition.from,
      [...base, "lifecycle", "transitions", verb, "from"],
      "source state",
      add,
    );
    transition.from.forEach((from, fromIndex) => {
      if (!states.has(from)) {
        add(
          [...base, "lifecycle", "transitions", verb, "from", fromIndex],
          `source state ${from} is not declared in lifecycle.states`,
        );
      }
    });
    if (!states.has(transition.to)) {
      add(
        [...base, "lifecycle", "transitions", verb, "to"],
        `target state ${transition.to} is not declared in lifecycle.states`,
      );
    }
  }

  for (const verb of Object.keys(noun.verbs)) {
    if (verb !== "create" && !Object.hasOwn(noun.lifecycle.transitions, verb)) {
      add(
        [...base, "verbs", verb],
        `verb ${verb} must declare a lifecycle transition`,
      );
    }
  }
  validateReachability(noun, base, add);

  const reservedFields = new Set([
    "createdAt",
    "id",
    "metadata",
    "refs",
    "status",
  ]);
  for (const field of Object.keys(noun.fields)) {
    if (reservedFields.has(field)) {
      add(
        [...base, "fields", field],
        `${field} is an envelope field and cannot be authored`,
      );
    }
  }
  addDuplicateIssues(
    noun.required,
    [...base, "required"],
    "required field",
    add,
  );
  noun.required.forEach((field, fieldIndex) => {
    if (!Object.hasOwn(noun.fields, field)) {
      add(
        [...base, "required", fieldIndex],
        `required references unknown field ${field}`,
      );
    }
  });

  if (noun.subject) {
    addDuplicateIssues(
      noun.subject.kinds,
      [...base, "subject", "kinds"],
      "subject kind",
      add,
    );
    noun.subject.kinds.forEach((kind, kindIndex) => {
      if (!subjects.has(kind)) {
        add(
          [...base, "subject", "kinds", kindIndex],
          `noun subject references unknown kind ${kind}`,
        );
      }
    });
  }

  validateParties(noun, base, references, add);
  validateUpdate(noun, base, states, add);
  validateSetsAt(noun, base, add);
  validateVerbs(noun, base, nouns, references, add);
  validateUnwind(noun, base, references, add);
  for (const issue of analyzeNounFinance(noun)) {
    add([...base, ...issue.path], issue.message);
  }
  validateAggregates(noun, base, nouns, references, add);
}

function validateSetsAt(
  noun: UdlNoun,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  const writers = new Map<string, string>();
  for (const [verbName, verb] of Object.entries(noun.verbs)) {
    if (!verb.setsAt) continue;
    const path = [...base, "verbs", verbName, "setsAt"] as const;
    const { field, offset } = verb.setsAt;
    if (verbName === "create") {
      add(
        path,
        "setsAt requires a lifecycle transition and cannot run on create",
      );
    }
    const earlierWriter = writers.get(field);
    if (earlierWriter) {
      add(
        [...path, "field"],
        `${field} is already written by verb ${earlierWriter}`,
      );
    } else {
      writers.set(field, verbName);
    }

    const schema = noun.fields[field];
    if (!schema) {
      add([...path, "field"], `setsAt references unknown field ${field}`);
    } else if (schema.type !== "string" || !isDateTimeFormat(schema.format)) {
      add([...path, "field"], "setsAt must target a date-time field");
    }
    if (noun.required.includes(field)) {
      add([...path, "field"], "setsAt target must be optional at create");
    }
    if (noun.update?.fields.includes(field)) {
      add([...path, "field"], "setsAt target cannot also be mutable");
    }
    const offsetMs = fixedIsoDurationMs(offset);
    if (offsetMs === null || offsetMs <= 0) {
      add(
        [...path, "offset"],
        "setsAt.offset must be a positive fixed ISO-8601 duration",
      );
    }

    const readers = Object.entries(noun.verbs).filter(
      ([, candidate]) =>
        candidate.due?.field === field || candidate.deadline?.field === field,
    );
    if (readers.length === 0) {
      add(
        path,
        `setsAt field ${field} must anchor at least one due condition or deadline`,
      );
      continue;
    }
    for (const [readerName] of readers) {
      if (
        readerName === verbName ||
        !verbDominatesReader(noun, verbName, readerName)
      ) {
        add(
          [...base, "verbs", readerName],
          `verb ${readerName} can read ${field} before writer ${verbName}`,
        );
      }
    }
  }
}

function verbDominatesReader(
  noun: UdlNoun,
  writer: string,
  reader: string,
): boolean {
  if (!noun.lifecycle.transitions[writer]) return false;
  const readerTransition = noun.lifecycle.transitions[reader];
  if (!readerTransition) return false;
  const reachable = new Set([noun.lifecycle.initial]);
  const pending = [noun.lifecycle.initial];
  while (pending.length > 0) {
    const state = pending.shift() as string;
    for (const [verb, transition] of Object.entries(
      noun.lifecycle.transitions,
    )) {
      if (
        verb === writer ||
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
  noun: UdlNoun,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  const reachable = new Set([noun.lifecycle.initial]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const transition of Object.values(noun.lifecycle.transitions)) {
      if (
        transition.from.some((state) => reachable.has(state)) &&
        !reachable.has(transition.to)
      ) {
        reachable.add(transition.to);
        changed = true;
      }
    }
  }
  noun.lifecycle.states.forEach((state, stateIndex) => {
    if (!reachable.has(state)) {
      add(
        [...base, "lifecycle", "states", stateIndex],
        `lifecycle state ${state} is unreachable from ${noun.lifecycle.initial}`,
      );
    }
  });
}

function validateParties(
  noun: UdlNoun,
  base: readonly PropertyKey[],
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  if (!noun.parties) return;
  const entries = Object.entries(noun.parties).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (entries.length === 0) {
    add([...base, "parties"], "parties must contain at least one declaration");
    return;
  }
  if (noun.distinctParties && entries.length < 2) {
    add(
      [...base, "distinctParties"],
      "distinctParties requires at least two declared party roles",
    );
  }
  addDuplicateIssues(
    entries.map(([, field]) => field),
    [...base, "parties"],
    "party field",
    add,
  );
  for (const [role, field] of entries) {
    const schema = noun.fields[field];
    if (!schema) {
      add(
        [...base, "parties", role],
        `party role ${role} references unknown field ${field}`,
      );
    } else if (!references.accepts(schema, "acct")) {
      add(
        [...base, "parties", role],
        `party role ${role} must reference an account-id field`,
      );
    }
  }
}

function validateUpdate(
  noun: UdlNoun,
  base: readonly PropertyKey[],
  states: ReadonlySet<string>,
  add: AddIssue,
): void {
  if (!noun.update) return;
  addDuplicateIssues(
    noun.update.fields,
    [...base, "update", "fields"],
    "field",
    add,
  );
  addDuplicateIssues(
    noun.update.states,
    [...base, "update", "states"],
    "state",
    add,
  );
  noun.update.fields.forEach((field, index) => {
    if (!Object.hasOwn(noun.fields, field)) {
      add(
        [...base, "update", "fields", index],
        `update references unknown field ${field}`,
      );
    }
  });
  noun.update.states.forEach((state, index) => {
    if (!states.has(state)) {
      add(
        [...base, "update", "states", index],
        `update references unknown state ${state}`,
      );
    }
  });
}

function validateVerbs(
  noun: UdlNoun,
  base: readonly PropertyKey[],
  nouns: ReadonlyMap<string, UdlNoun>,
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  for (const [verb, definition] of Object.entries(noun.verbs)) {
    const verbBase = [...base, "verbs", verb] as const;
    if (verb === "create" && definition.input) {
      add(
        [...verbBase, "input"],
        "create already consumes noun fields and must not declare input",
      );
    }
    if (definition.input && definition.input.type !== "object") {
      add(
        [...verbBase, "input", "type"],
        "verb input must declare an object-shaped JSON Schema",
      );
    }

    addDuplicateIssues(
      definition.moves.map((move) => move.key),
      [...verbBase, "moves"],
      "move key",
      add,
    );
    if (definition.earnable && definition.moves.length === 0) {
      add(verbBase, "earnable requires a money move");
    }
    definition.steps.forEach((step, stepIndex) =>
      validateStep(
        noun,
        definition,
        step,
        [...verbBase, "steps", stepIndex],
        add,
      ),
    );
    definition.moves.forEach((move, moveIndex) =>
      validateStep(
        noun,
        definition,
        move,
        [...verbBase, "moves", moveIndex],
        add,
      ),
    );

    if (definition.requiresRefs) {
      addDuplicateIssues(
        definition.requiresRefs.map((gate) => gate.field),
        [...verbBase, "requiresRefs"],
        "gate field",
        add,
      );
      definition.requiresRefs.forEach((gate, gateIndex) => {
        addDuplicateIssues(
          gate.statuses,
          [...verbBase, "requiresRefs", gateIndex, "statuses"],
          "gate status",
          add,
        );
        const schema = noun.fields[gate.field];
        if (!schema) {
          add(
            [...verbBase, "requiresRefs", gateIndex, "field"],
            `gate references unknown field ${gate.field}`,
          );
          return;
        }
        const targets = [...nouns.values()].filter((target) =>
          references.accepts(schema, target.idPrefix),
        );
        if (targets.length !== 1) {
          add(
            [...verbBase, "requiresRefs", gateIndex, "field"],
            `gate field ${gate.field} must identify exactly one noun (found ${targets.length})`,
          );
          return;
        }
        const target = targets[0] as UdlNoun;
        gate.statuses.forEach((status, statusIndex) => {
          if (!target.lifecycle.states.includes(status)) {
            add(
              [...verbBase, "requiresRefs", gateIndex, "statuses", statusIndex],
              `gate status ${status} is not declared by ${target.id}`,
            );
          }
        });
        validateGateShape(
          noun,
          verb,
          gate,
          target,
          [...verbBase, "requiresRefs", gateIndex],
          add,
        );
      });
    }

    if (definition.requiresDrainedAccount) {
      const drainBase = [...verbBase, "requiresDrainedAccount"] as const;
      if (verb === "create") {
        add(
          [...drainBase],
          "requiresDrainedAccount cannot gate create: no account exists yet",
        );
      }
      const path = definition.requiresDrainedAccount.path;
      const declared =
        (path.startsWith("fields.") &&
          Object.hasOwn(noun.fields, path.slice("fields.".length))) ||
        (path.startsWith("refs.") &&
          declaredRefKeys(noun).has(path.slice("refs.".length)));
      if (!declared) {
        add(
          [...drainBase, "path"],
          `requiresDrainedAccount reads ${path}, which is not declared`,
        );
      }
    }

    if (definition.due) {
      const transition = noun.lifecycle.transitions[verb];
      if (definition.due.every) {
        // A recurring due verb is stationary: each occurrence fires in place
        // and the runtime keeps the instance's current status, so `to` is
        // only a witness naming one of the source states.
        if (!transition || !transition.from.includes(transition.to)) {
          add(
            [...verbBase, "due"],
            "a recurring due verb must be stationary: its transition's to must name one of its from states",
          );
        }
      } else if (!transition || transition.from.includes(transition.to)) {
        add(
          [...verbBase, "due"],
          "a due verb must leave every source state so the maintenance loop fires its anchor exactly once",
        );
      }
      const schema = noun.fields[definition.due.field];
      if (!schema) {
        add(
          [...verbBase, "due", "field"],
          `due condition references unknown field ${definition.due.field}`,
        );
      } else if (!isDateTimeFormat(schema.format)) {
        add(
          [...verbBase, "due", "field"],
          "due field must be a date-time field",
        );
      }
      if (
        definition.due.offset &&
        fixedIsoDurationMs(definition.due.offset) === null
      ) {
        add(
          [...verbBase, "due", "offset"],
          "due.offset must be a fixed ISO-8601 duration using weeks, days, hours, minutes, or seconds",
        );
      }
    }

    if (definition.deadline) {
      if (definition.due) {
        add(
          [...verbBase, "deadline"],
          "a verb cannot declare both a due condition and a deadline",
        );
      }
      const schema = noun.fields[definition.deadline.field];
      if (!schema) {
        add(
          [...verbBase, "deadline", "field"],
          `deadline references unknown field ${definition.deadline.field}`,
        );
      } else if (!isDateTimeFormat(schema.format)) {
        add(
          [...verbBase, "deadline", "field"],
          "deadline field must be a date-time field",
        );
      }
      if (
        definition.deadline.offset &&
        fixedIsoDurationMs(definition.deadline.offset) === null
      ) {
        add(
          [...verbBase, "deadline", "offset"],
          "deadline.offset must be a fixed ISO-8601 duration using weeks, days, hours, minutes, or seconds",
        );
      }
    }

    if (definition.examples) {
      addDuplicateIssues(
        definition.examples.map((example) => example.name),
        [...verbBase, "examples"],
        "example name",
        add,
      );
      const inputSchema = exampleInputSchema(noun, verb, definition);
      definition.examples.forEach((example, exampleIndex) => {
        for (const error of validateUdlSchemaValue(inputSchema, example.input)
          .errors) {
          add(
            [...verbBase, "examples", exampleIndex, "input"],
            `example ${example.name} input ${error.error} at ${error.instanceLocation || "/"}`,
          );
        }
      });
    }
  }
}

/**
 * Shape rules for one resolved reference gate: derived bindings and the
 * uniqueness claim are create-only, bind keys must be declared immutable
 * fields, and every referenced path must name declared target structure. The
 * exact mirror of the Hyperscale contract registry's rules, so a document that loads
 * open-grammar clean also loads registry clean.
 */
function validateGateShape(
  noun: UdlNoun,
  verb: string,
  gate: UdlGate,
  target: UdlNoun,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  if (gate.unique && verb !== "create") {
    add([...base, "unique"], "unique is a create admission gate");
  }
  if (gate.bind && verb !== "create") {
    add([...base, "bind"], "bind derives fields at create only");
  }
  if (gate.bind && Object.keys(gate.bind).length === 0) {
    add([...base, "bind"], "bind must not be empty");
  }
  if (gate.match && Object.keys(gate.match).length === 0) {
    add([...base, "match"], "match must not be empty");
  }
  if (gate.optional && noun.required.includes(gate.field)) {
    add(
      [...base, "optional"],
      `optional declares an opt-out on ${gate.field}, which required lists`,
    );
  }
  for (const [key, path] of Object.entries(gate.bind ?? {})) {
    if (gate.optional && noun.required.includes(key)) {
      add(
        [...base, "bind", key],
        `an optional reference can only bind optional fields; required lists ${key}`,
      );
    }
    if (!Object.hasOwn(noun.fields, key)) {
      add([...base, "bind", key], `bind targets unknown field ${key}`);
    }
    if (key === gate.field) {
      add([...base, "bind", key], "bind cannot target the gate field itself");
    }
    if (noun.update?.fields.includes(key)) {
      add(
        [...base, "bind", key],
        `bind targets ${key}, which update declares mutable`,
      );
    }
    if (path === "nounInstanceId") {
      add(
        [...base, "bind", key],
        "the gate field already carries the referenced id",
      );
    } else if (!referencedPathDeclared(target, path)) {
      add(
        [...base, "bind", key],
        `bind reads ${path}, which ${target.id} does not declare`,
      );
    }
  }
  for (const [localPath, path] of Object.entries(gate.match ?? {})) {
    const localOk =
      verb === "create"
        ? localPath.startsWith("fields.") &&
          Object.hasOwn(noun.fields, localPath.slice("fields.".length))
        : localPath === "nounInstanceId" ||
          (localPath.startsWith("fields.") &&
            Object.hasOwn(noun.fields, localPath.slice("fields.".length))) ||
          (localPath.startsWith("refs.") &&
            declaredRefKeys(noun).has(localPath.slice("refs.".length)));
    if (!localOk) {
      add(
        [...base, "match", localPath],
        verb === "create"
          ? "a create match may only read the noun's own declared fields"
          : `match reads unknown local path ${localPath}`,
      );
    }
    if (!referencedPathDeclared(target, path)) {
      add(
        [...base, "match", localPath],
        `match reads ${path}, which ${target.id} does not declare`,
      );
    }
  }
}

/** Every `refs.<key>` a noun's instances can legitimately carry. */
function declaredRefKeys(noun: UdlNoun): ReadonlySet<string> {
  return new Set([
    ...Object.values(noun.verbs).flatMap((verb) =>
      [...verb.steps, ...verb.moves].flatMap((step) =>
        Object.keys(step.capture ?? {}),
      ),
    ),
    ...(noun.unwind ? ["unwindRefund", "unwindPenalty"] : []),
    ...(noun.subject ? ["subject"] : []),
  ]);
}

/** Whether a bind/match referenced path names declared target structure. */
function referencedPathDeclared(target: UdlNoun, path: string): boolean {
  if (path === "nounInstanceId") return true;
  if (path.startsWith("fields.")) {
    return Object.hasOwn(target.fields, path.slice("fields.".length));
  }
  if (path.startsWith("refs.")) {
    return declaredRefKeys(target).has(path.slice("refs.".length));
  }
  return false;
}

function validateStep(
  noun: UdlNoun,
  verb: UdlVerb,
  step: UdlStep | UdlMove,
  base: readonly PropertyKey[],
  add: AddIssue,
): void {
  if (Object.keys(step.bind).length === 0) {
    add([...base, "bind"], "a kernel step must bind at least one value");
  }
  if (step.capture && Object.keys(step.capture).length === 0) {
    add([...base, "capture"], "capture must not be empty");
  }
  const inputFields = recordValue(verb.input?.properties);
  for (const [field, binding] of Object.entries(step.bind)) {
    if (binding.from === "const") continue;
    if (binding.from === "input") {
      const root = binding.path.split(".")[0] as string;
      if (!Object.hasOwn(inputFields, root)) {
        add(
          [...base, "bind", field, "path"],
          `input binding references undeclared verb input field ${root}`,
        );
      }
      continue;
    }
    if (binding.path.startsWith("fields.")) {
      const root = binding.path.split(".")[1] as string;
      if (!Object.hasOwn(noun.fields, root)) {
        add(
          [...base, "bind", field, "path"],
          `instance binding references unknown noun field ${root}`,
        );
      }
      continue;
    }
    if (
      binding.path !== "nounInstanceId" &&
      binding.path !== "workspaceId" &&
      !binding.path.startsWith("refs.")
    ) {
      add(
        [...base, "bind", field, "path"],
        `instance binding path ${binding.path} must read nounInstanceId, workspaceId, fields.*, or refs.*`,
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
      );
    }
    for (const monetary of ["amount", "currency"] as const) {
      if (Object.hasOwn(step.bind, monetary)) {
        add(
          [...base, "bind", monetary],
          `${step.operation} must not bind ${monetary}`,
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
      );
    }
  }
}

function validateUnwind(
  noun: UdlNoun,
  base: readonly PropertyKey[],
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const unwind = noun.unwind;
  if (!unwind) return;
  if (unwind.quote === unwind.confirm) {
    add(
      [...base, "unwind", "confirm"],
      "unwind quote and confirm verbs must differ",
    );
  }
  for (const [fieldName, field] of [
    ["refundableField", unwind.refundableField],
    ["refundDestinationField", unwind.refundDestinationField],
  ] as const) {
    if (!Object.hasOwn(noun.fields, field)) {
      add(
        [...base, "unwind", fieldName],
        `unwind references unknown field ${field}`,
      );
    }
  }
  const refundable = noun.fields[unwind.refundableField];
  if (refundable && !isMoneySchema(refundable)) {
    add(
      [...base, "unwind", "refundableField"],
      "refundableField must be a money field",
    );
  }
  const destination = noun.fields[unwind.refundDestinationField];
  if (destination && !references.accepts(destination, "acct")) {
    add(
      [...base, "unwind", "refundDestinationField"],
      "refundDestinationField must be an account-id field",
    );
  }
  if (unwind.beforeField) {
    const before = noun.fields[unwind.beforeField];
    if (!before) {
      add(
        [...base, "unwind", "beforeField"],
        `unwind references unknown field ${unwind.beforeField}`,
      );
    } else if (!isDateTimeFormat(before.format)) {
      add(
        [...base, "unwind", "beforeField"],
        "beforeField must be a date-time field",
      );
    } else if (!noun.required.includes(unwind.beforeField)) {
      add([...base, "unwind", "beforeField"], "beforeField must be required");
    }
  }
  for (const [verbName, verb] of [
    ["quote", unwind.quote],
    ["confirm", unwind.confirm],
  ] as const) {
    const definition = noun.verbs[verb];
    if (!definition) {
      add(
        [...base, "unwind", verbName],
        `unwind references unknown verb ${verb}`,
      );
      continue;
    }
    if (definition.earnable) {
      add(
        [...base, "verbs", verb, "earnable"],
        `unwind ${verbName} verb ${verb} is refund-shaped and cannot be earnable`,
      );
    }
  }
  const confirm = noun.verbs[unwind.confirm];
  if (confirm) {
    const transfers = confirm.moves.filter(
      (move) => move.operation === "internal_transfer.create",
    );
    const refund = transfers[0];
    const amount = refund?.bind.amount;
    const sourceBinding = refund?.bind.sourceAccountId;
    const destinationBinding = refund?.bind.destinationAccountId;
    if (
      transfers.length !== 1 ||
      amount?.from !== "instance" ||
      amount.path !== "refs.unwindRefund" ||
      sourceBinding?.from !== "instance" ||
      destinationBinding?.from !== "instance" ||
      destinationBinding.path !== `fields.${unwind.refundDestinationField}`
    ) {
      add(
        [...base, "verbs", unwind.confirm, "moves"],
        `unwind confirm verb ${unwind.confirm} must contain exactly one internal transfer whose source comes from the noun instance, amount is refs.unwindRefund, and destination is fields.${unwind.refundDestinationField}`,
      );
    }
  }
  const offsets = unwind.penalty.flatMap((tier) =>
    tier.withinOffset ? [tier.withinOffset] : [],
  );
  addDuplicateIssues(
    offsets,
    [...base, "unwind", "penalty"],
    "penalty offset",
    add,
  );
  if (
    unwind.penalty.filter((tier) => tier.withinOffset === undefined).length > 1
  ) {
    add(
      [...base, "unwind", "penalty"],
      "unwind may declare at most one floor tier",
    );
  }
  unwind.penalty.forEach((tier, index) => {
    if (tier.withinOffset && fixedIsoDurationMs(tier.withinOffset) === null) {
      add(
        [...base, "unwind", "penalty", index, "withinOffset"],
        "withinOffset must be a fixed ISO-8601 duration using weeks, days, hours, minutes, or seconds",
      );
    }
  });
}

function validateAggregates(
  noun: UdlNoun,
  base: readonly PropertyKey[],
  nouns: ReadonlyMap<string, UdlNoun>,
  references: ReferenceShapeBudget,
  add: AddIssue,
): void {
  const aggregates = noun.aggregateInvariants;
  if (!aggregates) return;
  addDuplicateIssues(
    aggregates.map(
      (aggregate) =>
        `${aggregate.childNounId}:${aggregate.childRefField}:${aggregateMeasureKey(aggregate)}:${aggregate.parentField}`,
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
    const parentField = noun.fields[aggregate.parentField];
    if (!parentField) {
      add(
        [...aggregateBase, "parentField"],
        `aggregate references unknown parent field ${aggregate.parentField}`,
      );
    } else if (sum && !isMoneySchema(parentField)) {
      add(
        [...aggregateBase, "parentField"],
        `${noun.id}.${aggregate.parentField} must be a money field`,
      );
    } else if (
      !sum &&
      (parentField.type !== "integer" ||
        !noun.required.includes(aggregate.parentField))
    ) {
      add(
        [...aggregateBase, "parentField"],
        `${noun.id}.${aggregate.parentField} must be a required integer field to cap a count`,
      );
    } else if (noun.update?.fields.includes(aggregate.parentField)) {
      add(
        [...aggregateBase, "parentField"],
        `${noun.id}.${aggregate.parentField} cannot be updateable while it caps an aggregate`,
      );
    }
    const child = nouns.get(aggregate.childNounId);
    if (!child) {
      add(
        [...aggregateBase, "childNounId"],
        `aggregate references unknown child noun ${aggregate.childNounId}`,
      );
      return;
    }
    if (sum) {
      const childField = child.fields[sum.childField];
      if (!childField) {
        add(
          [...aggregateBase, "childField"],
          `aggregate references unknown child field ${sum.childField}`,
        );
      } else if (!isMoneySchema(childField)) {
        add(
          [...aggregateBase, "childField"],
          `${child.id}.${sum.childField} must be a money field`,
        );
      } else if (child.update?.fields.includes(sum.childField)) {
        add(
          [...aggregateBase, "childField"],
          `${child.id}.${sum.childField} cannot be updateable while it contributes to an aggregate`,
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
        );
      } else if (
        !isDateTimeFormat(windowField.format) ||
        !child.required.includes(window.field)
      ) {
        add(
          [...aggregateBase, "window", "field"],
          `${child.id}.${window.field} must be a required date-time field to window a count`,
        );
      } else if (child.update?.fields.includes(window.field)) {
        add(
          [...aggregateBase, "window", "field"],
          `${child.id}.${window.field} cannot be updateable while it windows an aggregate`,
        );
      }
    }
    const refField = child.fields[aggregate.childRefField];
    if (!refField) {
      add(
        [...aggregateBase, "childRefField"],
        `aggregate references unknown child ref field ${aggregate.childRefField}`,
      );
    } else if (!references.accepts(refField, noun.idPrefix)) {
      add(
        [...aggregateBase, "childRefField"],
        `${child.id}.${aggregate.childRefField} must reference ${noun.id}`,
      );
    } else if (child.update?.fields.includes(aggregate.childRefField)) {
      add(
        [...aggregateBase, "childRefField"],
        `${child.id}.${aggregate.childRefField} cannot be updateable while it links an aggregate`,
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
        );
      }
    });
  });
}

function exampleInputSchema(
  noun: UdlNoun,
  verb: string,
  definition: UdlVerb,
): Schema {
  if (verb !== "create") {
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
    ...Object.values(noun.verbs).flatMap((candidate) =>
      candidate.setsAt ? [candidate.setsAt.field] : [],
    ),
  ]);
  const properties: Record<string, unknown> = Object.fromEntries(
    Object.entries(noun.fields).filter(([key]) => !boundKeys.has(key)),
  );
  const required = noun.required.filter((key) => !boundKeys.has(key));
  if (noun.subject) {
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

/**
 * One budget's worth of reference-shape classification: the memo of the answers
 * already bought and what is left of the probe budget. What is guaranteed is
 * that separate opens are independent — each {@link openReferenceShapeBudget}
 * call returns its own memo and its own counter, and nothing resets either
 * afterwards. Sharing is the caller's call, and both choices are made today:
 * `validateUdl` opens one budget for its semantic pass, while the engine's
 * `checkComposerDocument` deliberately runs its noun-composition and
 * gate-deadlock passes on a single shared budget.
 */
export interface ReferenceShapeBudget {
  /**
   * Does this field schema identify exactly one noun family, by accepting that
   * family's scoped id and refusing a foreign one? Answering compiles two JSON
   * Schema validators, and the question is asked once per declared noun per
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
