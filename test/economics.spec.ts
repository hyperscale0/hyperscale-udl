import { expect, test } from "bun:test";
import { validateUdl } from "../src/index.js";
import { reviewDocument } from "./review-fixture.js";

function document() {
  const result = reviewDocument();
  result.parties = { payer: { kind: "business" }, payee: { kind: "business" } };
  result.instruments[0]!.actions.create!.moves = [
    {
      key: "payment",
      operation: "internal_transfer.create",
      amount: { literal: "100" },
      from: "party.payer",
      to: "party.payee",
      economics: { purpose: "earning", sourceParty: "payer" },
    },
  ];
  return result;
}

// Mutation: skip party validation for economics in decoded UDL.
test("economic sources must resolve even when the move endpoints resolve", () => {
  const value = document();
  expect(validateUdl(value).ok).toBe(true);
  value.instruments[0]!.actions.create!.moves[0]!.economics!.sourceParty =
    "nobody";
  const refused = validateUdl(value);
  expect(refused.ok).toBe(false);
  if (!refused.ok)
    expect(refused.issues).toContainEqual(
      expect.objectContaining({
        code: "economic_party_unbound",
        fix: "Bind sourceParty to a money party retained by this attachment.",
      }),
    );
});

// Mutation: classify a claim-book move as earned cash.
test("cash purposes refuse non-cash moves while internal accounting remains valid", () => {
  const value = document();
  const instrument = value.instruments[0]!;
  instrument.fields = [
    {
      name: "debt",
      type: "account",
      owner: "payer",
      book: "claim",
      key: "debt",
    },
    {
      name: "claim",
      type: "account",
      owner: "payee",
      book: "claim",
      key: "claim",
    },
  ];
  const move = instrument.actions.create!.moves[0]!;
  if (!("from" in move)) throw new Error("Fixture requires a transfer");
  move.from = "self.debt";
  move.to = "self.claim";
  const refused = validateUdl(value);
  expect(refused.ok).toBe(false);
  if (!refused.ok)
    expect(refused.issues).toContainEqual(
      expect.objectContaining({ code: "economic_move_invalid" }),
    );
  move.economics!.purpose = "internal";
  expect(validateUdl(value).ok).toBe(true);
});

// Mutation: let a posting replace the purpose retained by its reservation.
test("posting economics cannot conflict with its reservation", () => {
  const value = document();
  const instrument = value.instruments[0]!;
  instrument.fields = [{ name: "receipt", type: "text", optional: true }];
  instrument.actions.create!.moves = [
    {
      key: "reserve",
      operation: "internal_transfer.reserve",
      capture: "receipt",
      amount: { literal: "100" },
      from: "party.payer",
      to: "party.payee",
      economics: { purpose: "principal", sourceParty: "payer" },
    },
    {
      key: "post",
      operation: "internal_transfer.post",
      transfer: "self.receipt",
      economics: { purpose: "earning", sourceParty: "payer" },
    },
  ];
  const refused = validateUdl(value);
  expect(refused.ok).toBe(false);
  if (!refused.ok)
    expect(refused.issues).toContainEqual(
      expect.objectContaining({
        code: "economic_reservation_conflict",
        fix: "Keep the reservation's economics on its posting.",
      }),
    );
});
