import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { Validator, type Schema } from "@cfworker/json-schema";

import {
  canonicalizeUdl,
  parseUdl,
  serializeUdl,
  UdlError,
} from "../src/index.js";

const conformanceRoot = join(import.meta.dir, "..", "conformance");

interface ExpectedIssue {
  readonly code: string;
  readonly path: string;
}

interface ExpectedCase {
  readonly canonical?: string;
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

describe("conformance/valid", () => {
  test("carries the five domain documents plus the minimal pair", () => {
    expect(validNames).toEqual([
      "cards.udl",
      "commerce-escrow.udl",
      "hand-edited.udl",
      "insured-car-marketplace.udl",
      "insured-travel.udl",
      "minimal.udl",
      "protection.udl",
    ]);
  });

  for (const document of validNames) {
    test(`${document} is admitted and canonicalizes as declared`, async () => {
      const { bytes, expected } = await readCase("valid", document);
      const parsed = parseUdl(bytes);

      const canonicalName = expected.canonical;
      if (!canonicalName) throw new Error(`${document} declares no canonical`);
      const canonical = await Bun.file(
        join(conformanceRoot, "valid", canonicalName),
      ).text();
      expect(serializeUdl(parsed)).toBe(canonical);
      expect(canonicalizeUdl(bytes)).toBe(canonical);
      expect(parseUdl(serializeUdl(parsed))).toEqual(parsed);

      // The published schema must admit every document the parser admits, or
      // an implementation reading only spec/udl.schema.json would reject it.
      expect(specValidator.validate(parsed).errors).toEqual([]);
    });
  }
});

describe("conformance/invalid", () => {
  test("covers every issue code the format defines", async () => {
    const codes = new Set<string>();
    for (const document of invalidNames) {
      const { expected } = await readCase("invalid", document);
      for (const issue of expected.issues ?? []) codes.add(issue.code);
    }
    expect([...codes].sort()).toEqual([
      "invalid_json",
      "invalid_semantics",
      "invalid_shape",
      "invalid_utf8",
      "resource_limit",
    ]);
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
