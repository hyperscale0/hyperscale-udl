import { expect, test } from "bun:test";
import {
  canonicalDigest,
  serializeUdl,
  validateUdl,
  sameObjectField,
  objectActionState,
  type ObjectActionDiscovery,
} from "../src/index.js";
import { reviewDocument } from "./review-fixture.js";

// Mutation: traverse values with Object.entries rather than data descriptors.
test("admission refuses accessors without running them", () => {
  const document = reviewDocument();
  let reads = 0;
  Object.defineProperty(document, "title", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("getter ran");
    },
  });
  expect(validateUdl(document).ok).toBe(false);
  expect(reads).toBe(0);
});

// Mutation: remove the array shape and descriptor checks from bounded.
test("canonical admission refuses properties that JSON cannot retain", () => {
  const invalid = [
    new Array(2),
    Object.assign([1], { extra: "discarded" }),
    Object.defineProperty({}, "hidden", { value: 1 }),
    { [Symbol("hidden")]: 1 },
    JSON.parse('{"__proto__":{"meaning":"discarded"}}'),
  ];
  for (const input of invalid) {
    const document = reviewDocument();
    document.instruments[0]!.examples = [{ name: "Example", input }];
    expect(validateUdl(document).ok).toBe(false);
  }
});

// Mutation: count string code units only, without UTF-8 keys, in bounded.
test("decoded JSON budgets count UTF-8 keys and repeated aliases", () => {
  const document = reviewDocument();
  const shared = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [`${i}${"界".repeat(200)}`, 0]),
  );
  document.instruments[0]!.examples = [{ name: "Example", input: shared }];
  expect(validateUdl(document).ok).toBe(true);
  document.instruments[0]!.examples = [
    { name: "Example", input: [shared, shared] },
  ];
  expect(validateUdl(document).ok).toBe(false);
});

// Mutation: remove finite-structure admission before schema parsing.
test("cyclic and deeply nested examples refuse before recursive schema parsing", () => {
  const document = reviewDocument();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = { next: deep };
  for (const input of [cycle, deep]) {
    Object.assign(document.instruments[0]!, {
      examples: [{ name: "Example", input }],
    });
    expect(validateUdl(document).ok).toBe(false);
  }
});

// Mutation: remove recursive key sorting from writeJson, or sort array members.
test("canonical bytes ignore key insertion order and preserve array meaning", async () => {
  const first = reviewDocument();
  first.instruments[0]!.examples = [
    { name: "Example", input: { z: [1, 2], a: { z: 1, a: 2 } } },
  ];
  const second = reviewDocument();
  second.instruments[0]!.examples = [
    { name: "Example", input: { a: { a: 2, z: 1 }, z: [1, 2] } },
  ];
  expect(await canonicalDigest(first)).toBe(await canonicalDigest(second));
  expect(JSON.parse(serializeUdl(first))).toEqual(first);
  second.instruments[0]!.examples![0]!.input = { a: { a: 2, z: 1 }, z: [2, 1] };
  expect(await canonicalDigest(first)).not.toBe(await canonicalDigest(second));
});

// Mutation: replace writeJson with top-level-sorted JSON.stringify in sameObjectField.
test("field compatibility ignores nested family key insertion order", () => {
  const left = {
    name: "link",
    type: "ref" as const,
    targetKind: "instrument" as const,
    target: "record",
    targetFamily: { module: "records", exportPath: "entry", revision: 1 },
  };
  const right = {
    ...left,
    targetFamily: { revision: 1, exportPath: "entry", module: "records" },
  };
  expect(sameObjectField(left, right)).toBe(true);
  right.targetFamily.revision = 2;
  expect(sameObjectField(left, right)).toBe(false);
});

// Mutation: remove the own-property condition lookup in objectActionState.
test("an inherited condition name cannot crash action availability", () => {
  const action: ObjectActionDiscovery = {
    productBuildId: "build",
    digest: "digest",
    target: { kind: "attachment", attachment: "record" },
    name: "open",
    title: "Open",
    summary: "Open",
    instrument: "record",
    action: "create",
    requirements: [
      { name: "constructor", type: "text" },
      { name: "code", type: "text" },
    ],
    requirementConditions: {},
    inputSchema: {},
    fieldsSchema: {},
    availability: { status: "available" },
  };
  expect(objectActionState(action, {}).requiredNow).toEqual([
    "constructor",
    "code",
  ]);
});
