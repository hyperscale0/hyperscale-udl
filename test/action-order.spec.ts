import { describe, expect, test } from "bun:test";

import {
  diffInstrumentEvolution,
  parseUdl,
  serializeUdl,
  snapshotUdlInstrument,
  validateUdl,
  type UdlDocument,
} from "../src/index.js";

function orderedDocument(): UdlDocument {
  return {
    instruments: [
      {
        actionOrder: ["create", "zebra", "alpha"],
        actions: {
          alpha: { moves: [], steps: [], summary: "Finish second" },
          create: { moves: [], steps: [], summary: "Create" },
          zebra: { moves: [], steps: [], summary: "Finish first" },
        },
        fields: {},
        id: "ordered_actions",
        idPrefix: "ord",
        lifecycle: {
          initial: "open",
          states: ["open", "first", "finished"],
          transitions: {
            alpha: { from: ["first"], to: "finished" },
            zebra: { from: ["open"], to: "first" },
          },
        },
        required: [],
        summary: "Action order fixture",
        title: "Ordered actions",
      },
    ],
    product: "action_order_test",
    subjects: [],
    title: "Action order test",
    udl: 1,
    version: 1,
  };
}

describe("UDL action order", () => {
  test("preserves the declared order across canonical serialization", () => {
    const parsed = parseUdl(serializeUdl(orderedDocument()));

    expect(parsed.instruments[0]?.actionOrder).toEqual([
      "create",
      "zebra",
      "alpha",
    ]);
    expect(Object.keys(parsed.instruments[0]?.actions ?? {})).toEqual([
      "alpha",
      "create",
      "zebra",
    ]);
  });

  test("requires exact action membership without duplicates", () => {
    const document = orderedDocument();
    document.instruments[0]!.actionOrder = ["create", "zebra", "zebra", "gone"];

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "duplicate action id zebra; first declared at index 1",
          path: "$.instruments[0].actionOrder[2]",
        }),
        expect.objectContaining({
          message: "action order references unknown action gone",
          path: "$.instruments[0].actionOrder[3]",
        }),
        expect.objectContaining({
          message: "action alpha is missing from actionOrder",
          path: "$.instruments[0].actions.alpha",
        }),
      ]),
    );
  });

  test("freezes action order after publication", () => {
    const previous = snapshotUdlInstrument(orderedDocument().instruments[0]!);
    const next = {
      ...previous,
      actionOrder: ["create", "alpha", "zebra"],
    };

    expect(
      diffInstrumentEvolution(previous, next).map((entry) => entry.message),
    ).toContain(
      "ordered_actions: instrument action order changed after becoming live",
    );
  });

  test("allows new actions without reordering published actions", () => {
    const previous = snapshotUdlInstrument(orderedDocument().instruments[0]!);
    const next = {
      ...previous,
      actionOrder: [...previous.actionOrder!, "close"],
      actions: {
        ...previous.actions,
        close: previous.actions.create!,
      },
    };

    expect(diffInstrumentEvolution(previous, next)).toEqual([]);
  });
});
