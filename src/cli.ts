#!/usr/bin/env node
/**
 * The `udl` command. Actions over the same library the compiler uses:
 * `validate` answers whether a document is admissible, `fmt` writes the
 * canonical bytes, and `diff` answers whether a change is legal against a
 * document that already has live instances.
 */
import { readFile, writeFile } from "node:fs/promises";

import {
  canonicalizeUdl,
  canonicalDigest,
  diffValidatedUdlEvolution,
  parseUdl,
  UdlError,
  type UdlDocument,
  udlDiagnostic,
} from "./index.js";

const USAGE = `udl - the Universal Domain Language toolchain

usage:
  udl validate <file>          parse <file> and report every issue found
  udl fmt <file> [--write]     print the canonical form, or rewrite the file
  udl canon <file> [--digest]  print canonical bytes, or their SHA-256 digest
  udl diff <live> <next>       check <next> against the append-only law
  udl explain UDL####          explain one stable diagnostic code
  udl help                     print this

exit codes:
  0  the document is admissible, or the change is additive
  1  the document was refused, or the change breaks the append-only law
  2  the command line was wrong, or a file could not be read`;

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      return 0;
    case "validate":
      return validateCommand(rest);
    case "fmt":
      return formatCommand(rest);
    case "canon":
      return canonCommand(rest);
    case "diff":
      return diffCommand(rest);
    case "explain":
      return explainCommand(rest);
    case undefined:
      return usageError("udl: no command given");
    default:
      return usageError(`udl: unknown command ${command}`);
  }
}

async function canonCommand(args: readonly string[]): Promise<number> {
  const digest = args.includes("--digest");
  const [file, ...extra] = args.filter((argument) => argument !== "--digest");
  if (file === undefined || extra.length > 0) {
    return usageError("usage: udl canon <file> [--digest]");
  }
  const bytes = await readDocument(file);
  if (bytes === null) return 2;
  let document: UdlDocument;
  try {
    document = parseUdl(bytes);
  } catch (error) {
    return reportIssues(file, error);
  }
  if (digest) console.log(await canonicalDigest(document));
  else process.stdout.write(canonicalizeUdl(bytes));
  return 0;
}

function explainCommand(args: readonly string[]): number {
  const [code, ...extra] = args;
  if (code === undefined || extra.length > 0) {
    return usageError("usage: udl explain UDL####");
  }
  const diagnostic = udlDiagnostic(code);
  if (!diagnostic) {
    return usageError(`udl: unknown diagnostic code ${code}`);
  }
  console.log(`${code} ${diagnostic.title}`);
  console.log(`category: ${diagnostic.category}`);
  console.log(`family: ${diagnostic.family}`);
  console.log(`fix: ${diagnostic.fix}`);
  return 0;
}

async function validateCommand(args: readonly string[]): Promise<number> {
  const [file, ...extra] = args;
  if (file === undefined || extra.length > 0) {
    return usageError("usage: udl validate <file>");
  }
  const bytes = await readDocument(file);
  if (bytes === null) return 2;
  if (parseDocument(file, bytes) === null) return 1;
  console.log(`${file}: ok`);
  return 0;
}

async function formatCommand(args: readonly string[]): Promise<number> {
  const write = args.includes("--write");
  const [file, ...extra] = args.filter((argument) => argument !== "--write");
  if (file === undefined || extra.length > 0) {
    return usageError("usage: udl fmt <file> [--write]");
  }
  const bytes = await readDocument(file);
  if (bytes === null) return 2;

  let canonical: string;
  try {
    canonical = canonicalizeUdl(bytes);
  } catch (error) {
    return reportIssues(file, error);
  }

  if (!write) {
    process.stdout.write(canonical);
    return 0;
  }
  // The bytes decoded cleanly already: canonicalizeUdl refuses anything else.
  if (new TextDecoder().decode(bytes) === canonical) return 0;
  await writeFile(file, canonical);
  console.log(`${file}: formatted`);
  return 0;
}

async function diffCommand(args: readonly string[]): Promise<number> {
  const [livePath, nextPath, ...extra] = args;
  if (livePath === undefined || nextPath === undefined || extra.length > 0) {
    return usageError("usage: udl diff <live> <next>");
  }
  const liveBytes = await readDocument(livePath);
  const nextBytes = await readDocument(nextPath);
  if (liveBytes === null || nextBytes === null) return 2;

  const live = parseDocument(livePath, liveBytes);
  const next = parseDocument(nextPath, nextBytes);
  if (live === null || next === null) return 1;

  // `parseDocument` already validated both, so take the door that does not
  // validate a second time.
  const violations = diffValidatedUdlEvolution(live, next);
  if (violations.length === 0) {
    console.log(`${nextPath}: additive`);
    return 0;
  }
  for (const violation of violations) {
    console.error(
      `${nextPath}: ${violation.code} ${violation.path}: ${violation.message}`,
    );
  }
  return 1;
}

async function readDocument(file: string): Promise<Uint8Array | null> {
  try {
    return await readFile(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`udl: cannot read ${file}: ${reason}`);
    return null;
  }
}

/** Parses one document, printing its issues. Null means the document was refused. */
function parseDocument(file: string, bytes: Uint8Array): UdlDocument | null {
  try {
    return parseUdl(bytes);
  } catch (error) {
    reportIssues(file, error);
    return null;
  }
}

function reportIssues(file: string, error: unknown): number {
  if (!(error instanceof UdlError)) throw error;
  for (const issue of error.issues) {
    console.error(`${file}: ${issue.code} ${issue.path}: ${issue.message}`);
  }
  return 1;
}

function usageError(message: string): number {
  console.error(message);
  console.error(USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
