import { expect, test } from "bun:test";
import {
  udlDocumentSchema,
  validateUdl,
  type UdlDocument,
} from "../src/index.js";

function hold(): UdlDocument {
  return udlDocumentSchema.parse({
    udl: 4,
    version: 1,
    product: "shop",
    title: "Shop",
    currency: "SAR",
    parties: { buyer: { kind: "person" }, seller: { kind: "business" } },
    objects: [],
    instruments: [
      {
        id: "hold",
        title: "Hold",
        summary: "One funded account",
        calculate: [],
        fields: [
          { name: "amount", type: "money", value: "100" },
          { name: "held", type: "account", owner: "self" },
        ],
        lifecycle: {
          states: ["held", "paid"],
          initial: "held",
          transitions: { release: { from: ["held"], to: "paid" } },
        },
        actions: {
          create: {
            summary: "Fund",
            event: "hold.created",
            actor: "caller",
            input: [],
            requires: [],
            moves: [
              {
                key: "fund",
                operation: "internal_transfer.create",
                amount: { field: "self.amount" },
                from: "party.buyer",
                to: "self.held",
              },
            ],
          },
          release: {
            summary: "Release",
            event: "hold.released",
            actor: "caller",
            input: [],
            requires: [],
            moves: [
              {
                key: "release",
                operation: "internal_transfer.create",
                amount: { field: "self.amount" },
                from: "self.held",
                to: "party.seller",
              },
            ],
          },
        },
        actionOrder: ["create", "release"],
      },
    ],
  });
}

const mutations: Array<[string, (document: UdlDocument) => void]> = [
  [
    "cash cannot cross into claims",
    (d) => {
      const f = d.instruments[0]!.fields[1]!;
      if (f.type === "account") f.book = "claim";
    },
  ],
  [
    "terminal accounts must be empty",
    (d) => {
      d.instruments[0]!.actions.release!.moves = [];
    },
  ],
  [
    "create cannot override a fixed amount",
    (d) => {
      d.instruments[0]!.actions.create!.input = [
        { name: "amount", type: "money" },
      ];
    },
  ],
  [
    "account aliases cannot transfer to themselves",
    (d) => {
      const i = d.instruments[0]!;
      i.fields.push({
        name: "payer",
        type: "account",
        owner: "buyer",
        book: "cash",
      });
      i.actions.create!.moves.push({
        key: "alias",
        operation: "internal_transfer.create",
        amount: { literal: "1" },
        from: "self.payer",
        to: "party.buyer",
      });
    },
  ],
];
for (const [rule, mutate] of mutations)
  test(rule, () => {
    const original = hold();
    const changed = structuredClone(original);
    mutate(changed);
    expect([validateUdl(original).ok, validateUdl(changed).ok]).toEqual([
      true,
      false,
    ]);
  });

test("Earlier UDL formats have no migration reader", () => {
  expect(udlDocumentSchema.safeParse({ ...hold(), udl: 3 }).success).toBe(
    false,
  );
});

test("captured statuses include voided and reject misspellings", () => {
  const status = (literal: string) => {
    const document = hold();
    const instrument = document.instruments[0]!;
    instrument.fields.push({ name: "receipt", type: "text", optional: true });
    instrument.actions.create!.moves[0]!.capture = "receipt";
    instrument.actions.release!.requires.push({
      kind: "compare",
      left: { field: "self.receipt.status" },
      operator: "==",
      right: { literal },
    });
    return validateUdl(document).ok;
  };
  expect([status("posted"), status("voided"), status("void")]).toEqual([
    true,
    true,
    false,
  ]);
});

test("dated child positions start at one", () => {
  const document = hold();
  const instrument = document.instruments[0]!;
  instrument.fields.push(
    { name: "dates", type: "list", item: "date", maxItems: 3 },
    { name: "dueAt", type: "date" },
  );
  instrument.calculate.push({
    target: "dueAt",
    op: "at",
    list: "self.dates",
    position: { literal: 1 },
  });
  const original = validateUdl(document).ok;
  instrument.calculate[0] = {
    target: "dueAt",
    op: "at",
    list: "self.dates",
    position: { literal: 0 },
  };
  expect([original, validateUdl(document).ok]).toEqual([true, false]);
});

test("union reference paths require a compatible field on every target", () => {
  const record = (id: string) => ({
    id,
    title: id,
    summary: id,
    calculate: [],
    fields: [{ name: "amount", type: "money" }],
    lifecycle: { states: ["open"], initial: "open", transitions: {} },
    actions: {
      create: {
        summary: "Create",
        event: `${id}.created`,
        actor: "caller",
        input: [],
        requires: [],
        moves: [],
      },
    },
    actionOrder: ["create"],
  });
  const document = udlDocumentSchema.parse({
    udl: 4,
    version: 1,
    product: "union",
    title: "Union",
    currency: "SAR",
    parties: {},
    objects: [],
    instruments: [
      record("first"),
      record("second"),
      {
        ...record("policy"),
        fields: [
          {
            name: "subjectRef",
            type: "ref",
            targetKind: "instrument",
            target: ["first", "second"],
          },
        ],
        actions: {
          create: {
            summary: "Create",
            event: "policy.created",
            actor: "caller",
            input: [],
            moves: [],
            requires: [
              {
                kind: "compare",
                left: { field: "self.subjectRef.amount" },
                operator: ">",
                right: { literal: "0" },
              },
            ],
          },
        },
      },
    ],
  });
  const valid = validateUdl(document).ok;
  document.instruments[1]!.fields[0] = { name: "amount", type: "text" };
  expect([valid, validateUdl(document).ok]).toEqual([true, false]);
});

test("invocation bounds count one alternative for a union reference", () => {
  const record = (id: string) => ({
    id,
    title: id,
    summary: id,
    fields: [{ name: "group", type: "text" }],
    calculate: [],
    lifecycle: {
      states: ["open", "closed"],
      initial: "open",
      transitions: { run: { from: ["open"], to: "closed" } },
    },
    actions: {
      create: {
        summary: "Create",
        event: `${id}.created`,
        actor: "caller",
        input: [],
        requires: [],
        moves: [],
      },
      run: {
        summary: "Run",
        event: `${id}.ran`,
        actor: "caller",
        input: [],
        requires: [],
        moves: [],
      },
    },
    actionOrder: ["create", "run"],
  });
  const select = (instrument: string, limit: number) => ({
    selection: {
      instrument,
      reference: "group",
      anchor: "self.group",
      states: ["open"],
      limit,
    },
    action: "run",
    input: {},
  });
  const leaf = record("leaf"),
    middle = record("middle"),
    first = record("first"),
    second = record("second"),
    root = record("root");
  const document = udlDocumentSchema.parse({
    udl: 4,
    version: 1,
    product: "bounds",
    title: "Bounds",
    currency: "SAR",
    parties: {},
    objects: [],
    instruments: [
      leaf,
      {
        ...middle,
        actions: {
          ...middle.actions,
          run: { ...middle.actions.run, invoke: [select("leaf", 250)] },
        },
      },
      ...[first, second].map((item) => ({
        ...item,
        actions: {
          ...item.actions,
          run: { ...item.actions.run, invoke: [select("middle", 10)] },
        },
      })),
      {
        ...root,
        fields: [
          {
            name: "subjectRef",
            type: "ref",
            targetKind: "instrument",
            target: ["first", "second"],
          },
        ],
        actions: {
          ...root.actions,
          run: {
            ...root.actions.run,
            invoke: [
              { reference: "self.subjectRef", action: "run", input: {} },
            ],
          },
        },
      },
    ],
  });
  const valid = validateUdl(document).ok;
  const call = document.instruments[2]!.actions.run!.invoke![0]!;
  if ("selection" in call) call.selection.limit = 20;
  expect([valid, validateUdl(document).ok]).toEqual([true, false]);
});
