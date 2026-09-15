import type { UdlAction } from "./schema.js";

/** Arithmetic only. The host resolves and consumes the receipt and snapshot under locks. */
export function distributeReceiptAmounts(
  clause: NonNullable<UdlAction["receiptDistribution"]>,
  principal: bigint,
  profit: bigint,
  tickets: readonly { readonly id: string; readonly weight: bigint }[],
) {
  if (principal < 0n || profit < 0n || tickets.length === 0)
    throw new Error(
      "distribution requires nonnegative receipt amounts and tickets",
    );
  if (
    new Set(tickets.map((ticket) => ticket.id)).size !== tickets.length ||
    tickets.some((ticket) => ticket.weight <= 0n)
  )
    throw new Error(
      "snapshot tickets must have unique identities and positive weights",
    );
  const loss = clause.mode === "loss";
  if (loss && (profit !== 0n || clause.feeBps !== 0 || clause.vatBps !== 0))
    throw new Error("loss allocation contains only principal and no fees");
  const totalWeight = tickets.reduce((sum, ticket) => sum + ticket.weight, 0n);
  const fee = (profit * BigInt(clause.feeBps)) / 10000n;
  const vat = (fee * BigInt(clause.vatBps)) / 10000n;
  const amount = principal + profit - fee - vat;
  if (amount < 0n) throw new Error("fee and VAT exceed the receipt");
  const shares = tickets.map((ticket) => ({
    id: ticket.id,
    amount: (amount * ticket.weight) / totalWeight,
  }));
  let residual = amount - shares.reduce((sum, share) => sum + share.amount, 0n);
  if (loss) {
    // A loss cannot be paid to a residual cash beneficiary. Largest remainder
    // assigns every lost minor unit to an investor, with identity breaking ties.
    const ordered = tickets
      .map((ticket, index) => ({
        index,
        id: ticket.id,
        remainder: (amount * ticket.weight) % totalWeight,
      }))
      .sort((a, b) =>
        a.remainder === b.remainder
          ? a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0
          : a.remainder > b.remainder
            ? -1
            : 1,
      );
    for (const ticket of ordered) {
      if (residual === 0n) break;
      shares[ticket.index]!.amount += 1n;
      residual -= 1n;
    }
  }
  return { fee, vat, residual, shares };
}
