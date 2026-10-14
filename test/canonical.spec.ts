import { afterEach, expect, test } from "bun:test";
import * as z from "zod";
import {
  canonicalJson,
  digest,
  documentDigest,
  serializeUdl,
  udlDocumentSchema,
  udlFormatReaders,
  validateNewBuildUdl,
  validateUdl,
  UDL_FORMAT_VERSION,
} from "../src/index.js";
import { writeJson } from "../src/canonical.js";
import { reviewDocument } from "./review-fixture.js";

// Input, then the bytes every encoder this one replaced wrote for it: the
// contracts, engine, audit-chain, HSX and report encoders compact, and the
// UDL document writer pretty. The retained Build fixtures carry the rest of
// the proof: their stored buildDigest and documentDigest still reproduce
// (the engine's retained Builds spec).
const vectors: readonly [string, unknown, string, string][] = [
  [
    "uppercase sorts before lowercase",
    { B: 1, a: 2 },
    '{"B":1,"a":2}',
    '{\n  "B": 1,\n  "a": 2\n}',
  ],
  [
    "underscore sorts before letters",
    { ab: 1, a_b: 2 },
    '{"a_b":2,"ab":1}',
    '{\n  "a_b": 2,\n  "ab": 1\n}',
  ],
  [
    "code units, not locale or numeric order",
    { é: 1, Z: 2, a: 3, _: 4, "10": 5, "9": 6, "": 7 },
    '{"":7,"10":5,"9":6,"Z":2,"_":4,"a":3,"é":1}',
    '{\n  "": 7,\n  "10": 5,\n  "9": 6,\n  "Z": 2,\n  "_": 4,\n  "a": 3,\n  "é": 1\n}',
  ],
  [
    "strings escape as JSON.stringify does",
    {
      text: 'line\nbreak "quoted" \\ \u0000 \u2028 😀',
      empty: "",
      unicode: "ريال",
    },
    '{"empty":"","text":"line\\nbreak \\"quoted\\" \\\\ \\u0000 \u2028 😀","unicode":"ريال"}',
    '{\n  "empty": "",\n  "text": "line\\nbreak \\"quoted\\" \\\\ \\u0000 \u2028 😀",\n  "unicode": "ريال"\n}',
  ],
  [
    "numbers print as JSON.stringify does",
    {
      numbers: [
        0, -0, 1, -1, 0.1, 1e21, 1e-7, 9007199254740991, -9007199254740991,
      ],
    },
    '{"numbers":[0,0,1,-1,0.1,1e+21,1e-7,9007199254740991,-9007199254740991]}',
    '{\n  "numbers": [\n    0,\n    0,\n    1,\n    -1,\n    0.1,\n    1e+21,\n    1e-7,\n    9007199254740991,\n    -9007199254740991\n  ]\n}',
  ],
  [
    "nested keys sort and arrays keep order",
    {
      nested: { z: [1, { y: null, x: true }], a: { c: false, b: [] } },
      empty: {},
    },
    '{"empty":{},"nested":{"a":{"b":[],"c":false},"z":[1,{"x":true,"y":null}]}}',
    '{\n  "empty": {},\n  "nested": {\n    "a": {\n      "b": [],\n      "c": false\n    },\n    "z": [\n      1,\n      {\n        "x": true,\n        "y": null\n      }\n    ]\n  }\n}',
  ],
  [
    "empty containers",
    [[], {}, [[]], null, "a", 1, false],
    '[[],{},[[]],null,"a",1,false]',
    '[\n  [],\n  {},\n  [\n    []\n  ],\n  null,\n  "a",\n  1,\n  false\n]',
  ],
];

test.each(vectors)("%s", (_, value, compact, pretty) => {
  expect(canonicalJson(value)).toBe(compact);
  expect(writeJson(value)).toBe(pretty);
});

// Mutation: sort keys with localeCompare, or keep insertion order.
test("key order does not change the output", () => {
  const reversed = { b: { y: 2, x: 1 }, a: [{ d: 4, c: 3 }] };
  const ordered = { a: [{ c: 3, d: 4 }], b: { x: 1, y: 2 } };
  expect(canonicalJson(reversed)).toBe(canonicalJson(ordered));
  expect(digest(reversed)).toBe(digest(ordered));
  expect(digest(ordered)).toMatch(/^[a-f0-9]{64}$/);
});

const cycle: Record<string, unknown> = {};
cycle.self = cycle;
const sparse: unknown[] = [1];
sparse[2] = 3;

// Mutation: drop any one guard in write().
test.each([
  ["NaN", NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a Date", new Date(0)],
  ["a Date inside an object", { at: new Date("2026-08-06T00:00:00.000Z") }],
  ["undefined", undefined],
  ["an undefined field", { value: undefined }],
  ["an undefined item", [undefined]],
  ["a missing item", sparse],
  ["a cycle", cycle],
  ["a bigint", 1n],
  ["a function", () => 1],
  ["a symbol", Symbol("audit")],
  ["a symbol key", { [Symbol("audit")]: 1 }],
  ["a Map", new Map()],
] as const)("canonical JSON refuses %s", (_, value) => {
  expect(() => canonicalJson(value)).toThrow(TypeError);
  expect(() => writeJson(value)).toThrow(TypeError);
});

test("a shared object that is not a cycle encodes", () => {
  const shared = { a: 1 };
  expect(canonicalJson({ x: shared, y: [shared] })).toBe(
    '{"x":{"a":1},"y":[{"a":1}]}',
  );
});

test("a UDL document's bytes are its layout with a trailing newline", () => {
  const document = reviewDocument();
  expect(serializeUdl(document)).toBe(`${writeJson(document)}\n`);
  expect(documentDigest(document)).toMatch(/^[a-f0-9]{64}$/);
});

const current = udlFormatReaders.get(UDL_FORMAT_VERSION)!;
afterEach(() => {
  udlFormatReaders.set(UDL_FORMAT_VERSION, current);
  udlFormatReaders.delete(UDL_FORMAT_VERSION + 1);
});

// Mutation: hash the upgraded document, or skip a format's upgrade step.
test("a stored format reads through its upgrade step and keeps its digest", () => {
  const stored = reviewDocument();
  const before = documentDigest(stored);
  const next = UDL_FORMAT_VERSION + 1;
  udlFormatReaders.set(next, {
    schema: z.strictObject({
      ...udlDocumentSchema.shape,
      udl: z.literal(next),
      edition: z.literal(1),
    }),
  });
  udlFormatReaders.set(UDL_FORMAT_VERSION, {
    schema: current.schema,
    upgrade: (document) => ({
      ...(document as object),
      udl: next,
      edition: 1,
    }),
  });
  const read = validateUdl(stored);
  expect(read.ok && read.value).toMatchObject({ udl: next, edition: 1 });
  expect(documentDigest(stored)).toBe(before);
  expect(serializeUdl(stored)).toBe(`${writeJson(stored)}\n`);
});

// Mutation: fall back to the current schema for a format with no reader.
test("a format with no reader refuses", () => {
  const read = validateUdl({ ...reviewDocument(), udl: 0 });
  expect(read).toMatchObject({
    ok: false,
    issues: [{ code: "udl_format_unknown", path: "$.udl" }],
  });
  expect(() => documentDigest({ ...reviewDocument(), udl: 0 })).toThrow();
});

// Mutation: admit every readable format as a new Build.
test("a new Build admits only the current format, and a stored one reads format 1", () => {
  const format1 = { ...reviewDocument(), udl: 1 };
  expect(validateNewBuildUdl(format1)).toMatchObject({
    ok: false,
    issues: [
      {
        code: "udl_format_not_current",
        path: "$.udl",
        message: `a new Build is UDL format ${UDL_FORMAT_VERSION}; this document is format 1`,
      },
    ],
  });
  expect(validateUdl(format1).ok).toBe(true);
  expect(validateNewBuildUdl(reviewDocument()).ok).toBe(true);
});
