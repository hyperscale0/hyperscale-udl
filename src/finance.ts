import type { UdlBinding } from "./schema.js";
import { UDL_LIMITS } from "./limits.js";

export interface FinanceIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

export interface FinanceOptions {
  readonly penaltyMayBeNonzero?: boolean;
}

interface FinancialStep {
  readonly operation: string;
  readonly bind: Readonly<Record<string, UdlBinding>>;
  readonly capture?: Readonly<Record<string, string>> | undefined;
}

interface FinancialMove extends FinancialStep {
  readonly key: string;
}

interface FinancialNoun {
  readonly lifecycle: {
    readonly initial: string;
    readonly states: readonly string[];
    readonly transitions: Readonly<
      Record<string, { readonly from: readonly string[]; readonly to: string }>
    >;
  };
  readonly parties?:
    | {
        readonly beneficiary?: string | undefined;
        readonly payer?: string | undefined;
        readonly subjectHolder?: string | undefined;
      }
    | undefined;
  readonly unwind?:
    | {
        readonly confirm: string;
        readonly penalty: readonly {
          readonly bps: number;
        }[];
        readonly refundableField: string;
      }
    | undefined;
  readonly verbs: Readonly<
    Record<
      string,
      {
        readonly moves?: readonly FinancialMove[];
        readonly steps: readonly FinancialStep[];
      }
    >
  >;
}

type Balance =
  | { readonly kind: "empty" }
  | { readonly kind: "funded"; readonly amounts: readonly string[] }
  | { readonly kind: "penalty" }
  | { readonly kind: "unknown" };

interface AccountState {
  readonly balance: Balance;
  readonly holds: Readonly<Record<string, Balance>>;
}

interface Reservation {
  readonly amount: string;
  readonly destination?: string;
  readonly source?: string;
}

interface Effect {
  readonly amount: string;
  readonly kind:
    | "credit"
    | "debit"
    | "dynamic_debit"
    | "incoming_reserve"
    | "outgoing_reserve"
    | "penalty_debit"
    | "post"
    | "refund"
    | "void";
  readonly path: readonly PropertyKey[];
  readonly reservation?: string;
}

const EMPTY: Balance = { kind: "empty" };

const UNKNOWN: Balance = { kind: "unknown" };

// A funded balance is the exact set of amount identities currently held.
// Distinct identities stack (a partitioned funding); re-crediting an identity
// already present degrades to unknown, which keeps the state space finite.
function funded(amounts: readonly string[]): Balance {
  if (amounts.length === 0) return EMPTY;
  return { kind: "funded", amounts: [...amounts].sort() };
}

function withoutPiece(
  amounts: readonly string[],
  amount: string,
): readonly string[] {
  const index = amounts.indexOf(amount);
  return amounts.filter((_, position) => position !== index);
}

/**
 * One financial typestate owner for canonical UDL and static noun contracts.
 * It proves a tracked escrow account holds an exact set of funded amounts,
 * models held transfers through reserve/post/void, consumes every direct
 * debit piece by piece, and makes the unwind refund's sole remainder an
 * exactly-once penalty payout.
 */
export function analyzeNounFinance(
  noun: FinancialNoun,
  options: FinanceOptions = {},
): readonly FinanceIssue[] {
  const issues: FinanceIssue[] = [];
  const seenIssues = new Set<string>();
  const add = (path: readonly PropertyKey[], message: string): void => {
    const key = `${path.join(".")}\0${message}`;
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push({ message, path });
  };

  const admissionProblem = financeAdmissionProblem(noun);
  if (admissionProblem) {
    add(["lifecycle"], admissionProblem);
    return issues;
  }

  const trackedAccounts = workspaceEscrowAccounts(noun);
  const confirmTransfer = noun.unwind
    ? noun.verbs[noun.unwind.confirm]?.moves?.filter(
        (move) => move.operation === "internal_transfer.create",
      )[0]
    : undefined;
  const refundSource = canonicalAccount(
    noun,
    confirmTransfer?.bind.sourceAccountId,
  );
  if (refundSource) trackedAccounts.add(refundSource);
  if (trackedAccounts.size === 0) return [];
  if (trackedAccounts.size > UDL_LIMITS.financeAccounts) {
    add(
      ["verbs"],
      `financial analysis exceeds ${UDL_LIMITS.financeAccounts} tracked accounts`,
    );
    return issues;
  }

  const reservations = reservationsByKey(noun);
  const declaresPenaltyPayout = Object.values(noun.verbs).some((verb) =>
    (verb.moves ?? []).some((move) =>
      Object.values(move.bind).some(
        (binding) =>
          binding.from === "instance" && binding.path === "refs.unwindPenalty",
      ),
    ),
  );
  const penaltyCanBeNonzero =
    options.penaltyMayBeNonzero === true ||
    declaresPenaltyPayout ||
    noun.unwind?.penalty.some((tier) => tier.bps > 0) === true;

  if (noun.unwind) {
    validatePenaltyPayout(noun, refundSource, penaltyCanBeNonzero, add);
  }

  let pathVariants = 0;
  let work = 0;
  for (const account of trackedAccounts) {
    const effects = effectsByVerb(
      noun,
      account,
      reservations,
      penaltyCanBeNonzero,
    );
    const createEffects = effects.get("create") ?? [];
    work += 1 + createEffects.length;
    if (work > UDL_LIMITS.financeWork) {
      add(
        ["lifecycle"],
        `financial analysis exceeds ${UDL_LIMITS.financeWork} deterministic work units`,
      );
      return issues;
    }
    const initial = applyEffects(
      noun,
      account,
      "create",
      { balance: EMPTY, holds: {} },
      createEffects,
      reservations,
      account === refundSource,
      add,
    );
    const states = new Map<string, Map<string, AccountState>>([
      [noun.lifecycle.initial, new Map([[stateKey(initial), initial]])],
    ]);
    pathVariants += 1;
    const pending = [noun.lifecycle.initial];
    while (pending.length > 0) {
      const from = pending.shift() as string;
      const sourceStates = states.get(from);
      if (!sourceStates) continue;
      for (const [verb, transition] of Object.entries(
        noun.lifecycle.transitions,
      )) {
        if (!transition.from.includes(from)) continue;
        const targetStates = states.get(transition.to) ?? new Map();
        states.set(transition.to, targetStates);
        let grew = false;
        for (const sourceState of sourceStates.values()) {
          const transitionEffects = effects.get(verb) ?? [];
          work += 1 + transitionEffects.length;
          if (work > UDL_LIMITS.financeWork) {
            add(
              ["lifecycle"],
              `financial analysis exceeds ${UDL_LIMITS.financeWork} deterministic work units`,
            );
            return issues;
          }
          const targetState = applyEffects(
            noun,
            account,
            verb,
            sourceState,
            transitionEffects,
            reservations,
            account === refundSource,
            add,
          );
          const key = stateKey(targetState);
          if (targetStates.has(key)) continue;
          targetStates.set(key, targetState);
          pathVariants += 1;
          if (pathVariants > UDL_LIMITS.financePathVariants) {
            add(
              ["lifecycle"],
              `financial analysis exceeds ${UDL_LIMITS.financePathVariants} distinct path variants`,
            );
            return issues;
          }
          grew = true;
        }
        if (grew && !pending.includes(transition.to))
          pending.push(transition.to);
      }
    }
    const nonterminalStates = new Set(
      Object.values(noun.lifecycle.transitions).flatMap(
        (transition) => transition.from,
      ),
    );
    for (const [state, variants] of states) {
      if (nonterminalStates.has(state)) continue;
      for (const variant of variants.values()) {
        if (
          variant.balance.kind === "empty" &&
          Object.keys(variant.holds).length === 0
        ) {
          continue;
        }
        add(
          ["lifecycle", "states", noun.lifecycle.states.indexOf(state)],
          `terminal state ${state} can strand value in ${formatAccount(account)}`,
        );
      }
    }
  }

  return issues;
}

export function financeAdmissionProblem(
  noun: FinancialNoun,
): string | undefined {
  if (noun.lifecycle.states.length > UDL_LIMITS.financeStates) {
    return `financial analysis exceeds ${UDL_LIMITS.financeStates} lifecycle states`;
  }
  let transitionCount = 0;
  let transitionEdges = 0;
  for (const name in noun.lifecycle.transitions) {
    if (!Object.hasOwn(noun.lifecycle.transitions, name)) continue;
    transitionCount += 1;
    if (transitionCount > UDL_LIMITS.financeTransitions) {
      return `financial analysis exceeds ${UDL_LIMITS.financeTransitions} lifecycle transitions`;
    }
    transitionEdges += noun.lifecycle.transitions[name]?.from.length ?? 0;
    if (transitionEdges > UDL_LIMITS.financeTransitionEdges) {
      return `financial analysis exceeds ${UDL_LIMITS.financeTransitionEdges} lifecycle transition edges`;
    }
  }
  let verbCount = 0;
  let effectCount = 0;
  for (const name in noun.verbs) {
    if (!Object.hasOwn(noun.verbs, name)) continue;
    verbCount += 1;
    if (verbCount > UDL_LIMITS.financeVerbs) {
      return `financial analysis exceeds ${UDL_LIMITS.financeVerbs} verbs`;
    }
    const verb = noun.verbs[name];
    effectCount += (verb?.steps.length ?? 0) + (verb?.moves?.length ?? 0);
    if (effectCount > UDL_LIMITS.financeEffects) {
      return `financial analysis exceeds ${UDL_LIMITS.financeEffects} kernel effects`;
    }
  }
  return undefined;
}

function workspaceEscrowAccounts(noun: FinancialNoun): Set<string> {
  const accounts = new Set<string>();
  for (const verb of Object.values(noun.verbs)) {
    for (const step of verb.steps) {
      if (
        step.operation !== "account.escrow.provision" ||
        step.bind.role?.from !== "const" ||
        step.bind.role.value !== "workspace_escrow"
      ) {
        continue;
      }
      for (const [key, result] of Object.entries(step.capture ?? {})) {
        if (result === "accountId") accounts.add(`ref:${key}`);
      }
    }
  }

  // `workspace_escrow` also backs open-ended balance products such as wallets.
  // Only instance-bound amounts claim static conservation; caller-sized flows
  // remain runtime balance checks. Unwind sources are added separately above.
  return new Set(
    [...accounts].filter((account) =>
      Object.values(noun.verbs).some((verb) =>
        (verb.moves ?? []).some((step) => {
          if (
            (step.operation !== "internal_transfer.create" &&
              step.operation !== "internal_transfer.reserve") ||
            step.bind.amount?.from !== "instance"
          ) {
            return false;
          }
          return (
            canonicalAccount(noun, step.bind.sourceAccountId) === account ||
            canonicalAccount(noun, step.bind.destinationAccountId) === account
          );
        }),
      ),
    ),
  );
}

function reservationsByKey(
  noun: FinancialNoun,
): ReadonlyMap<string, Reservation> {
  const reservations = new Map<string, Reservation>();
  for (const verb of Object.values(noun.verbs)) {
    for (const step of verb.moves ?? []) {
      if (step.operation !== "internal_transfer.reserve") continue;
      const source = canonicalAccount(noun, step.bind.sourceAccountId);
      const destination = canonicalAccount(
        noun,
        step.bind.destinationAccountId,
      );
      const amount = amountIdentity(step.bind.amount);
      for (const [key, result] of Object.entries(step.capture ?? {})) {
        if (result === "transferId") {
          reservations.set(key, {
            amount,
            ...(destination ? { destination } : {}),
            ...(source ? { source } : {}),
          });
        }
      }
    }
  }
  return reservations;
}

function effectsByVerb(
  noun: FinancialNoun,
  account: string,
  reservations: ReadonlyMap<string, Reservation>,
  penaltyCanBeNonzero: boolean,
): ReadonlyMap<string, readonly Effect[]> {
  return new Map(
    Object.entries(noun.verbs).map(([verbName, verb]) => [
      verbName,
      (verb.moves ?? []).flatMap((step, stepIndex) => {
        const path = ["verbs", verbName, "moves", stepIndex, "bind"] as const;
        if (step.operation === "internal_transfer.create") {
          const effects: Effect[] = [];
          const amount = amountIdentity(step.bind.amount);
          if (
            canonicalAccount(noun, step.bind.destinationAccountId) === account
          ) {
            effects.push({ amount, kind: "credit", path });
          }
          const source = canonicalAccount(noun, step.bind.sourceAccountId);
          if (source && accountsMayAlias(source, account)) {
            const kind =
              verbName === noun.unwind?.confirm &&
              step.bind.amount?.from === "instance" &&
              step.bind.amount.path === "refs.unwindRefund"
                ? "refund"
                : step.bind.amount?.from === "instance" &&
                    step.bind.amount.path === "refs.unwindPenalty"
                  ? "penalty_debit"
                  : step.bind.amount?.from === "instance"
                    ? "debit"
                    : "dynamic_debit";
            effects.push({
              amount:
                kind === "refund" && !penaltyCanBeNonzero
                  ? "refund_without_penalty"
                  : amount,
              kind,
              path,
            });
          }
          return effects;
        }
        if (step.operation === "internal_transfer.reserve") {
          const reservation =
            transferRefKey(step) ?? `${verbName}:${stepIndex}`;
          const effects: Effect[] = [];
          const source = canonicalAccount(noun, step.bind.sourceAccountId);
          if (source && accountsMayAlias(source, account)) {
            effects.push({
              amount: amountIdentity(step.bind.amount),
              kind: "outgoing_reserve",
              path,
              reservation,
            });
          }
          if (
            canonicalAccount(noun, step.bind.destinationAccountId) === account
          ) {
            effects.push({
              amount: amountIdentity(step.bind.amount),
              kind: "incoming_reserve",
              path,
              reservation,
            });
          }
          return effects;
        }
        if (
          step.operation === "internal_transfer.post" ||
          step.operation === "internal_transfer.void"
        ) {
          const reservation = boundTransferRefKey(step);
          if (!reservation) return [];
          const reserved = reservations.get(reservation);
          if (
            !reserved ||
            (!(reserved.source && accountsMayAlias(reserved.source, account)) &&
              reserved.destination !== account)
          ) {
            return [];
          }
          return [
            {
              amount: reserved.amount,
              kind:
                step.operation === "internal_transfer.post" ? "post" : "void",
              path,
              reservation,
            } satisfies Effect,
          ];
        }
        return [];
      }),
    ]),
  );
}

function applyEffects(
  noun: FinancialNoun,
  account: string,
  verb: string,
  input: AccountState,
  effects: readonly Effect[],
  reservations: ReadonlyMap<string, Reservation>,
  exactBalance: boolean,
  add: (path: readonly PropertyKey[], message: string) => void,
): AccountState {
  let balance = input.balance;
  const holds = { ...input.holds };
  const accountLabel = formatAccount(account);
  for (const effect of effects) {
    const fail = (message: string): void =>
      add([...effect.path, "sourceAccountId"], `verb ${verb} ${message}`);
    if (effect.kind === "credit") {
      if (
        exactBalance &&
        (balance.kind !== "empty" || Object.keys(holds).length > 0)
      ) {
        add(
          [...effect.path, "destinationAccountId"],
          `verb ${verb} funds ${accountLabel} while earlier value may remain; unwind funding must establish exactly one refundable balance`,
        );
        balance = UNKNOWN;
        continue;
      }
      const pieces = balance.kind === "funded" ? balance.amounts : [];
      const stacks =
        (balance.kind === "empty" || balance.kind === "funded") &&
        !pieces.includes(effect.amount);
      balance = stacks ? funded([...pieces, effect.amount]) : UNKNOWN;
      continue;
    }
    if (effect.kind === "incoming_reserve") continue;
    if (effect.kind === "outgoing_reserve") {
      const held =
        balance.kind === "funded" && balance.amounts.includes(effect.amount);
      if (!held) {
        fail(
          `cannot reserve ${effect.amount} from ${accountLabel}; that exact balance is not guaranteed`,
        );
      }
      holds[effect.reservation as string] = held
        ? { kind: "funded", amounts: [effect.amount] }
        : UNKNOWN;
      balance =
        held && balance.kind === "funded"
          ? funded(withoutPiece(balance.amounts, effect.amount))
          : EMPTY;
      continue;
    }
    if (effect.kind === "post" || effect.kind === "void") {
      const key = effect.reservation as string;
      const reservation = reservations.get(key);
      if (
        reservation?.source &&
        accountsMayAlias(reservation.source, account)
      ) {
        const held = holds[key];
        delete holds[key];
        if (effect.kind === "void" && held) {
          const pieces = balance.kind === "funded" ? balance.amounts : [];
          const restorable =
            held.kind === "funded" &&
            (balance.kind === "empty" ||
              (balance.kind === "funded" &&
                held.amounts.every((piece) => !pieces.includes(piece))));
          if (restorable && held.kind === "funded") {
            balance = funded([...pieces, ...held.amounts]);
          } else if (balance.kind === "empty") {
            balance = held;
          } else {
            add(
              [...effect.path, "transferId"],
              `verb ${verb} restores a held ${accountLabel} balance on top of existing value`,
            );
            balance = UNKNOWN;
          }
        }
      }
      if (effect.kind === "post" && reservation?.destination === account) {
        if (balance.kind !== "empty" || Object.keys(holds).length > 0) {
          add(
            [...effect.path, "transferId"],
            `verb ${verb} posts funding into ${accountLabel} while earlier value may remain`,
          );
          balance = UNKNOWN;
        } else {
          balance = { kind: "funded", amounts: [effect.amount] };
        }
      }
      continue;
    }
    if (effect.kind === "refund") {
      const refundable = `fields.${noun.unwind?.refundableField ?? ""}`;
      if (
        balance.kind !== "funded" ||
        balance.amounts.length !== 1 ||
        balance.amounts[0] !== refundable
      ) {
        fail(
          `cannot refund ${refundable} from ${accountLabel}; that exact balance is not guaranteed`,
        );
        balance = UNKNOWN;
      } else {
        balance =
          effect.amount === "refund_without_penalty"
            ? EMPTY
            : { kind: "penalty" };
      }
      continue;
    }
    if (effect.kind === "penalty_debit") {
      if (balance.kind !== "penalty") {
        fail(
          `cannot pay refs.unwindPenalty from ${accountLabel} before the refund leaves that exact remainder`,
        );
      }
      balance = EMPTY;
      continue;
    }
    if (effect.kind === "dynamic_debit") {
      if (balance.kind === "empty") {
        fail(`can debit unfunded ${accountLabel}`);
      } else if (balance.kind === "penalty") {
        fail(
          `can debit ${accountLabel} after its refund left only refs.unwindPenalty`,
        );
      }
      balance = balance.kind === "empty" ? EMPTY : { kind: "unknown" };
      continue;
    }
    if (balance.kind === "funded" && balance.amounts.includes(effect.amount)) {
      balance = funded(withoutPiece(balance.amounts, effect.amount));
      continue;
    }
    if (balance.kind === "empty") {
      fail(`can debit unfunded ${accountLabel}`);
    } else if (balance.kind === "penalty") {
      fail(
        `can debit ${accountLabel} after its refund left only refs.unwindPenalty`,
      );
    } else if (balance.kind === "funded" || exactBalance) {
      fail(
        `cannot prove ${effect.amount} is the exact available balance of ${accountLabel}`,
      );
    }
    balance = EMPTY;
  }
  return { balance, holds };
}

function validatePenaltyPayout(
  noun: FinancialNoun,
  refundSource: string | undefined,
  required: boolean,
  add: (path: readonly PropertyKey[], message: string) => void,
): void {
  const uses = Object.entries(noun.verbs).flatMap(([verbName, verb]) =>
    (verb.moves ?? []).flatMap((step, stepIndex) =>
      Object.entries(step.bind).flatMap(([target, binding]) =>
        binding.from === "instance" && binding.path === "refs.unwindPenalty"
          ? [{ binding, step, stepIndex, target, verb, verbName }]
          : [],
      ),
    ),
  );
  if (required && uses.length !== 1) {
    add(
      ["verbs"],
      `refs.unwindPenalty is consumed ${uses.length} times; a nonzero penalty schedule requires exactly one payout`,
    );
  }
  if (uses.length === 0) return;
  if (uses.length !== 1) {
    if (!required) {
      add(
        ["verbs"],
        `refs.unwindPenalty is consumed ${uses.length} times; it may fund at most one payout`,
      );
    }
    return;
  }

  const use = uses[0] as (typeof uses)[number];
  const payoutTransition = noun.lifecycle.transitions[use.verbName];
  const confirmTarget = noun.lifecycle.transitions[noun.unwind!.confirm]?.to;
  const source = canonicalAccount(noun, use.step.bind.sourceAccountId);
  const destination = canonicalAccount(
    noun,
    use.step.bind.destinationAccountId,
  );
  const directAfterConfirm =
    confirmTarget !== undefined &&
    payoutTransition?.from.length === 1 &&
    payoutTransition.from[0] === confirmTarget;
  const oneWay =
    payoutTransition !== undefined &&
    payoutTransition.to !== confirmTarget &&
    !stateCanReach(noun, payoutTransition.to, confirmTarget);
  const valid =
    use.target === "amount" &&
    use.step.operation === "internal_transfer.create" &&
    (use.verb.moves?.length ?? 0) === 1 &&
    directAfterConfirm &&
    oneWay &&
    source !== undefined &&
    source === refundSource &&
    destination !== undefined &&
    !accountsMayAlias(source, destination);
  if (!valid) {
    add(
      ["verbs", use.verbName, "moves", use.stepIndex, "bind", use.target],
      `refs.unwindPenalty must be the amount of one internal transfer from the unwind refund source to a different account, in its own one-way verb directly after ${noun.unwind!.confirm}`,
    );
  }
}

function canonicalAccount(
  noun: FinancialNoun,
  binding: UdlBinding | undefined,
): string | undefined {
  if (binding?.from !== "instance") return undefined;
  const [root, key, extra] = binding.path.split(".");
  if (!key || extra !== undefined) return undefined;
  if (root === "fields") return `field:${key}`;
  if (root === "refs") return `ref:${key}`;
  if (root === "party") {
    const field =
      noun.parties?.[key as keyof NonNullable<FinancialNoun["parties"]>];
    return field ? `field:${field}` : undefined;
  }
  return undefined;
}

function accountsMayAlias(left: string, right: string): boolean {
  if (left.startsWith("field:") && right.startsWith("field:")) return true;
  return left === right;
}

function amountIdentity(binding: UdlBinding | undefined): string {
  if (binding?.from === "instance") return binding.path;
  return binding?.from === "const" ? `const:${binding.value}` : "dynamic";
}

function transferRefKey(step: FinancialStep): string | undefined {
  return Object.entries(step.capture ?? {}).find(
    ([, result]) => result === "transferId",
  )?.[0];
}

function boundTransferRefKey(step: FinancialStep): string | undefined {
  const binding = step.bind.transferId;
  return binding?.from === "instance" && binding.path.startsWith("refs.")
    ? binding.path.slice("refs.".length)
    : undefined;
}

function stateCanReach(
  noun: FinancialNoun,
  start: string,
  target: string | undefined,
): boolean {
  if (!target) return false;
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length > 0) {
    const state = pending.shift() as string;
    if (state === target) return true;
    for (const transition of Object.values(noun.lifecycle.transitions)) {
      if (!transition.from.includes(state) || seen.has(transition.to)) continue;
      seen.add(transition.to);
      pending.push(transition.to);
    }
  }
  return false;
}

function stateKey(state: AccountState): string {
  return JSON.stringify({
    balance: state.balance,
    holds: Object.fromEntries(
      Object.entries(state.holds).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
}

function formatAccount(account: string): string {
  const [kind, key] = account.split(":");
  return `${kind === "field" ? "fields" : "refs"}.${key}`;
}
