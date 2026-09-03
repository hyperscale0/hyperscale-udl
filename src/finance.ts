import type { UdlBinding } from "./schema.js";
import { UDL_LIMITS } from "./limits.js";
import type { UdlIssueCode } from "./diagnostics.js";

export interface FinanceIssue {
  readonly code: UdlIssueCode;
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

interface FinancialInstrument {
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
  readonly actions: Readonly<
    Record<
      string,
      {
        readonly commit?: string | undefined;
        readonly moves?: readonly FinancialMove[];
        readonly quote?:
          | {
              readonly baseField: string;
              readonly chargeRef: string;
              readonly charges: readonly { readonly bps: number }[];
              readonly netRef: string;
            }
          | undefined;
        readonly steps: readonly FinancialStep[];
      }
    >
  >;
}

/**
 * One quote-commit pair, flattened for the typestate. The quoting action prices
 * `baseField` into the charge and the net; the committing action spends the net
 * out of the account that funded the base.
 */
interface QuoteFacts {
  readonly baseField: string;
  readonly chargeRef: string;
  readonly chargeCanBeNonzero: boolean;
  readonly commit: string;
  readonly netRef: string;
  readonly quoting: string;
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
  /** The quoted base a refund effect returns; absent on every other kind. */
  readonly refundable?: string;
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
 * One financial typestate owner for canonical UDL and static instrument contracts.
 * It proves a tracked escrow account holds an exact set of funded amounts,
 * models held transfers through reserve/post/void, consumes every direct
 * debit piece by piece, and makes the quoted refund's sole remainder an
 * exactly-once penalty payout.
 */
export function analyzeInstrumentFinance(
  instrument: FinancialInstrument,
  options: FinanceOptions = {},
): readonly FinanceIssue[] {
  const issues: FinanceIssue[] = [];
  const seenIssues = new Set<string>();
  const add = (
    path: readonly PropertyKey[],
    message: string,
    code: UdlIssueCode = "UDL4001",
  ): void => {
    const key = `${path.join(".")}\0${message}`;
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push({ code, message, path });
  };

  const admissionProblem = financeAdmissionProblem(instrument);
  if (admissionProblem) {
    add(["lifecycle"], admissionProblem, "UDL1004");
    return issues;
  }

  const trackedAccounts = productEscrowAccounts(instrument);
  const quotes = quoteFacts(instrument, options);
  const refundSources = new Map<string, string>();
  for (const quote of quotes) {
    const commitTransfer = instrument.actions[quote.commit]?.moves?.filter(
      (move) => move.operation === "internal_transfer.create",
    )[0];
    const source = canonicalAccount(
      instrument,
      commitTransfer?.bind.sourceAccountId,
    );
    if (!source) continue;
    refundSources.set(quote.commit, source);
    trackedAccounts.add(source);
  }
  const refundSourceAccounts = new Set(refundSources.values());
  if (trackedAccounts.size === 0) return [];
  if (trackedAccounts.size > UDL_LIMITS.financeAccounts) {
    add(
      ["actions"],
      `financial analysis exceeds ${UDL_LIMITS.financeAccounts} tracked accounts`,
      "UDL1004",
    );
    return issues;
  }

  const reservations = reservationsByKey(instrument);
  for (const quote of quotes) {
    validateChargePayout(
      instrument,
      quote,
      refundSources.get(quote.commit),
      add,
    );
  }

  let pathVariants = 0;
  let work = 0;
  for (const account of trackedAccounts) {
    const effects = effectsByAction(instrument, account, reservations, quotes);
    const createEffects = effects.get("create") ?? [];
    work += 1 + createEffects.length;
    if (work > UDL_LIMITS.financeWork) {
      add(
        ["lifecycle"],
        `financial analysis exceeds ${UDL_LIMITS.financeWork} deterministic work units`,
        "UDL1004",
      );
      return issues;
    }
    const initial = applyEffects(
      account,
      "create",
      { balance: EMPTY, holds: {} },
      createEffects,
      reservations,
      refundSourceAccounts.has(account),
      add,
    );
    const states = new Map<string, Map<string, AccountState>>([
      [instrument.lifecycle.initial, new Map([[stateKey(initial), initial]])],
    ]);
    pathVariants += 1;
    const pending = [instrument.lifecycle.initial];
    while (pending.length > 0) {
      const from = pending.shift() as string;
      const sourceStates = states.get(from);
      if (!sourceStates) continue;
      for (const [action, transition] of Object.entries(
        instrument.lifecycle.transitions,
      )) {
        if (!transition.from.includes(from)) continue;
        const targetStates = states.get(transition.to) ?? new Map();
        states.set(transition.to, targetStates);
        let grew = false;
        for (const sourceState of sourceStates.values()) {
          const transitionEffects = effects.get(action) ?? [];
          work += 1 + transitionEffects.length;
          if (work > UDL_LIMITS.financeWork) {
            add(
              ["lifecycle"],
              `financial analysis exceeds ${UDL_LIMITS.financeWork} deterministic work units`,
              "UDL1004",
            );
            return issues;
          }
          const targetState = applyEffects(
            account,
            action,
            sourceState,
            transitionEffects,
            reservations,
            refundSourceAccounts.has(account),
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
              "UDL1004",
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
      Object.values(instrument.lifecycle.transitions).flatMap(
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
          ["lifecycle", "states", instrument.lifecycle.states.indexOf(state)],
          `terminal state ${state} can strand value in ${formatAccount(account)}`,
        );
      }
    }
  }

  return issues;
}

export function financeAdmissionProblem(
  instrument: FinancialInstrument,
): string | undefined {
  if (instrument.lifecycle.states.length > UDL_LIMITS.financeStates) {
    return `financial analysis exceeds ${UDL_LIMITS.financeStates} lifecycle states`;
  }
  let transitionCount = 0;
  let transitionEdges = 0;
  for (const name in instrument.lifecycle.transitions) {
    if (!Object.hasOwn(instrument.lifecycle.transitions, name)) continue;
    transitionCount += 1;
    if (transitionCount > UDL_LIMITS.financeTransitions) {
      return `financial analysis exceeds ${UDL_LIMITS.financeTransitions} lifecycle transitions`;
    }
    transitionEdges += instrument.lifecycle.transitions[name]?.from.length ?? 0;
    if (transitionEdges > UDL_LIMITS.financeTransitionEdges) {
      return `financial analysis exceeds ${UDL_LIMITS.financeTransitionEdges} lifecycle transition edges`;
    }
  }
  let actionCount = 0;
  let effectCount = 0;
  for (const name in instrument.actions) {
    if (!Object.hasOwn(instrument.actions, name)) continue;
    actionCount += 1;
    if (actionCount > UDL_LIMITS.financeActions) {
      return `financial analysis exceeds ${UDL_LIMITS.financeActions} actions`;
    }
    const action = instrument.actions[name];
    effectCount += (action?.steps.length ?? 0) + (action?.moves?.length ?? 0);
    if (effectCount > UDL_LIMITS.financeEffects) {
      return `financial analysis exceeds ${UDL_LIMITS.financeEffects} kernel effects`;
    }
  }
  return undefined;
}

function productEscrowAccounts(instrument: FinancialInstrument): Set<string> {
  const accounts = new Set<string>();
  for (const action of Object.values(instrument.actions)) {
    for (const step of action.steps) {
      if (
        step.operation !== "account.escrow.provision" ||
        step.bind.role?.from !== "const" ||
        step.bind.role.value !== "product_escrow"
      ) {
        continue;
      }
      for (const [key, result] of Object.entries(step.capture ?? {})) {
        if (result === "accountId") accounts.add(`ref:${key}`);
      }
    }
  }

  // `product_escrow` also backs open-ended balance products such as wallets.
  // Only instance-bound amounts claim static conservation; caller-sized flows
  // remain runtime balance checks. Commit sources are added separately above.
  return new Set(
    [...accounts].filter((account) =>
      Object.values(instrument.actions).some((action) =>
        (action.moves ?? []).some((step) => {
          if (
            (step.operation !== "internal_transfer.create" &&
              step.operation !== "internal_transfer.reserve") ||
            step.bind.amount?.from !== "instance"
          ) {
            return false;
          }
          return (
            canonicalAccount(instrument, step.bind.sourceAccountId) ===
              account ||
            canonicalAccount(instrument, step.bind.destinationAccountId) ===
              account
          );
        }),
      ),
    ),
  );
}

function reservationsByKey(
  instrument: FinancialInstrument,
): ReadonlyMap<string, Reservation> {
  const reservations = new Map<string, Reservation>();
  for (const action of Object.values(instrument.actions)) {
    for (const step of action.moves ?? []) {
      if (step.operation !== "internal_transfer.reserve") continue;
      const source = canonicalAccount(instrument, step.bind.sourceAccountId);
      const destination = canonicalAccount(
        instrument,
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

function effectsByAction(
  instrument: FinancialInstrument,
  account: string,
  reservations: ReadonlyMap<string, Reservation>,
  quotes: readonly QuoteFacts[],
): ReadonlyMap<string, readonly Effect[]> {
  const quoteByCommit = new Map(quotes.map((quote) => [quote.commit, quote]));
  const chargePaths = new Map(
    quotes.map((quote) => [`refs.${quote.chargeRef}`, quote]),
  );
  return new Map(
    Object.entries(instrument.actions).map(([actionName, action]) => [
      actionName,
      (action.moves ?? []).flatMap((step, stepIndex) => {
        const path = [
          "actions",
          actionName,
          "moves",
          stepIndex,
          "bind",
        ] as const;
        if (step.operation === "internal_transfer.create") {
          const effects: Effect[] = [];
          const amount = amountIdentity(step.bind.amount);
          if (
            canonicalAccount(instrument, step.bind.destinationAccountId) ===
            account
          ) {
            effects.push({ amount, kind: "credit", path });
          }
          const source = canonicalAccount(
            instrument,
            step.bind.sourceAccountId,
          );
          if (source && accountsMayAlias(source, account)) {
            const committed = quoteByCommit.get(actionName);
            const amountPath =
              step.bind.amount?.from === "instance"
                ? step.bind.amount.path
                : undefined;
            const refunded =
              committed && amountPath === `refs.${committed.netRef}`
                ? committed
                : undefined;
            const charged = amountPath
              ? chargePaths.get(amountPath)
              : undefined;
            const kind = refunded
              ? "refund"
              : charged
                ? "penalty_debit"
                : amountPath !== undefined
                  ? "debit"
                  : "dynamic_debit";
            effects.push({
              amount:
                refunded && !refunded.chargeCanBeNonzero
                  ? "refund_without_penalty"
                  : amount,
              kind,
              path,
              ...(refunded ? { refundable: refunded.baseField } : {}),
            });
          }
          return effects;
        }
        if (step.operation === "internal_transfer.reserve") {
          const reservation =
            transferRefKey(step) ?? `${actionName}:${stepIndex}`;
          const effects: Effect[] = [];
          const source = canonicalAccount(
            instrument,
            step.bind.sourceAccountId,
          );
          if (source && accountsMayAlias(source, account)) {
            effects.push({
              amount: amountIdentity(step.bind.amount),
              kind: "outgoing_reserve",
              path,
              reservation,
            });
          }
          if (
            canonicalAccount(instrument, step.bind.destinationAccountId) ===
            account
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
  account: string,
  action: string,
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
      add([...effect.path, "sourceAccountId"], `action ${action} ${message}`);
    if (effect.kind === "credit") {
      if (
        exactBalance &&
        (balance.kind !== "empty" || Object.keys(holds).length > 0)
      ) {
        add(
          [...effect.path, "destinationAccountId"],
          `action ${action} funds ${accountLabel} while earlier value may remain; quoted funding must establish exactly one refundable balance`,
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
              `action ${action} restores a held ${accountLabel} balance on top of existing value`,
            );
            balance = UNKNOWN;
          }
        }
      }
      if (effect.kind === "post" && reservation?.destination === account) {
        if (balance.kind !== "empty" || Object.keys(holds).length > 0) {
          add(
            [...effect.path, "transferId"],
            `action ${action} posts funding into ${accountLabel} while earlier value may remain`,
          );
          balance = UNKNOWN;
        } else {
          balance = { kind: "funded", amounts: [effect.amount] };
        }
      }
      continue;
    }
    if (effect.kind === "refund") {
      const refundable = `fields.${effect.refundable ?? ""}`;
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
          `cannot pay the quoted charge from ${accountLabel} before the refund leaves that exact remainder`,
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
          `can debit ${accountLabel} after its refund left only the quoted charge`,
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
        `can debit ${accountLabel} after its refund left only the quoted charge`,
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

/**
 * Flattens every quote-commit pair the instrument declares. A quoting action
 * with no committing action, or a commit naming a non-quoting action, is a
 * validator failure rather than a typestate one, so it is simply skipped here.
 */
function quoteFacts(
  instrument: FinancialInstrument,
  options: FinanceOptions,
): readonly QuoteFacts[] {
  const facts: QuoteFacts[] = [];
  for (const [quoting, action] of Object.entries(instrument.actions)) {
    const quote = action.quote;
    if (!quote) continue;
    const commit = Object.entries(instrument.actions).find(
      ([, candidate]) => candidate.commit === quoting,
    )?.[0];
    if (commit === undefined) continue;
    const chargePath = `refs.${quote.chargeRef}`;
    const declaresChargePayout = Object.values(instrument.actions).some(
      (candidate) =>
        (candidate.moves ?? []).some((move) =>
          Object.values(move.bind).some(
            (binding) =>
              binding.from === "instance" && binding.path === chargePath,
          ),
        ),
    );
    facts.push({
      baseField: quote.baseField,
      chargeCanBeNonzero:
        options.penaltyMayBeNonzero === true ||
        declaresChargePayout ||
        quote.charges.some((tier) => tier.bps > 0),
      chargeRef: quote.chargeRef,
      commit,
      netRef: quote.netRef,
      quoting,
    });
  }
  return facts;
}

/**
 * The quoted charge is the exact remainder the commit leaves behind, so it may
 * fund one transfer, out of the same account the refund left, in its own
 * one-way action directly after the commit.
 */
function validateChargePayout(
  instrument: FinancialInstrument,
  quote: QuoteFacts,
  refundSource: string | undefined,
  add: (path: readonly PropertyKey[], message: string) => void,
): void {
  const chargePath = `refs.${quote.chargeRef}`;
  const uses = Object.entries(instrument.actions).flatMap(
    ([actionName, action]) =>
      (action.moves ?? []).flatMap((step, stepIndex) =>
        Object.entries(step.bind).flatMap(([target, binding]) =>
          binding.from === "instance" && binding.path === chargePath
            ? [{ binding, step, stepIndex, target, action, actionName }]
            : [],
        ),
      ),
  );
  if (quote.chargeCanBeNonzero && uses.length !== 1) {
    add(
      ["actions"],
      `${chargePath} is consumed ${uses.length} times; a nonzero charge schedule requires exactly one payout`,
    );
  }
  if (uses.length === 0) return;
  if (uses.length !== 1) {
    if (!quote.chargeCanBeNonzero) {
      add(
        ["actions"],
        `${chargePath} is consumed ${uses.length} times; it may fund at most one payout`,
      );
    }
    return;
  }

  const use = uses[0] as (typeof uses)[number];
  const payoutTransition = instrument.lifecycle.transitions[use.actionName];
  const commitTarget = instrument.lifecycle.transitions[quote.commit]?.to;
  const source = canonicalAccount(instrument, use.step.bind.sourceAccountId);
  const destination = canonicalAccount(
    instrument,
    use.step.bind.destinationAccountId,
  );
  const directAfterCommit =
    commitTarget !== undefined &&
    payoutTransition?.from.length === 1 &&
    payoutTransition.from[0] === commitTarget;
  const oneWay =
    payoutTransition !== undefined &&
    payoutTransition.to !== commitTarget &&
    !stateCanReach(instrument, payoutTransition.to, commitTarget);
  const valid =
    use.target === "amount" &&
    use.step.operation === "internal_transfer.create" &&
    (use.action.moves?.length ?? 0) === 1 &&
    directAfterCommit &&
    oneWay &&
    source !== undefined &&
    source === refundSource &&
    destination !== undefined &&
    !accountsMayAlias(source, destination);
  if (!valid) {
    add(
      ["actions", use.actionName, "moves", use.stepIndex, "bind", use.target],
      `${chargePath} must be the amount of one internal transfer from the quoted refund source to a different account, in its own one-way action directly after ${quote.commit}`,
    );
  }
}

function canonicalAccount(
  instrument: FinancialInstrument,
  binding: UdlBinding | undefined,
): string | undefined {
  if (binding?.from !== "instance") return undefined;
  const [root, key, extra] = binding.path.split(".");
  if (!key || extra !== undefined) return undefined;
  if (root === "fields") return `field:${key}`;
  if (root === "refs") return `ref:${key}`;
  if (root === "party") {
    const field =
      instrument.parties?.[
        key as keyof NonNullable<FinancialInstrument["parties"]>
      ];
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
  instrument: FinancialInstrument,
  start: string,
  target: string | undefined,
): boolean {
  if (!target) return false;
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length > 0) {
    const state = pending.shift() as string;
    if (state === target) return true;
    for (const transition of Object.values(instrument.lifecycle.transitions)) {
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
