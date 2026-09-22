import { expect, test } from "bun:test";
import {
  documentSemanticsSchema,
  projectDocumentSemantics,
  sameObjectField,
  udlDocumentSchema,
  type UdlDocument,
} from "../src/index.js";
import { reviewDocument } from "./review-fixture.js";

function agreement(): UdlDocument {
  const document = reviewDocument();
  document.parties = { shop: { kind: "business" } };
  document.objects = [
    {
      id: "parcel",
      title: "Parcel",
      authoredFields: [],
      fields: [],
      columns: [],
      attachments: [
        {
          name: "payment",
          title: "Customer payment",
          instrument: "record",
          parties: { payer: { role: "owner" }, payee: { party: "shop" } },
        },
      ],
    },
  ];
  const instrument = document.instruments[0]!;
  instrument.subject = "parcel";
  instrument.fields = [
    { name: "amount", type: "money", value: "100" },
    { name: "cash", type: "account", owner: "self", book: "cash" },
    { name: "claim", type: "account", owner: "self", book: "claim" },
    { name: "receipt", type: "text", optional: true },
    { name: "cutoff", type: "date" },
  ];
  instrument.lifecycle = {
    states: ["a", "b", "c", "d"],
    initial: "a",
    labels: { b: "Money received" },
    transitions: {
      receive: { from: ["a"], to: "b" },
      finish: { from: ["b"], to: "c" },
      back: { from: ["b"], to: "d" },
    },
  };
  const base = {
    summary: "Action",
    event: "record.changed",
    actor: { party: "owner" },
    input: [],
    requires: [],
    moves: [],
  } as const;
  // Fresh mutable arrays keep this a UDL input, not a frozen test model.
  instrument.actions = {
    create: { ...base, input: [], requires: [], moves: [] },
    receive: {
      ...base,
      input: [],
      requires: [],
      publicAction: "receiveCash",
      moves: [
        {
          key: "in",
          operation: "internal_transfer.create",
          amount: { field: "self.amount" },
          from: "party.owner",
          to: "self.cash",
        },
      ],
    },
    finish: {
      ...base,
      input: [],
      requires: [],
      publicAction: "finish",
      title: "Pay the business",
      deadline: { at: "self.cutoff" },
      moves: [
        {
          key: "out",
          operation: "internal_transfer.create",
          amount: { field: "self.amount" },
          from: "self.cash",
          to: "party.shop",
        },
      ],
    },
    back: {
      ...base,
      input: [],
      requires: [],
      publicAction: "back",
      due: { at: "self.cutoff" },
      moves: [
        {
          key: "back",
          operation: "internal_transfer.create",
          amount: { field: "self.amount" },
          from: "self.cash",
          to: "party.owner",
        },
      ],
    },
  };
  instrument.actionOrder = ["create", "receive", "finish", "back"];
  return udlDocumentSchema.parse(document);
}

// Mutation: substitute the acting party for the recipient, or treat claim books as held cash.
test("money effects retain different callers, recipients, books and cash ownership", () => {
  const document = agreement();
  const semantics = projectDocumentSemantics(document);
  const instrument = semantics.instruments[0]!;
  expect(
    instrument.actions.find((action) => action.name === "finish"),
  ).toMatchObject({
    roles: [{ kind: "role", role: "owner" }],
    from: ["b"],
    to: "c",
    deadline: { at: "self.cutoff" },
    moneyEffects: [
      {
        from: [
          { owner: { kind: "instrument", instrument: "record" }, book: "cash" },
        ],
        to: [{ owner: { kind: "party", party: "shop" } }],
        disposition: "paid",
      },
    ],
  });
  expect(instrument.lifecycle.cancellationActions).toEqual(["back"]);
  expect(instrument.structures).toContain("held_funds");
  const changed = structuredClone(document);
  const cash = changed.instruments[0]!.fields.find(
    (field) => field.name === "cash",
  )!;
  if (cash.type === "account") cash.book = "claim";
  const claims = projectDocumentSemantics(changed).instruments[0]!;
  expect(claims.structures).not.toContain("held_funds");
  expect(
    claims.actions.find((action) => action.name === "receive")!.moneyEffects[0]!
      .disposition,
  ).toBe("claim");
});

// Mutation: associate post/void by action names instead of captured transfer identity.
test("a reservation section requires post and void of the same captured identity", () => {
  const document = agreement();
  const instrument = document.instruments[0]!;
  instrument.actions.receive!.moves = [
    {
      key: "r",
      operation: "internal_transfer.reserve",
      capture: "receipt",
      amount: { field: "self.amount" },
      from: "party.owner",
      to: "party.shop",
    },
  ];
  instrument.actions.finish!.moves = [
    { key: "p", operation: "internal_transfer.post", transfer: "self.receipt" },
  ];
  instrument.actions.back!.moves = [
    { key: "v", operation: "internal_transfer.void", transfer: "self.receipt" },
  ];
  const projected = projectDocumentSemantics(document).instruments[0]!;
  expect(projected.structures).toContain("reserved_payment");
  expect(
    projected.actions.find((action) => action.name === "finish")!
      .moneyEffects[0],
  ).toMatchObject({
    amount: { field: "self.amount" },
    from: [{ owner: { kind: "role", role: "owner" } }],
    to: [{ owner: { kind: "party", party: "shop" } }],
    reservations: [{ instrument: "record", action: "receive", key: "r" }],
    disposition: "paid",
  });
  instrument.actions.back!.moves = [
    {
      key: "v",
      operation: "internal_transfer.void",
      transfer: "self.otherReceipt",
    },
  ];
  const unmatched = projectDocumentSemantics(document).instruments[0]!;
  expect(unmatched.structures).not.toContain("reserved_payment");
  expect(
    unmatched.actions.find((action) => action.name === "back")!.moneyEffects[0]!
      .disposition,
  ).toBe("unresolved");
});

// Mutation: let labels participate in executable field equality or ignore explicit display text.
test("presentation overrides defaults without changing section selection or field compatibility", () => {
  const document = agreement();
  const before = projectDocumentSemantics(document);
  const instrument = document.instruments[0]!;
  instrument.fields[0]!.label = "Agreed price";
  const after = documentSemanticsSchema.parse(
    projectDocumentSemantics(document),
  );
  expect(after.instruments[0]!.structures).toEqual(
    before.instruments[0]!.structures,
  );
  expect(after.instruments[0]!.fields[0]!.label).toBe("Agreed price");
  expect(after.instruments[0]!.actions.map((action) => action.title)).toEqual([
    "Create",
    "Receive Cash",
    "Pay the business",
    "Back",
  ]);
  expect(after.instruments[0]!.lifecycle.states).toEqual([
    { name: "a", label: "A", terminal: false },
    { name: "b", label: "Money received", terminal: false },
    { name: "c", label: "C", terminal: true },
    { name: "d", label: "D", terminal: true },
  ]);
  expect(after.objects[0]!.attachments[0]!.title).toBe("Customer payment");
  expect(
    sameObjectField(
      { name: "price", type: "money", label: "Price" },
      { name: "total", type: "money", label: "Total" },
    ),
  ).toBe(true);
});

// Mutation: invent a due schedule from a money field and a generic reference, or drop reference bounds.
test("reference cardinality alone cannot imply a payment calendar", () => {
  const document = agreement();
  const instrument = document.instruments[0]!;
  instrument.fields.push(
    {
      name: "previous",
      type: "ref",
      targetKind: "instrument",
      target: "record",
      optional: true,
    },
    {
      name: "related",
      type: "list",
      item: "ref",
      targetKind: "instrument",
      target: "record",
      maxItems: 4,
    },
  );
  const projected = projectDocumentSemantics(document).instruments[0]!;
  expect(projected.relationships).toMatchObject([
    { name: "previous", kind: "reference", cardinality: { min: 0, max: 1 } },
    { name: "related", kind: "reference", cardinality: { min: 0, max: 4 } },
  ]);
  expect(projected.structures).not.toContain("payment_calendar");
});
