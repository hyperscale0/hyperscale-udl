import { describe, expect, test } from "bun:test";

import {
  deriveUdlActionEffects,
  movementClass,
  udlClauseVocabulary,
  udlEffectKinds,
  validateUdl,
  type UdlDocument,
} from "../src/index.js";

function documentWithEffects(): UdlDocument {
  return {
    instruments: [
      {
        actionOrder: ["create"],
        actions: {
          create: {
            decision: {
              capability: "identity_verification",
              deadlineMs: 15_000,
              onTimeout: "decline",
            },
            effects: {
              decides: [
                {
                  signature: "decides.identity_verification",
                  source: "decision",
                },
              ],
              notifies: [
                {
                  channel: "email",
                  role: "beneficiary",
                  signature: "notifies.email",
                  source: "effects.notifies[0]",
                },
                {
                  channel: "sms",
                  role: "beneficiary",
                  signature: "notifies.sms",
                  source: "effects.notifies[1]",
                },
              ],
            },
            moves: [],
            steps: [],
            summary: "Create the hold",
          },
        },
        fields: {},
        id: "effect_test",
        idPrefix: "eft",
        lifecycle: {
          initial: "held",
          states: ["held"],
          transitions: {},
        },
        required: [],
        summary: "Effect test",
        title: "Effect test",
      },
    ],
    product: "effect_test",
    subjects: [],
    title: "Effect test",
    udl: 1,
    version: 1,
  };
}

describe("UDL action effects", () => {
  test("classifies collection funding from its endpoint roles", () => {
    expect(
      movementClass({
        bind: {
          destinationAccountId: {
            from: "instance",
            path: "refs.escrowAccountId",
          },
          sourceAccountId: {
            from: "instance",
            path: "fields.buyerAccountId",
          },
        },
        operation: "internal_transfer.create",
      }),
    ).toBe("collection.pay_in");
    expect(
      movementClass({
        bind: {
          destinationAccountId: {
            from: "instance",
            path: "fields.sellerAccountId",
          },
          sourceAccountId: {
            from: "instance",
            path: "fields.buyerAccountId",
          },
        },
        operation: "internal_transfer.create",
      }),
    ).toBe("transfer.internal");
  });

  test("accepts the closed effect row and notification facts", () => {
    expect(validateUdl(documentWithEffects())).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  test("accepts an empty derived effect row when no clause emits effects", () => {
    const document = documentWithEffects();
    delete document.instruments[0]!.actions.create!.decision;
    document.instruments[0]!.actions.create!.effects = {};

    expect(validateUdl(document)).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  test.each([
    [
      "forged",
      (document: UdlDocument) => {
        document.instruments[0]!.actions.create!.effects!.decides![0]!.signature =
          "decides.forged";
      },
      "decides",
    ],
    [
      "missing",
      (document: UdlDocument) => {
        delete document.instruments[0]!.actions.create!.effects!.decides;
      },
      "decides",
    ],
    [
      "extra",
      (document: UdlDocument) => {
        document.instruments[0]!.actions.create!.effects!.decides!.push({
          signature: "decides.extra",
          source: "decision",
        });
      },
      "decides",
    ],
    [
      "reordered",
      (document: UdlDocument) => {
        document.instruments[0]!.actions.create!.effects!.notifies!.reverse();
      },
      "notifies",
    ],
  ])("rejects %s derived effects", (_case, mutate, kind) => {
    const document = documentWithEffects();
    mutate(document);

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a derived-effect failure");
    expect(result.issues).toContainEqual({
      category: "invalid_semantics",
      code: "UDL2005",
      fix: "Regenerate the action effects from its clauses.",
      message: `derived ${kind} effects do not match the action clauses`,
      path: `$.instruments[0].actions.create.effects.${kind}`,
    });
  });

  test("excludes derived effect rows from the authored node budget", () => {
    const document = documentWithEffects();
    document.instruments[0]!.actions.create!.effects!.decides = Array.from(
      { length: 10_001 },
      () => ({ signature: "", source: "" }),
    );

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a derived-effect failure");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ category: "invalid_shape", code: "UDL1003" }),
    );
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ category: "resource_limit" }),
    );
  });

  test("rejects unknown effect kinds and incomplete notifications", () => {
    const unknown = documentWithEffects() as unknown as {
      instruments: Array<{
        actions: Record<string, { effects: Record<string, unknown> }>;
      }>;
    };
    unknown.instruments[0]!.actions.create!.effects.writes = ["fields.amount"];
    const unknownResult = validateUdl(unknown);
    expect(unknownResult.ok).toBe(false);
    if (unknownResult.ok) throw new Error("expected an unknown effect failure");
    expect(unknownResult.issues).toContainEqual(
      expect.objectContaining({
        category: "invalid_shape",
        code: "UDL1003",
        path: "$.instruments[0].actions.create.effects",
      }),
    );

    const incomplete = documentWithEffects() as unknown as {
      instruments: Array<{
        actions: Record<
          string,
          { effects: { notifies: Array<Record<string, string>> } }
        >;
      }>;
    };
    incomplete.instruments[0]!.actions.create!.effects.notifies = [
      {
        role: "beneficiary",
        signature: "notifies.email",
        source: "effects.notifies[0]",
      },
    ];
    const incompleteResult = validateUdl(incomplete);
    expect(incompleteResult.ok).toBe(false);
    if (incompleteResult.ok)
      throw new Error("expected an incomplete notification failure");
    expect(incompleteResult.issues).toContainEqual(
      expect.objectContaining({
        category: "invalid_shape",
        code: "UDL1003",
        path: "$.instruments[0].actions.create.effects.notifies[0].channel",
      }),
    );
  });
});

describe("UDL movement classes", () => {
  test("classifies every priced operation family", () => {
    expect(movementClass({ operation: "internal_transfer.create" })).toBe(
      "transfer.internal",
    );
    expect(movementClass({ operation: "collection.pay_in.capture" })).toBe(
      "collection.pay_in",
    );
    expect(movementClass({ operation: "deposit.record" })).toBe(
      "deposit.attributed",
    );
    expect(movementClass({ operation: "payout.create" })).toBe(
      "payout.external",
    );
  });

  test("refuses an operation with no movement class", () => {
    expect(() => movementClass({ operation: "unknown.move" })).toThrow(
      "cannot classify UDL movement operation unknown.move",
    );
  });
});

describe("UDL clause vocabulary", () => {
  test("publishes the closed effect-kind list", () => {
    expect(udlEffectKinds).toEqual([
      "decides",
      "holds",
      "moves",
      "notifies",
      "reads",
      "schedules",
    ]);
  });

  test("publishes unique spellings with assignment cardinality", () => {
    const keys = udlClauseVocabulary.map(
      (entry) => `${entry.scope}:${entry.spelling}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(
      udlClauseVocabulary.every(
        (entry) => entry.cardinality === "one" || entry.cardinality === "many",
      ),
    ).toBe(true);
  });

  test("maps every general settlement clause without archetype branches", () => {
    const clauses = Object.fromEntries(
      udlClauseVocabulary.map((entry) => [
        `${entry.scope}:${entry.spelling}`,
        { cardinality: entry.cardinality, target: entry.target },
      ]),
    );

    expect(clauses).toEqual(
      expect.objectContaining({
        "action:computes distribute": {
          cardinality: "one",
          target: "distribute",
        },
        "action:computes remainder": {
          cardinality: "one",
          target: "remainder",
        },
        "action:computes signed_sum": {
          cardinality: "one",
          target: "signedSum",
        },
        "action:deadline": { cardinality: "one", target: "deadline" },
        "action:due": { cardinality: "one", target: "due" },
        "action:moves": { cardinality: "many", target: "moves" },
        "action:notify": {
          cardinality: "many",
          target: "effects.notifies",
        },
        "action:requires checks": {
          cardinality: "many",
          target: "requiresChecks",
        },
        "action:commit": { cardinality: "one", target: "commit" },
        "action:quote": { cardinality: "one", target: "quote" },
        "action:requires drained": {
          cardinality: "one",
          target: "requiresDrainedAccount",
        },
        "instrument:computes derived": {
          cardinality: "many",
          target: "derivedAmounts",
        },
        "instrument:computes fees": {
          cardinality: "many",
          target: "feeRules",
        },
        "instrument:partitions": {
          cardinality: "many",
          target: "partitions",
        },
      }),
    );
  });

  test("declares every existing effect-producing clause", () => {
    const effects = Object.fromEntries(
      udlClauseVocabulary
        .filter((entry) => "effects" in entry)
        .map((entry) => [`${entry.scope}:${entry.spelling}`, entry.effects]),
    );

    expect(effects).toEqual({
      "action:commit": [],
      "action:deadline": [
        {
          kind: "schedules",
          per: "clause",
          signature: { fixed: "deadline" },
        },
      ],
      "action:decision": [
        {
          kind: "decides",
          per: "clause",
          signature: { fromField: "capability" },
        },
      ],
      "action:due": [
        {
          kind: "schedules",
          per: "clause",
          signature: { fixed: "due" },
        },
      ],
      "action:moves": [
        {
          kind: "moves",
          per: "element",
          signature: { movementClass: true },
        },
        {
          kind: "holds",
          per: "element",
          signature: { fixed: "reserve" },
        },
      ],
      "action:notify": [
        {
          kind: "notifies",
          per: "element",
          signature: { fromField: "channel" },
        },
      ],
      "action:payout": [
        {
          kind: "moves",
          per: "clause",
          signature: { fixed: "payout.external" },
        },
      ],
      "action:port": [
        {
          kind: "decides",
          per: "clause",
          signature: { fixed: "tenant_port" },
        },
      ],
      "action:quote": [
        {
          kind: "holds",
          per: "clause",
          signature: { fixed: "quote" },
        },
        {
          kind: "schedules",
          per: "clause",
          signature: { fixed: "expiry" },
        },
      ],
      "action:reconcile": [
        {
          kind: "reads",
          per: "element",
          signature: { fixed: "reconcile" },
        },
      ],
      "action:requires aggregate": [
        {
          kind: "reads",
          per: "clause",
          signature: { fixed: "requires_aggregate" },
        },
      ],
      "action:requires checks": [
        {
          kind: "reads",
          per: "clause",
          signature: { fixed: "requires_checks" },
        },
      ],
      "action:requires refs": [
        {
          kind: "reads",
          per: "clause",
          signature: { fixed: "requires_refs" },
        },
      ],
    });
  });

  test("derives quote, commit, and reconcile effect signatures", () => {
    expect(
      deriveUdlActionEffects(
        {
          commit: "quote_refund",
          quote: { expires: { offset: "PT15M" } },
          reconcile: [
            { evidence: "debit_statement_line" },
            { evidence: "debit_statement_line" },
          ],
        },
        udlClauseVocabulary,
      ),
    ).toEqual({
      holds: [{ signature: "holds.quote", source: "quote" }],
      reads: [
        { signature: "reads.reconcile", source: "reconcile[0]" },
        { signature: "reads.reconcile", source: "reconcile[1]" },
      ],
      schedules: [{ signature: "schedules.expiry", source: "quote" }],
    });
  });

  test("scopes quote-commit to actions and keeps every clause target flat", () => {
    const quote = udlClauseVocabulary.find(
      (entry) => entry.scope === "action" && entry.spelling === "quote",
    );
    const commit = udlClauseVocabulary.find(
      (entry) => entry.scope === "action" && entry.spelling === "commit",
    );

    // The net is the money the committing action pays out, so the linear
    // typestate must see it routed. The charge is its complement, proven by the
    // finance typestate instead: a zero-rate schedule legitimately routes
    // nothing, and linearity would refuse that contract.
    expect(
      quote && "linearOutputs" in quote ? quote.linearOutputs : [],
    ).toEqual(["netRef"]);
    expect(commit && "linearOutputs" in commit).toBe(false);

    // Nested targets are gone with the unwind special case: a clause writes
    // one top-level slot, which is what keeps HSX from branching on shape.
    expect(
      udlClauseVocabulary.filter((entry) => entry.target.includes(".")),
    ).toEqual(
      udlClauseVocabulary.filter((entry) =>
        entry.target.startsWith("effects."),
      ),
    );
  });
});
