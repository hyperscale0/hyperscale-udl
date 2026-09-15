import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { assertValidUdl } from "../src/index.js";

const document = assertValidUdl(
  JSON.parse(
    readFileSync(
      new URL("../conformance/valid/vocabulary.udl", import.meta.url),
      "utf8",
    ),
  ),
);
test("funding requires captured custody, a collected ticket state and immutable principal terms", () => {
  for (const change of [
    (value: typeof document) => {
      value.instruments.find(
        (item) => item.id === "round",
      )!.actions.close!.funding!.sourceAccountPath = "fields.fundingAccount";
    },
    (value: typeof document) => {
      value.instruments.find(
        (item) => item.id === "round",
      )!.actions.close!.funding!.terms = {};
    },
    (value: typeof document) => {
      value.instruments.find(
        (item) => item.id === "ticket",
      )!.actions.collect!.due = { field: "currency" };
    },
  ]) {
    const mutant = structuredClone(document);
    change(mutant);
    expect(() => assertValidUdl(mutant)).toThrow();
  }
});

test("grouped exposure reads an investor identity and the anchor's minimum", () => {
  for (const field of ["groupField", "minimumField"] as const) {
    const mutant = structuredClone(document);
    mutant.instruments.find(
      (item) => item.id === "ticket",
    )!.actions.create!.requiresExposure![0]![field] = "currency";
    expect(() => assertValidUdl(mutant)).toThrow();
  }
});

test("cash distribution cannot consume a missing snapshot or a loss receipt", () => {
  for (const change of [
    (value: typeof document) => {
      value.instruments.find(
        (item) => item.id === "distribution",
      )!.actions.create!.receiptDistribution!.snapshotRef = "missing";
    },
    (value: typeof document) => {
      value.instruments.find(
        (item) => item.id === "distribution",
      )!.actions.create!.receiptDistribution!.mode = "loss";
    },
  ]) {
    const mutant = structuredClone(document);
    change(mutant);
    expect(() => assertValidUdl(mutant)).toThrow();
  }
});
