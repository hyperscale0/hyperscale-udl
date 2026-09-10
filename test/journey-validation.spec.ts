import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseUdl,
  validateUdl,
  type UdlDocument,
  type UdlJourney,
} from "../src/index.js";

const fixture = join(
  import.meta.dir,
  "..",
  "conformance",
  "valid",
  "protection.udl",
);

const validJourney: UdlJourney = {
  id: "policy_lifecycle",
  label: "Run the policy lifecycle",
  summary:
    "Create the prerequisites, quote the policy, bind it, and activate it.",
  steps: [
    {
      id: "holder",
      operation: "account.create",
      example: "customer_balance_account",
      bind: {},
    },
    {
      id: "insurer",
      operation: "account.create",
      example: "product_pool_account",
      bind: {},
    },
    {
      id: "subject",
      operation: "subject.create",
      example: "create_policy_risk_subject",
      bind: {},
    },
    {
      id: "policy",
      operation: "policy.create",
      example: "quote_asset_protection",
      bind: {
        insurerAccountId: "insurer",
        policyholderAccountId: "holder",
        subject: "subject",
      },
    },
    {
      operation: "policy.bind",
      example: "bind_carrier_accepted_risk",
      bind: { policyId: "policy" },
    },
    {
      operation: "policy.activate",
      example: "activate_cover_at_start",
      bind: { policyId: "policy" },
    },
  ],
};

async function documentWith(journey: UdlJourney): Promise<UdlDocument> {
  const document = parseUdl(await Bun.file(fixture).text());
  const policy = document.instruments[0];
  if (!policy) throw new Error("protection fixture has no policy instrument");
  return {
    ...document,
    instruments: [
      { ...policy, journeys: [journey] },
      ...document.instruments.slice(1),
    ],
  };
}

async function diagnosticCode(journey: UdlJourney): Promise<string[]> {
  const result = validateUdl(await documentWith(journey));
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("UDL authored journey validation", () => {
  test("accepts an ordered lifecycle with explicit prerequisite bindings", async () => {
    expect(validateUdl(await documentWith(validJourney)).ok).toBe(true);
  });

  test("rejects an unknown local operation", async () => {
    const steps = validJourney.steps.map((step, index) =>
      index === 4 ? { ...step, operation: "policy.missing" } : step,
    );
    expect(await diagnosticCode({ ...validJourney, steps })).toContain(
      "journey_unknown_operation",
    );
  });

  test("rejects an unknown authored example", async () => {
    const steps = validJourney.steps.map((step, index) =>
      index === 4 ? { ...step, example: "missing_example" } : step,
    );
    expect(await diagnosticCode({ ...validJourney, steps })).toContain(
      "journey_unknown_example",
    );
  });

  test("rejects a transition before its lifecycle predecessor", async () => {
    const steps = [...validJourney.steps];
    [steps[4], steps[5]] = [steps[5]!, steps[4]!];
    expect(await diagnosticCode({ ...validJourney, steps })).toContain(
      "journey_invalid_transition",
    );
  });

  test("rejects a missing reference binding", async () => {
    const steps = validJourney.steps.map((step, index) =>
      index === 4 ? { ...step, bind: {} } : step,
    );
    expect(await diagnosticCode({ ...validJourney, steps })).toContain(
      "journey_unbound_reference",
    );
  });

  test("rejects duplicate step ids", async () => {
    const steps = validJourney.steps.map((step, index) =>
      index === 1 ? { ...step, id: "holder" } : step,
    );
    expect(await diagnosticCode({ ...validJourney, steps })).toContain(
      "journey_duplicate_step_id",
    );
  });
});
