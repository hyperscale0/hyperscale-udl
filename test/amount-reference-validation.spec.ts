import { describe, expect, test } from "bun:test";
import { validateUdl, type UdlDocument } from "../src/index.js";

const moneyField = {
  pattern: "^[1-9][0-9]{0,17}$",
  type: "string",
} as const;
const currencyField = {
  maxLength: 3,
  minLength: 3,
  pattern: "^[A-Z]{3}$",
  type: "string",
} as const;

function distributionDocument(): UdlDocument {
  return {
    instruments: [
      {
        actionOrder: ["create"],
        fields: { currency: currencyField, poolAmount: moneyField },
        id: "source_pool",
        idPrefix: "spl",
        lifecycle: { initial: "open", states: ["open"], transitions: {} },
        required: ["poolAmount", "currency"],
        summary: "Stored distribution pool",
        title: "Source pool",
        actions: {
          create: { moves: [], steps: [], summary: "Create source pool" },
        },
      },
      {
        actionOrder: ["create", "payout"],
        fields: {
          currency: currencyField,
          parentId: {
            pattern: "^spl_(sandbox|live)_[a-z0-9]{8,64}$",
            type: "string",
          },
          weight: moneyField,
        },
        id: "entitlement",
        idPrefix: "ent",
        lifecycle: {
          initial: "recorded",
          states: ["recorded", "paid"],
          transitions: { payout: { from: ["recorded"], to: "paid" } },
        },
        required: ["parentId", "weight", "currency"],
        summary: "Stored weighted entitlement",
        title: "Entitlement",
        actions: {
          create: {
            moves: [],
            requiresRefs: [
              {
                bind: { currency: "fields.currency" },
                field: "parentId",
                statuses: ["open"],
              },
            ],
            steps: [],
            summary: "Record entitlement",
          },
          payout: {
            distribute: {
              amountRef: "payoutShare",
              onZero: "skip_steps",
              pool: { from: "parent", path: "fields.poolAmount" },
              refField: "parentId",
              statuses: ["recorded", "paid"],
              weightField: "weight",
            },
            moves: [],
            steps: [],
            summary: "Pay entitlement",
          },
        },
      },
    ],
    product: "distribution_test",
    subjects: [],
    title: "Distribution test",
    udl: 1,
    version: 1,
  };
}

function messages(value: unknown): readonly string[] {
  const result = validateUdl(value);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
}

describe("UDL computed amount reference validation", () => {
  test("rejects nonexistent and wrong-typed distribute references", () => {
    expect(validateUdl(distributionDocument()).ok).toBe(true);

    const missingParent = distributionDocument();
    missingParent.instruments[1]!.actions.payout!.distribute!.refField =
      "missingParentId";
    expect(messages(missingParent)).toContain(
      "distribute refField missingParentId must identify exactly one parent instrument",
    );

    const wrongParentType = distributionDocument();
    wrongParentType.instruments[1]!.actions.payout!.distribute!.refField =
      "weight";
    expect(messages(wrongParentType)).toContain(
      "distribute refField weight must identify exactly one parent instrument",
    );

    const missingPool = distributionDocument();
    missingPool.instruments[1]!.actions.payout!.distribute!.pool.path =
      "fields.missingAmount";
    expect(messages(missingPool)).toContain(
      "distribute pool fields.missingAmount must be a declared money field or ref of source_pool",
    );

    const wrongPoolType = distributionDocument();
    wrongPoolType.instruments[1]!.actions.payout!.distribute!.pool.path =
      "fields.currency";
    expect(messages(wrongPoolType)).toContain(
      "distribute pool fields.currency must be a declared money field or ref of source_pool",
    );

    const missingComputedPool = distributionDocument();
    missingComputedPool.instruments[1]!.actions.payout!.distribute!.pool.path =
      "refs.missingPool";
    expect(messages(missingComputedPool)).toContain(
      "distribute pool refs.missingPool must be a declared money field or ref of source_pool",
    );

    const missingWeight = distributionDocument();
    missingWeight.instruments[1]!.actions.payout!.distribute!.weightField =
      "missingWeight";
    expect(messages(missingWeight)).toContain(
      "distribute weightField missingWeight must be a declared money field",
    );

    const wrongWeightType = distributionDocument();
    wrongWeightType.instruments[1]!.actions.payout!.distribute!.weightField =
      "currency";
    expect(messages(wrongWeightType)).toContain(
      "distribute weightField currency must be a declared money field",
    );

    const missingStatus = distributionDocument();
    missingStatus.instruments[1]!.actions.payout!.distribute!.statuses = [
      "missing",
    ];
    expect(messages(missingStatus)).toContain(
      "distribute status missing is not declared by entitlement",
    );
  });

  test("rejects nonexistent and wrong-typed derived amount references", () => {
    const valid = distributionDocument();
    valid.instruments[0]!.fields.derivedAmount = moneyField;
    valid.instruments[0]!.derivedAmounts = [
      {
        field: "derivedAmount",
        rounding: "floor",
        rule: { bps: 250, kind: "percentage_of" },
        sourceField: "poolAmount",
      },
    ];
    expect(validateUdl(valid).ok).toBe(true);

    const missingTarget = structuredClone(valid);
    missingTarget.instruments[0]!.derivedAmounts![0]!.field = "missingAmount";
    expect(messages(missingTarget)).toContain(
      "derived amount target missingAmount must be a declared money field",
    );

    const wrongTargetType = structuredClone(valid);
    wrongTargetType.instruments[0]!.derivedAmounts![0]!.field = "currency";
    expect(messages(wrongTargetType)).toContain(
      "derived amount target currency must be a declared money field",
    );

    const missingSource = structuredClone(valid);
    missingSource.instruments[0]!.derivedAmounts![0]!.sourceField =
      "missingAmount";
    expect(messages(missingSource)).toContain(
      "derived amount source missingAmount must be a declared money field",
    );

    const wrongSourceType = structuredClone(valid);
    wrongSourceType.instruments[0]!.derivedAmounts![0]!.sourceField =
      "currency";
    expect(messages(wrongSourceType)).toContain(
      "derived amount source currency must be a declared money field",
    );
  });
});
