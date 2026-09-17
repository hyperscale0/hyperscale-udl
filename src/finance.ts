import type {
  UdlAction,
  UdlDocument,
  UdlInstrument,
  UdlValue,
} from "./schema.js";

export interface FinanceIssue {
  path: string;
  message: string;
}
type Sum = Map<string, bigint>;
type Balance = Sum | null;
interface Hold {
  from: string;
  to: string;
  amount: Balance;
}
interface State {
  status: string;
  balances: Map<string, Balance>;
  holds: Map<string, Hold>;
}
const add = (a: Balance, b: Balance, sign = 1n): Balance => {
  if (a === null || b === null) return null;
  const result = new Map(a);
  for (const [key, value] of b) {
    const next = (result.get(key) ?? 0n) + value * sign;
    if (next) result.set(key, next);
    else result.delete(key);
  }
  return result;
};
const show = (sum: Balance): string =>
  sum === null
    ? "unknown"
    : JSON.stringify(
        [...sum]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, String(value)]),
      );
const same = (a: Balance, b: Balance) => show(a) === show(b);

/** Join loop balances conservatively; a balance equality proves an unknown balance empty. */
export function analyzeInstrumentFinance(
  instrument: UdlInstrument,
  document?: UdlDocument,
): FinanceIssue[] {
  const owned = new Set(
    instrument.fields
      .filter((f) => f.type === "account" && f.owner === "self")
      .map((f) => `self.${f.name}`),
  );
  const shared = new Set<string>();
  for (const owner of document?.instruments ?? []) {
    if (owner.id === instrument.id) continue;
    for (const action of Object.values(owner.actions))
      for (const move of action.moves)
        if ("amount" in move)
          for (const endpoint of [move.from, move.to]) {
            const parts = endpoint.split(".");
            if (parts.shift() !== "self") continue;
            let targets = [owner];
            while (parts.length > 1) {
              const key = parts.shift();
              targets = targets.flatMap((target) => {
                const reference = target.fields.find(
                  (field) => field.name === key,
                );
                if (reference?.type !== "ref") return [];
                const ids =
                  typeof reference.target === "string"
                    ? [reference.target]
                    : reference.target;
                return (
                  document?.instruments.filter((candidate) =>
                    ids.includes(candidate.id),
                  ) ?? []
                );
              });
            }
            if (
              parts.length === 1 &&
              targets.some((target) => target.id === instrument.id) &&
              owned.has(`self.${parts[0]}`)
            )
              shared.add(`self.${parts[0]}`);
          }
  }
  const problems: FinanceIssue[] = [];
  const report = (message: string) =>
    problems.push({ path: ".actions", message });
  const equations = new Map<string, Sum>();
  for (const field of instrument.fields)
    if (field.type === "money" && field.value !== undefined)
      equations.set(
        `self.${field.name}`,
        new Map([["#", BigInt(field.value)]]),
      );
  for (const calc of instrument.calculate) {
    if (calc.op === "sum" || calc.op === "subtract") {
      const terms =
        calc.op === "sum"
          ? calc.values.map((v) => [v, 1n] as const)
          : [
              [calc.base, 1n] as const,
              ...calc.subtract.map((v) => [v, -1n] as const),
            ];
      let result: Balance = new Map();
      for (const [value, sign] of terms)
        result = add(result, raw(value, "create"), sign);
      equations.set(`self.${calc.target}`, result!);
    }
  }
  function raw(value: UdlValue, invocation: string): Sum {
    return "field" in value
      ? new Map([
          [
            value.field.startsWith("input.")
              ? `${invocation}:${value.field}`
              : value.field,
            1n,
          ],
        ])
      : new Map([["#", BigInt(String(value.literal))]]);
  }
  function expand(sum: Sum, seen = new Set<string>()): Sum {
    let result: Balance = new Map();
    for (const [key, coefficient] of sum) {
      const equation = equations.get(key);
      result = add(
        result,
        equation && !seen.has(key)
          ? expand(equation, new Set([...seen, key]))
          : new Map([[key, 1n]]),
        coefficient,
      );
    }
    return result!;
  }
  let invocation = 0;
  const apply = (state: State, action: UdlAction, name: string): void => {
    const scope = `${name}#${invocation++}`;
    const calculated = new Map<string, Balance>();
    const local = new Map(
      (action.calculate ?? []).map((c) => [`self.${c.target}`, c]),
    );
    const amount = (value: UdlValue, seen = new Set<string>()): Balance => {
      if ("field" in value) {
        if (calculated.has(value.field)) return calculated.get(value.field)!;
        if (
          value.field.endsWith(".balance") &&
          owned.has(value.field.slice(0, -8))
        )
          return state.balances.get(value.field.slice(0, -8)) ?? null;
        const calculation = local.get(value.field);
        if (calculation && !seen.has(value.field)) {
          const next = new Set([...seen, value.field]);
          if (calculation.op === "sum")
            return calculation.values.reduce<Balance>(
              (sum, value) => add(sum, amount(value, next)),
              new Map(),
            );
          if (calculation.op === "subtract")
            return calculation.subtract.reduce<Balance>(
              (sum, value) => add(sum, amount(value, next), -1n),
              amount(calculation.base, next),
            );
          return new Map([[`${scope}:${value.field}`, 1n]]);
        }
      }
      return expand(raw(value, scope));
    };
    for (const requirement of action.requires)
      if (requirement.kind === "compare" && requirement.operator === "==") {
        for (const [left, right] of [
          [requirement.left, requirement.right],
          [requirement.right, requirement.left],
        ] as const) {
          if ("field" in left && left.field.endsWith(".balance")) {
            const account = left.field.slice(0, -8);
            if (owned.has(account)) state.balances.set(account, amount(right));
          }
        }
      }
    for (const key of local.keys()) calculated.set(key, amount({ field: key }));
    const debit = (account: string, value: Balance) => {
      if (owned.has(account))
        state.balances.set(
          account,
          add(
            state.balances.has(account)
              ? state.balances.get(account)!
              : new Map(),
            value,
            -1n,
          ),
        );
    };
    const credit = (account: string, value: Balance) => {
      if (owned.has(account))
        state.balances.set(
          account,
          add(
            state.balances.has(account)
              ? state.balances.get(account)!
              : new Map(),
            value,
          ),
        );
    };
    for (const move of action.moves) {
      if ("amount" in move) {
        const value = amount(move.amount);
        debit(move.from, value);
        if (move.operation === "internal_transfer.reserve") {
          const key = `self.${move.capture}`;
          if (state.holds.has(key))
            report(`${move.capture} overwrites a live reservation`);
          state.holds.set(key, { from: move.from, to: move.to, amount: value });
        } else credit(move.to, value);
      } else {
        const hold = state.holds.get(move.transfer);
        if (!hold) {
          report(`${move.key} consumes a missing reservation ${move.transfer}`);
          continue;
        }
        credit(
          move.operation === "internal_transfer.post" ? hold.to : hold.from,
          hold.amount,
        );
        state.holds.delete(move.transfer);
      }
    }
    if (
      Object.keys(action.set ?? {}).some((key) =>
        instrument.fields.some((f) => f.name === key && f.type === "money"),
      )
    ) {
      for (const account of owned) state.balances.set(account, null);
    }
  };
  const initial: State = {
    status: instrument.lifecycle.initial,
    balances: new Map([...owned].map((key) => [key, new Map()])),
    holds: new Map(),
  };
  if (instrument.actions.create)
    apply(initial, instrument.actions.create, "create");
  const pending = [initial];
  const reached = new Map<string, State>();
  const copy = (state: State): State => ({
    status: state.status,
    balances: new Map(state.balances),
    holds: new Map([...state.holds].map(([key, hold]) => [key, { ...hold }])),
  });
  let work = 0;
  while (pending.length && !problems.length) {
    if (++work > 4096) {
      report("owned proof exceeds its finite work budget");
      break;
    }
    let state = pending.pop()!;
    const key = JSON.stringify([state.status, [...state.holds.keys()].sort()]);
    const previous = reached.get(key);
    if (previous) {
      const joined = copy(previous);
      let changed = false;
      for (const account of owned) {
        const before = previous.balances.has(account)
          ? previous.balances.get(account)!
          : new Map();
        const after = state.balances.has(account)
          ? state.balances.get(account)!
          : new Map();
        if (before !== null && !same(before, after)) {
          joined.balances.set(account, null);
          changed = true;
        }
      }
      for (const [name, hold] of joined.holds) {
        const next = state.holds.get(name)!;
        if (hold.from !== next.from || hold.to !== next.to) {
          report(`${name} changes reservation endpoints across paths`);
          break;
        }
        if (hold.amount !== null && !same(hold.amount, next.amount)) {
          hold.amount = null;
          changed = true;
        }
      }
      if (!changed) continue;
      state = joined;
    }
    if (reached.size >= 256 && !previous) {
      report("owned proof exceeds 256 state and reservation combinations");
      break;
    }
    reached.set(key, copy(state));
    const edges = Object.entries(instrument.lifecycle.transitions).filter(
      ([, edge]) => edge.from.includes(state.status),
    );
    if (
      !edges.length &&
      ([...state.balances].some(
        ([account, balance]) =>
          !shared.has(account) && (balance === null || balance.size > 0),
      ) ||
        state.holds.size)
    )
      report(
        `terminal state ${state.status} may strand owned money or an open reservation`,
      );
    for (const [name, edge] of edges) {
      const action = instrument.actions[name];
      if (!action) continue;
      const next = copy(state);
      next.status = edge.to;
      apply(next, action, name);
      pending.push(next);
    }
  }
  return problems;
}
