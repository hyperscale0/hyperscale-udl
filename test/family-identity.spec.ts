import { expect, test } from "bun:test";
import {
  udlDocumentSchema,
  validateUdl,
  type UdlDocument,
} from "../src/index.js";

function baseDocument(): UdlDocument {
  return udlDocumentSchema.parse({
    udl: 4,
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
          revision: 1,
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
              revision: 1,
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
                    revision: 1,
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
          revision: 1,
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

test("A revision that is zero, negative, fractional or unsafe refuses at validation", () => {
  const invalidRevisions = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 10];
  for (const revision of invalidRevisions) {
    const raw = baseDocument();
    (raw.instruments[0]!.family as Record<string, unknown>).revision = revision;
    const result = validateUdl(raw);
    expect(result.ok).toBe(false);
  }
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
      revision: 2,
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
      revision: 99,
    };
  }
  const result = validateUdl(doc);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues.some((i) => i.code === "UDL5001")).toBe(true);
  }
});
