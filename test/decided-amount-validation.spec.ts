import { describe, expect, test } from "bun:test";

import { validateUdl, type UdlDocument } from "../src/index.js";

const moneyField = {
  pattern: "^[1-9][0-9]{0,17}$",
  type: "string",
} as const;

const stringField = { type: "string" } as const;

const currencyField = {
  pattern: "^[A-Z]{3}$",
  type: "string",
} as const;

function decidedAmountDocument(): UdlDocument {
  const drain = {
    bind: {
      transferId: { from: "instance" as const, path: "refs.reservationId" },
    },
    key: "cancel",
    operation: "internal_transfer.void" as const,
  };
  return {
    instruments: [
      {
        actionOrder: ["cancel", "create", "decide"],
        actions: {
          cancel: {
            moves: [drain],
            steps: [],
            summary: "Cancel and release the reserved remainder",
          },
          create: {
            moves: [
              {
                bind: {
                  amount: { from: "instance", path: "fields.authorizedAmount" },
                  destinationAccountId: {
                    from: "instance",
                    path: "fields.destinationAccountId",
                  },
                  sourceAccountId: {
                    from: "instance",
                    path: "fields.sourceAccountId",
                  },
                },
                capture: { reservationId: "transferId" },
                key: "reserve",
                operation: "internal_transfer.reserve",
              },
            ],
            steps: [],
            summary: "Reserve the authorized amount",
          },
          decide: {
            decidedAmount: {
              boundField: "authorizedAmount",
              field: "settledAmount",
              remainderAction: "cancel",
            },
            input: {
              additionalProperties: false,
              properties: { settledAmount: moneyField },
              required: ["settledAmount"],
              type: "object",
            },
            moves: [
              {
                bind: {
                  amount: { from: "input", path: "settledAmount" },
                  currency: { from: "instance", path: "fields.currency" },
                  postMode: { from: "const", value: "partial_only" },
                  transferId: {
                    from: "instance",
                    path: "refs.reservationId",
                  },
                },
                key: "decided",
                operation: "internal_transfer.post",
              },
              { ...structuredClone(drain), key: "remainder" },
            ],
            steps: [],
            summary: "Settle the decided amount and release the remainder",
          },
        },
        fields: {
          authorizedAmount: moneyField,
          currency: currencyField,
          destinationAccountId: stringField,
          sourceAccountId: stringField,
        },
        id: "decided_hold",
        idPrefix: "dch",
        lifecycle: {
          initial: "held",
          states: ["held", "settled", "cancelled"],
          transitions: {
            cancel: { from: ["held"], to: "cancelled" },
            decide: { from: ["held"], to: "settled" },
          },
        },
        required: [
          "authorizedAmount",
          "currency",
          "destinationAccountId",
          "sourceAccountId",
        ],
        summary: "A hold with a caller-decided settlement amount",
        title: "Decided hold",
      },
    ],
    product: "decided_amount_test",
    subjects: [],
    title: "Decided amount test",
    udl: 1,
    version: 1,
  };
}

function issues(value: unknown) {
  const result = validateUdl(value);
  expect(result.ok).toBe(false);
  return result.ok
    ? []
    : result.issues.map(({ code, message, path }) => ({ code, message, path }));
}

describe("UDL decided amount validation", () => {
  test("accepts one decided post followed by its cloned remainder drain", () => {
    expect(validateUdl(decidedAmountDocument())).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  test("reports clause identifier shape errors at authored paths", () => {
    const document = decidedAmountDocument() as unknown as {
      instruments: Array<{
        actions: Record<string, { decidedAmount?: Record<string, string> }>;
      }>;
    };
    const clause = document.instruments[0]!.actions.decide!.decidedAmount!;
    clause.field = "SettledAmount";
    clause.boundField = "authorized_amount";
    clause.remainderAction = "cancelAction";

    expect(issues(document)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UDL1003",
          path: "$.instruments[0].actions.decide.decidedAmount.field",
        }),
        expect.objectContaining({
          code: "UDL1003",
          path: "$.instruments[0].actions.decide.decidedAmount.boundField",
        }),
        expect.objectContaining({
          code: "UDL1003",
          path: "$.instruments[0].actions.decide.decidedAmount.remainderAction",
        }),
      ]),
    );
  });

  test("rejects missing and non-money decided fields", () => {
    const missing = decidedAmountDocument();
    missing.instruments[0]!.actions.decide!.decidedAmount!.field =
      "missingAmount";
    expect(issues(missing)).toContainEqual({
      code: "UDL4001",
      message:
        "decided amount field missingAmount must be a declared action input money field",
      path: "$.instruments[0].actions.decide.decidedAmount.field",
    });

    const wrongType = decidedAmountDocument();
    const properties = wrongType.instruments[0]!.actions.decide!.input!
      .properties as Record<string, unknown>;
    properties.settledAmount = stringField;
    expect(issues(wrongType)).toContainEqual({
      code: "UDL4001",
      message:
        "decided amount field settledAmount must be a declared action input money field",
      path: "$.instruments[0].actions.decide.decidedAmount.field",
    });
  });

  test("rejects a decided field that the action input does not require", () => {
    const document = decidedAmountDocument();
    document.instruments[0]!.actions.decide!.input!.required = [];

    expect(issues(document)).toEqual([
      {
        code: "UDL2002",
        message:
          "decided amount field settledAmount must be required by the action input",
        path: "$.instruments[0].actions.decide.decidedAmount.field",
      },
    ]);
  });

  test("rejects a non-partition post or mismatched currency binding", () => {
    const wrongPostMode = decidedAmountDocument();
    wrongPostMode.instruments[0]!.actions.decide!.moves[0]!.bind.postMode = {
      from: "const",
      value: "full",
    };
    expect(issues(wrongPostMode)).toContainEqual({
      code: "UDL5008",
      message:
        "decided amount post must use partial_only so the remainder stays reserved",
      path: "$.instruments[0].actions.decide.moves[0].bind.postMode",
    });

    const wrongCurrency = decidedAmountDocument();
    wrongCurrency.instruments[0]!.actions.decide!.moves[0]!.bind.currency = {
      from: "const",
      value: "USD",
    };
    expect(issues(wrongCurrency)).toContainEqual({
      code: "UDL5008",
      message: "decided amount post must bind the instrument currency",
      path: "$.instruments[0].actions.decide.moves[0].bind.currency",
    });
  });

  test("rejects a missing, wrong-typed, optional, or mutable bound", () => {
    const missing = decidedAmountDocument();
    missing.instruments[0]!.actions.decide!.decidedAmount!.boundField =
      "missingAmount";
    expect(issues(missing)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "decided amount bound missingAmount must be a declared instrument money field",
          path: "$.instruments[0].actions.decide.decidedAmount.boundField",
        }),
        expect.objectContaining({
          message: "decided amount bound missingAmount must be required",
          path: "$.instruments[0].actions.decide.decidedAmount.boundField",
        }),
      ]),
    );

    const wrongType = decidedAmountDocument();
    wrongType.instruments[0]!.fields.authorizedAmount = stringField;
    expect(issues(wrongType)).toContainEqual(
      expect.objectContaining({
        message:
          "decided amount bound authorizedAmount must be a declared instrument money field",
        path: "$.instruments[0].actions.decide.decidedAmount.boundField",
      }),
    );

    const optional = decidedAmountDocument();
    optional.instruments[0]!.required =
      optional.instruments[0]!.required.filter(
        (field) => field !== "authorizedAmount",
      );
    expect(issues(optional)).toContainEqual(
      expect.objectContaining({
        message: "decided amount bound authorizedAmount must be required",
        path: "$.instruments[0].actions.decide.decidedAmount.boundField",
      }),
    );

    const mutable = decidedAmountDocument();
    mutable.instruments[0]!.update = {
      fields: ["authorizedAmount"],
      states: ["held"],
    };
    expect(issues(mutable)).toContainEqual({
      code: "UDL5008",
      message: "decided amount bound authorizedAmount cannot be mutable",
      path: "$.instruments[0].actions.decide.decidedAmount.boundField",
    });
  });

  test("rejects a missing or duplicate current-action remainder", () => {
    const missing = decidedAmountDocument();
    missing.instruments[0]!.actions.decide!.moves =
      missing.instruments[0]!.actions.decide!.moves.filter(
        (move) => move.key !== "remainder",
      );
    expect(issues(missing)).toContainEqual({
      code: "UDL5008",
      message:
        "decided amount action must declare exactly one remainder move; found 0",
      path: "$.instruments[0].actions.decide.moves",
    });

    const duplicate = decidedAmountDocument();
    duplicate.instruments[0]!.actions.decide!.moves.push(
      structuredClone(
        duplicate.instruments[0]!.actions.decide!.moves.find(
          (move) => move.key === "remainder",
        )!,
      ),
    );
    expect(issues(duplicate)).toContainEqual({
      code: "UDL5008",
      message:
        "decided amount action must declare exactly one remainder move; found 2",
      path: "$.instruments[0].actions.decide.moves",
    });
  });

  test("rejects an absent remainder action and mismatched source states", () => {
    const absent = decidedAmountDocument();
    absent.instruments[0]!.actions.decide!.decidedAmount!.remainderAction =
      "missing_action";
    expect(issues(absent)).toContainEqual({
      code: "UDL4001",
      message: "decided amount remainder action missing_action is not declared",
      path: "$.instruments[0].actions.decide.decidedAmount.remainderAction",
    });

    const wrongSource = decidedAmountDocument();
    wrongSource.instruments[0]!.lifecycle.transitions.cancel!.from = [
      "settled",
    ];
    expect(issues(wrongSource)).toContainEqual({
      code: "UDL4001",
      message:
        "decided amount remainder action cancel must start from the same lifecycle states as decide",
      path: "$.instruments[0].actions.decide.decidedAmount.remainderAction",
    });
  });

  test("rejects cancellation that strands or duplicates the remainder", () => {
    const stranded = decidedAmountDocument();
    stranded.instruments[0]!.actions.cancel!.moves = [];
    expect(issues(stranded)).toContainEqual({
      code: "UDL4001",
      message:
        "decided amount remainder action cancel must declare exactly one reservation drain; found 0",
      path: "$.instruments[0].actions.cancel.moves",
    });

    const duplicate = decidedAmountDocument();
    const cancel = duplicate.instruments[0]!.actions.cancel!;
    cancel.moves.push({
      ...structuredClone(cancel.moves[0]!),
      key: "cancel_again",
    });
    expect(issues(duplicate)).toContainEqual({
      code: "UDL4001",
      message:
        "decided amount remainder action cancel must declare exactly one reservation drain; found 2",
      path: "$.instruments[0].actions.cancel.moves",
    });
  });

  test("rejects a remainder drain for a different reservation", () => {
    const document = decidedAmountDocument();
    document.instruments[0]!.actions.cancel!.moves[0]!.bind.transferId = {
      from: "instance",
      path: "refs.otherReservationId",
    };

    expect(issues(document)).toContainEqual({
      code: "UDL4001",
      message:
        "decided amount and remainder action cancel must drain the same reservation",
      path: "$.instruments[0].actions.decide.decidedAmount.remainderAction",
    });
  });
});
