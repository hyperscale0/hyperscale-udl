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
              approval: { party: "underwriter" },
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

test("Approval bindings require staff with a role", () => {
  for (const party of [
    "underwriter",
    "agency",
    "actor",
    "person",
    "roleless",
  ]) {
    for (const issuance of [false, true]) {
      const document = programme();
      document.parties.person = { kind: "person" };
      document.parties.roleless = { kind: "staff" };
      const action = document.instruments[0]!.actions.create!;
      if (issuance) {
        action.input.push({ name: "expires", type: "date" });
        action.approval = {
          protectedRequest: "self",
          target: "self",
          action: "create",
          party,
          expires: "input.expires",
          input: { expires: { field: "input.expires" } },
          decision: "approved",
        };
      } else
        action.requires.push({
          kind: "approval",
          protectedRequest: "self",
          target: "self",
          party,
          decision: "approved",
        });
      if (party === "underwriter") expect(validateUdl(document).ok).toBe(true);
      else expect(codes(document)).toContain("party_kind_mismatch");
    }
  }
});

test("Separation changes canonical bytes", () => {
  const document = programme();
  const requirement = {
    kind: "approval" as const,
    protectedRequest: "self",
    target: "self",
    party: "underwriter",
    decision: "approved" as const,
  };
  document.instruments[0]!.actions.create!.requires.push(requirement);
  const before = serializeUdl(document);
  Object.assign(requirement, { differentFromInitiator: true });
  expect(serializeUdl(document)).not.toBe(before);
  expect(
    JSON.parse(serializeUdl(document)).instruments[0].actions.create.requires[0]
      .differentFromInitiator,
  ).toBe(true);
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
  expect(codes(document)).toContain("subject_field_unknown");
});

test("Protected requests canonicalize to instrument references", () => {
  for (const issuance of [false, true]) {
    const document = programme();
    const instrument = document.instruments[0]!;
    instrument.fields.push(
      {
        name: "request",
        type: "ref",
        targetKind: "instrument",
        target: "sale",
      },
      { name: "text", type: "text" },
      { name: "expires", type: "date" },
    );
    const clause = issuance
      ? {
          target: "self",
          party: "underwriter",
          action: "create",
          expires: "self.expires",
          input: {},
          decision: "approved",
        }
      : {
          kind: "approval",
          target: "self",
          party: "underwriter",
          decision: "approved",
        };
    const action = instrument.actions.create!;
    Object.assign(
      action,
      issuance ? { approval: clause } : { requires: [clause] },
    );
    const canonical = () => {
      const action = JSON.parse(serializeUdl(document)).instruments[0].actions
        .create;
      return issuance ? action.approval : action.requires[0];
    };
    expect(canonical().protectedRequest).toBe("self");
    Object.assign(clause, { protectedRequest: "self.request" });
    expect(canonical().protectedRequest).toBe("self.request");
    for (const path of ["self.text", "self.subject", "self.missing"]) {
      Object.assign(clause, { protectedRequest: path });
      expect(codes(document)).toContain("UDL5001");
      expect(() => serializeUdl(document)).toThrow();
    }
  }
});
