import { readUdl, UdlError } from "./validation.js";
import { sha256, writeJson } from "./canonical.js";

/** The stored bytes of a UDL document: its own format's layout, with a trailing newline. */
export function serializeUdl(value: unknown): string {
  const read = readUdl(value);
  if (!read.ok) throw new UdlError(read.issues);
  return `${writeJson(read.stored)}\n`;
}

/** SHA-256 over the stored document bytes, the `documentDigest` every Build carries. */
export function documentDigest(value: unknown): string {
  return sha256(serializeUdl(value));
}
