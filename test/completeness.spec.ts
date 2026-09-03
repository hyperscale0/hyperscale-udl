import { describe, expect, test } from "bun:test";
import {
  diffInstrumentEvolution,
  snapshotUdlInstrument,
  validateUdl,
  type UdlDocument,
} from "../src/index.js";

const money = { pattern: "^[1-9][0-9]{0,17}$", type: "string" } as const;
const account = {
  pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
  type: "string",
} as const;

function completeDocument(): UdlDocument {
  return {
    instruments: [
      {
        actionOrder: ["create", "revise", "settle"],
        actions: {
          create: { moves: [], steps: [], summary: "Open the agreement" },
          revise: {
            examples: [
              {
                input: {
                  agreementId: "agr_sandbox_agreement01",
                  note: "Updated terms",
                  tenantId: "ten_sandbox_example001",
                },
                name: "revise_terms",
              },
            ],
            input: {
              additionalProperties: false,
              properties: { note: { type: "string" } },
              required: ["note"],
              type: "object",
            },
            moves: [],
            principal: "user_session",
            steps: [],
            summary: "Revise the note",
            updates: ["note"],
          },
          settle: {
            deadline: { field: "closesAt" },
            moves: [
              {
                bind: {
                  amount: {
                    from: "instance",
                    path: "refs.remainingAmount",
                  },
                  currency: { from: "instance", path: "fields.currency" },
                  destinationAccountId: {
                    from: "instance",
                    path: "fields.destinationAccountId",
                  },
                  sourceAccountId: {
                    from: "instance",
                    path: "fields.sourceAccountId",
                  },
                },
                key: "settlement",
                operation: "internal_transfer.create",
              },
            ],
            remainder: {
              amountRef: "remainingAmount",
              onZero: "refuse",
              totalPath: "fields.amount",
            },
            requiresChecks: [
              {
                checkKind: "identity_verification",
                family: "national_identity",
                maxAge: "P30D",
                statuses: ["completed"],
                subjectField: "subjectId",
              },
            ],
            sandboxFailurePoint: "release",
            steps: [],
            summary: "Settle the agreement",
          },
        },
        callerParkedStates: {
          open: "The owner may revise or settle the agreement.",
        },
        dials: [
          {
            field: "closesAt",
            key: "settlement_window",
            kind: "window",
            maxOffset: "P30D",
            minOffset: "PT0S",
            summary: "The settlement deadline offset.",
            title: "Settlement window",
          },
        ],
        fields: {
          amount: money,
          closesAt: { format: "hyperscale-date-time", type: "string" },
          currency: { pattern: "^[A-Z]{3}$", type: "string" },
          destinationAccountId: account,
          note: { type: "string" },
          sourceAccountId: account,
          subjectId: { type: "string" },
        },
        id: "agreement",
        idPrefix: "agr",
        lifecycle: {
          initial: "open",
          states: ["open", "closed"],
          transitions: {
            revise: { from: ["open"], to: "open" },
            settle: { from: ["open"], to: "closed" },
          },
        },
        nav: ["Agreements"],
        required: [
          "amount",
          "closesAt",
          "currency",
          "destinationAccountId",
          "sourceAccountId",
          "subjectId",
        ],
        subject: { extensible: false, kinds: ["asset"] },
        summary: "One agreement with a computed final settlement.",
        surfaceVisibility: "public",
        templateId: "agreement",
        title: "Agreement",
        update: {
          examples: [
            {
              input: {
                agreementId: "agr_sandbox_agreement01",
                note: "Updated terms",
                tenantId: "ten_sandbox_example001",
              },
              name: "revise_terms",
            },
          ],
          fields: ["note"],
          states: ["open"],
        },
      },
    ],
    product: "complete_contract",
    subjects: [
      {
        declaredValue: "none",
        kind: "asset",
        schema: { additionalProperties: false, properties: {}, type: "object" },
        title: "Asset",
        version: 1,
      },
    ],
    title: "Complete contract",
    udl: 1,
    version: 1,
  };
}

function messages(document: UdlDocument): readonly string[] {
  const result = validateUdl(document);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
}

describe("UDL completeness clauses", () => {
  test("admits one document carrying every lifted clause family", () => {
    expect(validateUdl(completeDocument())).toEqual({
      ok: true,
      value: completeDocument(),
    });
  });

  test("refuses invalid remainder, check, update, dial, and parked-state clauses", () => {
    const remainder = completeDocument();
    remainder.instruments[0]!.actions.settle!.remainder!.inputKey = "partial";
    expect(messages(remainder)).toContain(
      "remainder inputKey partial is not declared by action input",
    );

    const check = completeDocument();
    check.instruments[0]!.actions.settle!.requiresChecks![0]!.maxAge = "P1M";
    expect(messages(check)).toContain(
      "check maxAge must be a fixed ISO-8601 duration",
    );

    const update = completeDocument();
    update.instruments[0]!.actions.revise!.updates = ["missing"];
    expect(messages(update)).toContain(
      "updated field missing is not declared by action input",
    );

    const dial = completeDocument();
    const windowDial = dial.instruments[0]!.dials![0];
    if (windowDial?.kind !== "window") throw new Error("window dial missing");
    windowDial.field = "missing";
    expect(messages(dial)).toContain(
      "window dial field missing anchors no action deadline or due condition",
    );

    const parked = completeDocument();
    parked.instruments[0]!.callerParkedStates = { missing: "Unknown state" };
    expect(messages(parked)).toContain(
      "callerParkedStates references unknown state missing",
    );
  });

  test("freezes parked state keys but not presentation text", () => {
    const previous = snapshotUdlInstrument(completeDocument().instruments[0]!);
    const reasonEdit = completeDocument().instruments[0]!;
    reasonEdit.callerParkedStates!.open = "A clearer operator reason.";
    reasonEdit.nav = ["Contracts", "Agreements"];
    reasonEdit.update!.examples = [];
    expect(
      diffInstrumentEvolution(previous, snapshotUdlInstrument(reasonEdit)),
    ).toEqual([]);

    const removed = completeDocument().instruments[0]!;
    removed.callerParkedStates = {};
    expect(
      diffInstrumentEvolution(previous, snapshotUdlInstrument(removed)).map(
        (entry) => entry.message,
      ),
    ).toContain("agreement: caller-parked state annotations changed");
  });

  test("treats absent completeness fields in stored snapshots as empty defaults", () => {
    const instrument = completeDocument().instruments[0]!;
    delete instrument.callerParkedStates;
    delete instrument.dials;
    delete instrument.nav;
    delete instrument.surfaceVisibility;
    delete instrument.templateId;
    delete instrument.subject!.extensible;
    delete instrument.update!.examples;
    const current = snapshotUdlInstrument(instrument);
    const storedBeforeLift = structuredClone(current);
    delete (
      storedBeforeLift as {
        callerParkedStates?: Readonly<Record<string, string>>;
      }
    ).callerParkedStates;
    delete (storedBeforeLift as { dials?: unknown }).dials;
    delete (storedBeforeLift as { nav?: readonly string[] }).nav;
    delete (storedBeforeLift as { subjectExtensible?: boolean })
      .subjectExtensible;
    delete (storedBeforeLift as { surfaceVisibility?: string | null })
      .surfaceVisibility;
    delete (storedBeforeLift as { templateId?: string | null }).templateId;
    delete (storedBeforeLift as { updateExamples?: unknown }).updateExamples;

    expect(diffInstrumentEvolution(storedBeforeLift, current)).toEqual([]);
  });

  test("treats absent completeness action fields as empty defaults", () => {
    const instrument = completeDocument().instruments[0]!;
    delete instrument.actions.revise!.principal;
    delete instrument.actions.revise!.updates;
    delete instrument.actions.settle!.remainder;
    delete instrument.actions.settle!.requiresChecks;
    delete instrument.actions.settle!.sandboxFailurePoint;
    const current = snapshotUdlInstrument(instrument);
    const storedBeforeLift = structuredClone(current);
    for (const action of Object.values(storedBeforeLift.actions)) {
      delete (action as { principal?: string | null }).principal;
      delete (action as { remainder?: unknown }).remainder;
      delete (action as { requiresChecks?: unknown }).requiresChecks;
      delete (action as { sandboxFailurePoint?: string | null })
        .sandboxFailurePoint;
      delete (action as { updates?: readonly string[] }).updates;
    }

    expect(diffInstrumentEvolution(storedBeforeLift, current)).toEqual([]);
  });
});
