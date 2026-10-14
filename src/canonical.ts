import { hash } from "fast-sha256";

/**
 * Canonical JSON, the one encoder behind every hashed value in Arc. Keys sort
 * by UTF-16 code unit and scalars encode as `JSON.stringify` writes them. Only
 * plain data encodes: non-finite numbers, `bigint`, functions, symbols,
 * `undefined`, missing array items, non-plain objects and cycles throw.
 */
export function canonicalJson(value: unknown): string {
  return write(value, "$", new WeakSet<object>());
}

/**
 * The UDL document layout: canonical JSON with a two-space indent. Every
 * stored `documentDigest` hashes these bytes.
 */
export function writeJson(value: unknown): string {
  return write(value, "$", new WeakSet<object>(), "");
}

function write(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  indent?: string,
): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) refuse("non finite numbers", path);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      refuse(typeof value, path);
  }
  const array = Array.isArray(value);
  if (!array) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      refuse("objects other than plain ones", path);
    if (Object.getOwnPropertySymbols(value).length > 0)
      refuse("symbol keys", path);
  }
  if (ancestors.has(value)) refuse("cycles", path);
  ancestors.add(value);
  try {
    const inner = indent === undefined ? undefined : `${indent}  `;
    const items: string[] = [];
    if (array) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          refuse("missing array items", `${path}[${index}]`);
        items.push(write(value[index], `${path}[${index}]`, ancestors, inner));
      }
    } else {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record).sort())
        items.push(
          `${JSON.stringify(key)}:${inner === undefined ? "" : " "}${write(record[key], `${path}.${key}`, ancestors, inner)}`,
        );
    }
    const [open, close] = array ? ["[", "]"] : ["{", "}"];
    if (inner === undefined || items.length === 0)
      return `${open}${items.join(",")}${close}`;
    return `${open}\n${inner}${items.join(`,\n${inner}`)}\n${indent}${close}`;
  } finally {
    ancestors.delete(value);
  }
}

function refuse(what: string, path: string): never {
  throw new TypeError(`canonical JSON does not support ${what} at ${path}`);
}

/** SHA-256 over canonical JSON, encoded as lowercase hexadecimal. */
export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function sha256(text: string): string {
  return Array.from(hash(new TextEncoder().encode(text)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
