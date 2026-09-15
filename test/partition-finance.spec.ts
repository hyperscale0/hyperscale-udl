import { describe, expect, test } from "bun:test";
import {
  analyzeInstrumentFinance,
  type FinancialInstrument,
} from "../src/finance.js";

function provisionEscrowStep() {
  return {
    operation: "account.escrow.provision",
    bind: { role: { from: "const" as const, value: "product_escrow" } },
    capture: { escrowAccountId: "accountId" },
  };
}

function createTransferMove(
  key: string,
  source: string,
  destination: string,
  amountPath: string,
) {
  return {
    key,
    operation: "internal_transfer.create",
    bind: {
      sourceAccountId: { from: "instance" as const, path: source },
      destinationAccountId: { from: "instance" as const, path: destination },
      amount: { from: "instance" as const, path: amountPath },
    },
  };
}

function createO02WitnessInstrument(): FinancialInstrument {
  return {
    lifecycle: {
      initial: "created",
      states: ["created", "funded", "released", "refunded"],
      transitions: {
        fund: { from: ["created"], to: "funded" },
        release: { from: ["funded"], to: "released" },
        refund: { from: ["funded"], to: "refunded" },
      },
    },
    partitions: [
      {
        totalField: "price",
        pieceFields: ["buyerContributionAmount", "funderContributionAmount"],
      },
      {
        totalField: "price",
        pieceFields: ["sellerNet", "sellerFee", "serviceTax"],
      },
    ],
    actions: {
      create: {
        steps: [provisionEscrowStep()],
      },
      fund: {
        steps: [],
        moves: [
          createTransferMove(
            "buyer_fund",
            "fields.buyerAccountId",
            "refs.escrowAccountId",
            "fields.buyerContributionAmount",
          ),
          createTransferMove(
            "funder_fund",
            "fields.funderAccountId",
            "refs.escrowAccountId",
            "fields.funderContributionAmount",
          ),
        ],
      },
      release: {
        steps: [],
        moves: [
          createTransferMove(
            "pay_seller",
            "refs.escrowAccountId",
            "fields.sellerAccountId",
            "fields.sellerNet",
          ),
          createTransferMove(
            "pay_fee",
            "refs.escrowAccountId",
            "fields.platformAccountId",
            "fields.sellerFee",
          ),
          createTransferMove(
            "pay_tax",
            "refs.escrowAccountId",
            "fields.taxAccountId",
            "fields.serviceTax",
          ),
        ],
      },
      refund: {
        steps: [],
        moves: [
          createTransferMove(
            "refund_buyer",
            "refs.escrowAccountId",
            "fields.buyerAccountId",
            "fields.buyerContributionAmount",
          ),
          createTransferMove(
            "refund_funder",
            "refs.escrowAccountId",
            "fields.funderAccountId",
            "fields.funderContributionAmount",
          ),
        ],
      },
    },
  };
}

function createContributionStageWitnessInstrument(): FinancialInstrument {
  return {
    lifecycle: {
      initial: "created",
      states: ["created", "funded", "released", "refunded"],
      transitions: {
        fund: { from: ["created"], to: "funded" },
        release: { from: ["funded"], to: "released" },
        refund: { from: ["funded"], to: "refunded" },
      },
    },
    contributions: {
      field: "contributions",
      amountKey: "amount",
      accountKey: "account",
      totalField: "price",
    },
    partitions: [
      {
        totalField: "price",
        pieceFields: ["sellerNet", "sellerFee", "serviceTax"],
      },
    ],
    actions: {
      create: {
        steps: [provisionEscrowStep()],
      },
      fund: {
        steps: [],
        contributionStage: {
          stage: "fund",
          accountPath: "refs.escrowAccountId",
        },
      },
      release: {
        steps: [],
        moves: [
          createTransferMove(
            "pay_seller",
            "refs.escrowAccountId",
            "fields.sellerAccountId",
            "fields.sellerNet",
          ),
          createTransferMove(
            "pay_fee",
            "refs.escrowAccountId",
            "fields.platformAccountId",
            "fields.sellerFee",
          ),
          createTransferMove(
            "pay_tax",
            "refs.escrowAccountId",
            "fields.taxAccountId",
            "fields.serviceTax",
          ),
        ],
      },
      refund: {
        steps: [],
        contributionStage: {
          stage: "refund",
          accountPath: "refs.escrowAccountId",
        },
      },
    },
  };
}

describe("partition finance substitution and contribution stages", () => {
  test("proves equal partition substitution for the O02 joined-settlement witness", () => {
    const witness = createO02WitnessInstrument();
    const issues = analyzeInstrumentFinance(witness);
    expect(issues).toEqual([]);
  });

  test("proves contribution stage funding and refunding against partition debits", () => {
    const witness = createContributionStageWitnessInstrument();
    const issues = analyzeInstrumentFinance(witness);
    expect(issues).toEqual([]);
  });

  test("mutation: rejecting unpartitioned debits replicates original UDL4001 proof gap", () => {
    const witness = createO02WitnessInstrument();
    const unpartitioned: FinancialInstrument = {
      ...witness,
      partitions: undefined,
    };
    const issues = analyzeInstrumentFinance(unpartitioned);
    expect(
      issues.some(
        (issue) =>
          issue.code === "UDL4001" &&
          issue.message.includes(
            "cannot prove fields.sellerNet is the exact available balance of refs.escrowAccountId",
          ),
      ),
    ).toBe(true);
  });

  test("mutation: rejects partial funding when second contributor amount is omitted", () => {
    const witness = createO02WitnessInstrument();
    const partialFunding: FinancialInstrument = {
      ...witness,
      actions: {
        ...witness.actions,
        fund: {
          steps: [],
          moves: [
            createTransferMove(
              "buyer_fund",
              "fields.buyerAccountId",
              "refs.escrowAccountId",
              "fields.buyerContributionAmount",
            ),
          ],
        },
      },
    };
    const issues = analyzeInstrumentFinance(partialFunding);
    expect(
      issues.some(
        (issue) =>
          issue.code === "UDL4001" &&
          issue.message.includes(
            "cannot prove fields.sellerNet is the exact available balance of refs.escrowAccountId",
          ),
      ),
    ).toBe(true);
  });

  test("mutation: rejects duplicate pieces in partition specification", () => {
    const witness = createO02WitnessInstrument();
    const duplicatePieces: FinancialInstrument = {
      ...witness,
      partitions: [
        witness.partitions![0]!,
        {
          totalField: "price",
          pieceFields: ["sellerNet", "sellerNet", "serviceTax"],
        },
      ],
    };
    const issues = analyzeInstrumentFinance(duplicatePieces);
    expect(
      issues.some(
        (issue) =>
          issue.code === "UDL4001" &&
          issue.message.includes("cannot prove fields.sellerNet"),
      ),
    ).toBe(true);
  });

  test("mutation: rejects mixed stray balance in held escrow account", () => {
    const witness = createO02WitnessInstrument();
    const strayBalance: FinancialInstrument = {
      ...witness,
      actions: {
        ...witness.actions,
        fund: {
          steps: [],
          moves: [
            ...witness.actions.fund!.moves!,
            createTransferMove(
              "stray_fee",
              "fields.buyerAccountId",
              "refs.escrowAccountId",
              "fields.strayFee",
            ),
          ],
        },
      },
    };
    const issues = analyzeInstrumentFinance(strayBalance);
    expect(
      issues.some(
        (issue) =>
          issue.code === "UDL4001" &&
          issue.message.includes("cannot prove fields.sellerNet"),
      ),
    ).toBe(true);
  });

  test("mutation: rejects double spend of incoming piece after partition substitution", () => {
    const witness = createO02WitnessInstrument();
    const doubleSpend: FinancialInstrument = {
      ...witness,
      actions: {
        ...witness.actions,
        release: {
          steps: [],
          moves: [
            ...witness.actions.release!.moves!,
            createTransferMove(
              "extra_spend",
              "refs.escrowAccountId",
              "fields.buyerAccountId",
              "fields.buyerContributionAmount",
            ),
          ],
        },
      },
    };
    const issues = analyzeInstrumentFinance(doubleSpend);
    expect(
      issues.some(
        (issue) =>
          issue.code === "UDL4001" &&
          issue.message.includes("cannot prove fields.buyerContributionAmount"),
      ),
    ).toBe(true);
  });

  test("mutation: rejects substitution while an active reservation hold exists", () => {
    const witness = createO02WitnessInstrument();
    const activeHold: FinancialInstrument = {
      ...witness,
      actions: {
        ...witness.actions,
        fund: {
          steps: [],
          moves: [
            ...witness.actions.fund!.moves!,
            {
              key: "hold_move",
              operation: "internal_transfer.reserve",
              bind: {
                sourceAccountId: {
                  from: "instance",
                  path: "refs.escrowAccountId",
                },
                destinationAccountId: {
                  from: "instance",
                  path: "fields.holdDestination",
                },
                amount: {
                  from: "instance",
                  path: "fields.buyerContributionAmount",
                },
              },
              capture: { holdTransfer: "transferId" },
            },
          ],
        },
      },
    };
    const issues = analyzeInstrumentFinance(activeHold);
    expect(issues.some((issue) => issue.code === "UDL4001")).toBe(true);
  });

  test("mutation: rejects partition substitution when partition totals mismatch", () => {
    const witness = createO02WitnessInstrument();
    const mismatchedTotals: FinancialInstrument = {
      ...witness,
      partitions: [
        {
          totalField: "deposit",
          pieceFields: ["buyerContributionAmount", "funderContributionAmount"],
        },
        {
          totalField: "price",
          pieceFields: ["sellerNet", "sellerFee", "serviceTax"],
        },
      ],
    };
    const issues = analyzeInstrumentFinance(mismatchedTotals);
    expect(
      issues.some(
        (issue) =>
          issue.code === "UDL4001" &&
          issue.message.includes("cannot prove fields.sellerNet"),
      ),
    ).toBe(true);
  });

  test("mutation: rejects cycle attempting repeated partition substitution", () => {
    const witness = createO02WitnessInstrument();
    const cyclicInstrument: FinancialInstrument = {
      ...witness,
      lifecycle: {
        initial: "created",
        states: ["created", "funded", "released", "refunded"],
        transitions: {
          fund: { from: ["created"], to: "funded" },
          release: { from: ["funded"], to: "released" },
          refund: { from: ["funded"], to: "refunded" },
          re_release: { from: ["released"], to: "funded" },
        },
      },
    };
    const issues = analyzeInstrumentFinance(cyclicInstrument);
    expect(
      issues.some(
        (issue) => issue.code === "UDL4001" || issue.code === "UDL1004",
      ),
    ).toBe(true);
  });
});
