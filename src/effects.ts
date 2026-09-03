export const udlEffectKinds = [
  "decides",
  "holds",
  "moves",
  "notifies",
  "reads",
  "schedules",
] as const;

export type UdlEffectKind = (typeof udlEffectKinds)[number];

type EffectDescriptor = {
  readonly kind: UdlEffectKind;
  readonly per: "clause" | "element";
  readonly signature:
    | { readonly fixed: string }
    | { readonly fromField: string }
    | { readonly movementClass: true };
};

type ActionClauseDescriptor = {
  readonly effects?: readonly EffectDescriptor[];
  readonly scope: "action" | "instrument";
  readonly target: string;
};

type EffectRow = {
  readonly channel?: string;
  readonly role?: string;
  readonly signature: string;
  readonly source: string;
};

export type DerivedUdlEffects = Partial<
  Readonly<Record<UdlEffectKind, readonly EffectRow[]>>
>;

export type UdlMovementClass =
  | "collection.pay_in"
  | "deposit.attributed"
  | "payout.external"
  | "transfer.internal";

interface Movement {
  readonly bind?: Readonly<Record<string, unknown>>;
  readonly operation: string;
}

function boundPath(move: Movement, endpoint: string): string | undefined {
  const binding = move.bind?.[endpoint];
  if (binding === null || typeof binding !== "object") return undefined;
  const path = (binding as { readonly path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

/**
 * Maps a UDL money operation to the meter and pricing class that owns it.
 * Internal-transfer endpoint bindings are product accounts by construction.
 * External collection, deposit, and payout operations carry their role in the
 * operation family because their remote endpoint is not a UDL account binding.
 */
export function movementClass(move: Movement): UdlMovementClass {
  if (move.operation.startsWith("internal_transfer.")) {
    const source = boundPath(move, "sourceAccountId");
    const destination = boundPath(move, "destinationAccountId");
    if (
      source?.startsWith("fields.") &&
      destination === "refs.escrowAccountId"
    ) {
      return "collection.pay_in";
    }
    return "transfer.internal";
  }
  if (move.operation.startsWith("collection.pay_in.")) {
    return "collection.pay_in";
  }
  if (move.operation.startsWith("deposit.")) {
    return "deposit.attributed";
  }
  if (move.operation.startsWith("payout.")) {
    return "payout.external";
  }
  throw new Error(`cannot classify UDL movement operation ${move.operation}`);
}

/** Derive the ABI effect rows declared by the action-clause vocabulary. */
export function deriveUdlActionEffects(
  action: Readonly<Record<string, unknown>>,
  vocabulary: readonly ActionClauseDescriptor[],
): DerivedUdlEffects {
  const effects: Partial<Record<UdlEffectKind, EffectRow[]>> = {};
  for (const clause of vocabulary) {
    if (clause.scope !== "action" || !clause.effects) continue;
    const value = actionClauseValue(action, clause.target);
    if (value === undefined) continue;
    for (const descriptor of clause.effects) {
      const values =
        descriptor.per === "element" && Array.isArray(value) ? value : [value];
      for (const [index, candidate] of values.entries()) {
        const object = recordValue(candidate);
        if (
          descriptor.kind === "holds" &&
          "fixed" in descriptor.signature &&
          descriptor.signature.fixed === "reserve" &&
          object?.operation !== "internal_transfer.reserve"
        ) {
          continue;
        }
        const suffix = effectSignatureSuffix(descriptor, object);
        if (!suffix) continue;
        (effects[descriptor.kind] ??= []).push({
          signature: `${descriptor.kind}.${suffix}`,
          source:
            descriptor.per === "element"
              ? `${clause.target}[${index}]`
              : clause.target,
          ...(descriptor.kind === "notifies" &&
          typeof object?.channel === "string" &&
          typeof object.role === "string"
            ? { channel: object.channel, role: object.role }
            : {}),
        });
      }
    }
  }
  return effects;
}

function actionClauseValue(
  action: Readonly<Record<string, unknown>>,
  target: string,
): unknown {
  const [head, tail] = target.split(".");
  if (!head) return undefined;
  const value = action[head];
  if (!tail) return value;
  return recordValue(value)?.[tail];
}

function effectSignatureSuffix(
  descriptor: EffectDescriptor,
  value: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if ("fixed" in descriptor.signature) return descriptor.signature.fixed;
  if ("fromField" in descriptor.signature) {
    const field = value?.[descriptor.signature.fromField];
    return typeof field === "string" ? field : undefined;
  }
  if (!value || !("movementClass" in descriptor.signature)) return undefined;
  const operation = value.operation;
  const bind = recordValue(value.bind);
  return typeof operation === "string"
    ? movementClass({ ...(bind ? { bind } : {}), operation })
    : undefined;
}

function recordValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
