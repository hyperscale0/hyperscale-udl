import {
  udlDocumentSchema,
  subjectPartyRoles,
  sameObjectField,
  MAX_ACTION_EXPANSION,
  type UdlDocument,
  type UdlField,
  type UdlInstrument,
  type UdlValue,
  type UdlCalculation,
  type UdlSelection,
  type UdlAction,
  type UdlActionSubject,
  type UdlSubjectRequirement,
  type UdlObjectField,
  type UdlObjectKind,
} from "./schema.js";
import { issue, type UdlIssue } from "./diagnostics.js";
import { validateReportDefinition } from "./reporting-validation.js";
import { analyzeInstrumentFinance } from "./finance.js";

export const RESERVED_OBJECT_NAMES = [
  "objectId",
  "externalId",
  "revision",
  "kind",
  "tenantId",
  "productId",
] as const;
const reservedObjectNamesSet = new Set<string>(RESERVED_OBJECT_NAMES);
function hasParty(
  document: UdlDocument,
  instrument: UdlInstrument | undefined,
  name: string,
): boolean {
  if (document.parties[name]) return true;
  if (!instrument?.subject) return false;
  return (
    document.objects
      .find((kind) => kind.id === instrument.subject)
      ?.attachments.some(
        (attachment) =>
          (attachment.instrument === instrument.id ||
            instrument.id.startsWith(`${attachment.instrument}_`)) &&
          Object.values(attachment.parties).some((binding) =>
            "role" in binding ? binding.role === name : binding.party === name,
          ),
      ) ?? false
  );
}

function moneyParty(
  document: UdlDocument,
  instrument: UdlInstrument | undefined,
  name: string,
): boolean {
  return (
    hasParty(document, instrument, name) &&
    (document.parties[name]?.kind === "business" ||
      (!document.parties[name] && !!instrument?.subject) ||
      (!instrument?.subject && document.parties[name]?.kind === "person"))
  );
}

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
function commonField(
  fields: (UdlField | UdlObjectField | undefined)[],
): UdlField | undefined {
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
    if (
      fields.some(
        (field) =>
          field?.type !== "ref" ||
          field.targetKind !== first.targetKind ||
          JSON.stringify(field.targetFamily) !==
            JSON.stringify(first.targetFamily),
      )
    )
      return;
    const targets = [
      ...new Set(
        fields.flatMap((field) =>
          field?.type === "ref" ? targetIds(field.target) : [],
        ),
      ),
    ];
    return {
      ...first,
      targetKind: first.targetKind,
      target: targets.length === 1 ? targets[0]! : targets,
      ...(first.targetFamily ? { targetFamily: first.targetFamily } : {}),
    } as UdlField;
  }
  if (
    first.type === "account" &&
    fields.some(
      (field) =>
        field?.type !== "account" ||
        field.book !== first.book ||
        JSON.stringify(field.owner) !== JSON.stringify(first.owner) ||
        field.key !== first.key ||
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
        field.targetKind !== first.targetKind ||
        field.target !== first.target,
    )
  )
    return;
  return first as UdlField;
}

export function resolveField(
  document: UdlDocument,
  instrument: UdlInstrument,
  path: string,
  input: readonly UdlField[] = [],
  action?: UdlAction | UdlActionSubject,
): UdlField | undefined {
  return resolvePath(document, instrument, path, input, new Map(), action);
}

/** A subject expression names a requirement; objectField names its stored metadata. */
export function resolveSubjectRequirement(
  instrument: UdlInstrument,
  name: string,
  action?: UdlAction | UdlActionSubject,
): UdlSubjectRequirement | undefined {
  const requirements = action
    ? "requirements" in action
      ? action.requirements
      : action.subject?.requirements
    : Object.values(instrument.actions).flatMap(
        (item) => item.subject?.requirements ?? [],
      );
  return requirements?.find((requirement) => requirement.field.name === name);
}

function resolveReferencePath(
  document: UdlDocument,
  field: Extract<UdlField, { type: "ref" }>,
  suffix: string,
  cache: Map<string, UdlField | undefined>,
): UdlField | undefined {
  return commonField(
    targetIds(field.target).map((id) => {
      const key = `${field.targetKind}:${id}:${suffix}`;
      if (!cache.has(key)) {
        const object =
          field.targetKind === "object" &&
          document.objects.find((item) => item.id === id);
        const instrument =
          field.targetKind === "instrument" &&
          document.instruments.find((item) => item.id === id);
        cache.set(
          key,
          object
            ? resolveObjectPath(document, object, suffix, cache)
            : instrument
              ? resolvePath(document, instrument, `self.${suffix}`, [], cache)
              : undefined,
        );
      }
      return cache.get(key);
    }),
  );
}

function resolveObjectPath(
  document: UdlDocument,
  object: UdlObjectKind,
  path: string,
  cache: Map<string, UdlField | undefined>,
): UdlField | undefined {
  const parts = path.split(".");
  const key = parts.shift();
  if (!key) return;
  const field = object.fields.find((f) => f.name === key);
  if (!field) return;
  if (parts.length === 0) return field as UdlField;
  if (field.type !== "ref") return;
  return resolveReferencePath(document, field, parts.join("."), cache);
}

function resolvePath(
  document: UdlDocument,
  instrument: UdlInstrument,
  path: string,
  input: readonly UdlField[],
  cache: Map<string, UdlField | undefined>,
  action?: UdlAction | UdlActionSubject,
): UdlField | undefined {
  const parts = path.split(".");
  const root = parts.shift();
  const key = parts.shift();
  if (!key)
    return root === "self"
      ? {
          name: "id",
          type: "ref",
          targetKind: "instrument",
          target: instrument.id,
        }
      : undefined;
  if (root === "party") {
    if (!moneyParty(document, instrument, key)) return;
    if (parts.length === 0)
      return { name: key, type: "account", owner: key, book: "cash" };
    if (parts.length === 1 && ["balance", "reserved"].includes(parts[0]!))
      return { name: parts[0]!, type: "money" };
    return;
  }
  if (root === "self" && key === "subject" && instrument.subject) {
    if (parts.length === 0)
      return {
        name: "subject",
        type: "ref",
        targetKind: "object",
        target: instrument.subject,
      };
    const target = document.objects.find((o) => o.id === instrument.subject);
    if (!target) return;
    const suffix = parts.join(".");
    const cacheKey = `obj:${instrument.subject}:${suffix}`;
    if (!cache.has(cacheKey))
      cache.set(cacheKey, resolveObjectPath(document, target, suffix, cache));
    return cache.get(cacheKey);
  }
  if (root === "self" && parts.length === 0) {
    if (key === "id")
      return {
        name: key,
        type: "ref",
        targetKind: "instrument",
        target: instrument.id,
      };
    if (key === "now" || key === "createdAt")
      return { name: key, type: "date" };
    if (key === "productRevision") return { name: key, type: "text" };
    if (key === "status")
      return { name: key, type: "enum", values: instrument.lifecycle.states };
  }
  if (root === "subject") {
    const requirement = resolveSubjectRequirement(instrument, key, action);
    if (!requirement) return;
    // Evidence collected at the action need not exist on the object; the
    // declared requirement is the contract for a bare `subject.<name>`.
    if (parts.length === 0 && !requirement.objectField)
      return requirement.field;
    if (!instrument.subject) return;
    const object = document.objects.find(
      (item) => item.id === instrument.subject,
    );
    if (!object) return;
    return resolveObjectPath(
      document,
      object,
      [requirement.objectField ?? requirement.field.name, ...parts].join("."),
      cache,
    );
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
    return resolveReferencePath(
      document,
      field,
      parts.slice(index).join("."),
      cache,
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
  if (document.objects.length === 0 && document.instruments.length === 0)
    add("$", "document requires at least one object or instrument", "UDL2002");

  duplicate(
    document.objects.map((o) => o.id),
    "$.objects",
  );
  duplicate(
    document.instruments.map((i) => i.id),
    "$.instruments",
  );

  for (const name of subjectPartyRoles)
    if (document.parties[name])
      add(
        `$.parties.${name}`,
        `${name} is a reserved subject role`,
        "party_name_reserved",
      );

  const byObjectId = new Map(document.objects.map((o) => [o.id, o]));
  const byId = new Map(document.instruments.map((i) => [i.id, i]));

  const checkFields = (
    fields: readonly (UdlField | UdlObjectField)[],
    where: string,
    isObject = false,
    instrument?: UdlInstrument,
  ) => {
    duplicate(
      fields.map((f) => f.name),
      where,
    );
    for (const f of fields) {
      if (isObject) {
        if (reservedObjectNamesSet.has(f.name))
          add(where, `${f.name} is a reserved object name`);
      } else {
        if (f.type === "account" && f.contra && f.book !== "claim")
          add(where, "contra accounts require the claim book");
        if (
          ["id", "status", "createdAt", "now", "productRevision"].includes(
            f.name,
          )
        )
          add(where, `${f.name} is a sealed instance field`);
        if (f.type === "account" && typeof f.owner === "object") {
          const binding = f.owner.adapter;
          const declarations = Object.values(instrument?.actions ?? {})
            .flatMap((action) => action.subject?.adapters ?? [])
            .filter((entry) => entry.binding === binding);
          if (!declarations.length)
            add(
              where,
              `${f.name} needs adapter declaration ${binding}`,
              "subject_adapter_unbound",
            );
          const providers = new Set(
            declarations.flatMap((entry) =>
              entry.snapshot ? [entry.snapshot.provider] : [],
            ),
          );
          if (providers.size > 1)
            add(
              where,
              `${binding} names conflicting providers`,
              "subject_adapter_unbound",
            );
        }
        if (
          f.type === "account" &&
          typeof f.owner === "string" &&
          f.owner !== "self" &&
          !moneyParty(document, instrument, f.owner)
        )
          add(
            where,
            `${f.name} needs an eligible money party as owner`,
            hasParty(document, instrument, f.owner)
              ? "party_kind_mismatch"
              : "subject_party_unbound",
          );
      }
      if (f.type === "text") {
        if ((f.minLength ?? 1) > (f.maxLength ?? 2048))
          add(where, "text minimum exceeds maximum");
        if (f.pattern) {
          try {
            new RegExp(f.pattern);
          } catch {
            add(where, "invalid text character class");
          }
        }
      }
      if (f.type === "ref") {
        duplicate(targetIds(f.target), where);
        for (const id of targetIds(f.target)) {
          const exists =
            f.targetKind === "object" ? byObjectId.has(id) : byId.has(id);
          if (!exists) add(where, `unknown reference target ${id}`, "UDL5001");
        }
        if (f.targetFamily) {
          if (f.targetKind !== "instrument") {
            add(
              where,
              "targetFamily requires an instrument reference target",
              "UDL5001",
            );
          } else {
            for (const id of targetIds(f.target)) {
              const targetInst = byId.get(id);
              if (
                targetInst &&
                (!targetInst.family ||
                  targetInst.family.module !== f.targetFamily.module ||
                  targetInst.family.exportPath !== f.targetFamily.exportPath ||
                  targetInst.family.revision !== f.targetFamily.revision)
              ) {
                add(
                  where,
                  `targetFamily does not match target instrument ${id} family`,
                  "UDL5001",
                );
              }
            }
          }
        }
      }
      if (f.type === "enum") {
        duplicate(f.values, where);
        if (f.value !== undefined && !f.values.includes(f.value))
          add(where, `${f.name} constant is outside its enum`);
      }
      if (f.type === "list") {
        const validRefList =
          f.item === "ref" &&
          f.targetKind &&
          (f.targetKind === "object"
            ? byObjectId.has(f.target ?? "")
            : byId.has(f.target ?? ""));
        const nonRefTarget =
          f.item !== "ref" &&
          (f.targetKind !== undefined || f.target !== undefined);
        if (!validRefList && (f.item === "ref" || nonRefTarget))
          add(
            where,
            `${f.name} needs a target exactly when its items are references`,
          );
        if (f.targetFamily) {
          if (f.item !== "ref" || f.targetKind !== "instrument") {
            add(
              where,
              "targetFamily requires an instrument reference target",
              "UDL5001",
            );
          } else if (f.target) {
            const targetInst = byId.get(f.target);
            if (
              targetInst &&
              (!targetInst.family ||
                targetInst.family.module !== f.targetFamily.module ||
                targetInst.family.exportPath !== f.targetFamily.exportPath ||
                targetInst.family.revision !== f.targetFamily.revision)
            ) {
              add(
                where,
                `targetFamily does not match target instrument ${f.target} family`,
                "UDL5001",
              );
            }
          }
        }
      }
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

  for (const [index, obj] of document.objects.entries()) {
    const base = `$.objects[${index}]`;
    if (reservedObjectNamesSet.has(obj.id))
      add(base, `${obj.id} is a reserved object name`);
    duplicate(
      obj.attachments.map((attachment) => attachment.name),
      `${base}.attachments`,
    );
    duplicate(
      obj.attachments.map((attachment) => attachment.instrument),
      `${base}.attachments`,
    );
    for (const [attachmentIndex, attachment] of obj.attachments.entries()) {
      for (const [parameter, binding] of Object.entries(attachment.parties))
        if ("party" in binding && !document.parties[binding.party])
          add(
            `${base}.attachments[${attachmentIndex}].parties.${parameter}`,
            `unknown declared party ${binding.party}`,
            "subject_party_unbound",
          );
      if (byId.get(attachment.instrument)?.subject !== obj.id)
        add(
          `${base}.attachments`,
          `${attachment.instrument} must attach to ${obj.id}`,
        );
    }
    duplicate(obj.authoredFields, `${base}.authoredFields`);
    duplicate(obj.columns, `${base}.columns`);
    checkFields(obj.fields, `${base}.fields`, true);
    for (let i = 0; i < obj.authoredFields.length; i++) {
      const af = obj.authoredFields[i]!;
      if (reservedObjectNamesSet.has(af))
        add(`${base}.authoredFields`, `${af} is a reserved object name`);
      if (!obj.fields.some((f) => f.name === af))
        add(
          `${base}.authoredFields`,
          `authored field ${af} is not in declared fields`,
          "subject_field_unknown",
        );
      if (obj.fields[i]?.name !== af)
        add(
          base,
          `authored field ${af} must precede attached requirements in fields`,
        );
    }
    for (const col of obj.columns) {
      if (reservedObjectNamesSet.has(col))
        add(`${base}.columns`, `${col} is a reserved object name`);
      if (!obj.fields.some((f) => f.name === col))
        add(
          `${base}.columns`,
          `column ${col} is not a declared field`,
          "subject_field_unknown",
        );
    }
    const pubActions = document.instruments
      .filter((i) => i.subject === obj.id)
      .flatMap((i) =>
        Object.values(i.actions).flatMap((a) =>
          a.publicAction ? [a.publicAction] : [],
        ),
      );
    duplicate(pubActions, `$.objects.${obj.id}.publicActions`);
  }

  const reportIds = new Set<string>();
  for (const [index, instrument] of document.instruments.entries()) {
    for (const report of instrument.reports ?? []) {
      const path = `$.instruments[${index}].reports`;
      if (reportIds.has(report.identity.id))
        add(path, `duplicate report ${report.identity.id}`);
      reportIds.add(report.identity.id);
      try {
        validateReportDefinition(report, document);
      } catch (error) {
        add(
          path,
          error instanceof Error ? error.message : "Invalid report definition",
        );
      }
    }
  }

  const calls = new Map<string, { targets: string[]; count: number }[]>();
  for (const [index, inst] of document.instruments.entries()) {
    const base = `$.instruments[${index}]`;
    if (inst.subject && !byObjectId.has(inst.subject))
      add(base, `unknown subject object ${inst.subject}`);
    const field = (
      p: string,
      input: readonly UdlField[] = [],
      action?: UdlAction | UdlActionSubject,
    ) => resolveField(document, inst, p, input, action);
    const expect = (
      p: string,
      type: UdlField["type"],
      where: string,
      input: readonly UdlField[] = [],
      action?: UdlAction | UdlActionSubject,
    ) => {
      const party = p.startsWith("party.") ? p.split(".")[1]! : undefined;
      if (party && !moneyParty(document, inst, party))
        add(
          where,
          `${party} cannot supply a money account`,
          hasParty(document, inst, party)
            ? "party_kind_mismatch"
            : "subject_party_unbound",
        );
      const found = field(p, input, action);
      if (found?.type !== type)
        add(where, `${p} must name a ${type} field`, "UDL5001");
      return found;
    };
    const checkValue = (
      v: UdlValue,
      type: UdlField["type"],
      where: string,
      input: readonly UdlField[] = [],
      action?: UdlAction | UdlActionSubject,
    ) => {
      if ("field" in v) {
        expect(v.field, type, where, input, action);
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
    checkFields(inst.fields, `${base}.fields`, false, inst);
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
        (a.type !== "ref" ||
          (b.type === "ref" &&
            a.targetKind === b.targetKind &&
            overlap(a.target, b.target)));
      const anchor = field(selection.anchor, input);
      for (const target of targets) {
        if (
          selection.family &&
          (!target.family ||
            target.family.module !== selection.family.module ||
            target.family.exportPath !== selection.family.exportPath ||
            target.family.revision !== selection.family.revision)
        )
          add(
            where,
            `selection family does not match target instrument ${target.id} family`,
            "UDL5001",
          );
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
      act?: UdlAction,
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
                const list = field(c.list, input, act);
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
          checkValue(v, arithmetic ? resultType : "money", where, input, act);
        };
        if (c.op === "at") {
          expect(c.list, "list", where, input, act);
          checkValue(c.position, "integer", where, input, act);
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
              ? field(c.numerator.field, input, act)?.type
              : typeof c.numerator.literal === "number"
                ? "integer"
                : "money";
          if (type !== "integer" && type !== "money" && type !== "percent")
            add(where, "ratio weights must share a numeric type");
          else {
            checkValue(c.numerator, type, where, input, act);
            checkValue(c.denominator, type, where, input, act);
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
          checkValue(c.bps, "percent", where, input, act);
          operands.push(c.bps);
        }
        if (c.op === "multiply" || c.op === "divide") {
          money(c.amount);
          const count = c.op === "multiply" ? c.units : c.divisor;
          checkValue(count, "integer", where, input, act);
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
          checkValue(c.date, "date", where, input, act);
          checkValue(c.milliseconds, "duration", where, input, act);
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
    if (states.has("preserve"))
      add(base, "preserve is a reserved transition destination", "UDL3001");
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
        (edge.to !== "preserve" && !states.has(edge.to)) ||
        edge.from.some((s) => !states.has(s))
      )
        add(base, `invalid transition ${action}`, "UDL3001");
    }
    for (let pass = 0; pass < states.size; pass++)
      for (const edge of Object.values(inst.lifecycle.transitions))
        if (edge.to !== "preserve" && edge.from.some((s) => reachable.has(s)))
          reachable.add(edge.to);
    for (const state of states)
      if (!reachable.has(state))
        add(base, `unreachable state ${state}`, "UDL3001");
    const checkRequirements = (
      requirements: typeof inst.invariants,
      where: string,
      input: readonly UdlField[] = [],
      act?: UdlAction,
    ) => {
      for (const req of requirements ?? []) {
        if (req.kind === "compare") {
          const left =
            "field" in req.left ? field(req.left.field, input, act) : undefined;
          const right =
            "field" in req.right
              ? field(req.right.field, input, act)
              : undefined;
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
                (left.targetKind !== right.targetKind ||
                  !overlap(left.target, right.target))))
          )
            add(where, "comparison operands have different types");
          if (left && "literal" in req.right) {
            checkValue(req.right, left.type, where, input, act);
            if (
              left.type === "enum" &&
              !left.values.includes(String(req.right.literal))
            )
              add(where, "comparison names an undeclared enum value");
          }
          if (right && "literal" in req.left) {
            checkValue(req.left, right.type, where, input, act);
            if (
              right.type === "enum" &&
              !right.values.includes(String(req.left.literal))
            )
              add(where, "comparison names an undeclared enum value");
          }
        } else if (req.kind === "state") {
          const target = expect(req.reference, "ref", where, input, act);
          if (
            target?.type === "ref" &&
            target.targetKind === "instrument" &&
            req.states.some((s) =>
              targetIds(target.target).some(
                (id) => !byId.get(id)?.lifecycle.states.includes(s),
              ),
            )
          )
            add(where, "reference gate names an undeclared state");
        } else if (req.kind === "unique") {
          for (const p of req.fields)
            if (!field(p, input, act))
              add(where, `unknown identity field ${p}`);
        } else if (req.kind === "evidence") {
          if (req.instruction) {
            expect(req.instruction, "text", where, input, act);
            if (!["confirmed", "rejected"].includes(req.result))
              add(where, "instruction evidence requires a terminal outcome");
          }
          const subject = field(req.subject, input, act);
          if (
            !subject ||
            !["account", "text", ...(req.instruction ? ["ref"] : [])].includes(
              subject.type,
            )
          )
            add(
              where,
              "evidence subject must be an account or text subject id",
            );
        } else if (req.kind === "hours") {
          expect(req.at, "date", where, input, act);
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
              act,
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
      if (action.subject) {
        const subBase = `${where}.subject`;
        checkFields(
          action.subject.requirements.map((r) => ({
            ...r.field,
            name: r.objectField ?? r.field.name,
          })),
          `${subBase}.requirements`,
          true,
        );
        for (const req of action.subject.requirements) {
          if (req.field.optional)
            add(
              `${subBase}.requirements`,
              `subject requirement ${req.field.name} cannot be optional`,
              "UDL2002",
            );
          const name = req.objectField ?? req.field.name;
          if (reservedObjectNamesSet.has(name))
            add(subBase, `${name} is a reserved object name`);
          if (inst.subject) {
            const field = byObjectId
              .get(inst.subject)
              ?.fields.find((field) => field.name === name);
            if (!field || !sameObjectField(field, req.field))
              add(
                subBase,
                `object field ${name} must match requirement ${req.field.name}`,
                field ? "subject_field_conflict" : "subject_field_unknown",
              );
          }
        }
        duplicate(
          action.subject.adapters.map((a) => a.binding),
          `${subBase}.adapters`,
        );
        for (const adapter of action.subject.adapters) {
          if (adapter.snapshot) {
            checkFields(
              adapter.snapshot.requirements,
              `${subBase}.adapters.${adapter.binding}.requirements`,
              true,
            );
            for (const reqField of adapter.snapshot.requirements) {
              const objectName =
                adapter.renames?.[reqField.name] ?? reqField.name;
              const requirement = action.subject.requirements.find(
                (item) =>
                  (item.objectField ?? item.field.name) === objectName &&
                  sameObjectField(item.field, reqField),
              );
              if (!requirement)
                add(
                  subBase,
                  `adapter ${adapter.binding} requirement ${reqField.name} is absent from the action`,
                );
              if (reqField.optional)
                add(
                  `${subBase}.adapters.${adapter.binding}`,
                  `adapter requirement ${reqField.name} cannot be optional`,
                  "UDL2002",
                );
            }
          }
        }
      }
      checkFields(action.input, `${where}.input`, false, inst);
      if (action.reminder) {
        expect(action.reminder.installment, "ref", where, action.input, action);
        expect(
          action.reminder.recipient,
          "account",
          where,
          action.input,
          action,
        );
        expect(action.reminder.dueAt, "date", where, action.input, action);
        if (action.reminder.startHour >= action.reminder.endHour)
          add(where, "reminder sending window is empty");
        try {
          new Intl.DateTimeFormat("en", { timeZone: action.reminder.timezone });
        } catch {
          add(where, "reminder requires an IANA timezone");
        }
      }
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
        action,
      );
      checkRequirements(
        action.requires,
        `${where}.requires`,
        action.input,
        action,
      );
      if (
        typeof action.actor === "object" &&
        "party" in action.actor &&
        !hasParty(document, inst, action.actor.party)
      )
        add(where, "actor names an undeclared party");
      if (
        typeof action.actor === "object" &&
        "parent" in action.actor &&
        targetIds(action.actor.parent).some((id) => !byId.has(id))
      )
        add(where, "actor names an undeclared parent");
      if (action.actor === "clock" && !action.due)
        add(where, "clock action needs a due instant");
      for (const clock of [action.due, action.deadline])
        if (clock) {
          expect(clock.at, "date", where, action.input, action);
          if (clock.localDay) {
            try {
              new Intl.DateTimeFormat("en", {
                timeZone: clock.localDay.timezone,
              }).format(0);
            } catch {
              add(where, "clock timezone must be an IANA timezone");
            }
          }
        }
      for (const move of action.moves) {
        if (
          move.operation === "internal_transfer.reserve" &&
          move.boundary &&
          !action.subject?.adapters.some(
            (binding) =>
              binding.binding === move.boundary!.adapter && binding.snapshot,
          )
        )
          add(
            where,
            "boundary reservation requires a retained adapter binding",
          );
        if ("amount" in move) {
          checkValue(move.amount, "money", where, action.input, action);
          const from = expect(
            move.from,
            "account",
            where,
            action.input,
            action,
          );
          const to = expect(move.to, "account", where, action.input, action);
          if (
            from?.type === "account" &&
            to?.type === "account" &&
            from.book !== to.book
          )
            add(where, "moves cannot cross account books", "UDL4001");
          const sameBoundAccount =
            from?.type === "account" &&
            to?.type === "account" &&
            from.owner !== "self" &&
            JSON.stringify(from.owner) === JSON.stringify(to.owner) &&
            from.book === to.book &&
            (from.key ?? "balance") === (to.key ?? "balance");
          if (move.from === move.to || sameBoundAccount)
            add(where, "a transfer needs distinct accounts", "UDL4001");
        } else expect(move.transfer, "text", where, action.input, action);
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
        else checkValue(v, target.type, where, action.input, action);
      }
      const checkArguments = (
        targetId: string | undefined,
        actionName: string,
        values: Record<string, UdlValue>,
        binding?: string,
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
          if (binding && "field" in value && value.field === binding) {
            if (declared.type !== "integer")
              add(where, "range binding requires an integer target input");
            continue;
          }
          checkValue(value, declared.type, where, action.input, action);
          if (declared.type === "ref" && "field" in value) {
            const supplied = field(value.field, action.input, action);
            if (
              supplied?.type !== "ref" ||
              supplied.targetKind !== declared.targetKind ||
              !targetIds(supplied.target).every((id) =>
                targetIds(declared.target).includes(id),
              )
            )
              add(where, `target input ${name} has the wrong reference type`);
          }
        }
      };
      const targets: { targets: string[]; count: number }[] = [];
      for (const call of action.invoke ?? []) {
        if (call.guard)
          checkRequirements([call.guard], where, action.input, action);
        const range = "instrument" in call ? call.range : undefined;
        if (range) {
          checkValue(range.count, "integer", where, action.input, action);
          if (["self", "input", "party", "subject"].includes(range.bind))
            add(where, "range binding cannot shadow a reserved scope");
          if (
            "literal" in range.count &&
            (typeof range.count.literal !== "number" ||
              range.count.literal < 1 ||
              range.count.literal > range.maximum)
          )
            add(where, "range count must be between one and its maximum");
        }
        if ("selection" in call)
          checkSelection(call.selection, where, action.input);
        const target =
          "reference" in call
            ? field(call.reference, action.input, action)
            : undefined;
        const selected =
          "instrument" in call
            ? call.instrument
            : "selection" in call
              ? call.selection.instrument
              : target?.type === "ref" && target.targetKind === "instrument"
                ? target.target
                : undefined;
        const ids = Array.isArray(selected)
          ? selected
          : selected
            ? [selected]
            : [];
        if (!ids.length) add(where, "invocation needs a declared target");
        for (const targetId of ids) {
          checkArguments(targetId, call.action, call.input, range?.bind);
          if (call.action === "create" && !("instrument" in call))
            add(
              where,
              "invocation references an existing instance and cannot create it again",
            );
          const targetInst = byId.get(targetId);
          if (!targetInst?.actions[call.action])
            add(where, "invocation target must name a declared action");
          else if (!call.guard) {
            const targetAction = targetInst.actions[call.action]!;
            if (
              inst.subject &&
              targetInst.subject &&
              inst.subject === targetInst.subject
            ) {
              const callerRequirements = action.subject?.requirements ?? [];
              for (const targetReq of targetAction.subject?.requirements ??
                []) {
                const targetObjFieldName =
                  targetReq.objectField ?? targetReq.field.name;
                const satisfied = callerRequirements.some(
                  (cr) =>
                    (cr.objectField ?? cr.field.name) === targetObjFieldName,
                );
                if (!satisfied) {
                  add(
                    `${where}.invoke`,
                    `mandatory invocation of ${targetId}.${call.action} requires subject field ${targetReq.field.name}`,
                    "UDL2002",
                  );
                }
              }
            }
          }
        }
        targets.push({
          targets: ids.map((id) => `${id}.${call.action}`),
          count:
            "selection" in call ? call.selection.limit : (range?.maximum ?? 1),
        });
      }
      calls.set(`${inst.id}.${actionName}`, targets);
    }
    if (!issues.some((i) => i.path.startsWith(base)))
      issues.push(
        ...analyzeInstrumentFinance(inst, document).map((i) => ({
          ...issue("UDL4001", base + i.path, i.message),
          ...(i.stranded ? { stranded: i.stranded } : {}),
        })),
      );
  }
  const active = new Set<string>();
  const depths = new Map<string, number>();
  const visit = (key: string): number => {
    if (active.has(key)) {
      add("$.instruments", `invocation cycle at ${key}`, "UDL2010");
      return MAX_ACTION_EXPANSION + 1;
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
    const [id, action] = key.split(".");
    const limit =
      document.instruments.find((item) => item.id === id)?.actions[action!]
        ?.expansionLimit ?? MAX_ACTION_EXPANSION;
    if (size > limit)
      add(
        "$.instruments",
        `invocation ${key} exceeds ${limit} actions`,
        "UDL2010",
      );
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
