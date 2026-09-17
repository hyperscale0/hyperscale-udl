import {
  udlDocumentSchema,
  type UdlDocument,
  type UdlField,
  type UdlInstrument,
  type UdlValue,
  type UdlCalculation,
  type UdlSelection,
} from "./schema.js";
import { issue, type UdlIssue } from "./diagnostics.js";
import { analyzeInstrumentFinance } from "./finance.js";

export type UdlValidationResult =
  | { ok: true; value: UdlDocument }
  | { ok: false; issues: readonly UdlIssue[] };
export class UdlError extends Error {
  constructor(readonly issues: readonly UdlIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
    this.name = "UdlError";
  }
}

/** Reject cycles and oversized structures before the schema walks caller data. */
function bounded(value: unknown): boolean {
  const active = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (++nodes > 100000 || depth > 32) return false;
    if (typeof v === "string") {
      bytes += v.length;
      return bytes <= 1048576;
    }
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isSafeInteger(v);
    if (typeof v !== "object" || active.has(v)) return false;
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      return false;
    active.add(v);
    const ok = Object.entries(v).every(
      ([key, entry]) => key.length <= 240 && visit(entry, depth + 1),
    );
    active.delete(v);
    return ok;
  };
  return visit(value, 0);
}

const targetIds = (target: string | string[]): string[] =>
  typeof target === "string" ? [target] : target;
const overlap = (a: string | string[], b: string | string[]) =>
  targetIds(a).some((id) => targetIds(b).includes(id));

/** Union paths retain only fields with compatible types on every member. */
function commonField(fields: (UdlField | undefined)[]): UdlField | undefined {
  const first = fields[0];
  if (
    !first ||
    fields.some(
      (field) =>
        !field ||
        field.type !== first.type ||
        field.optional !== first.optional,
    )
  )
    return;
  if (first.type === "ref") {
    const targets = [
      ...new Set(
        fields.flatMap((field) =>
          field?.type === "ref" ? targetIds(field.target) : [],
        ),
      ),
    ];
    return { ...first, target: targets.length === 1 ? targets[0]! : targets };
  }
  if (
    first.type === "account" &&
    fields.some(
      (field) =>
        field?.type !== "account" ||
        field.book !== first.book ||
        field.owner !== first.owner ||
        field.key !== first.key ||
        field.external !== first.external ||
        field.contra !== first.contra,
    )
  )
    return;
  if (
    first.type === "enum" &&
    fields.some(
      (field) =>
        field?.type !== "enum" ||
        field.values.length !== first.values.length ||
        field.values.some((value) => !first.values.includes(value)),
    )
  )
    return;
  if (
    first.type === "list" &&
    fields.some(
      (field) =>
        field?.type !== "list" ||
        field.item !== first.item ||
        field.target !== first.target,
    )
  )
    return;
  return first;
}

export function resolveField(
  document: UdlDocument,
  instrument: UdlInstrument,
  path: string,
  input: readonly UdlField[] = [],
): UdlField | undefined {
  return resolvePath(document, instrument, path, input, new Map());
}

function resolvePath(
  document: UdlDocument,
  instrument: UdlInstrument,
  path: string,
  input: readonly UdlField[],
  cache: Map<string, UdlField | undefined>,
): UdlField | undefined {
  const parts = path.split(".");
  const root = parts.shift();
  const key = parts.shift();
  if (!key)
    return root === "self"
      ? { name: "id", type: "ref", target: instrument.id }
      : undefined;
  if (root === "party") {
    if (!document.parties[key]) return;
    if (parts.length === 0)
      return { name: key, type: "account", owner: key, book: "cash" };
    if (parts.length === 1 && ["balance", "reserved"].includes(parts[0]!))
      return { name: parts[0]!, type: "money" };
    return;
  }
  if (root === "self" && parts.length === 0) {
    if (key === "id") return { name: key, type: "ref", target: instrument.id };
    if (key === "now" || key === "createdAt")
      return { name: key, type: "date" };
    if (key === "status")
      return { name: key, type: "enum", values: instrument.lifecycle.states };
  }
  const scope = instrument;
  let field = (
    root === "self" ? instrument.fields : root === "input" ? input : []
  ).find((f) => f.name === key);
  for (const [index, part] of parts.entries()) {
    if (
      field?.type === "account" &&
      ["balance", "reserved"].includes(part) &&
      index === parts.length - 1
    )
      return { name: part, type: "money" };
    if (
      field?.type === "text" &&
      part === "status" &&
      index === parts.length - 1 &&
      Object.values(scope.actions).some((a) =>
        a.moves.some((m) => "capture" in m && m.capture === field?.name),
      )
    )
      return {
        name: part,
        type: "enum",
        values: ["reserved", "posted", "settled", "reversed", "voided"],
      };
    if (field?.type !== "ref") return;
    return commonField(
      targetIds(field.target).map((id) => {
        const target = document.instruments.find(
          (instrument) => instrument.id === id,
        );
        if (!target) return;
        const suffix = "self." + parts.slice(index).join(".");
        const key = `${id}:${suffix}`;
        if (!cache.has(key))
          cache.set(key, resolvePath(document, target, suffix, [], cache));
        return cache.get(key);
      }),
    );
  }
  return field;
}

export function validateUdl(value: unknown): UdlValidationResult {
  if (!bounded(value))
    return {
      ok: false,
      issues: [
        issue(
          "UDL1004",
          "$",
          "document exceeds structural limits or is not finite JSON",
        ),
      ],
    };
  const parsed = udlDocumentSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((i) =>
        issue(
          "UDL1003",
          "$" +
            i.path
              .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
              .join(""),
          i.message,
        ),
      ),
    };
  const document = parsed.data;
  const issues: UdlIssue[] = [];
  const add = (
    path: string,
    message: string,
    code: UdlIssue["code"] = "UDL2002",
  ) => issues.push(issue(code, path, message));
  const duplicate = (values: readonly string[], path: string) => {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) add(path, `duplicate ${v}`, "UDL2001");
      seen.add(v);
    }
  };
  duplicate(
    document.instruments.map((i) => i.id),
    "$.instruments",
  );
  const byId = new Map(document.instruments.map((i) => [i.id, i]));
  const calls = new Map<string, { targets: string[]; count: number }[]>();
  for (const [index, inst] of document.instruments.entries()) {
    const base = `$.instruments[${index}]`;
    const field = (p: string, input: readonly UdlField[] = []) =>
      resolveField(document, inst, p, input);
    const expect = (
      p: string,
      type: UdlField["type"],
      where: string,
      input: readonly UdlField[] = [],
    ) => {
      const found = field(p, input);
      if (found?.type !== type)
        add(where, `${p} must name a ${type} field`, "UDL5001");
      return found;
    };
    const checkValue = (
      v: UdlValue,
      type: UdlField["type"],
      where: string,
      input: readonly UdlField[] = [],
    ) => {
      if ("field" in v) {
        expect(v.field, type, where, input);
        return;
      }
      const valid =
        type === "money"
          ? typeof v.literal === "string" &&
            /^(0|[1-9][0-9]{0,17})$/.test(v.literal)
          : type === "integer" || type === "percent" || type === "duration"
            ? typeof v.literal === "number" &&
              Number.isSafeInteger(v.literal) &&
              (type !== "percent" || (v.literal >= 0 && v.literal <= 10000))
            : type === "boolean"
              ? typeof v.literal === "boolean"
              : typeof v.literal === "string";
      if (!valid) add(where, `literal must have type ${type}`);
    };
    const checkFields = (fields: readonly UdlField[], where: string) => {
      duplicate(
        fields.map((f) => f.name),
        where,
      );
      for (const f of fields) {
        if (
          f.type === "account" &&
          ((f.contra && f.book !== "claim") ||
            (f.external && (f.book !== "cash" || f.owner === "self")))
        )
          add(
            where,
            "contra accounts require the claim book; external accounts require a cash party owner",
          );
        if (["id", "status", "createdAt", "now"].includes(f.name))
          add(where, `${f.name} is a sealed instance field`);
        if (f.type === "ref") {
          duplicate(targetIds(f.target), where);
          for (const id of targetIds(f.target))
            if (!byId.has(id))
              add(where, `unknown reference target ${id}`, "UDL5001");
        }
        if (
          f.type === "account" &&
          f.owner !== "self" &&
          !document.parties[f.owner]
        )
          add(where, `${f.name} needs self or a declared party as owner`);
        if (f.type === "enum") {
          duplicate(f.values, where);
          if (f.value !== undefined && !f.values.includes(f.value))
            add(where, `${f.name} constant is outside its enum`);
        }
        if (
          f.type === "list" &&
          (f.item === "ref"
            ? !f.target || !byId.has(f.target)
            : f.target !== undefined)
        )
          add(
            where,
            `${f.name} needs a target exactly when its items are references`,
          );
        if (
          (f.type === "integer" || f.type === "money") &&
          f.minimum !== undefined &&
          f.maximum !== undefined &&
          BigInt(f.minimum) > BigInt(f.maximum)
        )
          add(where, `${f.name} minimum exceeds maximum`);
        if (
          (f.type === "integer" || f.type === "money") &&
          f.value !== undefined &&
          ((f.minimum !== undefined && BigInt(f.value) < BigInt(f.minimum)) ||
            (f.maximum !== undefined && BigInt(f.value) > BigInt(f.maximum)))
        )
          add(where, `${f.name} constant violates its bounds`);
      }
    };
    checkFields(inst.fields, `${base}.fields`);
    const captures = new Set(
      Object.values(inst.actions).flatMap((a) => [
        ...a.moves.flatMap((m) =>
          "capture" in m && m.capture ? [m.capture] : [],
        ),
      ]),
    );
    for (const captured of captures) {
      const target = inst.fields.find((f) => f.name === captured);
      if (target?.type !== "text" || target.value !== undefined)
        add(
          base,
          `${captured} must be a text field reserved for an executor receipt`,
        );
    }
    const checkSelection = (
      selection: UdlSelection,
      where: string,
      input: readonly UdlField[] = [],
    ) => {
      const ids =
        typeof selection.instrument === "string"
          ? [selection.instrument]
          : selection.instrument;
      duplicate(ids, where);
      const targets = ids.flatMap((id) => {
        const target = byId.get(id);
        if (!target) add(where, `unknown selected instrument ${id}`);
        return target ? [target] : [];
      });
      const compatible = (a: UdlField | undefined, b: UdlField | undefined) =>
        a &&
        b &&
        a.type === b.type &&
        (a.type !== "ref" || (b.type === "ref" && overlap(a.target, b.target)));
      const anchor = field(selection.anchor, input);
      for (const target of targets) {
        if (
          selection.window &&
          target.fields.find((f) => f.name === selection.window!.field)
            ?.type !== "date"
        )
          add(
            where,
            "selection window requires a date field on every selected instrument",
          );
        const reference = target.fields.find(
          (f) => f.name === selection.reference,
        );
        if (!compatible(reference, anchor))
          add(
            where,
            "selection reference and anchor must have the same declared type",
          );
        if (
          selection.states.some(
            (state) => !target.lifecycle.states.includes(state),
          )
        )
          add(where, `selection names an undeclared state on ${target.id}`);
        for (const key of selection.order ?? []) {
          const ordered = resolveField(document, target, `self.${key}`);
          if (!ordered || ["account", "ref", "list"].includes(ordered.type))
            add(where, `selection order needs a scalar path: ${key}`);
        }
        for (const [key, value] of Object.entries(selection.where ?? {})) {
          const selected = resolveField(
            document,
            target,
            key.startsWith("self.") ? key : `self.${key}`,
          );
          if (!selected) add(where, `unknown selected field ${key}`);
          else if ("field" in value) {
            if (!compatible(selected, field(value.field, input)))
              add(where, `selection filter ${key} has incompatible operands`);
          } else checkValue(value, selected.type, where, input);
        }
      }
      const first = targets[0];
      if (!first) return;
      return {
        ...first,
        fields: first.fields.flatMap((field) => {
          const shared = commonField(
            targets.map((target) =>
              target.fields.find((candidate) => candidate.name === field.name),
            ),
          );
          return shared ? [shared] : [];
        }),
      };
    };
    const checkCalculations = (
      calculations: readonly UdlCalculation[],
      where: string,
      input: readonly UdlField[] = [],
    ) => {
      duplicate(
        calculations.map((c) => c.target),
        where,
      );
      const dependencies = new Map<string, string[]>();
      for (const c of calculations) {
        const arithmetic = ["sum", "subtract", "minimum", "divide"].includes(
          c.op,
        );
        const resultType =
          c.op === "at"
            ? (() => {
                const list = field(c.list, input);
                return list?.type === "list" ? list.item : "text";
              })()
            : (c.op === "aggregate" && c.measure === "count") ||
                (arithmetic && field(`self.${c.target}`)?.type === "integer")
              ? "integer"
              : c.op === "shift"
                ? "date"
                : "money";
        const result = expect(`self.${c.target}`, resultType, where);
        if (result && "value" in result && result.value !== undefined)
          add(where, `calculation cannot replace constant ${c.target}`);
        const operands: UdlValue[] = [];
        const money = (v: UdlValue) => {
          operands.push(v);
          checkValue(v, arithmetic ? resultType : "money", where, input);
        };
        if (c.op === "at") {
          expect(c.list, "list", where, input);
          checkValue(c.position, "integer", where, input);
          if ("literal" in c.position && Number(c.position.literal) < 1)
            add(where, "list positions start at one");
          operands.push({ field: c.list }, c.position);
        }
        if (c.op === "aggregate") {
          const selected = checkSelection(c.selection, where, input);
          if (
            c.measure !== "count" &&
            (!selected ||
              resolveField(document, selected, `self.${c.measure.sum}`)
                ?.type !== "money")
          )
            add(where, "aggregate calculation needs a typed money path");
        }
        if (c.op === "ratio") {
          money(c.amount);
          const type =
            "field" in c.numerator
              ? field(c.numerator.field, input)?.type
              : typeof c.numerator.literal === "number"
                ? "integer"
                : "money";
          if (type !== "integer" && type !== "money" && type !== "percent")
            add(where, "ratio weights must share a numeric type");
          else {
            checkValue(c.numerator, type, where, input);
            checkValue(c.denominator, type, where, input);
          }
          if (
            "literal" in c.denominator &&
            BigInt(c.denominator.literal.toString()) <= 0n
          )
            add(where, "ratio denominator must be positive");
          operands.push(c.numerator, c.denominator);
        }
        if (c.op === "sum" || c.op === "minimum") c.values.forEach(money);
        if (c.op === "subtract") {
          money(c.base);
          c.subtract.forEach(money);
        }
        if (c.op === "rate") {
          money(c.base);
          checkValue(c.bps, "percent", where, input);
          operands.push(c.bps);
        }
        if (c.op === "multiply" || c.op === "divide") {
          money(c.amount);
          const count = c.op === "multiply" ? c.units : c.divisor;
          checkValue(count, "integer", where, input);
          operands.push(count);
          if (
            "literal" in count &&
            (c.op === "divide"
              ? Number(count.literal) <= 0
              : Number(count.literal) < 0)
          )
            add(
              where,
              "money multiplier must be nonnegative and divisor must be positive",
            );
        }
        if (c.op === "shift") {
          checkValue(c.date, "date", where, input);
          checkValue(c.milliseconds, "duration", where, input);
          operands.push(c.date, c.milliseconds);
        }
        dependencies.set(
          c.target,
          operands.flatMap((v) =>
            "field" in v && v.field.startsWith("self.")
              ? [v.field.slice(5)]
              : [],
          ),
        );
      }
      const active = new Set<string>();
      const visited = new Set<string>();
      const visit = (key: string): void => {
        if (active.has(key)) {
          add(where, `calculation cycle at ${key}`);
          return;
        }
        if (visited.has(key)) return;
        active.add(key);
        visited.add(key);
        for (const dep of dependencies.get(key) ?? []) visit(dep);
        active.delete(key);
      };
      for (const key of dependencies.keys()) visit(key);
    };
    checkCalculations(inst.calculate, `${base}.calculate`);
    const states = new Set(inst.lifecycle.states);
    duplicate(inst.lifecycle.states, `${base}.lifecycle.states`);
    if (!states.has(inst.lifecycle.initial) || !inst.actions.create)
      add(base, "declare create and a declared initial state", "UDL3001");
    duplicate(inst.actionOrder, `${base}.actionOrder`);
    if (
      inst.actionOrder.length !== Object.keys(inst.actions).length ||
      inst.actionOrder.some((a) => !inst.actions[a])
    )
      add(base, "actionOrder must list every action once");
    const reachable = new Set([inst.lifecycle.initial]);
    for (const [action, edge] of Object.entries(inst.lifecycle.transitions)) {
      if (
        !inst.actions[action] ||
        action === "create" ||
        !states.has(edge.to) ||
        edge.from.some((s) => !states.has(s))
      )
        add(base, `invalid transition ${action}`, "UDL3001");
    }
    for (let pass = 0; pass < states.size; pass++)
      for (const edge of Object.values(inst.lifecycle.transitions))
        if (edge.from.some((s) => reachable.has(s))) reachable.add(edge.to);
    for (const state of states)
      if (!reachable.has(state))
        add(base, `unreachable state ${state}`, "UDL3001");
    const checkRequirements = (
      requirements: typeof inst.invariants,
      where: string,
      input: readonly UdlField[] = [],
    ) => {
      for (const req of requirements ?? []) {
        if (req.kind === "compare") {
          const left =
            "field" in req.left ? field(req.left.field, input) : undefined;
          const right =
            "field" in req.right ? field(req.right.field, input) : undefined;
          if (
            ("field" in req.left && !left) ||
            ("field" in req.right && !right)
          )
            add(where, "comparison refers to an undeclared field");
          if (
            left &&
            right &&
            (left.type !== right.type ||
              (left.type === "ref" &&
                right.type === "ref" &&
                !overlap(left.target, right.target)))
          )
            add(where, "comparison operands have different types");
          if (left && "literal" in req.right) {
            checkValue(req.right, left.type, where, input);
            if (
              left.type === "enum" &&
              !left.values.includes(String(req.right.literal))
            )
              add(where, "comparison names an undeclared enum value");
          }
          if (right && "literal" in req.left) {
            checkValue(req.left, right.type, where, input);
            if (
              right.type === "enum" &&
              !right.values.includes(String(req.left.literal))
            )
              add(where, "comparison names an undeclared enum value");
          }
        } else if (req.kind === "state") {
          const target = expect(req.reference, "ref", where, input);
          if (
            target?.type === "ref" &&
            req.states.some((s) =>
              targetIds(target.target).some(
                (id) => !byId.get(id)?.lifecycle.states.includes(s),
              ),
            )
          )
            add(where, "reference gate names an undeclared state");
        } else if (req.kind === "unique") {
          for (const p of req.fields)
            if (!field(p, input)) add(where, `unknown identity field ${p}`);
        } else if (req.kind === "approval") {
          const target = expect(req.target, "ref", where, input);
          if (!document.parties[req.party])
            add(where, `unknown approving party ${req.party}`);
          if (
            req.action &&
            target?.type === "ref" &&
            targetIds(target.target).some(
              (id) => !byId.get(id)?.actions[req.action!],
            )
          )
            add(where, `unknown approved action ${req.action}`);
        } else if (req.kind === "evidence") {
          const subject = field(req.subject, input);
          if (!subject || !["account", "text"].includes(subject.type))
            add(
              where,
              "evidence subject must be an account or text subject id",
            );
        } else if (req.kind === "hours") {
          expect(req.at, "date", where, input);
          try {
            new Intl.DateTimeFormat("en", { timeZone: req.timezone });
          } catch {
            add(where, "hours requires an IANA timezone");
          }
          if (req.start === req.end)
            add(where, "hours interval admits no time");
        } else {
          const selected = checkSelection(req.selection, where, input);
          if (req.kind === "aggregate") {
            const measure = req.measure;
            if (
              typeof measure !== "string" &&
              (selected &&
                resolveField(document, selected, `self.${measure.sum}`)
                  ?.type) !== "money"
            )
              add(where, "aggregate sum requires a money field");
            checkValue(
              req.value,
              req.measure === "count" ? "integer" : "money",
              where,
              input,
            );
          }
        }
      }
    };
    checkRequirements(inst.invariants, `${base}.invariants`);
    for (const [actionName, action] of Object.entries(inst.actions)) {
      const where = `${base}.actions.${actionName}`;
      if (actionName !== "create" && !inst.lifecycle.transitions[actionName])
        add(where, "action needs a lifecycle transition", "UDL3001");
      checkFields(action.input, `${where}.input`);
      for (const input of action.input) {
        if (input.type === "account")
          add(where, "account bindings cannot be caller inputs");
        const declared = inst.fields.find((f) => f.name === input.name);
        const calculated = [
          ...inst.calculate,
          ...Object.values(inst.actions).flatMap((a) => a.calculate ?? []),
        ].some((c) => c.target === input.name);
        if (
          actionName === "create" &&
          (calculated ||
            (declared && "value" in declared && declared.value !== undefined))
        )
          add(
            where,
            `${input.name} is fixed by the contract and cannot be an input`,
          );
        if (captures.has(input.name))
          add(
            where,
            `${input.name} is an executor-owned receipt and cannot be an input`,
          );
      }
      checkCalculations(
        action.calculate ?? [],
        `${where}.calculate`,
        action.input,
      );
      checkRequirements(action.requires, `${where}.requires`, action.input);
      if (
        typeof action.actor === "object" &&
        "party" in action.actor &&
        !document.parties[action.actor.party]
      )
        add(where, "actor names an undeclared party");
      if (
        typeof action.actor === "object" &&
        "parent" in action.actor &&
        !byId.has(action.actor.parent)
      )
        add(where, "actor names an undeclared parent");
      if (action.actor === "clock" && !action.due)
        add(where, "clock action needs a due instant");
      for (const clock of [action.due, action.deadline])
        if (clock) expect(clock.at, "date", where, action.input);
      for (const move of action.moves) {
        if ("amount" in move) {
          checkValue(move.amount, "money", where, action.input);
          const from = expect(move.from, "account", where, action.input);
          const to = expect(move.to, "account", where, action.input);
          if (
            from?.type === "account" &&
            to?.type === "account" &&
            from.book !== to.book
          )
            add(where, "moves cannot cross account books", "UDL4001");
          const samePartyAccount =
            from?.type === "account" &&
            to?.type === "account" &&
            from.owner !== "self" &&
            from.owner === to.owner &&
            from.book === to.book &&
            (from.key ?? "balance") === (to.key ?? "balance");
          if (move.from === move.to || samePartyAccount)
            add(where, "a transfer needs distinct accounts", "UDL4001");
        } else expect(move.transfer, "text", where, action.input);
      }
      duplicate(
        action.moves.flatMap((m) =>
          "capture" in m && m.capture ? [m.capture] : [],
        ),
        `${where}.captures`,
      );
      duplicate(
        action.moves.map((m) => m.key),
        `${where}.moves`,
      );
      for (const [key, v] of Object.entries(action.set ?? {})) {
        const target = inst.fields.find((f) => f.name === key);
        if (
          !target ||
          captures.has(key) ||
          ("value" in target && target.value !== undefined) ||
          target.type === "account" ||
          target.type === "ref" ||
          inst.calculate.some((c) => c.target === key)
        )
          add(where, `cannot write immutable field ${key}`);
        else checkValue(v, target.type, where, action.input);
      }
      const checkArguments = (
        targetId: string | undefined,
        actionName: string,
        values: Record<string, UdlValue>,
      ) => {
        const target = targetId
          ? byId.get(targetId)?.actions[actionName]
          : undefined;
        if (!target) return;
        for (const required of target.input)
          if (
            !required.optional &&
            !("value" in required && required.value !== undefined) &&
            !(required.name in values)
          )
            add(where, `missing target input ${required.name}`);
        for (const [name, value] of Object.entries(values)) {
          const declared = target.input.find((f) => f.name === name);
          if (!declared) {
            add(where, `unknown target input ${name}`);
            continue;
          }
          checkValue(value, declared.type, where, action.input);
          if (declared.type === "ref" && "field" in value) {
            const supplied = field(value.field, action.input);
            if (
              supplied?.type !== "ref" ||
              !targetIds(supplied.target).every((id) =>
                targetIds(declared.target).includes(id),
              )
            )
              add(where, `target input ${name} has the wrong reference type`);
          }
        }
      };
      if (action.approval) {
        const reference = expect(
          action.approval.target,
          "ref",
          where,
          action.input,
        );
        if (
          reference?.type === "ref" &&
          targetIds(reference.target).some(
            (id) => !byId.get(id)?.actions[action.approval!.action],
          )
        )
          add(where, "approval target action does not exist");
        if (reference?.type === "ref")
          for (const id of targetIds(reference.target))
            checkArguments(id, action.approval.action, action.approval.input);
        expect(action.approval.expires, "date", where, action.input);
        if (!document.parties[action.approval.party])
          add(where, "approval needs a declared party");
      }
      const targets: { targets: string[]; count: number }[] = [];
      for (const call of action.invoke ?? []) {
        if ("selection" in call)
          checkSelection(call.selection, where, action.input);
        const target =
          "reference" in call ? field(call.reference, action.input) : undefined;
        const selected =
          "instrument" in call
            ? call.instrument
            : "selection" in call
              ? call.selection.instrument
              : target?.type === "ref"
                ? target.target
                : undefined;
        const ids = Array.isArray(selected)
          ? selected
          : selected
            ? [selected]
            : [];
        if (!ids.length) add(where, "invocation needs a declared target");
        for (const targetId of ids) {
          checkArguments(targetId, call.action, call.input);
          if (call.action === "create" && !("instrument" in call))
            add(
              where,
              "invocation references an existing instance and cannot create it again",
            );
          if (!byId.get(targetId)?.actions[call.action])
            add(where, "invocation target must name a declared action");
        }
        targets.push({
          targets: ids.map((id) => `${id}.${call.action}`),
          count: "selection" in call ? call.selection.limit : 1,
        });
      }
      calls.set(`${inst.id}.${actionName}`, targets);
    }
    if (!issues.some((i) => i.path.startsWith(base)))
      issues.push(
        ...analyzeInstrumentFinance(inst, document).map((i) =>
          issue("UDL4001", base + i.path, i.message),
        ),
      );
  }
  const active = new Set<string>();
  const depths = new Map<string, number>();
  const visit = (key: string): number => {
    if (active.has(key)) {
      add("$.instruments", `invocation cycle at ${key}`, "UDL2010");
      return 4097;
    }
    const known = depths.get(key);
    if (known !== undefined) return known;
    active.add(key);
    const size =
      1 +
      (calls.get(key) ?? []).reduce(
        (n, edge) => n + edge.count * Math.max(0, ...edge.targets.map(visit)),
        0,
      );
    active.delete(key);
    depths.set(key, size);
    if (size > 4096)
      add("$.instruments", `invocation ${key} exceeds 4096 actions`, "UDL2010");
    return size;
  };
  for (const key of calls.keys()) visit(key);
  return issues.length ? { ok: false, issues } : { ok: true, value: document };
}
export function assertValidUdl(value: unknown): UdlDocument {
  const result = validateUdl(value);
  if (!result.ok) throw new UdlError(result.issues);
  return result.value;
}
