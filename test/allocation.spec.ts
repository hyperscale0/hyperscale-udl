import { expect, test } from "bun:test";
import {
  planAllocationRefund,
  planAllocation,
  type AllocationInput,
  type AllocationSlice,
} from "../src/allocation.js";
const contract = {
  buckets: [
    { key: "principal" },
    { key: "profit" },
    { key: "cost" },
    { key: "fine" },
  ],
} as const;
function slice(position: number, paid = false): AllocationSlice {
  return {
    id: `slice${position}`,
    position,
    dueAt: `2026-0${position}-01T00:00:00Z`,
    paid,
    buckets: [
      {
        key: "principal",
        assessmentId: `principal${position}`,
        destinationAccountId: "lender",
        amount: 800000n,
        consumed: paid ? 800000n : 0n,
      },
      {
        key: "profit",
        assessmentId: `profit${position}`,
        destinationAccountId: "lender",
        amount: 40000n,
        consumed: paid ? 40000n : 0n,
      },
    ],
  };
}
function input(overrides: Partial<AllocationInput> = {}): AllocationInput {
  return {
    asOf: "2026-01-02T00:00:00Z",
    earningRule: "per_slice_on_due",
    mode: "payment",
    payment: 400000n,
    slices: [slice(1)],
    ...overrides,
  };
}

test("allocation consumes oldest slice then bucket priority, skipping zero buckets", () => {
  const first = planAllocation(
    contract,
    input({ slices: [slice(2), slice(1)] }),
  );
  expect(
    first.postings.map((row) => [row.sliceId, row.bucket, row.amount]),
  ).toEqual([["slice1", "principal", 400000n]]);
  const partial = {
    ...slice(1),
    buckets: slice(1).buckets.map((balance) => ({
      ...balance,
      consumed: balance.key === "principal" ? 400000n : 0n,
    })),
  };
  const later = planAllocation(
    contract,
    input({ payment: 440000n, slices: [partial] }),
  );
  expect(later.postings.map((row) => [row.bucket, row.amount])).toEqual([
    ["principal", 400000n],
    ["profit", 40000n],
  ]);
  const wrongPriority = {
    ...contract,
    buckets: [...contract.buckets].reverse(),
  };
  expect(
    planAllocation(wrongPriority, input()).postings.map((row) => [
      row.bucket,
      row.amount,
    ]),
  ).not.toEqual([["principal", 400000n]]);
  expect(() => planAllocation(contract, input({ payment: 840001n }))).toThrow(
    "payment does not match outstanding allocation",
  );
});

test("per-slice payoff cancels SAR 2000 unearned profit without a cash refund", () => {
  const slices = Array.from({ length: 6 }, (_, i) => slice(i + 1, i === 0));
  const payoff = planAllocation(
    contract,
    input({ mode: "payoff", payment: 4000000n, slices }),
  );
  expect(payoff.postings.reduce((sum, row) => sum + row.amount, 0n)).toBe(
    4000000n,
  );
  expect(payoff.cancellations.reduce((sum, row) => sum + row.amount, 0n)).toBe(
    200000n,
  );
  expect(
    payoff.cancellations.every(
      (row) => row.bucket === "profit" && row.reason === "unearned_profit",
    ),
  ).toBe(true);
  expect(() =>
    planAllocation(
      contract,
      input({
        mode: "payoff",
        payment: 4000000n,
        earningRule: "on_disbursement",
        slices,
      }),
    ),
  ).toThrow();
  const disbursed = planAllocation(
    contract,
    input({
      mode: "payoff",
      payment: 4200000n,
      earningRule: "on_disbursement",
      slices,
    }),
  );
  expect(disbursed.cancellations).toEqual([]);
  expect(disbursed.amount).toBe(4200000n);
});

test("write-off records principal loss separately from unearned profit and posts no cash", () => {
  const result = planAllocation(
    contract,
    input({ mode: "write_off", payment: undefined, slices: [slice(2)] }),
  );
  expect(result.postings).toEqual([]);
  expect(
    result.cancellations.map((row) => [row.bucket, row.amount, row.reason]),
  ).toEqual([
    ["principal", 800000n, "write_off"],
    ["profit", 40000n, "unearned_profit"],
  ]);
  expect(() => planAllocation(contract, input({ mode: "write_off" }))).toThrow(
    "invalid allocation payment",
  );
});

test("one assessment identity cannot contribute debt twice across aliases", () => {
  const repeated = { ...slice(2), buckets: [slice(1).buckets[0]!] };
  expect(() =>
    planAllocation(contract, input({ slices: [slice(1), repeated] })),
  ).toThrow("invalid or duplicate assessment balance");
  const overconsumed = {
    ...slice(1),
    buckets: [{ ...slice(1).buckets[0]!, consumed: 800001n }],
  };
  expect(() =>
    planAllocation(contract, input({ slices: [overconsumed] })),
  ).toThrow("invalid or duplicate assessment balance");
  const charged = {
    ...slice(1, true),
    buckets: [
      ...slice(1, true).buckets,
      {
        key: "cost" as const,
        assessmentId: "cost",
        destinationAccountId: "supplier",
        amount: 2500n,
        consumed: 0n,
      },
      {
        key: "fine" as const,
        assessmentId: "fine",
        destinationAccountId: "charity",
        amount: 5000n,
        consumed: 0n,
      },
    ],
  };
  expect(
    planAllocation(
      contract,
      input({ payment: 7500n, slices: [charged] }),
    ).postings.map((row) => [row.bucket, row.amount]),
  ).toEqual([
    ["cost", 2500n],
    ["fine", 5000n],
  ]);
});

test("a collected SAR 50 fine refunds its original payer only once", () => {
  const rows = [
    {
      sliceId: "slice1",
      assessmentId: "fine1",
      bucket: "fine" as const,
      destinationAccountId: "charity",
      amount: 5000n,
    },
  ];
  expect(planAllocationRefund(rows, "payer", [], "fine1")).toEqual([
    {
      assessmentId: "fine1",
      amount: 5000n,
      sourceAccountId: "charity",
      destinationAccountId: "payer",
    },
  ]);
  expect(() => planAllocationRefund(rows, "payer", ["fine1"], "fine1")).toThrow(
    "already refunded",
  );
  expect(() => planAllocationRefund(rows, "payer", [], "anotherFine")).toThrow(
    "no recorded allocation",
  );
});
