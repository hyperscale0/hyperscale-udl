import { describe, expect, it } from "bun:test";
import {
  deriveActionEffectsFromPlan,
  resolveUdlActionPlans,
} from "../src/effects.js";
import { validateUdl } from "../src/validation.js";
import { makeValidDocument } from "./fixtures/piece-plan-calls.js";

describe("W1 UDL ABI Refactor Clauses", () => {
  it("validates a well-formed piece plan, piece stage, action library, and calls", () => {
    const doc = makeValidDocument();
    const result = validateUdl(doc);
    expect(result.ok).toBe(true);

    const planRes = resolveUdlActionPlans(doc.instruments[0]!);
    expect(planRes.issues.length).toBe(0);
    const piecePlans = planRes.plans.filter(
      (plan) => plan.pieceId !== undefined,
    );
    expect(piecePlans.length).toBe(4);
    expect(piecePlans[0]?.pieceId).toBe("p1");
    expect(piecePlans[1]?.pieceId).toBe("p2");
    expect(piecePlans[0]?.leaves[0]?.originPath).toEqual([
      "fund_piece",
      "call_fund",
      "leaf_fund",
    ]);

    const effects = deriveActionEffectsFromPlan(piecePlans[0]!.leaves);
    expect(effects.moves?.[0]?.source).toBe("fund_piece.call_fund.leaf_fund");
  });

  it("resolves every ordinary action without changing its steps or effects", () => {
    const instrument = makeValidDocument().instruments[0]!;
    const ordinary = instrument.actionOrder.filter(
      (key) =>
        !instrument.actions[key]!.calls?.length &&
        !instrument.actions[key]!.pieceStage,
    );
    const resolved = resolveUdlActionPlans(instrument);
    const actual = resolved.plans
      .filter((plan) => ordinary.includes(plan.action))
      .map((plan) => ({
        action: plan.action,
        steps: plan.leaves.map((leaf) => leaf.step),
        effects: plan.effects,
      }));
    const expected = ordinary.map((action) => ({
      action,
      steps: [
        ...instrument.actions[action]!.steps,
        ...instrument.actions[action]!.moves,
      ],
      effects: instrument.actions[action]!.effects ?? {},
    }));
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  it("enforces UDL4002 piece partition and immutability invariants", () => {
    // 1. Missing partition match
    const doc1 = makeValidDocument();
    delete doc1.instruments[0]!.partitions;
    const res1 = validateUdl(doc1);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.code === "UDL4002")).toBe(true);
    }

    // 1b. Two pieces sharing one amount field never match a partition
    const doc1b = makeValidDocument();
    doc1b.instruments[0]!.piecePlan!.pieces[1]!.amount = "p1Amount";
    doc1b.instruments[0]!.partitions = [
      { pieceFields: ["p1Amount", "p1Amount"], totalField: "totalAmount" },
    ];
    const res1b = validateUdl(doc1b);
    expect(res1b.ok).toBe(false);
    if (!res1b.ok) {
      expect(
        res1b.issues.some(
          (i) => i.code === "UDL4002" && i.message.includes("must be distinct"),
        ),
      ).toBe(true);
    }

    // 2. Mutable piece total in updates
    const doc2 = makeValidDocument();
    doc2.instruments[0]!.actions.create!.updates = ["totalAmount"];
    const res2 = validateUdl(doc2);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === "UDL4002")).toBe(true);
    }

    // 3. Mutable piece release_to in instrument update policy
    const doc3 = makeValidDocument();
    doc3.instruments[0]!.update = { fields: ["p1Release"], states: ["draft"] };
    const res3 = validateUdl(doc3);
    expect(res3.ok).toBe(false);
    if (!res3.ok) {
      expect(res3.issues.some((i) => i.code === "UDL4002")).toBe(true);
    }

    // 4. Non-money total field
    const doc4 = makeValidDocument();
    doc4.instruments[0]!.fields.totalAmount = { type: "string" };
    const res4 = validateUdl(doc4);
    expect(res4.ok).toBe(false);
    if (!res4.ok) {
      expect(res4.issues.some((i) => i.code === "UDL4002")).toBe(true);
    }

    // 5. Mixed currency in pieces
    const doc5 = makeValidDocument();
    doc5.instruments[0]!.fields.p1Amount = {
      pattern: "^[1-9][0-9]{0,17}$",
      type: "string",
      "x-hyperscale-currency": "USD",
    };
    doc5.instruments[0]!.fields.p2Amount = {
      pattern: "^[1-9][0-9]{0,17}$",
      type: "string",
      "x-hyperscale-currency": "EUR",
    };
    const res5 = validateUdl(doc5);
    expect(res5.ok).toBe(false);
    if (!res5.ok) {
      expect(res5.issues.some((i) => i.code === "UDL4002")).toBe(true);
    }

    // 6. Singleton piece plan with total field passes without declared partition
    const doc6 = makeValidDocument();
    delete doc6.instruments[0]!.partitions;
    doc6.instruments[0]!.piecePlan!.pieces = [
      {
        amount: "totalAmount",
        id: "p1",
        refund_to: "p1Refund",
        release_to: "p1Release",
      },
    ];
    doc6.instruments[0]!.piecePlan!.fund_order = ["p1"];
    doc6.instruments[0]!.piecePlan!.unfund_order = ["p1"];
    doc6.instruments[0]!.piecePlan!.release_order = ["p1"];
    doc6.instruments[0]!.piecePlan!.refund_order = ["p1"];
    doc6.instruments[0]!.actions.fund_piece!.input = {
      additionalProperties: false,
      properties: { pieceId: { enum: ["p1"], type: "string" } },
      required: ["pieceId"],
      type: "object",
    };
    doc6.instruments[0]!.actions.payout_piece!.input = {
      additionalProperties: false,
      properties: { pieceId: { enum: ["p1"], type: "string" } },
      required: ["pieceId"],
      type: "object",
    };
    const res6 = validateUdl(doc6);
    expect(res6.ok).toBe(true);
  });

  it("enforces UDL5013 piece stage and order invariants", () => {
    // 1. unfund_order is not the reverse of fund_order
    const doc1 = makeValidDocument();
    doc1.instruments[0]!.piecePlan!.unfund_order = ["p1", "p2"];
    const res1 = validateUdl(doc1);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.code === "UDL5013")).toBe(true);
    }

    // 1b. pieceStage action with direct moves and no calls never bypasses the oracle
    const doc1b = makeValidDocument();
    delete doc1b.instruments[0]!.actions.fund_piece!.calls;
    doc1b.instruments[0]!.actions.fund_piece!.moves = [
      {
        bind: {
          amount: { from: "instance", path: "fields.totalAmount" },
          destinationAccountId: { from: "instance", path: "fields.p1Release" },
          sourceAccountId: { from: "instance", path: "fields.buyerAccount" },
        },
        key: "direct_fund",
        operation: "internal_transfer.create",
      },
    ];
    const res1b = validateUdl(doc1b);
    expect(res1b.ok).toBe(false);
    if (!res1b.ok) {
      expect(
        res1b.issues.some(
          (i) => i.code === "UDL5013" && i.path.endsWith("fund_piece.calls"),
        ),
      ).toBe(true);
    }

    // 2. pieceStage on create action
    const doc2 = makeValidDocument();
    doc2.instruments[0]!.actions.create!.pieceStage = {
      plan: "split_plan",
      stage: "fund",
    };
    const res2 = validateUdl(doc2);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === "UDL5013")).toBe(true);
    }

    // 3. pieceStage selecting unknown plan
    const doc3 = makeValidDocument();
    doc3.instruments[0]!.actions.fund_piece!.pieceStage!.plan = "nonexistent";
    const res3 = validateUdl(doc3);
    expect(res3.ok).toBe(false);
    if (!res3.ok) {
      expect(res3.issues.some((i) => i.code === "UDL5013")).toBe(true);
    }

    // 4. Input overriding pieceId enum order
    const doc4 = makeValidDocument();
    doc4.instruments[0]!.actions.fund_piece!.input = {
      additionalProperties: false,
      properties: {
        pieceId: { enum: ["p2", "p1"], type: "string" },
      },
      required: ["pieceId"],
      type: "object",
    };
    const res4 = validateUdl(doc4);
    expect(res4.ok).toBe(false);
    if (!res4.ok) {
      expect(res4.issues.some((i) => i.code === "UDL5013")).toBe(true);
    }

    // 5. Swapping release and refund payees in pieceStage leaf binding
    const doc5 = makeValidDocument();
    doc5.instruments[0]!.actionLibrary!.transfers!.actions.execute_release!.leaves[0]!.bind.destinationAccountId =
      "$p.refund_to";
    const res5 = validateUdl(doc5);
    expect(res5.ok).toBe(false);
    if (!res5.ok) {
      expect(res5.issues.some((i) => i.code === "UDL5013")).toBe(true);
    }
  });

  it("enforces UDL2010 action graph, order permutation, and recursion bounds", () => {
    // 1. Mixed direct steps and calls
    const doc1 = makeValidDocument();
    doc1.instruments[0]!.actions.fund_piece!.steps = [
      {
        bind: {
          accountId: { from: "instance", path: "fields.buyerAccount" },
        },
        operation: "account.freeze",
      },
    ];
    const res1 = validateUdl(doc1);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.code === "UDL2010")).toBe(true);
    }

    // 2. Duplicate order in private action
    const doc2 = makeValidDocument();
    doc2.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.order =
      ["leaf_fund", "leaf_fund"];
    const res2 = validateUdl(doc2);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === "UDL2010")).toBe(true);
    }

    // 3. Unknown call target
    const doc3 = makeValidDocument();
    doc3.instruments[0]!.actions.fund_piece!.calls![0]!.action =
      "transfers.unknown_action";
    const res3 = validateUdl(doc3);
    expect(res3.ok).toBe(false);
    if (!res3.ok) {
      expect(res3.issues.some((i) => i.code === "UDL2010")).toBe(true);
    }

    // 4. Undeclared call target named "constructor" emits fatal diagnostic without throwing
    const doc4 = makeValidDocument();
    doc4.instruments[0]!.actions.fund_piece!.calls![0]!.action =
      "transfers.constructor";
    const res4 = validateUdl(doc4);
    expect(res4.ok).toBe(false);
    if (!res4.ok) {
      expect(res4.issues.some((i) => i.code === "UDL2010")).toBe(true);
    }

    // 5. Action call cycle
    const doc5 = makeValidDocument();
    doc5.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.calls =
      [
        {
          action: "transfers.execute_release",
          bind: { inst: "$inst", p: "$p" },
          id: "call_rel_cycle",
        },
      ];
    doc5.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.order.push(
      "call_rel_cycle",
    );
    doc5.instruments[0]!.actionLibrary!.transfers!.actions.execute_release!.calls =
      [
        {
          action: "transfers.execute_fund",
          bind: { inst: "$inst", p: "$p" },
          id: "call_fund_cycle",
        },
      ];
    doc5.instruments[0]!.actionLibrary!.transfers!.actions.execute_release!.order.push(
      "call_fund_cycle",
    );
    const res5 = validateUdl(doc5);
    expect(res5.ok).toBe(false);
    if (!res5.ok) {
      expect(res5.issues.some((i) => i.code === "UDL2010")).toBe(true);
    }
  });

  it("resolves $instance member paths and bare $piece from a public call scope", () => {
    const doc = makeValidDocument();
    const fund =
      doc.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!;
    fund.parameters = {
      buyer: { kind: "account" },
      inst: { kind: "instance" },
      piece: { kind: "piece" },
    };
    fund.leaves[0]!.bind = {
      amount: "$piece.amount",
      destinationAccountId: "$piece.release_to",
      sourceAccountId: "$buyer",
    };
    doc.instruments[0]!.actions.fund_piece!.calls![0]!.bind = {
      buyer: "$instance.fields.buyerAccount",
      inst: "$instance",
      piece: "$piece",
    };
    const res = validateUdl(doc);
    expect(res.ok).toBe(true);
  });

  it("enforces UDL2011 binding validation and rejects $results", () => {
    // 1. Reference to $results.*
    const doc1 = makeValidDocument();
    doc1.instruments[0]!.actions.fund_piece!.calls![0]!.bind.p =
      "$results.previous_leaf";
    const res1 = validateUdl(doc1);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.code === "UDL2011")).toBe(true);
    }

    // 2. Parameter kind mismatch (passing instance to piece parameter)
    const doc2 = makeValidDocument();
    doc2.instruments[0]!.actions.fund_piece!.calls![0]!.bind.p = "$instance";
    const res2 = validateUdl(doc2);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === "UDL2011")).toBe(true);
    }

    // 3. Unknown field reference in leaf bind
    const doc3 = makeValidDocument();
    doc3.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.leaves[0]!.bind.sourceAccountId =
      "$fields.nonexistent";
    const res3 = validateUdl(doc3);
    expect(res3.ok).toBe(false);
    if (!res3.ok) {
      expect(res3.issues.some((i) => i.code === "UDL2011")).toBe(true);
    }

    // 4. Repeated consumption of money amount field in one action
    const doc4 = makeValidDocument();
    doc4.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.leaves.push(
      {
        bind: {
          amount: "$p.amount",
          destinationAccountId: "$p.release_to",
          sourceAccountId: "$i.fields.buyerAccount",
        },
        effects: [
          {
            kind: "moves",
            signature: "moves.transfer.internal",
          },
        ],
        evidence: "duplicate amount transfer",
        id: "leaf_duplicate",
        operation: "internal_transfer.create",
      },
    );
    doc4.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.order.push(
      "leaf_duplicate",
    );
    const res4 = validateUdl(doc4);
    expect(res4.ok).toBe(false);
    if (!res4.ok) {
      expect(res4.issues.some((i) => i.code === "UDL2011")).toBe(true);
    }
  });

  it("enforces UDL2012 authority, approval, and tenant boundaries", () => {
    // 1. Independent approval rejected
    const doc1 = makeValidDocument();
    doc1.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.approval =
      "independent";
    const res1 = validateUdl(doc1);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.code === "UDL2012")).toBe(true);
    }

    // 2. External recovery rejected
    const doc2 = makeValidDocument();
    doc2.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.recovery =
      "external";
    const res2 = validateUdl(doc2);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === "UDL2012")).toBe(true);
    }

    // 3. Principal mismatch
    const doc3 = makeValidDocument();
    doc3.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.principal =
      "user_session";
    const res3 = validateUdl(doc3);
    expect(res3.ok).toBe(false);
    if (!res3.ok) {
      expect(res3.issues.some((i) => i.code === "UDL2012")).toBe(true);
    }
  });

  it("enforces UDL2013 effect signature and evidence rules", () => {
    // 1. Blank evidence. The schema refuses it first; the resolver refuses it
    // on its own for callers that bypass the schema.
    const doc1 = makeValidDocument();
    doc1.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.leaves[0]!.evidence =
      "   ";
    const res1 = validateUdl(doc1);
    expect(res1.ok).toBe(false);
    const planRes1 = resolveUdlActionPlans(doc1.instruments[0]!);
    expect(planRes1.issues.some((i) => i.code === "UDL2013")).toBe(true);

    // 2. Effect signature mismatch
    const doc2 = makeValidDocument();
    doc2.instruments[0]!.actionLibrary!.transfers!.actions.execute_fund!.leaves[0]!.effects =
      [{ kind: "moves", signature: "moves.payout.external" }];
    const res2 = validateUdl(doc2);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === "UDL2013")).toBe(true);
    }
  });
});
