import { expect, test } from "bun:test";
import { distributeReceiptAmounts } from "../src/distribution.js";
import { udlClauseVocabulary, type UdlAction } from "../src/schema.js";
import { deriveUdlActionEffects } from "../src/effects.js";

const clause: NonNullable<UdlAction["receiptDistribution"]> = {
  roundField: "roundId",
  snapshotRef: "fundingSnapshot",
  receiptField: "receiptId",
  receiptPath: "refs.allocationReceipt",
  mode: "cash",
  feeBps: 100,
  vatBps: 1500,
  feeAccountField: "feeAccountId",
  taxAccountField: "taxAccountId",
  residualAccountField: "residualAccountId",
  capture: "distributionReceipt",
};

test("unequal ticket weights conserve cash after fee, VAT and floor residual", () => {
  const tickets = [
    { id: "a", weight: 1n },
    { id: "b", weight: 2n },
  ];
  const witness = (weights: typeof tickets) => {
    const result = distributeReceiptAmounts(clause, 100n, 12345n, weights);
    expect(result).toEqual({
      fee: 123n,
      vat: 18n,
      residual: 1n,
      shares: [
        { id: "a", amount: 4101n },
        { id: "b", amount: 8202n },
      ],
    });
  };
  witness(tickets);
  expect(() =>
    witness([
      { id: "a", weight: 1n },
      { id: "b", weight: 1n },
    ]),
  ).toThrow();
});

test("loss allocation assigns every principal unit to investors without fees", () => {
  const loss = { ...clause, mode: "loss" as const, feeBps: 0, vatBps: 0 };
  expect(
    distributeReceiptAmounts(loss, 5n, 0n, [
      { id: "b", weight: 1n },
      { id: "a", weight: 1n },
    ]),
  ).toEqual({
    fee: 0n,
    vat: 0n,
    residual: 0n,
    shares: [
      { id: "b", amount: 2n },
      { id: "a", amount: 3n },
    ],
  });
  expect(() =>
    distributeReceiptAmounts({ ...loss, feeBps: 1 }, 5n, 0n, [
      { id: "a", weight: 1n },
    ]),
  ).toThrow();
});

test("loss receipts declare no cash movement effect", () => {
  const effects = (mode: "cash" | "loss") =>
    deriveUdlActionEffects(
      { receiptDistribution: { ...clause, mode } },
      udlClauseVocabulary,
    );
  expect(effects("loss").moves).toBeUndefined();
  expect(effects("cash").moves).toEqual([
    { signature: "moves.allocation", source: "receiptDistribution" },
  ]);
});
