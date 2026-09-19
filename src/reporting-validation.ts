import type { UdlDocument } from "./schema.js";
import type {
  ReportDefinition,
  ReportExpression,
  ReportType,
} from "./reporting.js";

type Types = Map<string, ReportType>;
const integer: ReportType = { kind: "integer" };
const boolean: ReportType = { kind: "boolean" };
const date: ReportType = { kind: "date" };
const same = (a: ReportType, b: ReportType) =>
  a.kind === b.kind &&
  (a.kind !== "money" || (b.kind === "money" && a.currency === b.currency));
function requireType(types: Types, name: string): ReportType {
  const value = types.get(name);
  if (!value) throw new Error(`Unknown reporting field or expression ${name}`);
  return value;
}
function requireRule(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function reportExpressionTypes(
  expressions: readonly ReportExpression[],
  initial: Types,
): Types {
  const types = new Map(initial);
  for (const expression of expressions) {
    requireRule(
      !types.has(expression.id),
      `Duplicate expression ${expression.id}`,
    );
    const read = (name: string) => requireType(types, name);
    let result: ReportType;
    switch (expression.op) {
      case "field":
        result = read(expression.path);
        break;
      case "parameter":
        result = date;
        break;
      case "literal": {
        result = expression.type;
        const value = expression.value;
        requireRule(
          result.kind === "money"
            ? typeof value === "string" && /^(0|[1-9][0-9]{0,17})$/.test(value)
            : result.kind === "integer"
              ? typeof value === "number" && Number.isSafeInteger(value)
              : result.kind === "boolean"
                ? typeof value === "boolean"
                : result.kind === "date"
                  ? typeof value === "string" &&
                    Number.isFinite(Date.parse(value))
                  : typeof value === "string",
          `Invalid literal ${expression.id}`,
        );
        break;
      }
      case "not":
        requireRule(
          read(expression.value).kind === "boolean",
          "not requires boolean",
        );
        result = boolean;
        break;
      case "choose": {
        requireRule(
          read(expression.condition).kind === "boolean",
          "choose requires boolean",
        );
        result = read(expression.yes);
        requireRule(
          same(result, read(expression.no)),
          "choose branches must have matching types and currencies",
        );
        break;
      }
      case "bucket":
        requireRule(
          read(expression.value).kind === "date",
          "bucket requires date",
        );
        result = { kind: "text" };
        break;
      case "ratio": {
        const numerator = read(expression.numerator),
          denominator = read(expression.denominator);
        requireRule(
          same(numerator, denominator) &&
            ["money", "integer"].includes(numerator.kind),
          "ratio needs matching numeric measures",
        );
        result = integer;
        break;
      }
      default: {
        const left = read(expression.left),
          right = read(expression.right);
        requireRule(
          same(left, right),
          `Incompatible types or currencies in ${expression.id}`,
        );
        if (["equal", "less", "atMost"].includes(expression.op))
          result = boolean;
        else if (expression.op === "and" || expression.op === "or") {
          requireRule(
            left.kind === "boolean",
            "Boolean operation requires booleans",
          );
          result = boolean;
        } else if (expression.op === "daysBetween") {
          requireRule(left.kind === "date", "daysBetween requires dates");
          result = integer;
        } else {
          requireRule(
            ["money", "integer"].includes(left.kind),
            "Arithmetic requires numeric measures",
          );
          result = left;
        }
      }
    }
    types.set(expression.id, result);
  }
  return types;
}
function aggregateTypes(
  aggregates: ReportDefinition["calculation"]["aggregates"],
  input: Types,
  target: Types,
) {
  for (const aggregate of aggregates) {
    requireRule(
      !target.has(aggregate.name),
      `Duplicate aggregate ${aggregate.name}`,
    );
    const type =
      aggregate.op === "count"
        ? integer
        : requireType(input, aggregate.value ?? "");
    requireRule(
      !["sum", "average"].includes(aggregate.op) ||
        ["money", "integer"].includes(type.kind),
      "sum requires numeric values",
    );
    requireRule(
      aggregate.op !== "count" || aggregate.value === undefined,
      "count has no value field",
    );
    requireRule(
      aggregate.op === "average"
        ? aggregate.rounding !== undefined
        : aggregate.rounding === undefined,
      "Only average requires an explicit rounding policy",
    );
    target.set(aggregate.name, type);
  }
}
/** Used by compilation and replay, never a report-name dispatch. */
export function validateReportDefinition(
  report: ReportDefinition,
  document: UdlDocument,
): void {
  requireRule(
    report.scope.currency === document.currency,
    "Report currency differs from Product currency",
  );
  const datasets = new Map<string, Types>();
  for (const dataset of report.datasets) {
    requireRule(!datasets.has(dataset.id), `Duplicate dataset ${dataset.id}`);
    const fields: Types = new Map();
    for (const column of dataset.columns) {
      requireRule(!fields.has(column.name), `Duplicate column ${column.name}`);
      if (column.type.kind === "money")
        requireRule(
          column.type.currency === report.scope.currency,
          "Incompatible dataset currency",
        );
      if (dataset.source === "instrument") {
        requireRule(
          report.scope.kind === "product",
          "Company instrument reports require cross-Build bindings",
        );
        requireRule(
          dataset.instruments.length > 0,
          "Instrument source requires declared instruments",
        );
        for (const id of dataset.instruments) {
          const instrument = document.instruments.find(
            (entry) => entry.id === id,
          );
          requireRule(instrument, `Unknown report instrument ${id}`);
          const parts = column.field.split(".");
          const field = instrument.fields.find(
            (entry) => entry.name === parts[0],
          );
          const sealed = (
            { id: "text", status: "text", createdAt: "date" } as Record<
              string,
              string
            >
          )[column.field];
          const actual =
            parts.length === 2 &&
            parts[1] === "balance" &&
            field?.type === "account"
              ? "money"
              : (sealed ??
                (field && ["ref", "account", "enum"].includes(field.type)
                  ? "text"
                  : field?.type));
          requireRule(
            actual === column.type.kind,
            `Unknown or mistyped report field ${id}.${column.field}`,
          );
        }
      } else {
        requireRule(
          dataset.instruments.length === 0,
          "Only instrument sources bind instruments",
        );
        const sourceFields: Record<string, Record<string, string>> = {
          account: {
            id: "text",
            ownerParticipantId: "text",
            currency: "text",
            role: "text",
            status: "text",
            createdAt: "date",
            balance: "money",
          },
          identity: {
            id: "text",
            entityId: "text",
            participantId: "text",
            status: "text",
            createdAt: "date",
          },
          operation: {
            id: "text",
            name: "text",
            status: "text",
            createdAt: "date",
          },
        };
        requireRule(
          sourceFields[dataset.source]?.[column.field] === column.type.kind,
          `Unknown or mistyped ${dataset.source} field ${column.field}`,
        );
      }
      fields.set(column.name, column.type);
    }
    requireRule(
      requireType(fields, dataset.rowKey).kind === "text",
      "Row key must be text",
    );
    const types = reportExpressionTypes(dataset.expressions, fields);
    if (dataset.selection)
      requireRule(
        requireType(types, dataset.selection).kind === "boolean",
        "Selection must be boolean",
      );
    if (dataset.selection) validateSourceKey(dataset, dataset.selection);
    datasets.set(dataset.id, types);
  }
  const aggregateNames = [
    ...report.calculation.joins.flatMap((join) => join.aggregates),
    ...report.calculation.aggregates,
  ].map((aggregate) => aggregate.name);
  requireRule(
    new Set(aggregateNames).size === aggregateNames.length,
    "Aggregate names must be unique across stages for null accounting",
  );
  const primary = datasets.get(report.selection.dataset);
  requireRule(primary, "Unknown primary dataset");
  let types = new Map(primary);
  const joined = new Set<string>();
  for (const join of report.calculation.joins) {
    requireRule(
      !joined.has(join.dataset),
      "Duplicate join requires a distinct dataset alias",
    );
    requireRule(
      join.dataset !== report.selection.dataset,
      "Self joins require a distinct dataset alias",
    );
    joined.add(join.dataset);
    const foreign = datasets.get(join.dataset);
    requireRule(foreign, `Unknown joined dataset ${join.dataset}`);
    validateSourceKey(
      report.datasets.find((dataset) => dataset.id === join.dataset)!,
      join.foreign,
    );
    requireRule(
      same(requireType(types, join.local), requireType(foreign, join.foreign)),
      "Join keys have incompatible types",
    );
    requireRule(
      join.aggregates.length > 0,
      "Joins must declare aggregates; implicit row multiplication is forbidden",
    );
    aggregateTypes(join.aggregates, foreign, types);
  }
  types = reportExpressionTypes(report.calculation.expressions, types);
  if (report.selection.predicate)
    requireRule(
      requireType(types, report.selection.predicate).kind === "boolean",
      "Selection must be boolean",
    );
  for (const required of report.validation.required)
    requireType(types, required);
  for (const pair of report.validation.rowReconcile)
    requireRule(
      same(requireType(types, pair.left), requireType(types, pair.right)),
      "Row reconciliation requires matching measures",
    );
  if (report.calculation.aggregates.length) {
    const grouped: Types = new Map(
      report.calculation.groupBy.map((key) => [key, requireType(types, key)]),
    );
    aggregateTypes(report.calculation.aggregates, types, grouped);
    types = grouped;
  } else
    requireRule(
      report.calculation.groupBy.length === 0,
      "Grouping requires aggregates",
    );
  types = reportExpressionTypes(report.calculation.resultExpressions, types);
  for (const pair of report.validation.reconcile)
    requireRule(
      same(requireType(types, pair.left), requireType(types, pair.right)),
      "Reconciliation requires matching measures",
    );
  const outputs = new Set<string>();
  for (const column of report.output.columns) {
    requireRule(!outputs.has(column.name), "Duplicate output column");
    outputs.add(column.name);
    requireRule(
      same(requireType(types, column.name), column.type),
      `Output type differs for ${column.name}`,
    );
  }
  for (const sort of report.output.sort)
    requireRule(outputs.has(sort), `Sort key ${sort} must be an output column`);
}

function validateSourceKey(
  dataset: ReportDefinition["datasets"][number],
  key: string,
  seen = new Set<string>(),
): void {
  if (seen.has(key)) return;
  seen.add(key);
  const column = dataset.columns.find((entry) => entry.name === key);
  if (column) {
    requireRule(
      column.field !== "balance" && !column.field.endsWith(".balance"),
      "Source selection and join keys cannot depend on ledger balances",
    );
    return;
  }
  const expression = dataset.expressions.find((entry) => entry.id === key);
  requireRule(expression, `Unknown source key ${key}`);
  requireRule(
    expression.op !== "ratio",
    "Ratios belong after source selection",
  );
  const read = (name: string) => validateSourceKey(dataset, name, seen);
  if (expression.op === "field") read(expression.path);
  else if (expression.op === "choose") {
    read(expression.condition);
    read(expression.yes);
    read(expression.no);
  } else if (expression.op === "not" || expression.op === "bucket")
    read(expression.value);
  else if ("left" in expression) {
    read(expression.left);
    read(expression.right);
  }
}
