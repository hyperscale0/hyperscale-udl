import { serializeUdl } from "./canonical.js";
import { issue } from "./diagnostics.js";
import { UDL_LIMITS } from "./limits.js";
import type { UdlDocument } from "./schema.js";
import { assertValidUdl, UdlError } from "./validation.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function parseUdl(source: string | Uint8Array): UdlDocument {
  const sourceBytes =
    typeof source === "string"
      ? source.length > UDL_LIMITS.maxSourceBytes
        ? source.length
        : new TextEncoder().encode(source).byteLength
      : source.byteLength;
  if (sourceBytes > UDL_LIMITS.maxSourceBytes) {
    throw new UdlError([
      issue(
        "UDL1004",
        "$",
        `UDL source exceeds ${UDL_LIMITS.maxSourceBytes} bytes`,
      ),
    ]);
  }
  return parseUdlText(
    typeof source === "string" ? source : decodeUdlBytes(source),
  );
}

function parseUdlText(source: string): UdlDocument {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new UdlError([
      issue(
        "UDL1002",
        "$",
        error instanceof Error ? error.message : "could not parse JSON",
      ),
    ]);
  }
  // JSON.parse has already checked syntax. Scan member names before its
  // last-value-wins behavior can erase an authored declaration.
  const members: (Set<string> | null)[] = [];
  let name = "";
  for (const token of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g)) {
    const text = token[0];
    if (text === "{") members.push(new Set());
    else if (text === "[") members.push(null);
    else if (text === "}" || text === "]") members.pop();
    else if (text === ":") {
      const keys = members[members.length - 1];
      if (keys?.has(name))
        throw new UdlError([
          issue(
            "UDL1002",
            "$",
            `duplicate JSON member ${name} at offset ${token.index}`,
          ),
        ]);
      keys?.add(name);
    } else name = JSON.parse(text) as string;
  }
  return assertValidUdl(value);
}

export function canonicalizeUdl(source: string | Uint8Array): string {
  return serializeUdl(parseUdl(source));
}

function decodeUdlBytes(source: Uint8Array): string {
  try {
    return utf8Decoder.decode(source);
  } catch {
    throw new UdlError([
      issue("UDL1001", "$", "UDL bytes must be valid UTF-8"),
    ]);
  }
}
