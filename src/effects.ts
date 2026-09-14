import { issue, type UdlIssue } from "./diagnostics.js";
import { UDL_LIMITS } from "./limits.js";
import {
  udlClauseVocabulary,
  udlEffectKinds,
  type UdlEffectKind,
  type UdlBinding,
  type UdlCall,
  type UdlInstrument,
  type UdlMove,
  type UdlPiece,
  type UdlPrivateAction,
  type UdlPrivateParameterKind,
  type UdlStep,
} from "./schema.js";

export { udlEffectKinds, type UdlEffectKind } from "./schema.js";

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

export interface ResolvedActionPlanLeaf {
  readonly effects: readonly {
    readonly kind: UdlEffectKind;
    readonly signature: string;
  }[];
  readonly evidence: string;
  readonly originPath: readonly string[];
  readonly step: UdlStep | UdlMove;
}

export interface ResolvedActionPlan {
  readonly action: string;
  readonly effects: DerivedUdlEffects;
  readonly leaves: readonly ResolvedActionPlanLeaf[];
  readonly pieceId?: string;
}

export interface ResolvedActionPlansResult {
  readonly issues: readonly UdlIssue[];
  readonly plans: readonly ResolvedActionPlan[];
}

export function deriveActionEffectsFromPlan(
  leaves: readonly ResolvedActionPlanLeaf[],
): DerivedUdlEffects {
  const effects: Partial<Record<UdlEffectKind, EffectRow[]>> = {};
  for (const leaf of leaves) {
    for (const eff of leaf.effects) {
      const kind = eff.kind;
      (effects[kind] ??= []).push({
        signature: eff.signature,
        source: leaf.originPath.join("."),
      });
    }
  }
  return effects;
}

function combineDerivedEffects(
  direct: DerivedUdlEffects,
  leaves: DerivedUdlEffects,
): DerivedUdlEffects {
  const result: Partial<Record<UdlEffectKind, EffectRow[]>> = {};
  for (const kind of udlEffectKinds) {
    const directRows = direct[kind] ?? [];
    const leafRows = leaves[kind] ?? [];
    if (directRows.length > 0 || leafRows.length > 0) {
      result[kind] = [...directRows, ...leafRows];
    }
  }
  return result;
}

function encodeOriginPathKey(originPath: readonly string[]): string {
  const parts = originPath.map((seg) => `${seg.length}_${seg}`);
  return `k_${parts.join("_")}`;
}

function expectedLeafEffects(
  step: UdlStep | UdlMove,
): readonly { readonly kind: UdlEffectKind; readonly signature: string }[] {
  if (step.operation === "internal_transfer.reserve") {
    const moveClass = movementClass(step);
    return [
      { kind: "moves", signature: `moves.${moveClass}` },
      { kind: "holds", signature: "holds.reserve" },
    ];
  }
  if (step.operation.startsWith("internal_transfer.")) {
    const moveClass = movementClass(step);
    return [{ kind: "moves", signature: `moves.${moveClass}` }];
  }
  if (step.operation === "account.escrow.provision") {
    return [{ kind: "holds", signature: "holds.escrow" }];
  }
  if (step.operation === "account.freeze") {
    return [{ kind: "holds", signature: "holds.freeze" }];
  }
  if (step.operation === "account.unfreeze") {
    return [{ kind: "holds", signature: "holds.unfreeze" }];
  }
  return [];
}

const accountPattern = "^acct_(sandbox|live)_[a-z0-9]{8,64}$";
const positiveMoneyPattern = "^[1-9][0-9]{0,17}$";
const nonNegativeMoneyPattern = "^(0|[1-9][0-9]{0,17})$";
const currencyPattern = "^[A-Z]{3}$";

function isMoneySchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as Record<string, unknown>;
  return (
    s.type === "string" &&
    (s.pattern === positiveMoneyPattern ||
      s.pattern === nonNegativeMoneyPattern)
  );
}

function isAccountSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as Record<string, unknown>;
  return s.type === "string" && s.pattern === accountPattern;
}

function isStringSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as Record<string, unknown>;
  return s.type === "string";
}

function isDeniedCrossTenantSegment(segment: string): boolean {
  return (
    segment === "tenant" ||
    segment === "tenantId" ||
    segment === "org" ||
    segment === "environment"
  );
}

function checkCrossTenant(rawBind: string): boolean {
  if (rawBind.startsWith("/")) return true;
  const segments = rawBind.split(/[./]/);
  return segments.some(isDeniedCrossTenantSegment);
}

function instrumentConcreteCurrency(
  instrument: UdlInstrument,
): string | undefined {
  const mutableFields = new Set(instrument.update?.fields ?? []);
  const allUpdatedFields = new Set(
    Object.values(instrument.actions).flatMap((a) => a.updates ?? []),
  );
  const currencyFields = Object.entries(instrument.fields).filter(
    ([, schema]) =>
      typeof schema === "object" &&
      schema !== null &&
      (schema as Record<string, unknown>).pattern === currencyPattern,
  );
  if (currencyFields.length === 1) {
    const [fieldName, fieldDefObj] = currencyFields[0]!;
    if (mutableFields.has(fieldName) || allUpdatedFields.has(fieldName)) {
      return undefined;
    }
    const fieldDef = fieldDefObj as Record<string, unknown>;
    if (
      typeof fieldDef.const === "string" &&
      /^[A-Z]{3}$/.test(fieldDef.const)
    ) {
      return fieldDef.const;
    }
    if (
      Array.isArray(fieldDef.enum) &&
      fieldDef.enum.length === 1 &&
      typeof fieldDef.enum[0] === "string" &&
      /^[A-Z]{3}$/.test(fieldDef.enum[0])
    ) {
      return fieldDef.enum[0];
    }
  }
  return undefined;
}

function pieceCurrency(
  piece: UdlPiece,
  instrument: UdlInstrument,
): string | undefined {
  const amountSchema = instrument.fields[piece.amount] as
    | Record<string, unknown>
    | undefined;
  if (
    amountSchema &&
    typeof amountSchema["x-hyperscale-currency"] === "string" &&
    /^[A-Z]{3}$/.test(amountSchema["x-hyperscale-currency"])
  ) {
    return amountSchema["x-hyperscale-currency"];
  }
  return instrumentConcreteCurrency(instrument);
}

export function resolveUdlActionPlans(
  instrument: UdlInstrument,
): ResolvedActionPlansResult {
  const issues: UdlIssue[] = [];
  const plans: ResolvedActionPlan[] = [];

  if (instrument.piecePlan) {
    for (const piece of instrument.piecePlan.pieces) {
      if (pieceCurrency(piece, instrument) === undefined) {
        issues.push(
          issue(
            "UDL4002",
            `$.piecePlan.pieces.${piece.id}`,
            `piece ${piece.id} requires a valid concrete ISO currency from amount tag or immutable instrument currency declaration`,
          ),
        );
      }
    }
  }

  const libraryMap = instrument.actionLibrary ?? {};

  function hasLibrary(lib: string): boolean {
    if (!instrument.actionLibrary) return false;
    return Object.hasOwn(instrument.actionLibrary, lib);
  }

  function getAction(lib: string, act: string): UdlPrivateAction | undefined {
    if (!instrument.actionLibrary) return undefined;
    if (!Object.hasOwn(instrument.actionLibrary, lib)) return undefined;
    const mod = instrument.actionLibrary[lib];
    if (
      !mod ||
      typeof mod !== "object" ||
      !mod.actions ||
      typeof mod.actions !== "object"
    )
      return undefined;
    if (!Object.hasOwn(mod.actions, act)) return undefined;
    return mod.actions[act];
  }

  // Check all private actions for structure, complete order, collisions, and authority
  for (const [libKey, libModule] of Object.entries(libraryMap)) {
    const libPath = `$.actionLibrary.${libKey}`;
    const actionKeys = Object.keys(libModule.actions);
    const orderSet = new Set(libModule.actionOrder);

    if (new Set(libModule.actionOrder).size !== libModule.actionOrder.length) {
      issues.push(
        issue(
          "UDL2010",
          `${libPath}.actionOrder`,
          `actionOrder in library ${libKey} contains duplicate action names`,
        ),
      );
    }
    for (const actionKey of actionKeys) {
      if (!orderSet.has(actionKey)) {
        issues.push(
          issue(
            "UDL2010",
            `${libPath}.actionOrder`,
            `action ${actionKey} is declared in library ${libKey} but missing from actionOrder`,
          ),
        );
      }
    }
    for (const orderKey of libModule.actionOrder) {
      if (!Object.hasOwn(libModule.actions, orderKey)) {
        issues.push(
          issue(
            "UDL2010",
            `${libPath}.actionOrder`,
            `actionOrder in library ${libKey} references unknown action ${orderKey}`,
          ),
        );
      }
    }

    for (const [actKey, privAction] of Object.entries(libModule.actions)) {
      const actPath = `${libPath}.actions.${actKey}`;
      if (privAction.approval === "independent") {
        issues.push(
          issue(
            "UDL2012",
            `${actPath}.approval`,
            `private action ${libKey}.${actKey} cannot declare independent approval`,
          ),
        );
      }
      if (privAction.recovery === "external") {
        issues.push(
          issue(
            "UDL2012",
            `${actPath}.recovery`,
            `private action ${libKey}.${actKey} cannot declare external recovery`,
          ),
        );
      }

      const leafIds = privAction.leaves.map((l) => l.id);
      const callIds = privAction.calls.map((c) => c.id);
      const leafIdSet = new Set(leafIds);
      const callIdSet = new Set(callIds);

      if (leafIdSet.size !== leafIds.length) {
        issues.push(
          issue(
            "UDL2010",
            `${actPath}.leaves`,
            `duplicate leaf id in private action ${libKey}.${actKey}`,
          ),
        );
      }
      if (callIdSet.size !== callIds.length) {
        issues.push(
          issue(
            "UDL2010",
            `${actPath}.calls`,
            `duplicate call id in private action ${libKey}.${actKey}`,
          ),
        );
      }

      for (const id of leafIds) {
        if (callIdSet.has(id)) {
          issues.push(
            issue(
              "UDL2010",
              `${actPath}.order`,
              `collision between leaf id and call id ${id} in private action ${libKey}.${actKey}`,
            ),
          );
        }
      }

      const allIds = new Set([...leafIds, ...callIds]);
      const orderIds = privAction.order;
      if (
        orderIds.length !== allIds.size ||
        !orderIds.every((id) => allIds.has(id)) ||
        new Set(orderIds).size !== orderIds.length
      ) {
        issues.push(
          issue(
            "UDL2010",
            `${actPath}.order`,
            `order in private action ${libKey}.${actKey} must be an exact permutation of leaf and call ids`,
          ),
        );
      }

      for (const call of privAction.calls) {
        const [targetLib, targetAct] = call.action.split(".");
        if (!targetLib || !targetAct || !hasLibrary(targetLib)) {
          issues.push(
            issue(
              "UDL2010",
              `${actPath}.calls.${call.id}.action`,
              `call ${call.id} references unknown library ${targetLib ?? ""}`,
            ),
          );
        } else {
          const targetActionDef = getAction(targetLib, targetAct);
          if (!targetActionDef) {
            issues.push(
              issue(
                "UDL2010",
                `${actPath}.calls.${call.id}.action`,
                `call ${call.id} references unknown action ${targetAct} in library ${targetLib}`,
              ),
            );
          } else {
            for (const key of Object.keys(call.bind)) {
              if (!Object.hasOwn(targetActionDef.parameters, key)) {
                issues.push(
                  issue(
                    "UDL2011",
                    `${actPath}.calls.${call.id}.bind.${key}`,
                    `unexpected parameter ${key} in call to ${call.action}`,
                  ),
                );
              }
            }
            for (const paramName of Object.keys(targetActionDef.parameters)) {
              if (!Object.hasOwn(call.bind, paramName)) {
                issues.push(
                  issue(
                    "UDL2011",
                    `${actPath}.calls.${call.id}.bind.${paramName}`,
                    `missing binding for parameter ${paramName} in call to ${call.action}`,
                  ),
                );
              }
            }
          }
        }
      }
    }
  }

  // Cycle detection in private actions
  const actionVisited = new Set<string>();
  const recursionStack = new Set<string>();

  function checkCycle(currentActionRef: string, path: string[]): boolean {
    const [lib, act] = currentActionRef.split(".");
    if (path.length > UDL_LIMITS.maxDepth) {
      issues.push(
        issue(
          "UDL2010",
          `$.actionLibrary.${lib ?? ""}.actions.${act ?? ""}`,
          `action call depth exceeds maximum depth of ${UDL_LIMITS.maxDepth}`,
        ),
      );
      return true;
    }
    actionVisited.add(currentActionRef);
    recursionStack.add(currentActionRef);

    const actionDef = lib && act ? getAction(lib, act) : undefined;
    if (actionDef) {
      for (const call of actionDef.calls) {
        const [targetLib, targetAct] = call.action.split(".");
        if (!targetLib || !targetAct || !getAction(targetLib, targetAct)) {
          continue;
        }
        if (recursionStack.has(call.action)) {
          issues.push(
            issue(
              "UDL2010",
              `$.actionLibrary.${lib}.actions.${act}`,
              `action call cycle detected: ${[...path, call.action].join(" -> ")}`,
            ),
          );
          return true;
        }
        if (!actionVisited.has(call.action)) {
          if (checkCycle(call.action, [...path, call.action])) return true;
        }
      }
    }
    recursionStack.delete(currentActionRef);
    return false;
  }

  for (const [libKey, libModule] of Object.entries(libraryMap)) {
    for (const actKey of Object.keys(libModule.actions)) {
      const ref = `${libKey}.${actKey}`;
      if (!actionVisited.has(ref)) {
        checkCycle(ref, [ref]);
      }
    }
  }

  type ParamValue =
    | { readonly kind: "instance" }
    | { readonly kind: "piece"; readonly piece: UdlPiece }
    | { readonly kind: "account"; readonly path: string }
    | {
        readonly kind: "money";
        readonly currency?: string | undefined;
        readonly path: string;
      }
    | {
        readonly kind: "text";
        readonly value?: string | undefined;
        readonly path?: string | undefined;
      };

  function resolveBinding(
    rawBind: string,
    scope: ReadonlyMap<string, ParamValue>,
    leafPath: string,
  ):
    | {
        readonly binding: UdlBinding;
        readonly currency?: string | undefined;
        readonly kind: UdlPrivateParameterKind;
        readonly path?: string | undefined;
        readonly piece?: UdlPiece | undefined;
        readonly value?: string | undefined;
      }
    | undefined {
    if (rawBind.includes("$results")) {
      issues.push(
        issue(
          "UDL2011",
          leafPath,
          `results is not an implicit binding scope: ${rawBind}`,
        ),
      );
      return undefined;
    }
    if (checkCrossTenant(rawBind)) {
      issues.push(
        issue(
          "UDL2012",
          leafPath,
          `cross-tenant field paths are not allowed: ${rawBind}`,
        ),
      );
      return undefined;
    }

    if (rawBind === "$instance") {
      return {
        binding: { from: "instance", path: "instrumentInstanceId" },
        kind: "instance",
      };
    }

    if (rawBind === "$piece") {
      const pieceVal = scope.get("piece");
      if (!pieceVal || pieceVal.kind !== "piece") {
        issues.push(
          issue(
            "UDL2011",
            leafPath,
            `$piece reference is not available in caller scope`,
          ),
        );
        return undefined;
      }
      return {
        binding: { from: "const", value: pieceVal.piece.id },
        kind: "piece",
        piece: pieceVal.piece,
      };
    }

    if (rawBind.startsWith("$fields.")) {
      const parts = rawBind.slice("$fields.".length).split(".");
      if (parts.length !== 1) {
        issues.push(
          issue(
            "UDL2011",
            leafPath,
            `invalid member access on field: ${rawBind}`,
          ),
        );
        return undefined;
      }
      const fieldName = parts[0]!;
      const fieldSchema = instrument.fields[fieldName];
      if (!fieldSchema) {
        issues.push(
          issue(
            "UDL2011",
            leafPath,
            `referenced field ${fieldName} is not declared on instrument`,
          ),
        );
        return undefined;
      }
      if (isMoneySchema(fieldSchema)) {
        const cur =
          ((fieldSchema as Record<string, unknown>)["x-hyperscale-currency"] as
            | string
            | undefined) ?? instrumentConcreteCurrency(instrument);
        return {
          binding: { from: "instance", path: `fields.${fieldName}` },
          currency: cur,
          kind: "money",
          path: `fields.${fieldName}`,
        };
      }
      if (isAccountSchema(fieldSchema)) {
        return {
          binding: { from: "instance", path: `fields.${fieldName}` },
          kind: "account",
          path: `fields.${fieldName}`,
        };
      }
      if (isStringSchema(fieldSchema)) {
        return {
          binding: { from: "instance", path: `fields.${fieldName}` },
          kind: "text",
          path: `fields.${fieldName}`,
        };
      }
      issues.push(
        issue(
          "UDL2011",
          leafPath,
          `field ${fieldName} is not an account, money, or text field`,
        ),
      );
      return undefined;
    }

    if (rawBind.startsWith("$")) {
      const parts = rawBind.slice(1).split(".");
      const paramName = parts[0]!;
      const val = scope.get(paramName);
      if (!val) {
        issues.push(
          issue(
            "UDL2011",
            leafPath,
            `unbound parameter $${paramName} in binding ${rawBind}`,
          ),
        );
        return undefined;
      }

      if (val.kind === "piece") {
        if (parts.length === 1) {
          return {
            binding: { from: "const", value: val.piece.id },
            kind: "piece",
            piece: val.piece,
          };
        }
        if (parts.length !== 2) {
          issues.push(
            issue(
              "UDL2011",
              leafPath,
              `invalid trailing member access on piece reference: ${rawBind}`,
            ),
          );
          return undefined;
        }
        const member = parts[1]!;
        if (member === "id") {
          return {
            binding: { from: "const", value: val.piece.id },
            kind: "text",
          };
        }
        if (member === "amount") {
          const cur = pieceCurrency(val.piece, instrument);
          if (cur === undefined) {
            issues.push(
              issue(
                "UDL4002",
                leafPath,
                `piece ${val.piece.id} amount field lacks a concrete currency`,
              ),
            );
          }
          return {
            binding: { from: "instance", path: `fields.${val.piece.amount}` },
            currency: cur ?? "UNKNOWN",
            kind: "money",
            path: `fields.${val.piece.amount}`,
          };
        }
        if (member === "release_to") {
          return {
            binding: {
              from: "instance",
              path: `fields.${val.piece.release_to}`,
            },
            kind: "account",
            path: `fields.${val.piece.release_to}`,
          };
        }
        if (member === "refund_to") {
          return {
            binding: {
              from: "instance",
              path: `fields.${val.piece.refund_to}`,
            },
            kind: "account",
            path: `fields.${val.piece.refund_to}`,
          };
        }
        if (member === "currency") {
          const cur = pieceCurrency(val.piece, instrument);
          if (cur === undefined) {
            issues.push(
              issue(
                "UDL4002",
                leafPath,
                `piece ${val.piece.id} currency cannot be resolved to a concrete currency`,
              ),
            );
          }
          return {
            binding: { from: "const", value: cur ?? "UNKNOWN" },
            kind: "text",
          };
        }
        issues.push(
          issue(
            "UDL2011",
            leafPath,
            `unknown piece member ${member} in ${rawBind}`,
          ),
        );
        return undefined;
      }

      if (val.kind === "instance") {
        if (parts.length === 1) {
          return {
            binding: { from: "instance", path: "instrumentInstanceId" },
            kind: "instance",
          };
        }
        if (parts[1] === "fields") {
          if (parts.length !== 3) {
            issues.push(
              issue(
                "UDL2011",
                leafPath,
                `invalid trailing member access on instance field: ${rawBind}`,
              ),
            );
            return undefined;
          }
          const fieldName = parts[2]!;
          const fieldSchema = instrument.fields[fieldName];
          if (!fieldSchema) {
            issues.push(
              issue(
                "UDL2011",
                leafPath,
                `referenced field ${fieldName} is not declared on instrument`,
              ),
            );
            return undefined;
          }
          if (isMoneySchema(fieldSchema)) {
            const cur =
              ((fieldSchema as Record<string, unknown>)[
                "x-hyperscale-currency"
              ] as string | undefined) ??
              instrumentConcreteCurrency(instrument);
            return {
              binding: { from: "instance", path: `fields.${fieldName}` },
              currency: cur,
              kind: "money",
              path: `fields.${fieldName}`,
            };
          }
          if (isAccountSchema(fieldSchema)) {
            return {
              binding: { from: "instance", path: `fields.${fieldName}` },
              kind: "account",
              path: `fields.${fieldName}`,
            };
          }
          if (isStringSchema(fieldSchema)) {
            return {
              binding: { from: "instance", path: `fields.${fieldName}` },
              kind: "text",
              path: `fields.${fieldName}`,
            };
          }
          issues.push(
            issue(
              "UDL2011",
              leafPath,
              `field ${fieldName} is not an account, money, or text field`,
            ),
          );
          return undefined;
        }
        if (
          parts.length === 2 &&
          (parts[1] === "instrumentInstanceId" || parts[1] === "productId")
        ) {
          return {
            binding: { from: "instance", path: parts[1] },
            kind: "text",
            path: parts[1],
          };
        }
        issues.push(
          issue(
            "UDL2011",
            leafPath,
            `invalid or trailing member access on instance reference: ${rawBind}`,
          ),
        );
        return undefined;
      }

      // Money, Account, Text parameter references do not allow member access
      if (parts.length > 1) {
        issues.push(
          issue(
            "UDL2011",
            leafPath,
            `member access is not allowed on ${val.kind} parameter: ${rawBind}`,
          ),
        );
        return undefined;
      }

      if (val.kind === "account") {
        return {
          binding: { from: "instance", path: val.path },
          kind: "account",
          path: val.path,
        };
      }

      if (val.kind === "money") {
        return {
          binding: { from: "instance", path: val.path },
          currency: val.currency,
          kind: "money",
          path: val.path,
        };
      }

      if (val.kind === "text") {
        return {
          binding: val.path
            ? { from: "instance", path: val.path }
            : { from: "const", value: val.value ?? "" },
          kind: "text",
          path: val.path,
          value: val.value,
        };
      }
    }

    issues.push(
      issue(
        "UDL2011",
        leafPath,
        `invalid or unsupported binding reference: ${rawBind}`,
      ),
    );
    return undefined;
  }

  function resolveCallParameters(
    call: UdlCall,
    targetActionDef: UdlPrivateAction,
    scope: ReadonlyMap<string, ParamValue>,
    callPath: string,
    issuesList: UdlIssue[],
    piece?: UdlPiece,
  ): Map<string, ParamValue> {
    const callScope = new Map<string, ParamValue>();

    // Check extra keys
    for (const key of Object.keys(call.bind)) {
      if (!Object.hasOwn(targetActionDef.parameters, key)) {
        issuesList.push(
          issue(
            "UDL2011",
            `${callPath}.bind.${key}`,
            `unexpected parameter ${key} in call to ${call.action}`,
          ),
        );
      }
    }

    // Check missing keys & resolve bindings
    for (const [pName, pDef] of Object.entries(targetActionDef.parameters)) {
      if (!Object.hasOwn(call.bind, pName)) {
        issuesList.push(
          issue(
            "UDL2011",
            `${callPath}.bind.${pName}`,
            `missing binding for parameter ${pName} in call to ${call.action}`,
          ),
        );
        continue;
      }
      const raw = call.bind[pName]!;
      const resolved = resolveBinding(raw, scope, `${callPath}.bind.${pName}`);
      if (resolved) {
        if (pDef.kind !== resolved.kind) {
          issuesList.push(
            issue(
              "UDL2011",
              `${callPath}.bind.${pName}`,
              `parameter ${pName} expected kind ${pDef.kind} but received ${resolved.kind}`,
            ),
          );
        }
        if (
          pDef.kind === "money" &&
          pDef.currency &&
          resolved.currency &&
          pDef.currency !== resolved.currency
        ) {
          issuesList.push(
            issue(
              "UDL2011",
              `${callPath}.bind.${pName}`,
              `currency mismatch for money parameter ${pName}: expected ${pDef.currency} but received ${resolved.currency}`,
            ),
          );
        }
        if (resolved.kind === "piece") {
          callScope.set(pName, {
            kind: "piece",
            piece: resolved.piece ?? piece!,
          });
        } else if (resolved.kind === "instance") {
          callScope.set(pName, { kind: "instance" });
        } else if (resolved.kind === "account") {
          callScope.set(pName, { kind: "account", path: resolved.path ?? "" });
        } else if (resolved.kind === "money") {
          callScope.set(pName, {
            currency: resolved.currency ?? pDef.currency,
            kind: "money",
            path: resolved.path ?? "",
          });
        } else {
          callScope.set(pName, {
            kind: "text",
            path: resolved.path,
            value: resolved.value,
          });
        }
      }
    }

    return callScope;
  }

  // Counts private-action expansions for one public action plan. Reset before
  // each plan so the bound is per plan, not per document.
  let totalCumulativeCalls = 0;

  function expandPrivateAction(
    targetLibKey: string,
    targetActionKey: string,
    callArgs: ReadonlyMap<string, ParamValue>,
    originPrefix: readonly string[],
    callChain: readonly string[],
    callerPrincipal: "api_key" | "user_session",
    capturedDestinations: Set<string>,
    consumedSources: Set<string>,
    expandedLeaves: ResolvedActionPlanLeaf[],
  ): void {
    totalCumulativeCalls += 1;
    if (totalCumulativeCalls > UDL_LIMITS.maxActionExpansion) {
      issues.push(
        issue(
          "UDL2010",
          `$.actions.${originPrefix[0]}`,
          `action exceeds cumulative call bound of ${UDL_LIMITS.maxActionExpansion}`,
        ),
      );
      return;
    }

    if (callChain.length > UDL_LIMITS.maxDepth) {
      issues.push(
        issue(
          "UDL2010",
          `$.actions.${originPrefix[0]}`,
          `action recursion depth exceeded ${UDL_LIMITS.maxDepth}`,
        ),
      );
      return;
    }

    const actionRef = `${targetLibKey}.${targetActionKey}`;
    if (callChain.includes(actionRef)) {
      issues.push(
        issue(
          "UDL2010",
          `$.actions.${originPrefix[0]}`,
          `action graph cycle detected in call to ${actionRef}`,
        ),
      );
      return;
    }

    const privAction = getAction(targetLibKey, targetActionKey);
    if (!privAction) {
      issues.push(
        issue(
          "UDL2010",
          `$.actions.${originPrefix[0]}`,
          `call references unknown action ${targetActionKey} in library ${targetLibKey}`,
        ),
      );
      return;
    }

    if (privAction.principal !== callerPrincipal) {
      issues.push(
        issue(
          "UDL2012",
          `$.actionLibrary.${targetLibKey}.actions.${targetActionKey}.principal`,
          `principal mismatch: caller requires ${callerPrincipal} but ${actionRef} requires ${privAction.principal}`,
        ),
      );
    }

    const leavesMap = new Map(privAction.leaves.map((l) => [l.id, l]));
    const callsMap = new Map(privAction.calls.map((c) => [c.id, c]));

    for (const itemId of privAction.order) {
      if (expandedLeaves.length >= UDL_LIMITS.maxActionLeaves) {
        issues.push(
          issue(
            "UDL2010",
            `$.actions.${originPrefix[0]}`,
            `action exceeds cumulative expanded leaf bound of ${UDL_LIMITS.maxActionLeaves}`,
          ),
        );
        return;
      }

      if (leavesMap.has(itemId)) {
        const leaf = leavesMap.get(itemId)!;
        const leafPath = `$.actionLibrary.${targetLibKey}.actions.${targetActionKey}.leaves.${leaf.id}`;
        const resolvedBinds: Record<string, UdlBinding> = {};

        for (const [key, bindStr] of Object.entries(leaf.bind)) {
          const resolved = resolveBinding(
            bindStr,
            callArgs,
            `${leafPath}.bind.${key}`,
          );
          if (resolved) {
            resolvedBinds[key] = resolved.binding;
            if (key === "amount" && resolved.kind !== "money") {
              issues.push(
                issue(
                  "UDL2011",
                  `${leafPath}.bind.${key}`,
                  `amount operand must resolve to money`,
                ),
              );
            }
            if (
              (key === "sourceAccountId" ||
                key === "destinationAccountId" ||
                key === "accountId") &&
              resolved.kind !== "account"
            ) {
              issues.push(
                issue(
                  "UDL2011",
                  `${leafPath}.bind.${key}`,
                  `${key} operand must resolve to account`,
                ),
              );
            }
          }
        }

        // Check leaf evidence
        if (!leaf.evidence || leaf.evidence.trim().length === 0) {
          issues.push(
            issue(
              "UDL2013",
              `${leafPath}.evidence`,
              `leaf evidence is mandatory and cannot be blank`,
            ),
          );
        }

        // Check leaf captures: destination ref is the map key
        if (leaf.capture) {
          for (const capKey of Object.keys(leaf.capture)) {
            if (capturedDestinations.has(capKey)) {
              issues.push(
                issue(
                  "UDL2011",
                  `${leafPath}.capture.${capKey}`,
                  `duplicate capture destination ${capKey} across expanded leaves`,
                ),
              );
            }
            capturedDestinations.add(capKey);
          }
        }

        const originPath = [...originPrefix, leaf.id];
        let step: UdlStep | UdlMove;

        if (leaf.operation.startsWith("internal_transfer.")) {
          step = {
            bind: resolvedBinds,
            ...(leaf.capture ? { capture: leaf.capture } : {}),
            key: encodeOriginPathKey(originPath),
            operation: leaf.operation as UdlMove["operation"],
          };
        } else {
          step = {
            bind: resolvedBinds,
            ...(leaf.capture ? { capture: leaf.capture } : {}),
            operation: leaf.operation as UdlStep["operation"],
          };
        }

        // Check repeated consumption of money amount or hold identity
        const amountSrc = boundPath(step, "amount");
        if (amountSrc) {
          if (consumedSources.has(amountSrc)) {
            issues.push(
              issue(
                "UDL2011",
                `${leafPath}.bind.amount`,
                `repeated consumption of money source ${amountSrc} in one expanded action`,
              ),
            );
          }
          consumedSources.add(amountSrc);
        }
        const holdSrc = boundPath(step, "holdId");
        if (holdSrc) {
          const holdKey = `hold:${holdSrc}`;
          if (consumedSources.has(holdKey)) {
            issues.push(
              issue(
                "UDL2011",
                `${leafPath}.bind.holdId`,
                `repeated consumption of hold ${holdSrc} in one expanded action`,
              ),
            );
          }
          consumedSources.add(holdKey);
        }

        const expectedEffects = expectedLeafEffects(step);
        const actualCounts = new Map<string, number>();
        for (const eff of leaf.effects) {
          const key = `${eff.kind}:${eff.signature}`;
          actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
        }
        const expectedCounts = new Map<string, number>();
        for (const eff of expectedEffects) {
          const key = `${eff.kind}:${eff.signature}`;
          expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
        }
        let effectsMatch = actualCounts.size === expectedCounts.size;
        if (effectsMatch) {
          for (const [k, count] of actualCounts.entries()) {
            if (expectedCounts.get(k) !== count) {
              effectsMatch = false;
              break;
            }
          }
        }
        if (!effectsMatch) {
          issues.push(
            issue(
              "UDL2013",
              `${leafPath}.effects`,
              `declared leaf effects do not match expected effects for operation ${leaf.operation}`,
            ),
          );
        }

        expandedLeaves.push({
          effects: leaf.effects,
          evidence: leaf.evidence,
          originPath,
          step,
        });
      } else if (callsMap.has(itemId)) {
        const nextCall = callsMap.get(itemId)!;
        const [nextLib, nextAct] = nextCall.action.split(".");
        if (!nextLib || !nextAct || !hasLibrary(nextLib)) {
          issues.push(
            issue(
              "UDL2010",
              `$.actionLibrary.${targetLibKey}.actions.${targetActionKey}.calls.${nextCall.id}.action`,
              `call ${nextCall.id} references unknown library ${nextLib ?? ""}`,
            ),
          );
          continue;
        }
        const nextActionDef = getAction(nextLib, nextAct);
        if (!nextActionDef) {
          issues.push(
            issue(
              "UDL2010",
              `$.actionLibrary.${targetLibKey}.actions.${targetActionKey}.calls.${nextCall.id}.action`,
              `call ${nextCall.id} references unknown action ${nextAct} in library ${nextLib}`,
            ),
          );
          continue;
        }

        const nextScope = resolveCallParameters(
          nextCall,
          nextActionDef,
          callArgs,
          `$.actionLibrary.${targetLibKey}.actions.${targetActionKey}.calls.${nextCall.id}`,
          issues,
        );

        expandPrivateAction(
          nextLib,
          nextAct,
          nextScope,
          [...originPrefix, nextCall.id],
          [...callChain, actionRef],
          privAction.principal,
          capturedDestinations,
          consumedSources,
          expandedLeaves,
        );
      }
    }
  }

  // Iterate over public actions in actionOrder
  for (const actionKey of instrument.actionOrder) {
    const action = instrument.actions[actionKey];
    if (!action) continue;

    const actionPath = `$.actions.${actionKey}`;
    const publicPrincipal = action.principal ?? "api_key";

    // Reject mixed direct steps/moves and calls
    if (
      action.calls &&
      action.calls.length > 0 &&
      (action.steps.length > 0 || action.moves.length > 0)
    ) {
      issues.push(
        issue(
          "UDL2010",
          `${actionPath}.calls`,
          `action ${actionKey} cannot mix calls with direct steps or moves`,
        ),
      );
    }

    if (action.calls) {
      const publicCallIds = action.calls.map((c) => c.id);
      if (new Set(publicCallIds).size !== publicCallIds.length) {
        issues.push(
          issue(
            "UDL2010",
            `${actionPath}.calls`,
            `duplicate call id in action ${actionKey}`,
          ),
        );
      }
    }

    if (action.pieceStage) {
      if (!action.calls || action.calls.length === 0) {
        issues.push(
          issue(
            "UDL5013",
            `${actionPath}.calls`,
            `pieceStage action ${actionKey} must move money through calls, never through direct moves or steps`,
          ),
        );
      }

      if (actionKey === "create") {
        issues.push(
          issue(
            "UDL5013",
            `${actionPath}.pieceStage`,
            `create action cannot declare pieceStage`,
          ),
        );
      }

      if (
        !instrument.piecePlan ||
        instrument.piecePlan.id !== action.pieceStage.plan
      ) {
        issues.push(
          issue(
            "UDL5013",
            `${actionPath}.pieceStage.plan`,
            `pieceStage references unknown plan ${action.pieceStage.plan}`,
          ),
        );
      }

      const stage = action.pieceStage.stage;
      const stageOrder: readonly string[] =
        stage === "fund"
          ? (instrument.piecePlan?.fund_order ?? [])
          : stage === "release"
            ? (instrument.piecePlan?.release_order ?? [])
            : stage === "refund"
              ? (instrument.piecePlan?.refund_order ?? [])
              : (instrument.piecePlan?.unfund_order ?? []);

      if (stageOrder.length === 0) {
        issues.push(
          issue(
            "UDL5013",
            `${actionPath}.pieceStage.stage`,
            `piece stage ${stage} is empty`,
          ),
        );
      }

      // Check input must be present and exact
      if (!action.input) {
        issues.push(
          issue(
            "UDL5013",
            `${actionPath}.input`,
            `pieceStage action input is required and must declare exact pieceId enum matching stage order`,
          ),
        );
      } else {
        const inp = action.input as Record<string, unknown>;
        const props = (inp.properties ?? {}) as Record<string, unknown>;
        const pieceIdProp = (props.pieceId ?? {}) as Record<string, unknown>;
        const enumVals = Array.isArray(pieceIdProp.enum)
          ? pieceIdProp.enum
          : [];

        if (
          inp.type !== "object" ||
          inp.additionalProperties !== false ||
          !Array.isArray(inp.required) ||
          inp.required.length !== 1 ||
          inp.required[0] !== "pieceId" ||
          Object.keys(props).length !== 1 ||
          pieceIdProp.type !== "string" ||
          enumVals.length !== stageOrder.length ||
          !enumVals.every((id, idx) => id === stageOrder[idx])
        ) {
          issues.push(
            issue(
              "UDL5013",
              `${actionPath}.input`,
              `pieceStage action input must declare exact pieceId enum matching stage order`,
            ),
          );
        }
      }

      const variantMultiplicities: Map<string, number>[] = [];

      for (const pieceId of stageOrder) {
        const piece = instrument.piecePlan?.pieces.find(
          (p) => p.id === pieceId,
        );
        if (!piece) {
          issues.push(
            issue(
              "UDL5013",
              `${actionPath}.pieceStage`,
              `piece id ${pieceId} in stage order is not declared in piecePlan`,
            ),
          );
          continue;
        }

        const expandedLeaves: ResolvedActionPlanLeaf[] = [];
        const capturedDestinations = new Set<string>();
        const consumedSources = new Set<string>();
        totalCumulativeCalls = 0;

        const scope = new Map<string, ParamValue>([
          ["piece", { kind: "piece", piece }],
          ["instance", { kind: "instance" }],
        ]);

        for (const call of action.calls ?? []) {
          const [lib, act] = call.action.split(".");
          if (!lib || !act || !hasLibrary(lib)) {
            issues.push(
              issue(
                "UDL2010",
                `${actionPath}.calls.${call.id}.action`,
                `call ${call.id} references unknown library ${lib ?? ""}`,
              ),
            );
            continue;
          }
          const targetActionDef = getAction(lib, act);
          if (!targetActionDef) {
            issues.push(
              issue(
                "UDL2010",
                `${actionPath}.calls.${call.id}.action`,
                `call ${call.id} references unknown action ${act} in library ${lib}`,
              ),
            );
            continue;
          }

          const callScope = resolveCallParameters(
            call,
            targetActionDef,
            scope,
            `${actionPath}.calls.${call.id}`,
            issues,
            piece,
          );

          expandPrivateAction(
            lib,
            act,
            callScope,
            [actionKey, call.id],
            [],
            publicPrincipal,
            capturedDestinations,
            consumedSources,
            expandedLeaves,
          );
        }

        // Refuse input amount/destination binding in leaves and validate piece bindings
        for (const leaf of expandedLeaves) {
          const binds = leaf.step.bind ?? {};
          for (const [k, b] of Object.entries(binds)) {
            if (
              (k === "amount" ||
                k === "sourceAccountId" ||
                k === "destinationAccountId") &&
              typeof b === "object" &&
              b !== null &&
              (b as { from?: string }).from === "input"
            ) {
              issues.push(
                issue(
                  "UDL5013",
                  `${actionPath}.pieceStage`,
                  `pieceStage leaves cannot bind amount or destination to input: ${k}`,
                ),
              );
            }
          }

          if (leaf.step.operation.startsWith("internal_transfer.")) {
            const amt = binds.amount;
            if (
              !amt ||
              typeof amt !== "object" ||
              (amt as { from?: string }).from !== "instance" ||
              (amt as { path?: string }).path !== `fields.${piece.amount}`
            ) {
              issues.push(
                issue(
                  "UDL5013",
                  `${actionPath}.pieceStage`,
                  `pieceStage transfer amount must resolve to selected piece.amount (${piece.amount})`,
                ),
              );
            }

            if (stage === "release") {
              const dest = binds.destinationAccountId;
              if (
                !dest ||
                typeof dest !== "object" ||
                (dest as { from?: string }).from !== "instance" ||
                (dest as { path?: string }).path !==
                  `fields.${piece.release_to}`
              ) {
                issues.push(
                  issue(
                    "UDL5013",
                    `${actionPath}.pieceStage`,
                    `pieceStage release destination must resolve to selected piece.release_to (${piece.release_to})`,
                  ),
                );
              }
            } else if (stage === "refund") {
              const dest = binds.destinationAccountId;
              if (
                !dest ||
                typeof dest !== "object" ||
                (dest as { from?: string }).from !== "instance" ||
                (dest as { path?: string }).path !== `fields.${piece.refund_to}`
              ) {
                issues.push(
                  issue(
                    "UDL5013",
                    `${actionPath}.pieceStage`,
                    `pieceStage refund destination must resolve to selected piece.refund_to (${piece.refund_to})`,
                  ),
                );
              }
            }
          }
        }

        const counts = new Map<string, number>();
        for (const leaf of expandedLeaves) {
          for (const eff of leaf.effects) {
            counts.set(eff.signature, (counts.get(eff.signature) ?? 0) + 1);
          }
        }
        variantMultiplicities.push(counts);

        const directEffects = deriveUdlActionEffects(
          action as Readonly<Record<string, unknown>>,
          udlClauseVocabulary,
        );
        const leafEffects =
          action.calls && action.calls.length > 0
            ? deriveActionEffectsFromPlan(expandedLeaves)
            : {};
        const effects = combineDerivedEffects(directEffects, leafEffects);

        plans.push({
          action: actionKey,
          effects,
          leaves: expandedLeaves,
          pieceId,
        });
      }

      // Verify identical effect signature multiplicities across piece variants
      if (variantMultiplicities.length > 1) {
        const baseCounts = variantMultiplicities[0]!;
        for (let i = 1; i < variantMultiplicities.length; i++) {
          const comp = variantMultiplicities[i]!;
          let identical = baseCounts.size === comp.size;
          if (identical) {
            for (const [sig, count] of baseCounts.entries()) {
              if (comp.get(sig) !== count) {
                identical = false;
                break;
              }
            }
          }
          if (!identical) {
            issues.push(
              issue(
                "UDL2013",
                `${actionPath}.pieceStage`,
                `piece variants of action ${actionKey} have differing effect signature multiplicities`,
              ),
            );
            break;
          }
        }
      }
    } else if (action.calls && action.calls.length > 0) {
      const expandedLeaves: ResolvedActionPlanLeaf[] = [];
      const capturedDestinations = new Set<string>();
      const consumedSources = new Set<string>();
      totalCumulativeCalls = 0;
      const scope = new Map<string, ParamValue>([
        ["instance", { kind: "instance" }],
      ]);

      for (const call of action.calls) {
        const [lib, act] = call.action.split(".");
        if (!lib || !act || !hasLibrary(lib)) {
          issues.push(
            issue(
              "UDL2010",
              `${actionPath}.calls.${call.id}.action`,
              `call ${call.id} references unknown library ${lib ?? ""}`,
            ),
          );
          continue;
        }
        const targetActionDef = getAction(lib, act);
        if (!targetActionDef) {
          issues.push(
            issue(
              "UDL2010",
              `${actionPath}.calls.${call.id}.action`,
              `call ${call.id} references unknown action ${act} in library ${lib}`,
            ),
          );
          continue;
        }

        const callScope = resolveCallParameters(
          call,
          targetActionDef,
          scope,
          `${actionPath}.calls.${call.id}`,
          issues,
        );

        expandPrivateAction(
          lib,
          act,
          callScope,
          [actionKey, call.id],
          [],
          publicPrincipal,
          capturedDestinations,
          consumedSources,
          expandedLeaves,
        );
      }

      const directEffects = deriveUdlActionEffects(
        action as Readonly<Record<string, unknown>>,
        udlClauseVocabulary,
      );
      const leafEffects = deriveActionEffectsFromPlan(expandedLeaves);
      const effects = combineDerivedEffects(directEffects, leafEffects);

      plans.push({
        action: actionKey,
        effects,
        leaves: expandedLeaves,
      });
    }
  }

  return { issues, plans };
}
