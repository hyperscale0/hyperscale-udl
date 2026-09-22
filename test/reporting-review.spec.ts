import { expect, test } from "bun:test";
import { validateUdl, type ReportDefinition } from "../src/index.js";
import { reviewDocument } from "./review-fixture.js";

function report(field: string): ReportDefinition {
  return {
    identity: { id: "records", version: 1, description: "Records" },
    scope: { kind: "product", classification: "internal", currency: "SAR" },
    datasets: [
      {
        id: "records",
        source: "instrument",
        instruments: ["record"],
        rowKey: "id",
        columns: [
          { name: "id", field: "id", type: { kind: "text" }, required: true },
          { name: "label", field, type: { kind: "text" }, required: true },
        ],
        expressions: [],
      },
    ],
    time: {
      timezone: "Asia/Riyadh",
      boundary: "startInclusiveEndExclusive",
      observation: "periodEnd",
      history: "retainedOnly",
    },
    selection: { dataset: "records" },
    calculation: {
      joins: [],
      expressions: [],
      groupBy: [],
      aggregates: [],
      resultExpressions: [],
    },
    validation: {
      empty: "refuse",
      required: [],
      rowReconcile: [],
      reconcile: [],
      unavailableFacts: [],
      lockTimeoutMs: 1,
      captureTimeoutMs: 1,
      maxRows: 1,
      maxJoinRows: 1,
      maxBytes: 1024,
    },
    output: {
      profile: "internal.v1",
      formats: ["json"],
      columns: [{ name: "label", label: "Label", type: { kind: "text" } }],
      sort: ["label"],
    },
    authority: {
      request: ["staff"],
      read: ["staff"],
      release: [],
      retention: { policy: "records", years: 1 },
    },
  };
}

// Mutation: fall back to the root field type for multi-part report paths.
test("report columns reject suffixes that the source reader cannot resolve", () => {
  const document = reviewDocument();
  const instrument = document.instruments[0]!;
  instrument.fields = [{ name: "label", type: "text" }];
  instrument.reports = [report("label")];
  expect(validateUdl(document).ok).toBe(true);
  instrument.reports = [report("label.missing")];
  const invalid = validateUdl(document);
  expect(invalid.ok).toBe(false);
  if (!invalid.ok)
    expect(invalid.issues[0]?.path).toBe("$.instruments[0].reports[0]");
});

// Mutation: report duplicate report identities as UDL2002 at the whole report array.
test("duplicate report identities identify the second declaration", () => {
  const document = reviewDocument();
  const instrument = document.instruments[0]!;
  instrument.fields = [{ name: "label", type: "text" }];
  instrument.reports = [report("label"), report("label")];
  const result = validateUdl(document);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "UDL2001",
        path: "$.instruments[0].reports[1]",
      }),
    );
});

// Mutation: resolve sealed report fields through an inherited object lookup.
test("prototype names remain usable as declared report fields", () => {
  const document = reviewDocument();
  const instrument = document.instruments[0]!;
  instrument.fields = [{ name: "constructor", type: "text" }];
  instrument.reports = [report("constructor")];
  expect(validateUdl(document).ok).toBe(true);
});
