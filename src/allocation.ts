export type AllocationBucketKey = "principal" | "profit" | "cost" | "fine";
export interface AllocationBalance {
  readonly key: AllocationBucketKey;
  readonly assessmentId: string;
  readonly destinationAccountId: string;
  readonly amount: bigint;
  readonly consumed: bigint;
}
export interface AllocationSlice {
  readonly id: string;
  readonly dueAt: string;
  readonly position: number;
  readonly paid: boolean;
  readonly buckets: readonly AllocationBalance[];
}
export interface AllocationInput {
  readonly asOf: string;
  readonly earningRule: "per_slice_on_due" | "on_disbursement";
  readonly mode: "payment" | "payoff" | "write_off";
  readonly payment?: bigint | undefined;
  readonly assessmentId?: string;
  readonly slices: readonly AllocationSlice[];
}
export interface AllocationPosting {
  readonly sliceId: string;
  readonly assessmentId: string;
  readonly bucket: AllocationBucketKey;
  readonly destinationAccountId: string;
  readonly amount: bigint;
}
export interface AllocationCancellation {
  readonly sliceId: string;
  readonly assessmentId: string;
  readonly bucket: AllocationBucketKey;
  readonly amount: bigint;
  readonly reason: "unearned_profit" | "write_off";
}
function clock(value: string): number {
  if (!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?Z)?$/.test(value))
    throw new Error("allocation needs an authoritative UTC time");
  const result = Date.parse(value);
  if (
    !Number.isFinite(result) ||
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
      value.slice(0, 10)
  )
    throw new Error("invalid allocation time");
  return result;
}

/** Plan from locked balances. The engine owns identity claims and atomic posting. */
export function planAllocation(
  contract: {
    readonly buckets: readonly { readonly key: AllocationBucketKey }[];
  },
  input: AllocationInput,
) {
  const priority = contract.buckets.map((bucket) => bucket.key);
  const keys = new Set(priority);
  if (
    priority.length < 2 ||
    priority.length > 4 ||
    keys.size !== priority.length ||
    !keys.has("principal") ||
    !keys.has("profit") ||
    priority.some(
      (key) => !["principal", "profit", "cost", "fine"].includes(key),
    )
  )
    throw new Error("invalid allocation priority");
  if (
    !["per_slice_on_due", "on_disbursement"].includes(input.earningRule) ||
    !["payment", "payoff", "write_off"].includes(input.mode)
  )
    throw new Error("invalid earning rule or allocation mode");
  if (!input.slices.length || input.slices.length > 366)
    throw new Error("allocation requires 1 to 366 slices");
  if (
    input.assessmentId !== undefined &&
    (input.mode !== "payment" || !input.assessmentId)
  )
    throw new Error("assessment selection requires payment mode");
  const asOf = clock(input.asOf);
  if (
    input.mode === "write_off"
      ? input.payment !== undefined
      : input.payment === undefined
        ? input.mode !== "payoff" && input.assessmentId === undefined
        : typeof input.payment !== "bigint" ||
          input.payment < 0n ||
          (input.mode === "payment" && input.payment === 0n)
  )
    throw new Error("invalid allocation payment");
  const ids = new Set<string>();
  const positions = new Set<number>();
  const assessments = new Set<string>();
  const slices = input.slices
    .map((slice) => {
      const due = clock(slice.dueAt);
      if (
        !slice.id ||
        ids.has(slice.id) ||
        !Number.isInteger(slice.position) ||
        slice.position < 1 ||
        positions.has(slice.position) ||
        typeof slice.paid !== "boolean" ||
        slice.buckets.length > 256
      )
        throw new Error("invalid or duplicate slice");
      ids.add(slice.id);
      positions.add(slice.position);
      for (const balance of slice.buckets) {
        if (
          !keys.has(balance.key) ||
          !balance.assessmentId ||
          assessments.has(balance.assessmentId) ||
          !balance.destinationAccountId ||
          typeof balance.amount !== "bigint" ||
          typeof balance.consumed !== "bigint" ||
          balance.amount < 0n ||
          balance.consumed < 0n ||
          balance.consumed > balance.amount
        )
          throw new Error("invalid or duplicate assessment balance");
        assessments.add(balance.assessmentId);
      }
      return { slice, due };
    })
    .sort((a, b) => a.due - b.due || a.slice.position - b.slice.position);
  const candidates: AllocationPosting[] = [];
  const cancellations: AllocationCancellation[] = [];
  for (const { slice, due } of slices) {
    const earned =
      input.earningRule === "on_disbursement" || due <= asOf || slice.paid;
    for (const key of priority) {
      // Multiple assessed charges of one kind have a deterministic identity order.
      const balances = slice.buckets
        .filter((balance) => balance.key === key)
        .sort((a, b) =>
          a.assessmentId < b.assessmentId
            ? -1
            : a.assessmentId > b.assessmentId
              ? 1
              : 0,
        );
      for (const balance of balances) {
        const amount = balance.amount - balance.consumed;
        if (
          input.assessmentId !== undefined &&
          balance.assessmentId !== input.assessmentId
        )
          continue;
        if (amount === 0n) continue;
        const unearned = key === "profit" && !earned;
        if (
          input.mode === "write_off" ||
          (input.mode === "payoff" && unearned)
        ) {
          cancellations.push({
            sliceId: slice.id,
            assessmentId: balance.assessmentId,
            bucket: key,
            amount,
            reason: unearned ? "unearned_profit" : "write_off",
          });
        } else {
          candidates.push({
            sliceId: slice.id,
            assessmentId: balance.assessmentId,
            bucket: key,
            destinationAccountId: balance.destinationAccountId,
            amount,
          });
        }
      }
    }
  }
  const outstanding = candidates.reduce((sum, row) => sum + row.amount, 0n);
  if (input.mode === "write_off")
    return { postings: [] as AllocationPosting[], cancellations, amount: 0n };
  if (input.assessmentId !== undefined && !assessments.has(input.assessmentId))
    throw new Error("assessment is not in the allocation");
  const payment = input.payment ?? outstanding;
  if (input.mode === "payment" && payment === 0n)
    throw new Error("assessment already consumed");
  if (
    payment > outstanding ||
    (input.mode === "payoff" && payment !== outstanding)
  )
    throw new Error("payment does not match outstanding allocation");
  let remaining = payment;
  const postings: AllocationPosting[] = [];
  for (const candidate of candidates) {
    const amount = candidate.amount < remaining ? candidate.amount : remaining;
    if (amount > 0n) postings.push({ ...candidate, amount });
    remaining -= amount;
    if (remaining === 0n) break;
  }
  return { postings, cancellations, amount: payment };
}

/** Reverse recorded postings once, without reopening the consumed assessment. */
export function planAllocationRefund(
  postings: readonly AllocationPosting[],
  originalPayer: string,
  refundedAssessments: readonly string[],
  assessmentId?: string,
) {
  if (!originalPayer || postings.length > 366 * 256)
    throw new Error("invalid allocation receipt");
  const selected = postings.filter(
    (row) => assessmentId === undefined || row.assessmentId === assessmentId,
  );
  if (!selected.length)
    throw new Error("assessment has no recorded allocation");
  const seen = new Set<string>();
  return selected.map((row) => {
    if (
      row.amount <= 0n ||
      !row.destinationAccountId ||
      !row.assessmentId ||
      seen.has(row.assessmentId) ||
      refundedAssessments.includes(row.assessmentId)
    )
      throw new Error("assessment already refunded or invalid receipt");
    seen.add(row.assessmentId);
    return {
      assessmentId: row.assessmentId,
      amount: row.amount,
      sourceAccountId: row.destinationAccountId,
      destinationAccountId: originalPayer,
    };
  });
}

/** Evaluate a slice gate from the same locked consumption balances used to allocate. */
export function matchesAllocationConsumption(
  clause: {
    readonly buckets: readonly AllocationBucketKey[];
    readonly check: "settled" | "outstanding";
  },
  slice: AllocationSlice,
): boolean {
  if (
    !clause.buckets.length ||
    new Set(clause.buckets).size !== clause.buckets.length
  )
    throw new Error("allocation gate needs distinct buckets");
  const settled = clause.buckets
    .map((key) => {
      const rows = slice.buckets.filter((bucket) => bucket.key === key);
      for (const row of rows)
        if (row.consumed < 0n || row.consumed > row.amount || row.amount < 0n)
          throw new Error("invalid consumption");
      return rows.every((row) => row.consumed === row.amount);
    })
    .every(Boolean);
  return clause.check === "settled" ? settled : !settled;
}
