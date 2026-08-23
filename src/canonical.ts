import { assertValidUdl } from "./validation.js";

const INDENT = "  ";

export function serializeUdl(value: unknown): string {
  const document = assertValidUdl(value);
  return `${writeJson(document, 0)}\n`;
}

function writeJson(value: unknown, depth: number): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("UDL canonical JSON received a non-JSON value");
    }
    return encoded;
  }

  const indent = INDENT.repeat(depth);
  const childIndent = INDENT.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value
      .map((item) => `${childIndent}${writeJson(item, depth + 1)}`)
      .join(",\n")}\n${indent}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodeUnits);
  if (keys.length === 0) return "{}";
  return `{\n${keys
    .map(
      (key) =>
        `${childIndent}${JSON.stringify(key)}: ${writeJson(record[key], depth + 1)}`,
    )
    .join(",\n")}\n${indent}}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
