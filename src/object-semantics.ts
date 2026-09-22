import {
  subjectPartyRoles,
  type UdlDocument,
  type UdlInstrument,
  type UdlField,
  type UdlAction,
} from "./schema.js";
import { resolveField } from "./validation.js";
import type {
  DocumentSemantics,
  SemanticAccount,
  SemanticOwner,
  SemanticAction,
  SemanticMoneyEffect,
  SemanticRelationship,
} from "./object-semantics-schema.js";
import { projectStructures } from "./object-structures.js";

export function presentationLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
const labelled = <T extends UdlField>(field: T): T => ({
  ...field,
  label: field.label ?? presentationLabel(field.name),
});
const targets = (target: string | string[]) =>
  typeof target === "string" ? [target] : target;

function owner(
  document: UdlDocument,
  instrument: UdlInstrument,
  value: Extract<UdlField, { type: "account" }>["owner"],
): SemanticOwner {
  if (typeof value !== "string")
    return { kind: "adapter", adapter: value.adapter };
  if (value === "self")
    return { kind: "instrument", instrument: instrument.id };
  const binding = document.objects
    .flatMap((object) => object.attachments)
    .find((attachment) => attachment.instrument === instrument.id)?.parties[
    value
  ];
  if (binding)
    return "role" in binding
      ? { kind: "role", role: binding.role }
      : { kind: "party", party: binding.party };
  const role = subjectPartyRoles.find((role) => role === value);
  return instrument.subject && role
    ? { kind: "role", role }
    : { kind: "party", party: value };
}

/** Follow typed references, retaining every union member instead of guessing an owner. */
function scopes(
  document: UdlDocument,
  instrument: UdlInstrument,
  path: string,
): { instrument: UdlInstrument; path: string }[] {
  const [root, key, ...rest] = path.split(".");
  const field = instrument.fields.find((field) => field.name === key);
  if (
    root === "self" &&
    rest.length &&
    field?.type === "ref" &&
    field.targetKind === "instrument"
  )
    return document.instruments
      .filter((candidate) => targets(field.target).includes(candidate.id))
      .flatMap((candidate) =>
        scopes(document, candidate, `self.${rest.join(".")}`),
      );
  return [{ instrument, path }];
}
function accounts(
  document: UdlDocument,
  instrument: UdlInstrument,
  path: string,
  action?: UdlAction,
): SemanticAccount[] {
  return scopes(document, instrument, path).flatMap((scope) => {
    const field = resolveField(
      document,
      scope.instrument,
      scope.path,
      action?.input,
      action,
    );
    if (field?.type !== "account") return [];
    return [
      {
        path,
        scope: instrument.id,
        instrument: scope.instrument.id,
        field: field.name,
        owner: owner(document, scope.instrument, field.owner),
        book: field.book,
        key: field.key ?? (field.owner === "self" ? field.name : "balance"),
        contra: field.contra ?? false,
      },
    ];
  });
}
function moneyEffects(
  document: UdlDocument,
  instrument: UdlInstrument,
  action: UdlAction,
): SemanticMoneyEffect[] {
  return action.moves.map((move) => {
    const reservations =
      "transfer" in move
        ? scopes(document, instrument, move.transfer).flatMap((scope) =>
            scope.instrument.actionOrder.flatMap((name) =>
              scope.instrument.actions[name]!.moves.flatMap((candidate) =>
                candidate.operation === "internal_transfer.reserve" &&
                scope.path === `self.${candidate.capture}`
                  ? [
                      {
                        instrument: scope.instrument,
                        action: name,
                        move: candidate,
                      },
                    ]
                  : [],
              ),
            ),
          )
        : [];
    const movements = "amount" in move ? [{ instrument, move }] : reservations;
    const from = movements.flatMap((entry) =>
      accounts(document, entry.instrument, entry.move.from, action),
    );
    const to = movements.flatMap((entry) =>
      accounts(document, entry.instrument, entry.move.to, action),
    );
    const amount =
      "amount" in move
        ? move.amount
        : reservations.length === 1
          ? reservations[0]!.move.amount
          : null;
    return {
      key: move.key,
      operation: move.operation,
      amount,
      from,
      to,
      disposition:
        !from.length || !to.length
          ? "unresolved"
          : move.operation === "internal_transfer.void"
            ? "released"
            : move.operation === "internal_transfer.reserve"
              ? "held"
              : to.some((account) => account.book === "claim")
                ? "claim"
                : to.some((account) => account.owner.kind === "instrument")
                  ? "held"
                  : "paid",
      transfer:
        "transfer" in move
          ? move.transfer
          : move.operation === "internal_transfer.reserve"
            ? `self.${move.capture}`
            : null,
      reservations: reservations.map((entry) => ({
        instrument: entry.instrument.id,
        action: entry.action,
        key: entry.move.key,
      })),
    };
  });
}
function relationships(
  document: UdlDocument,
  instrument: UdlInstrument,
): SemanticRelationship[] {
  const references: SemanticRelationship[] = instrument.fields.flatMap(
    (field) => {
      if (field.type === "ref")
        return [
          {
            kind: "reference" as const,
            via: "field" as const,
            name: field.name,
            targetKind: field.targetKind,
            targets: targets(field.target),
            cardinality: { min: field.optional ? 0 : 1, max: 1 },
          },
        ];
      if (field.type === "list" && field.item === "ref" && field.target)
        return [
          {
            kind: "reference" as const,
            via: "field" as const,
            name: field.name,
            targetKind: field.targetKind ?? "instrument",
            targets: [field.target],
            cardinality: { min: 0, max: field.maxItems },
          },
        ];
      return [];
    },
  );
  for (const object of document.objects) {
    const attachment = object.attachments.find(
      (item) => item.instrument === instrument.id,
    );
    if (!attachment) continue;
    for (const child of object.attachments.filter(
      (item) => item.parent === attachment.name,
    ))
      references.push({
        kind: "child",
        via: "attachment",
        name: child.name,
        targetKind: "instrument",
        targets: [child.instrument],
        cardinality: { min: 0, max: null },
      });
  }
  for (const name of instrument.actionOrder)
    for (const call of instrument.actions[name]!.invoke ?? [])
      if ("instrument" in call)
        references.push({
          kind: "child",
          via: "invocation",
          name,
          targetKind: "instrument",
          targets: [call.instrument],
          // This bound is per invocation, not the lifetime number of children.
          cardinality: { min: 0, max: call.range?.maximum ?? 1 },
        });
  for (const child of document.instruments) {
    const parentActor = Object.values(child.actions).some(
      (action) =>
        typeof action.actor === "object" &&
        "parent" in action.actor &&
        targets(action.actor.parent).includes(instrument.id),
    );
    if (
      parentActor &&
      child.fields.some(
        (field) =>
          field.type === "ref" &&
          field.targetKind === "instrument" &&
          targets(field.target).includes(instrument.id),
      )
    )
      references.push({
        kind: "child",
        via: "parent_actor",
        name: child.id,
        targetKind: "instrument",
        targets: [child.id],
        cardinality: { min: 0, max: null },
      });
  }
  return references;
}
function projectAction(
  document: UdlDocument,
  instrument: UdlInstrument,
  name: string,
): SemanticAction {
  const action = instrument.actions[name]!;
  const transition = instrument.lifecycle.transitions[name];
  const actor = action.actor;
  return {
    name,
    alias: action.publicAction ?? null,
    title: action.title ?? presentationLabel(action.publicAction ?? name),
    actor,
    roles: [
      typeof actor === "string"
        ? { kind: actor }
        : "party" in actor
          ? owner(document, instrument, actor.party)
          : { kind: "parent", instruments: targets(actor.parent) },
    ],
    from: transition?.from ?? [],
    to:
      name === "create"
        ? instrument.lifecycle.initial
        : (transition?.to ?? null),
    ...(name === "create"
      ? {
          references: instrument.fields.filter(
            (field) =>
              field.type === "ref" ||
              (field.type === "list" && field.item === "ref"),
          ),
          invokedBy: document.instruments.flatMap((parent) =>
            parent.actionOrder.flatMap((parentName) =>
              (parent.actions[parentName]!.invoke ?? []).flatMap((call) =>
                "instrument" in call && call.instrument === instrument.id
                  ? [
                      {
                        instrument: parent.id,
                        action: parentName,
                        alias: parent.actions[parentName]!.publicAction ?? null,
                        invocation: call,
                      },
                    ]
                  : [],
              ),
            ),
          ),
        }
      : {}),
    inputs: action.input.map(labelled),
    subject: action.subject,
    prerequisites: action.requires,
    due: action.due ?? null,
    deadline: action.deadline ?? null,
    calculations: action.calculate ?? [],
    assignments: action.set ?? {},
    moves: action.moves,
    moneyEffects: moneyEffects(document, instrument, action),
    invokes: action.invoke ?? [],
  };
}

/** Shared static meaning for authoring and discovery. No balances or eligibility are evaluated here. */
export function projectDocumentSemantics(
  document: UdlDocument,
): DocumentSemantics {
  const instruments: DocumentSemantics["instruments"] =
    document.instruments.map((instrument) => ({
      id: instrument.id,
      title: instrument.title,
      subject: instrument.subject,
      fields: instrument.fields.map(labelled),
      accounts: instrument.fields.flatMap((field) =>
        field.type === "account"
          ? accounts(document, instrument, `self.${field.name}`)
          : [],
      ),
      relationships: relationships(document, instrument),
      calculations: instrument.calculate,
      invariants: instrument.invariants ?? [],
      initialState: instrument.lifecycle.initial,
      lifecycle: {
        initial: instrument.lifecycle.initial,
        states: instrument.lifecycle.states.map((name) => ({
          name,
          label: instrument.lifecycle.labels?.[name] ?? presentationLabel(name),
          terminal: !Object.values(instrument.lifecycle.transitions).some(
            (transition) => transition.from.includes(name),
          ),
        })),
        cancellationActions: [],
      },
      actions: instrument.actionOrder.map((name) =>
        projectAction(document, instrument, name),
      ),
      reports: instrument.reports ?? [],
      structures: [],
    }));
  for (const instrument of instruments)
    projectStructures(instrument, instruments);
  return {
    currency: document.currency,
    parties: document.parties,
    objects: document.objects.map((object) => ({
      ...object,
      fields: object.fields.map(labelled),
      attachments: object.attachments.map((attachment) => ({
        ...attachment,
        title: attachment.title ?? presentationLabel(attachment.name),
        cardinality: { min: 0, max: null },
      })),
    })),
    instruments,
  };
}
