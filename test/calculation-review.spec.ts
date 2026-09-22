import { expect, test } from "bun:test";
import { validateUdl, type UdlValue } from "../src/index.js";
import { reviewDocument } from "./review-fixture.js";

// Mutation: omit selection anchor and where values from calculation dependencies.
test("selection anchors and filters participate in calculation cycles", () => {
  for (const filter of [false, true]) {
    const document = reviewDocument();
    const instrument = document.instruments[0]!;
    instrument.fields = [
      { name: "count", type: "integer" },
      { name: "group", type: "integer" },
    ];
    instrument.calculate = [
      {
        target: "count",
        op: "aggregate",
        measure: "count",
        selection: {
          instrument: "record",
          reference: "group",
          anchor: filter ? "self.group" : "self.count",
          states: ["open"],
          limit: 1,
          ...(filter
            ? { where: { group: { field: "self.count" } as UdlValue } }
            : {}),
        },
      },
    ];
    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(
        result.issues.some(
          (issue) => issue.message === "calculation cycle at count",
        ),
      ).toBe(true);
  }
});

// Mutation: omit reference target comparison for calculate.at.
test("list extraction preserves its reference namespace and target", () => {
  const document = reviewDocument();
  document.objects = [
    {
      id: "record",
      title: "Record",
      fields: [],
      authoredFields: [],
      columns: [],
      attachments: [],
    },
  ];
  const instrument = document.instruments[0]!;
  instrument.fields = [
    {
      name: "items",
      type: "list",
      item: "ref",
      targetKind: "object",
      target: "record",
      maxItems: 2,
    },
    { name: "chosen", type: "ref", targetKind: "instrument", target: "record" },
  ];
  instrument.calculate = [
    {
      target: "chosen",
      op: "at",
      list: "self.items",
      position: { literal: 1 },
    },
  ];
  expect(validateUdl(document).ok).toBe(false);
  instrument.fields[1] = {
    name: "chosen",
    type: "ref",
    targetKind: "object",
    target: "record",
  };
  expect(validateUdl(document).ok).toBe(true);
});

// Mutation: use type-only checkValue for assignments.
test("set literals obey field constraints", () => {
  const document = reviewDocument();
  const instrument = document.instruments[0]!;
  instrument.fields = [
    { name: "stage", type: "enum", values: ["open", "closed"] },
  ];
  instrument.actions.create!.set = { stage: { literal: "missing" } };
  expect(validateUdl(document).ok).toBe(false);
  instrument.actions.create!.set.stage = { literal: "closed" };
  expect(validateUdl(document).ok).toBe(true);
});

// Mutation: remove text constant validation against the field value schema.
test("text constants obey the declared pattern and length", () => {
  const document = reviewDocument();
  document.instruments[0]!.fields = [
    { name: "code", type: "text", pattern: "^[A-Z]{2}$", value: "abc" },
  ];
  expect(validateUdl(document).ok).toBe(false);
  document.instruments[0]!.fields = [
    { name: "code", type: "text", pattern: "^[A-Z]{2}$", value: "AB" },
  ];
  expect(validateUdl(document).ok).toBe(true);
});

// Mutation: remove date parsing in checkValue.
test("shift dates require an offset timestamp", () => {
  for (const [date, valid] of [
    ["2026-01-01T00:00:00Z", true],
    ["2026-01-01T00:00:00", false],
    ["yesterday", false],
  ] as const) {
    const document = reviewDocument();
    document.instruments[0]!.fields = [{ name: "due", type: "date" }];
    document.instruments[0]!.calculate = [
      {
        target: "due",
        op: "shift",
        date: { literal: date },
        milliseconds: { literal: 1 },
        direction: "after",
      },
    ];
    expect(validateUdl(document).ok).toBe(valid);
  }
});

// Mutations: restore duration checking for literals; omit the negative guard;
// remove the safe-integer check in checkValue; accept integer fields as durations.
test("shift milliseconds accept nonnegative integer literals or duration fields", () => {
  const cases: [UdlValue, boolean][] = [
    [{ literal: 0 }, true],
    [{ literal: 1 }, true],
    [{ literal: 86400000 }, true],
    [{ literal: -1 }, false],
    [{ literal: 0.5 }, false],
    [{ literal: Number.MAX_SAFE_INTEGER + 1 }, false],
    [{ literal: "1" }, false],
    [{ literal: true }, false],
    [{ field: "self.grace" }, true],
    [{ field: "self.count" }, false],
  ];
  for (const [milliseconds, valid] of cases) {
    const document = reviewDocument();
    document.instruments[0]!.fields = [
      { name: "due", type: "date" },
      { name: "grace", type: "duration", value: 1 },
      { name: "count", type: "integer", value: 1 },
    ];
    document.instruments[0]!.calculate = [
      {
        target: "due",
        op: "shift",
        date: { literal: "2026-01-01T00:00:00Z" },
        milliseconds,
        direction: "after",
      },
    ];
    expect(validateUdl(document).ok).toBe(valid);
  }
});

// Mutation: exclude self accounts from sameBoundAccount.
test("owned account aliases cannot hide an impossible round trip", () => {
  const document = reviewDocument();
  const instrument = document.instruments[0]!;
  instrument.fields = ["first", "second"].map((name) => ({
    name,
    type: "account",
    owner: "self",
    key: "shared",
    book: "cash",
  }));
  instrument.actions.create!.moves = [
    {
      key: "out",
      operation: "internal_transfer.create",
      from: "self.first",
      to: "self.second",
      amount: { literal: "1" },
    },
    {
      key: "back",
      operation: "internal_transfer.create",
      from: "self.second",
      to: "self.first",
      amount: { literal: "1" },
    },
  ];
  const result = validateUdl(document);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(
      result.issues.some(
        (issue) => issue.message === "a transfer needs distinct accounts",
      ),
    ).toBe(true);
});

// Mutation: compare adapter binding names instead of retained provider identities.
test("adapter aliases resolve to one provider account", () => {
  const document = reviewDocument();
  const instrument = document.instruments[0]!;
  instrument.fields = ["first", "second"].map((name) => ({
    name,
    type: "account",
    owner: { adapter: name },
    book: "cash",
  }));
  instrument.actions.create!.subject = {
    requirements: [],
    adapters: ["first", "second"].map((binding) => ({
      binding,
      snapshot: {
        provider: "provider",
        capability: "pay",
        operation: "pay",
        declarationDigest: "a".repeat(64),
        requirements: [],
      },
    })),
  };
  instrument.actions.create!.moves = [
    {
      key: "pay",
      operation: "internal_transfer.create",
      from: "self.first",
      to: "self.second",
      amount: { literal: "1" },
    },
  ];
  expect(validateUdl(document).ok).toBe(false);
});
