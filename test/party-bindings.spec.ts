import { expect, test } from "bun:test";
import {
  udlDocumentSchema,
  validateUdl,
  serializeUdl,
  projectObjectDiscovery,
  objectActionState,
  validateObjectActionSubject,
} from "../src/index.js";

function programme() {
  return udlDocumentSchema.parse({
    udl: 4,
    version: 1,
    product: "shop",
    title: "Shop",
    currency: "SAR",
    parties: {
      agency: { kind: "business" },
      underwriter: { kind: "staff", role: "underwrite" },
    },
    objects: [
      {
        id: "car",
        title: "Car",
        authoredFields: [],
        columns: [],
        fields: [{ name: "price", type: "money" }],
        attachments: [
          {
            name: "sale",
            instrument: "sale",
            parties: {
              payer: { role: "actor" },
              payee: { party: "agency" },
            },
          },
        ],
      },
    ],
    instruments: [
      {
        id: "sale",
        title: "Sale",
        summary: "Sale",
        subject: "car",
        fields: [],
        calculate: [],
        lifecycle: { states: ["open"], initial: "open", transitions: {} },
        actionOrder: ["create"],
        actions: {
          create: {
            summary: "Sell",
            event: "sale.created",
            actor: { party: "underwriter" },
            publicAction: "sell",
            input: [],
            moves: [],
            requires: [],
            subject: {
              requirements: [{ field: { name: "price", type: "money" } }],
              adapters: [],
            },
          },
        },
      },
    ],
  });
}
function codes(document: unknown) {
  const result = validateUdl(document);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

test("Attachment bindings have exactly one source", () => {
  const document = programme();
  expect(
    JSON.parse(serializeUdl(document)).objects[0].attachments[0].parties,
  ).toEqual(document.objects[0]!.attachments[0]!.parties);
  for (const binding of [
    "actor",
    {},
    { role: "actor", party: "agency" },
    { role: "actor", extra: true },
  ]) {
    const changed = structuredClone(document);
    Object.assign(changed.objects[0]!.attachments[0]!.parties, {
      payer: binding,
    });
    expect(codes(changed)).toContain("UDL1003");
    expect(() => serializeUdl(changed)).toThrow();
  }
});

test("Reserved party names cannot enter canonical UDL", () => {
  for (const name of ["owner", "actor", "operator"]) {
    const document = programme();
    document.parties[name] = { kind: "business" };
    expect(codes(document)).toContain("party_name_reserved");
    expect(() => serializeUdl(document)).toThrow();
  }
});

test("Attachment declarations must exist", () => {
  const document = programme();
  document.objects[0]!.attachments[0]!.parties.payee = { party: "missing" };
  expect(codes(document)).toContain("subject_party_unbound");
  expect(() => serializeUdl(document)).toThrow();
});

test("Staff and declared persons cannot fund attached money actions", () => {
  for (const kind of ["business", "staff", "person"] as const) {
    for (const account of [false, true]) {
      const document = programme();
      document.parties.agency = { kind };
      const instrument = document.instruments[0]!;
      if (account)
        instrument.fields.push({
          name: "payer",
          type: "account",
          owner: "agency",
          book: "cash",
        });
      else
        instrument.actions.create!.moves.push({
          key: "pay",
          operation: "internal_transfer.create",
          from: "party.agency",
          to: "party.actor",
          amount: { literal: "1" },
        });
      expect(codes(document).includes("party_kind_mismatch")).toBe(
        kind !== "business",
      );
      if (kind !== "business") expect(() => serializeUdl(document)).toThrow();
    }
  }
});

test("Action state preserves its schema and action identity", () => {
  const action = projectObjectDiscovery(programme(), {
    productBuildId: "build",
    digest: "digest",
  }).kinds[0]!.actions[0]!;
  const state = objectActionState(action, { price: "12" });
  expect(state).toEqual({ ...action, requiredNow: [] });
});

test("Submitted subject fields are action-scoped and optional", () => {
  const action = projectObjectDiscovery(programme(), {
    productBuildId: "build",
    digest: "digest",
  }).kinds[0]!.actions[0]!;
  expect(action.fieldsSchema.additionalProperties).toBe(false);
  expect(action.fieldsSchema.required ?? []).toEqual([]);
  expect(Object.keys(action.fieldsSchema.properties!)).toEqual(["price"]);
  expect(validateObjectActionSubject(action, { price: "12" }, {})).toEqual([]);
  expect(
    validateObjectActionSubject(
      action,
      { price: "12" },
      { unrelated: "value" },
    )[0]?.code,
  ).toBe("subject_field_unknown");
});

test("Object field diagnostics distinguish missing fields from conflicting types", () => {
  for (const conflict of [false, true]) {
    const document = programme();
    document.objects[0]!.fields = conflict
      ? [{ name: "price", type: "text" }]
      : [];
    expect(codes(document)).toContain(
      conflict ? "subject_field_conflict" : "subject_field_unknown",
    );
  }
  const document = programme();
  document.objects[0]!.columns = ["missing"];
});
