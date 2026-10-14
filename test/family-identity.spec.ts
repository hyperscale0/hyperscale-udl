import { expect, test } from "bun:test";
import {
  sameFamily,
  udlDocumentSchema,
  validateUdl,
  type UdlDocument,
} from "../src/index.js";

const installments = "a".repeat(64);
const limits = "b".repeat(64);

function baseDocument(): UdlDocument {
  return udlDocumentSchema.parse({
    udl: 2,
    version: 1,
    product: "family_test",
    title: "Family Identity Test",
    currency: "SAR",
    parties: {
      agency: { kind: "business", role: "agency" },
    },
    objects: [],
    instruments: [
      {
        id: "plan",
        title: "Plan",
        summary: "Financing plan",
        family: {
          module: "financing",
          exportPath: "installments",
          digest: installments,
        },
        fields: [
          {
            name: "limitRef",
            type: "ref",
            targetKind: "instrument",
            target: "limit",
            targetFamily: {
              module: "financing",
              exportPath: "limits",
              digest: limits,
            },
          },
          {
            name: "owner",
            type: "text",
          },
        ],
        calculate: [],
        lifecycle: { states: ["active"], initial: "active", transitions: {} },
        actionOrder: ["create"],
        actions: {
          create: {
            summary: "Create",
            event: "plan.created",
            actor: "caller",
            input: [],
            moves: [],
            requires: [
              {
                kind: "aggregate",
                selection: {
                  family: {
                    module: "financing",
                    exportPath: "limits",
                    digest: limits,
                  },
                  instrument: "limit",
                  reference: "owner",
                  anchor: "self.owner",
                  states: ["active"],
                  limit: 10,
                },
                measure: "count",
                operator: ">=",
                value: { literal: 0 },
              },
            ],
          },
        },
      },
      {
        id: "limit",
        title: "Limit",
        summary: "Financing limit",
        family: {
          module: "financing",
          exportPath: "limits",
          digest: limits,
        },
        fields: [
          {
            name: "owner",
            type: "text",
          },
        ],
        calculate: [],
        lifecycle: { states: ["active"], initial: "active", transitions: {} },
        actionOrder: ["create"],
        actions: {
          create: {
            summary: "Create",
            event: "limit.created",
            actor: "caller",
            input: [],
            moves: [],
            requires: [],
          },
        },
      },
    ],
  });
}

test("Valid document with family identity passes validation", () => {
  const doc = baseDocument();
  const result = validateUdl(doc);
  expect(result.ok).toBe(true);
});

// Mutation: let a format 2 document keep a format 1 revision family.
test("A format 2 family names a digest, a format 1 family a revision", () => {
  const revised = baseDocument() as Record<string, any>;
  revised.instruments[1].family = {
    module: "financing",
    exportPath: "limits",
    revision: 1,
  };
  expect(validateUdl(revised).ok).toBe(false);
  for (const digest of ["", "A".repeat(64), "a".repeat(63)]) {
    const raw = baseDocument();
    (raw.instruments[0]!.family as Record<string, unknown>).digest = digest;
    expect(validateUdl(raw).ok).toBe(false);
  }
  const format1 = JSON.parse(
    JSON.stringify(baseDocument()).replaceAll(
      /"digest":"[a-f0-9]{64}"/g,
      '"revision":1',
    ),
  );
  expect(validateUdl({ ...format1, udl: 1 }).ok).toBe(true);
  expect(validateUdl(format1).ok).toBe(false);
});

// Mutation: compare digests across formats, or ignore them within format 2.
test("Families compare digests only when both sides are format 2", () => {
  const named = { module: "financing", exportPath: "limits" };
  expect(
    sameFamily({ ...named, digest: limits }, { ...named, digest: limits }),
  ).toBe(true);
  expect(
    sameFamily(
      { ...named, digest: limits },
      { ...named, digest: installments },
    ),
  ).toBe(false);
  expect(
    sameFamily({ ...named, revision: 1 }, { ...named, digest: installments }),
  ).toBe(true);
  expect(
    sameFamily(
      { ...named, revision: 1 },
      { module: "financing", exportPath: "installments", digest: limits },
    ),
  ).toBe(false);
});

test("Mismatched targetFamily refuses at validation", () => {
  const doc = baseDocument();
  doc.instruments[0]!.fields[0] = {
    name: "limitRef",
    type: "ref",
    targetKind: "instrument",
    target: "limit",
    targetFamily: {
      module: "financing",
      exportPath: "limits",
      digest: installments,
    },
  };
  const result = validateUdl(doc);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues.some((i) => i.code === "UDL5001")).toBe(true);
  }
});

test("Mismatched selection.family refuses at validation", () => {
  const doc = baseDocument();
  const req = doc.instruments[0]!.actions.create!.requires[0]!;
  if (req.kind === "aggregate") {
    req.selection.family = {
      module: "financing",
      exportPath: "limits",
      digest: installments,
    };
  }
  const result = validateUdl(doc);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues.some((i) => i.code === "UDL5001")).toBe(true);
  }
});
