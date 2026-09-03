import { describe, expect, test } from "bun:test";
import { type UdlDocument, validateUdl } from "../src/index.js";

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
const accountField = {
  pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
  type: "string",
} as const;

function feeDocument(): UdlDocument {
  return {
    instruments: [
      {
        actionOrder: ["create"],
        actions: {
          create: { moves: [], steps: [], summary: "Create the charge" },
        },
        feeRules: [
          {
            amountField: "feeAmount",
            baseField: "baseAmount",
            bearerField: "payerAccountId",
            position: "carved",
            rule: { bps: 250, kind: "bps" },
          },
        ],
        fields: {
          baseAmount: moneyField,
          currency: currencyField,
          feeAmount: moneyField,
          netAmount: moneyField,
          payerAccountId: accountField,
        },
        id: "fee_charge",
        idPrefix: "fch",
        lifecycle: { initial: "created", states: ["created"], transitions: {} },
        partitions: [
          { pieceFields: ["netAmount", "feeAmount"], totalField: "baseAmount" },
        ],
        required: ["baseAmount", "currency", "netAmount", "payerAccountId"],
        summary: "A charge with one fee",
        title: "Fee charge",
      },
    ],
    product: "fee_test",
    subjects: [],
    title: "Fee test",
    udl: 1,
    version: 1,
  };
}

function messages(value: unknown): readonly string[] {
  const result = validateUdl(value);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
}

describe("UDL unified fee rules", () => {
  test("accepts carved bps, direct exact, and mixed tiered rules", () => {
    expect(validateUdl(feeDocument()).ok).toBe(true);

    const exact = feeDocument();
    exact.instruments[0]!.feeRules![0] = {
      amountField: "feeAmount",
      baseField: "baseAmount",
      bearerField: "payerAccountId",
      position: "carved",
      rule: { currencyField: "currency", field: "feeAmount", kind: "exact" },
    };
    exact.instruments[0]!.required.push("feeAmount");
    expect(validateUdl(exact).ok).toBe(true);

    const tiered = feeDocument();
    tiered.instruments[0]!.feeRules![0] = {
      amountField: "feeAmount",
      baseField: "baseAmount",
      bearerField: "payerAccountId",
      position: "on_top",
      rule: {
        kind: "tiered",
        tiers: [
          {
            fromInclusive: "0",
            rule: { bps: 125, kind: "bps" },
            toExclusive: "10000",
          },
          {
            fromInclusive: "10000",
            rule: {
              currencyField: "currency",
              field: "netAmount",
              kind: "exact",
            },
          },
        ],
      },
    };
    delete tiered.instruments[0]!.partitions;
    expect(validateUdl(tiered).ok).toBe(true);
  });

  test("refuses gaps, overlaps, and two open-ended tiers", () => {
    const tiered = feeDocument();
    tiered.instruments[0]!.feeRules![0]!.rule = {
      kind: "tiered",
      tiers: [
        {
          fromInclusive: "0",
          rule: { bps: 100, kind: "bps" },
          toExclusive: "100",
        },
        { fromInclusive: "101", rule: { bps: 200, kind: "bps" } },
      ],
    };
    expect(messages(tiered)).toContain("fee tiers have a gap before 101");

    const overlap = structuredClone(tiered);
    overlap.instruments[0]!.feeRules![0]!.rule = {
      kind: "tiered",
      tiers: [
        {
          fromInclusive: "0",
          rule: { bps: 100, kind: "bps" },
          toExclusive: "100",
        },
        { fromInclusive: "99", rule: { bps: 200, kind: "bps" } },
      ],
    };
    expect(messages(overlap)).toContain("fee tiers overlap at 99");

    const twoOpen = structuredClone(tiered);
    twoOpen.instruments[0]!.feeRules![0]!.rule = {
      kind: "tiered",
      tiers: [
        { fromInclusive: "0", rule: { bps: 100, kind: "bps" } },
        { fromInclusive: "100", rule: { bps: 200, kind: "bps" } },
      ],
    };
    expect(messages(twoOpen)).toContain(
      "tiered fee must declare exactly one open-ended tier; found 2",
    );
  });

  test("refuses wrong currency and mutable exact money", () => {
    const exact = feeDocument();
    exact.instruments[0]!.feeRules![0]!.rule = {
      currencyField: "settlementCurrency",
      field: "feeAmount",
      kind: "exact",
    };
    exact.instruments[0]!.fields.settlementCurrency = currencyField;
    exact.instruments[0]!.required.push("feeAmount", "settlementCurrency");
    expect(messages(exact)).toContain(
      "exact fee currency settlementCurrency must equal the fee base currency field",
    );

    const mutable = feeDocument();
    mutable.instruments[0]!.feeRules![0]!.rule = {
      currencyField: "currency",
      field: "feeAmount",
      kind: "exact",
    };
    mutable.instruments[0]!.required.push("feeAmount");
    mutable.instruments[0]!.update = {
      fields: ["feeAmount"],
      states: ["created"],
    };
    expect(messages(mutable)).toContain(
      "exact fee field feeAmount cannot be mutable",
    );
  });

  test("refuses a carved base-plus-fee exit", () => {
    const invalid = feeDocument();
    invalid.instruments[0]!.partitions = [
      {
        pieceFields: ["baseAmount", "feeAmount"],
        totalField: "netAmount",
      },
    ];
    expect(messages(invalid)).toContain(
      "carved fee feeAmount must form part of a partition of baseAmount",
    );
  });
});
