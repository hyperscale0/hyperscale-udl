import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { Validator, type Schema } from "@cfworker/json-schema";

import {
  canonicalizeUdl,
  canonicalDigest,
  diffValidatedUdlEvolution,
  diffInstrumentEvolution,
  openReferenceShapeBudget,
  parseUdl,
  reconcileExceptionChildProblems,
  serializeUdl,
  snapshotUdlInstrument,
  udlClauseVocabulary,
  udlDiagnostics,
  UdlError,
} from "../src/index.js";

const conformanceRoot = join(import.meta.dir, "..", "conformance");

interface ExpectedIssue {
  readonly code: string;
  readonly path: string;
}

interface ExpectedCase {
  readonly canonical?: string;
  readonly digest?: string;
  readonly issues?: readonly ExpectedIssue[];
  readonly summary: string;
  readonly verdict: "invalid" | "valid";
}

async function caseNames(verdict: "invalid" | "valid"): Promise<string[]> {
  const entries = await readdir(join(conformanceRoot, verdict));
  const documents = entries.filter((name) => name.endsWith(".udl")).sort();
  const expectations = entries
    .filter((name) => name.endsWith(".expected.json"))
    .map((name) => name.replace(/\.expected\.json$/, ".udl"))
    .sort();

  // An orphan on either side means a case silently stopped running.
  expect(expectations).toEqual(documents);
  return documents;
}

async function readCase(
  verdict: "invalid" | "valid",
  document: string,
): Promise<{ bytes: Uint8Array; expected: ExpectedCase }> {
  const directory = join(conformanceRoot, verdict);
  const bytes = new Uint8Array(
    await Bun.file(join(directory, document)).arrayBuffer(),
  );
  const expected = (await Bun.file(
    join(directory, document.replace(/\.udl$/, ".expected.json")),
  ).json()) as ExpectedCase;
  expect(expected.verdict).toBe(verdict);
  expect(expected.summary.trim().length).toBeGreaterThan(0);
  return { bytes, expected };
}

const specValidator = new Validator(
  (await Bun.file(
    join(conformanceRoot, "..", "spec", "udl.schema.json"),
  ).json()) as Schema,
  "2020-12",
  false,
);

const validNames = await caseNames("valid");
const invalidNames = await caseNames("invalid");

async function evolutionCaseNames(): Promise<string[]> {
  const entries = await readdir(join(conformanceRoot, "evolution"));
  const live = entries
    .filter((name) => name.endsWith(".live.udl"))
    .map((name) => name.replace(/\.live\.udl$/, ""))
    .sort();
  const next = entries
    .filter((name) => name.endsWith(".next.udl"))
    .map((name) => name.replace(/\.next\.udl$/, ""))
    .sort();
  const expected = entries
    .filter((name) => name.endsWith(".expected.json"))
    .map((name) => name.replace(/\.expected\.json$/, ""))
    .sort();
  expect(next).toEqual(live);
  expect(expected).toEqual(live);
  return live;
}

const evolutionNames = await evolutionCaseNames();

describe("conformance/valid", () => {
  test("every clause vocabulary target has an admitted example", async () => {
    const documents = await Promise.all(
      validNames.map((name) =>
        Bun.file(join(conformanceRoot, "valid", name)).json(),
      ),
    );
    for (const clause of udlClauseVocabulary) {
      expect(
        documents.some((document) =>
          hasTarget(document, clause.target.split(".")),
        ),
      ).toBe(true);
    }
  });

  for (const document of validNames) {
    test(`${document} is admitted and canonicalizes as declared`, async () => {
      const { bytes, expected } = await readCase("valid", document);
      const parsed = parseUdl(bytes);

      const canonicalName = expected.canonical;
      if (!canonicalName) throw new Error(`${document} declares no canonical`);
      if (!expected.digest) throw new Error(`${document} declares no digest`);
      const canonical = await Bun.file(
        join(conformanceRoot, "valid", canonicalName),
      ).text();
      expect(serializeUdl(parsed)).toBe(canonical);
      expect(canonicalizeUdl(bytes)).toBe(canonical);
      expect(parseUdl(serializeUdl(parsed))).toEqual(parsed);
      expect(await canonicalDigest(parsed)).toBe(expected.digest);

      // The published schema must admit every document the parser admits, or
      // an implementation reading only spec/udl.schema.json would reject it.
      expect(specValidator.validate(parsed).errors).toEqual([]);
    });
  }
});

describe("conformance/invalid", () => {
  test("covers every admission and document issue code", async () => {
    const codes = new Set<string>();
    for (const document of invalidNames) {
      const { expected } = await readCase("invalid", document);
      for (const issue of expected.issues ?? []) codes.add(issue.code);
    }
    for (const document of evolutionNames) {
      const expected = (await Bun.file(
        join(conformanceRoot, "evolution", `${document}.expected.json`),
      ).json()) as ExpectedCase;
      for (const issue of expected.issues ?? []) codes.add(issue.code);
    }
    expect([...codes].sort()).toEqual(
      udlDiagnostics.map((diagnostic) => diagnostic.code).sort(),
    );
  });

  for (const document of invalidNames) {
    test(`${document} is refused with the declared issues`, async () => {
      const { bytes, expected } = await readCase("invalid", document);

      let issues: readonly { code: string; path: string }[] | undefined;
      try {
        parseUdl(bytes);
      } catch (error) {
        if (!(error instanceof UdlError)) throw error;
        issues = error.issues;
      }
      if (!issues) throw new Error(`${document} was admitted`);

      // Level 3 of the suite: the listed code and path pairs must all be
      // reported. An implementation may report more.
      const reported = issues.map((issue) => `${issue.code} ${issue.path}`);
      for (const issue of expected.issues ?? []) {
        expect(reported).toContain(`${issue.code} ${issue.path}`);
      }
    });
  }
});

describe("conformance/evolution", () => {
  for (const name of evolutionNames) {
    test(`${name} reports the declared evolution issues`, async () => {
      const directory = join(conformanceRoot, "evolution");
      const live = parseUdl(
        new Uint8Array(
          await Bun.file(join(directory, `${name}.live.udl`)).arrayBuffer(),
        ),
      );
      const next = parseUdl(
        new Uint8Array(
          await Bun.file(join(directory, `${name}.next.udl`)).arrayBuffer(),
        ),
      );
      const expected = (await Bun.file(
        join(directory, `${name}.expected.json`),
      ).json()) as ExpectedCase;
      expect(expected.verdict).toBe("invalid");
      const reported = diffValidatedUdlEvolution(live, next).map(
        (entry) => `${entry.code} ${entry.path}`,
      );
      for (const entry of expected.issues ?? []) {
        expect(reported).toContain(`${entry.code} ${entry.path}`);
      }
    });
  }

  test("direct instrument diffs use the instrument collection path", async () => {
    const document = parseUdl(
      await Bun.file(join(conformanceRoot, "valid", "minimal.udl")).text(),
    );
    const previous = snapshotUdlInstrument(document.instruments[0]!);
    const next = { ...previous, id: "renamed_note" };
    expect(diffInstrumentEvolution(previous, next)[0]?.path).toBe(
      "$.instruments",
    );
  });
});

describe("diagnostic catalog", () => {
  test("reconcile exception fields are required plain money and text", () => {
    const fields = {
      amount: { pattern: "^[1-9][0-9]{0,17}$", type: "string" },
      parentId: { type: "string" },
      reason: { type: "string" },
    };
    const exception = {
      amountField: "amount",
      reasonField: "reason",
      refField: "parentId",
    };
    expect(
      reconcileExceptionChildProblems(
        "parent",
        { fields, required: ["reason"] },
        exception,
        openReferenceShapeBudget(),
      ),
    ).toContain("UDL5009");
    expect(
      reconcileExceptionChildProblems(
        "parent",
        { fields, required: ["amount"] },
        exception,
        openReferenceShapeBudget(),
      ),
    ).toContain("UDL5011");
    for (const constrainedReason of [
      { pattern: "^reason$", type: "string" },
      { format: "hyperscale-date", type: "string" },
      { enum: ["reason"], type: "string" },
    ]) {
      expect(
        reconcileExceptionChildProblems(
          "parent",
          {
            fields: { ...fields, reason: constrainedReason },
            required: ["amount", "reason"],
          },
          exception,
          openReferenceShapeBudget(),
        ),
      ).toContain("UDL5012");
    }
  });

  test("is the complete UDL code set raised by package source", async () => {
    const sourceRoot = join(import.meta.dir, "..", "src");
    const codes = new Set<string>();
    for (const name of await readdir(sourceRoot)) {
      if (!name.endsWith(".ts") || name === "diagnostics.ts") continue;
      const source = await Bun.file(join(sourceRoot, name)).text();
      for (const match of source.matchAll(/\bUDL\d{4}\b/g)) codes.add(match[0]);
    }
    expect([...codes].sort()).toEqual(
      udlDiagnostics.map((diagnostic) => diagnostic.code).sort(),
    );
  });
});

function hasTarget(value: unknown, target: readonly string[]): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((entry) => hasTarget(entry, target));
  const record = value as Readonly<Record<string, unknown>>;
  let candidate: unknown = record;
  for (const segment of target) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      candidate = undefined;
      break;
    }
    candidate = (candidate as Readonly<Record<string, unknown>>)[segment];
  }
  if (candidate !== undefined) return true;
  return Object.values(record).some((entry) => hasTarget(entry, target));
}
