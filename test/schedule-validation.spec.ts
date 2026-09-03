import { describe, expect, test } from "bun:test";

import { validateUdl, type UdlDocument } from "../src/index.js";

const dateTimeField = {
  format: "hyperscale-date-time",
  type: "string",
} as const;

const accountField = {
  pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
  type: "string",
} as const;

const moneyField = {
  pattern: "^[1-9][0-9]{0,17}$",
  type: "string",
} as const;

const currencyField = {
  pattern: "^[A-Z]{3}$",
  type: "string",
} as const;

function scheduleDocument(): UdlDocument {
  return {
    instruments: [
      {
        actionOrder: ["cancel", "collect_period", "create", "open_period"],
        actions: {
          cancel: {
            moves: [],
            port: { allowedParties: ["payer"] },
            requiresDrainedAccount: { path: "fields.payerAccountId" },
            steps: [],
            summary: "Cancel the collection and prove its account drained",
          },
          collect_period: {
            moves: [],
            steps: [],
            summary: "Collect through an authored period action",
          },
          create: {
            moves: [],
            steps: [],
            summary: "Create the recurring collection",
          },
          open_period: {
            due: {
              every: {
                delinquency: "parent_policy",
                drainAction: "cancel",
                liability: "one_open",
                period: {
                  calendar: "gregorian",
                  monthEnd: "clamp_to_last_day",
                  months: 1,
                },
                untilAction: "cancel",
              },
              field: "firstDueAt",
            },
            moves: [],
            steps: [],
            summary: "Open one collection period",
          },
        },
        fields: {
          firstDueAt: dateTimeField,
          payerAccountId: accountField,
          terminationAt: dateTimeField,
        },
        id: "recurring_charge",
        idPrefix: "rch",
        lifecycle: {
          initial: "active",
          states: ["active", "period_open", "cancelled"],
          transitions: {
            cancel: {
              from: ["active", "period_open"],
              to: "cancelled",
            },
            collect_period: {
              from: ["period_open"],
              to: "active",
            },
            open_period: { from: ["active"], to: "period_open" },
          },
        },
        parties: { payer: "payerAccountId" },
        required: ["firstDueAt", "payerAccountId", "terminationAt"],
        summary: "One open recurring collection period",
        title: "Recurring charge",
      },
    ],
    product: "schedule_test",
    subjects: [],
    title: "Schedule test",
    udl: 1,
    version: 1,
  };
}

function messages(value: unknown): readonly string[] {
  const result = validateUdl(value);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
}

describe("UDL open-ended schedule validation", () => {
  test("accepts a monthly series with an explicit anchor rule and port termination", () => {
    expect(validateUdl(scheduleDocument()).ok).toBe(true);
  });

  test("refuses missing and ambiguous termination", () => {
    const missing = scheduleDocument();
    delete missing.instruments[0]!.actions.open_period!.due!.every!.untilAction;
    expect(messages(missing)).toContain(
      "recurrence must declare a termination using countField, untilField, or untilAction",
    );

    const ambiguous = scheduleDocument();
    ambiguous.instruments[0]!.actions.open_period!.due!.every!.untilField =
      "terminationAt";
    expect(messages(ambiguous)).toContain(
      "recurrence termination is ambiguous: untilField, untilAction",
    );
  });

  test("refuses a calendar-month series without its month-end rule", () => {
    const document = scheduleDocument() as unknown as {
      instruments: Array<{
        actions: Record<
          string,
          { due?: { every?: { period: Record<string, unknown> } } }
        >;
      }>;
    };
    delete document.instruments[0]!.actions.open_period!.due!.every!.period
      .monthEnd;

    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "UDL1003",
        path: "$.instruments[0].actions.open_period.due.every.period",
      }),
    );
  });

  test("refuses overlapping recurring period liabilities", () => {
    const document = scheduleDocument();
    const instrument = document.instruments[0]!;
    instrument.actions.open_other = structuredClone(
      instrument.actions.open_period!,
    );
    instrument.lifecycle.states.push("other_open");
    instrument.lifecycle.transitions.open_other = {
      from: ["active"],
      to: "other_open",
    };

    expect(messages(document)).toContain(
      "recurring due actions open_period and open_other overlap period liability in states active",
    );
  });

  test("requires the recurring collection parent delinquency policy", () => {
    const document = scheduleDocument();
    delete document.instruments[0]!.actions.open_period!.due!.every!
      .delinquency;

    expect(messages(document)).toContain(
      "one-open recurrence must reuse delinquency parent_policy",
    );
  });

  test("refuses port and stored-date termination without a drain proof", () => {
    const port = scheduleDocument();
    delete port.instruments[0]!.actions.open_period!.due!.every!.drainAction;
    expect(messages(port)).toContain(
      "open-ended recurrence must declare its drain action",
    );

    const storedDate = scheduleDocument();
    const instrument = storedDate.instruments[0]!;
    const every = instrument.actions.open_period!.due!.every!;
    delete every.untilAction;
    every.untilField = "terminationAt";
    every.drainAction = "terminate";
    instrument.actions.terminate = {
      due: { field: "terminationAt" },
      moves: [],
      steps: [],
      summary: "Stop future anchors at the stored termination date",
    };
    instrument.actionOrder.push("terminate");
    instrument.lifecycle.transitions.terminate = {
      from: ["active", "period_open"],
      to: "cancelled",
    };

    expect(validateUdl(storedDate).ok).toBe(true);
    delete every.drainAction;
    expect(messages(storedDate)).toContain(
      "open-ended recurrence must declare its drain action",
    );
  });

  test("refuses a recurring timeout action that moves money", () => {
    const document = scheduleDocument();
    document.instruments[0]!.actions.open_period!.moves.push({
      bind: {
        transferId: { from: "instance", path: "refs.periodHoldId" },
      },
      key: "timeout_settlement",
      operation: "internal_transfer.void",
    });

    expect(messages(document)).toContain(
      "a recurring due action cannot move money; it may only open one period or invoke a declared system action",
    );
  });

  test("allows stored-date cancellation to void a hold but refuses timeout settlement", () => {
    const document = scheduleDocument();
    const instrument = document.instruments[0]!;
    const every = instrument.actions.open_period!.due!.every!;
    delete every.untilAction;
    every.untilField = "terminationAt";
    every.drainAction = "terminate";
    instrument.fields.amount = moneyField;
    instrument.fields.currency = currencyField;
    instrument.fields.reserveAccountId = accountField;
    instrument.required.push("amount", "currency", "reserveAccountId");
    instrument.actions.create!.moves.push({
      bind: {
        amount: { from: "instance", path: "fields.amount" },
        currency: { from: "instance", path: "fields.currency" },
        destinationAccountId: {
          from: "instance",
          path: "fields.reserveAccountId",
        },
        productId: { from: "instance", path: "productId" },
        sourceAccountId: {
          from: "instance",
          path: "fields.payerAccountId",
        },
      },
      capture: { reservationId: "transferId" },
      key: "hold",
      operation: "internal_transfer.reserve",
    });
    instrument.actions.terminate = {
      due: { field: "terminationAt" },
      moves: [
        {
          bind: {
            transferId: {
              from: "instance",
              path: "refs.reservationId",
            },
          },
          key: "cancel_hold",
          operation: "internal_transfer.void",
        },
      ],
      steps: [],
      summary: "Cancel the held period at the stored termination date",
    };
    instrument.actionOrder.push("terminate");
    instrument.lifecycle.transitions.terminate = {
      from: ["active", "period_open"],
      to: "cancelled",
    };

    expect(validateUdl(document).ok).toBe(true);

    const settlement = structuredClone(document);
    settlement.instruments[0]!.actions.terminate!.moves[0]!.operation =
      "internal_transfer.post";
    expect(messages(settlement)).toContain(
      "a stored-date recurrence termination may only void reserved money; no timeout creates, reserves, posts, or pays out money",
    );
  });
});
