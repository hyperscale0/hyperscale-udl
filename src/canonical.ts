import { assertValidUdl } from "./validation.js";
import { writeJson } from "./json.js";

export function serializeUdl(value: unknown): string {
  const document = assertValidUdl(value);
  return `${writeJson(document, 0)}\n`;
}

/** SHA-256 over the canonical UTF-8 bytes, encoded as lowercase hexadecimal. */
export async function canonicalDigest(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serializeUdl(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
