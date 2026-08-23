import { serializeUdl } from "./canonical.js";
import { UDL_LIMITS } from "./limits.js";
import type { UdlDocument } from "./schema.js";
import { assertValidUdl, UdlError, type UdlIssue } from "./validation.js";

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
      {
        code: "resource_limit",
        message: `UDL source exceeds ${UDL_LIMITS.maxSourceBytes} bytes`,
        path: "$",
      },
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
      {
        code: "invalid_json",
        message:
          error instanceof Error ? error.message : "could not parse JSON",
        path: "$",
      },
    ]);
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
    const issue: UdlIssue = {
      code: "invalid_utf8",
      message: "UDL bytes must be valid UTF-8",
      path: "$",
    };
    throw new UdlError([issue]);
  }
}
