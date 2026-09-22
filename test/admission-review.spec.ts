import { expect, test } from "bun:test";
import { validateUdl } from "../src/index.js";
import { reviewDocument } from "./review-fixture.js";

// Mutation: restore BigInt(denominator.literal.toString()) without a type guard.
test("invalid ratio literals produce diagnostics without throwing", () => {
  for (const literal of ["invalid", true, "0", -1]) {
    const document = reviewDocument();
    const instrument = document.instruments[0]!;
    instrument.fields = [{ name: "share", type: "money" }];
    instrument.calculate = [
      {
        target: "share",
        op: "ratio",
        amount: { literal: "10" },
        numerator: { literal: 1 },
        denominator: { literal },
        rounding: "floor",
      },
    ];
    expect(validateUdl(document).ok).toBe(false);
  }
});

// Mutation: restore truthy record lookup in checkArguments or invocation admission.
test("an inherited action cannot satisfy an invocation", () => {
  const document = reviewDocument();
  const instrument = document.instruments[0]!;
  instrument.fields = [
    { name: "other", type: "ref", targetKind: "instrument", target: "record" },
  ];
  instrument.actions.create!.invoke = [
    { reference: "self.other", action: "constructor", input: {} },
  ];
  const result = validateUdl(document);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(
      result.issues.some(
        (issue) =>
          issue.message === "invocation target must name a declared action",
      ),
    ).toBe(true);
});

// Mutation: replace Object.hasOwn(values, required.name) with required.name in values.
test("inherited properties do not supply required child inputs", () => {
  const document = reviewDocument();
  const parent = document.instruments[0]!;
  const child = structuredClone(parent);
  child.id = "child";
  child.actions.create!.input = [{ name: "constructor", type: "text" }];
  parent.actions.create!.invoke = [
    { instrument: "child", action: "create", input: {} },
  ];
  document.instruments.push(child);
  const result = validateUdl(document);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(
      result.issues.some(
        (issue) => issue.message === "missing target input constructor",
      ),
    ).toBe(true);
});

// Mutation: restore inherited party lookup in hasParty.
test("an inherited party cannot authorize an action", () => {
  const document = reviewDocument();
  document.instruments[0]!.actions.create!.actor = { party: "constructor" };
  expect(validateUdl(document).ok).toBe(false);
  Object.assign(document.parties, { constructor: { kind: "staff" } });
  expect(validateUdl(document).ok).toBe(true);
});

// Mutation: restore inherited lookup in actionOrder membership.
test("action order cannot replace a declared action with an inherited name", () => {
  const document = reviewDocument();
  document.instruments[0]!.actionOrder = ["constructor"];
  expect(validateUdl(document).ok).toBe(false);
});

// Mutation: omit the public subject attachment check.
test("public subject actions need a target for discovery", () => {
  const document = reviewDocument();
  document.objects = [
    {
      id: "item",
      title: "Item",
      fields: [],
      authoredFields: [],
      columns: [],
      attachments: [],
    },
  ];
  const instrument = document.instruments[0]!;
  instrument.subject = "item";
  instrument.actions.create!.publicAction = "open";
  expect(validateUdl(document).ok).toBe(false);
  document.objects[0]!.attachments = [
    { name: "record", instrument: "record", parties: {} },
  ];
  expect(validateUdl(document).ok).toBe(true);
});

// Mutation: omit the instrument targetKind check for state requirements.
test("object references cannot carry lifecycle state gates", () => {
  const document = reviewDocument();
  document.objects = [
    {
      id: "item",
      title: "Item",
      fields: [],
      authoredFields: [],
      columns: [],
      attachments: [],
    },
  ];
  const instrument = document.instruments[0]!;
  instrument.fields = [
    { name: "item", type: "ref", targetKind: "object", target: "item" },
  ];
  instrument.actions.create!.requires = [
    { kind: "state", reference: "self.item", states: ["open"] },
  ];
  expect(validateUdl(document).ok).toBe(false);
});

// Mutation: omit the condition instrument/action lookup.
test("subject conditions cannot refer to undeclared actions", () => {
  const document = reviewDocument();
  document.instruments[0]!.actions.create!.subject = {
    adapters: [],
    requirements: [
      {
        field: { name: "code", type: "text" },
        when: [
          [
            {
              instrument: "missing",
              action: "create",
              guard: {
                kind: "compare",
                left: { literal: 1 },
                operator: "==",
                right: { literal: 1 },
              },
            },
          ],
        ],
      },
    ],
  };
  expect(validateUdl(document).ok).toBe(false);
});

// Mutation: check only renamed objectField names for duplicates.
test("subject source names remain unique after renaming", () => {
  const document = reviewDocument();
  document.instruments[0]!.actions.create!.subject = {
    adapters: [],
    requirements: [
      { field: { name: "code", type: "text" }, objectField: "first" },
      { field: { name: "code", type: "text" }, objectField: "second" },
    ],
  };
  const result = validateUdl(document);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.issues.some((issue) => issue.code === "UDL2001")).toBe(true);
});
