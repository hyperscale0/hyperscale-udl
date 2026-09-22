import { expect, test } from "bun:test";
import { udlDocumentSchema, validateUdl } from "../src/index.js";

function document() {
  return udlDocumentSchema.parse({
    udl: 4,
    version: 1,
    product: "insurance",
    title: "Insurance",
    currency: "SAR",
    objects: [],
    parties: { tenant: { kind: "business" } },
    instruments: [
      {
        id: "cover",
        title: "Cover",
        summary: "Cover",
        calculate: [],
        fields: [
          {
            name: "premium",
            type: "account",
            owner: { adapter: "insurer" },
            key: "premium",
          },
          {
            name: "claims",
            type: "account",
            owner: { adapter: "insurer" },
            key: "claims",
          },
        ],
        lifecycle: { states: ["open"], initial: "open", transitions: {} },
        actions: {
          create: {
            summary: "Create",
            event: "cover.created",
            actor: "caller",
            input: [],
            requires: [],
            subject: {
              requirements: [],
              adapters: [{ binding: "insurer", snapshot: null }],
            },
            moves: [
              {
                key: "fund",
                operation: "internal_transfer.create",
                from: "self.premium",
                to: "self.claims",
                amount: { literal: "100" },
              },
            ],
          },
        },
        actionOrder: ["create"],
      },
    ],
  });
}

// Mutation: omit the adapter declaration check in checkFields.
test("adapter account owners need a declared binding, never a party", () => {
  const doc = document();
  expect(validateUdl(doc).ok).toBe(true);
  doc.instruments[0]!.actions.create!.subject!.adapters = [];
  const invalid = validateUdl(doc);
  expect(invalid.ok).toBe(false);
  if (!invalid.ok)
    expect(invalid.issues.map((issue) => issue.code)).toContain(
      "subject_adapter_unbound",
    );
});

// Mutation: compare account owner objects by reference instead of value.
test("two adapter fields cannot transfer between the same binding, book and key", () => {
  const doc = document();
  const field = doc.instruments[0]!.fields[1]!;
  if (field.type !== "account") throw new Error("account required");
  field.key = "premium";
  const invalid = validateUdl(doc);
  expect(invalid.ok).toBe(false);
  if (!invalid.ok)
    expect(invalid.issues.map((issue) => issue.code)).toContain("UDL4001");
});
