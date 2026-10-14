import type * as z from "zod";
import {
  UDL_FORMAT_VERSION,
  udlDocumentSchema,
  udlFormat1DocumentSchema,
  type UdlAnyFamily,
} from "./schema.js";

/**
 * How this engine reads one UDL format. A Build is bytecode and keeps the
 * format it compiled to. The current format parses straight into the engine's
 * document; an older one parses with its own schema, then `upgrade`, a pure
 * and deterministic step, turns it into the next format.
 */
export interface UdlFormatReader {
  readonly schema: z.ZodType;
  readonly upgrade?: (document: unknown) => unknown;
}

/**
 * One reader per format a stored Build uses, keyed by `document.udl`. A format
 * bump adds its schema here and gives the previous format an upgrade step. A
 * new Build admits only `UDL_FORMAT_VERSION` (`validateNewBuildUdl`).
 */
export const udlFormatReaders = new Map<number, UdlFormatReader>([
  [1, { schema: udlFormat1DocumentSchema }],
  [UDL_FORMAT_VERSION, { schema: udlDocumentSchema }],
]);

/**
 * Whether two families name the same std declaration. Two format 2 families
 * compare digests. When either is format 1, module and export path decide,
 * which is what a stored revision decided: every stored revision is 1.
 */
export function sameFamily(
  a: UdlAnyFamily | undefined,
  b: UdlAnyFamily,
): boolean {
  return (
    a !== undefined &&
    a.module === b.module &&
    a.exportPath === b.exportPath &&
    (!("digest" in a) || !("digest" in b) || a.digest === b.digest)
  );
}

/** The format a stored document declares, when this engine can read it. */
export function readableUdlFormat(document: unknown): number | undefined {
  const format =
    document !== null && typeof document === "object"
      ? (document as { udl?: unknown }).udl
      : undefined;
  return typeof format === "number" && udlFormatReaders.has(format)
    ? format
    : undefined;
}
