import { UDL_LIMITS } from "./limits.js";
import type { UdlAggregate, UdlDocument, UdlNoun, UdlVerb } from "./schema.js";
import { assertValidUdl, UdlError } from "./validation.js";

export interface EvolutionFieldSnapshot {
  readonly required: boolean;
  readonly schema: unknown;
}

export interface EvolutionStepSnapshot {
  readonly bind: unknown;
  readonly capture: unknown;
  readonly operation: string;
}

export interface EvolutionMoveSnapshot extends EvolutionStepSnapshot {
  readonly key: string;
}

export interface EvolutionVerbSnapshot {
  readonly deadline: unknown;
  readonly decision: unknown;
  readonly due: unknown;
  readonly earnable: boolean;
  readonly eventName: string | null;
  readonly input: Readonly<Record<string, EvolutionFieldSnapshot>> | null;
  /**
   * Every top-level input schema keyword EXCEPT properties/required (those are
   * diffed field by field). additionalProperties, oneOf, minProperties, and
   * friends change what callers may send, so they are frozen once live.
   */
  readonly inputConstraints: unknown;
  readonly port: unknown;
  readonly requiresAggregate: unknown;
  readonly requiresDrainedAccount: unknown;
  readonly requiresRefs: unknown;
  readonly setsAt: unknown;
  readonly moves: readonly EvolutionMoveSnapshot[];
  readonly steps: readonly EvolutionStepSnapshot[];
}

export interface EvolutionTransitionSnapshot {
  readonly from: readonly string[];
  readonly to: string;
}

/** The complete serializable algebra protected by append-only evolution. */
export interface NounEvolutionSnapshot {
  readonly aggregateInvariants: readonly string[];
  readonly distinctParties?: true;
  readonly fields: Readonly<Record<string, EvolutionFieldSnapshot>>;
  readonly id: string;
  readonly idPrefix: string;
  readonly initial: string;
  readonly parties: Readonly<Record<string, string>>;
  readonly partitions: readonly string[];
  readonly states: readonly string[];
  readonly subjects: readonly string[];
  readonly transitions: Readonly<Record<string, EvolutionTransitionSnapshot>>;
  readonly unwind: unknown;
  readonly updateFields: readonly string[];
  readonly updateStates: readonly string[];
  readonly verbs: Readonly<Record<string, EvolutionVerbSnapshot>>;
}

/** Project an open .udl noun into the evolution engine's exact semantic shape. */
export function snapshotUdlNoun(noun: UdlNoun): NounEvolutionSnapshot {
  const required = new Set(noun.required);
  return {
    aggregateInvariants: (noun.aggregateInvariants ?? []).map(
      aggregateInvariantKey,
    ),
    ...(noun.distinctParties ? { distinctParties: true as const } : {}),
    fields: Object.fromEntries(
      Object.entries(noun.fields).map(([field, schema]) => [
        field,
        { required: required.has(field), schema },
      ]),
    ),
    id: noun.id,
    idPrefix: noun.idPrefix,
    initial: noun.lifecycle.initial,
    parties: compactStringRecord(noun.parties),
    partitions: (noun.partitions ?? []).map(
      (partition) =>
        `${partition.totalField} = ${[...partition.pieceFields].sort().join(" + ")}`,
    ),
    states: [...noun.lifecycle.states],
    subjects: noun.subject ? [...noun.subject.kinds] : [],
    transitions: Object.fromEntries(
      Object.entries(noun.lifecycle.transitions).map(([verb, transition]) => [
        verb,
        { from: [...transition.from], to: transition.to },
      ]),
    ),
    unwind: noun.unwind ?? null,
    updateFields: noun.update?.fields ?? [],
    updateStates: noun.update?.states ?? [],
    verbs: Object.fromEntries(
      Object.entries(noun.verbs).map(([verb, definition]) => [
        verb,
        snapshotUdlVerb(definition),
      ]),
    ),
  };
}

/**
 * Compare two product definitions under the append-only evolution law.
 *
 * Both arguments are validated first. The typed signature this used to carry
 * invited a caller to hand over an object it had never parsed, and the diff
 * walks straight into `stableStringify`: a document with a cycle in it threw
 * a RangeError out of here while `validateUdl` returned a clean
 * `resource_limit` issue for the same object.
 */
export function diffUdlEvolution(
  previous: unknown,
  next: unknown,
): readonly string[] {
  return diffValidatedUdlEvolution(
    assertValidUdl(previous),
    assertValidUdl(next),
  );
}

/**
 * The same comparison for a caller holding two documents `validateUdl` has
 * already admitted. Validation costs roughly twice what the diff costs, so a
 * caller that has paid once should not pay again: `udl diff` parses both
 * files and then takes this door.
 */
export function diffValidatedUdlEvolution(
  previous: UdlDocument,
  next: UdlDocument,
): readonly string[] {
  const violations: string[] = [];
  if (previous.product !== next.product) {
    violations.push(
      `product id changed from ${previous.product} to ${next.product}`,
    );
  }
  if (next.version < previous.version) {
    violations.push(
      `product version moved backward from ${previous.version} to ${next.version}`,
    );
  }

  let semanticChange = false;
  const previousSubjects = new Map(
    previous.subjects.map((subject) => [subject.kind, subject] as const),
  );
  const nextSubjects = new Map(
    next.subjects.map((subject) => [subject.kind, subject] as const),
  );
  for (const [kind, subject] of previousSubjects) {
    const current = nextSubjects.get(kind);
    if (!current) {
      semanticChange = true;
      violations.push(`subject kind ${kind} was removed or renamed`);
    } else if (stableStringify(subject) !== stableStringify(current)) {
      semanticChange = true;
      violations.push(`subject kind ${kind} changed after becoming live`);
    }
  }
  for (const kind of nextSubjects.keys()) {
    if (!previousSubjects.has(kind)) semanticChange = true;
  }

  const previousNouns = new Map(
    previous.nouns.map((noun) => [noun.id, snapshotUdlNoun(noun)] as const),
  );
  const nextNouns = new Map(
    next.nouns.map((noun) => [noun.id, snapshotUdlNoun(noun)] as const),
  );
  for (const [id, noun] of previousNouns) {
    const current = nextNouns.get(id);
    if (!current) {
      semanticChange = true;
      violations.push(`${id}: live noun was removed from the product`);
      continue;
    }
    if (stableStringify(noun) !== stableStringify(current)) {
      semanticChange = true;
    }
    violations.push(...diffNounEvolution(noun, current));
  }
  for (const id of nextNouns.keys()) {
    if (!previousNouns.has(id)) semanticChange = true;
  }

  if (semanticChange && next.version <= previous.version) {
    violations.push(
      `product definition changed without increasing version ${previous.version}`,
    );
  }
  return violations;
}

/** Diff one noun snapshot. An empty result means the change is additive. */
export function diffNounEvolution(
  previous: NounEvolutionSnapshot,
  next: NounEvolutionSnapshot,
): readonly string[] {
  if (previous.id !== next.id) {
    return [`noun id changed from ${previous.id} to ${next.id}`];
  }
  const violations: string[] = [];
  if (previous.idPrefix !== next.idPrefix) {
    violations.push(
      `instance id prefix changed from ${previous.idPrefix} to ${next.idPrefix}`,
    );
  }
  if (previous.initial !== next.initial) {
    violations.push(
      `initial lifecycle state changed from ${previous.initial} to ${next.initial}`,
    );
  }

  violations.push(
    ...removedSetEntries(
      previous.states,
      next.states,
      (state) => `lifecycle state ${state} was removed or renamed`,
    ),
  );
  for (const [verb, transition] of Object.entries(previous.transitions)) {
    const current = next.transitions[verb];
    if (!current) {
      violations.push(`transition for verb ${verb} was removed or renamed`);
      continue;
    }
    if (transition.to !== current.to) {
      violations.push(
        `transition for verb ${verb} changed its target state from ${transition.to} to ${current.to}`,
      );
    }
    violations.push(
      ...removedSetEntries(
        transition.from,
        current.from,
        (state) =>
          `transition for verb ${verb} no longer fires from state ${state}`,
      ),
    );
  }

  violations.push(...diffFields(previous.fields, next.fields));
  if (Boolean(previous.distinctParties) !== Boolean(next.distinctParties)) {
    violations.push("distinct-party admission changed after becoming live");
  }
  violations.push(...diffVerbs(previous.verbs, next.verbs));
  violations.push(...diffParties(previous.parties, next.parties));
  violations.push(...diffAggregates(previous, next));
  violations.push(
    ...removedSetEntries(
      previous.partitions,
      next.partitions,
      (law) => `partition law [${law}] was removed`,
    ),
    ...next.partitions
      .filter((law) => !previous.partitions.includes(law))
      .map(
        (law) =>
          `partition law [${law}] was added, which can reject existing callers`,
      ),
  );
  violations.push(...diffUnwind(previous.unwind, next.unwind));
  violations.push(
    ...removedSetEntries(
      previous.subjects,
      next.subjects,
      (kind) => `subject kind ${kind} was removed, rejecting linked instances`,
    ),
    ...removedSetEntries(
      previous.updateFields,
      next.updateFields,
      (field) => `update policy no longer permits field ${field}`,
    ),
    ...removedSetEntries(
      previous.updateStates,
      next.updateStates,
      (state) => `update policy no longer permits state ${state}`,
    ),
  );
  return violations.map((violation) => `${next.id}: ${violation}`);
}

function snapshotUdlVerb(definition: UdlVerb): EvolutionVerbSnapshot {
  return {
    deadline: definition.deadline ?? null,
    decision: definition.decision ?? null,
    due: definition.due ?? null,
    earnable: definition.earnable ?? false,
    eventName: definition.eventName ?? null,
    input: definition.input ? snapshotJsonSchemaFields(definition.input) : null,
    inputConstraints: definition.input
      ? snapshotJsonSchemaConstraints(definition.input)
      : null,
    port: definition.port ?? null,
    setsAt: definition.setsAt ?? null,
    moves: definition.moves.map((move) => ({
      bind: move.bind,
      capture: move.capture ?? {},
      key: move.key,
      operation: move.operation,
    })),
    requiresAggregate: definition.requiresAggregate ?? [],
    requiresDrainedAccount: definition.requiresDrainedAccount ?? null,
    requiresRefs: definition.requiresRefs ?? [],
    steps: definition.steps.map((step) => ({
      bind: step.bind,
      capture: step.capture ?? {},
      operation: step.operation,
    })),
  };
}

function snapshotJsonSchemaFields(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, EvolutionFieldSnapshot>> {
  const properties = recordValue(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  return Object.fromEntries(
    Object.entries(properties).map(([field, fieldSchema]) => [
      field,
      { required: required.has(field), schema: fieldSchema },
    ]),
  );
}

function snapshotJsonSchemaConstraints(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const {
    properties: _properties,
    required: _required,
    ...constraints
  } = schema;
  return constraints;
}

function diffFields(
  previous: Readonly<Record<string, EvolutionFieldSnapshot>>,
  next: Readonly<Record<string, EvolutionFieldSnapshot>>,
): string[] {
  const violations: string[] = [];
  for (const [field, descriptor] of Object.entries(previous)) {
    const current = next[field];
    if (!current) {
      violations.push(`field ${field} was removed or renamed`);
      continue;
    }
    if (!descriptor.required && current.required) {
      violations.push(`field ${field} became required, tightening the schema`);
    }
    if (
      stableStringify(descriptor.schema) !== stableStringify(current.schema)
    ) {
      violations.push(
        `field ${field} schema changed; a live field schema is frozen`,
      );
    }
  }
  for (const [field, descriptor] of Object.entries(next)) {
    if (!previous[field] && descriptor.required) {
      violations.push(
        `field ${field} was added as required, which rejects existing instances (only optional fields are additive)`,
      );
    }
  }
  return violations;
}

function diffVerbs(
  previous: Readonly<Record<string, EvolutionVerbSnapshot>>,
  next: Readonly<Record<string, EvolutionVerbSnapshot>>,
): string[] {
  const violations: string[] = [];
  for (const [verb, descriptor] of Object.entries(previous)) {
    const current = next[verb];
    if (!current) {
      violations.push(`verb ${verb} was removed or renamed`);
      continue;
    }
    if (descriptor.moves.length !== current.moves.length) {
      violations.push(
        `verb ${verb} changed its move count from ${descriptor.moves.length} to ${current.moves.length}; money movement is frozen once live`,
      );
    } else {
      descriptor.moves.forEach((move, index) => {
        const nextMove = current.moves[index] as EvolutionMoveSnapshot;
        if (stableStringify(move) !== stableStringify(nextMove)) {
          violations.push(
            `verb ${verb} changed move ${move.key} at index ${index}; money movement is frozen once live`,
          );
        }
      });
    }
    if (descriptor.steps.length !== current.steps.length) {
      violations.push(
        `verb ${verb} changed its step count from ${descriptor.steps.length} to ${current.steps.length}; a live verb's steps are frozen`,
      );
    } else {
      descriptor.steps.forEach((step, index) => {
        const nextStep = current.steps[index] as EvolutionStepSnapshot;
        if (stableStringify(step) === stableStringify(nextStep)) return;
        violations.push(
          `verb ${verb} changed step ${index} (${step.operation}); a live verb's steps are frozen`,
        );
      });
    }
    violations.push(
      ...diffInput(verb, descriptor.input ?? {}, current.input ?? {}),
    );
    // A verb gaining its first input is additive (per-field checks still catch
    // added-as-required); once an input is live, its schema envelope is frozen.
    if (
      descriptor.input !== null &&
      stableStringify(descriptor.inputConstraints) !==
        stableStringify(current.inputConstraints)
    ) {
      violations.push(
        `verb ${verb} changed its input schema beyond declared fields; a live verb input is frozen`,
      );
    }
    if (
      stableStringify(descriptor.requiresRefs) !==
      stableStringify(current.requiresRefs)
    ) {
      violations.push(`verb ${verb} changed its cross-noun gates`);
    }
    if (
      stableStringify(descriptor.requiresAggregate) !==
      stableStringify(current.requiresAggregate)
    ) {
      violations.push(`verb ${verb} changed its aggregate admission gates`);
    }
    if (
      stableStringify(descriptor.requiresDrainedAccount) !==
      stableStringify(current.requiresDrainedAccount)
    ) {
      violations.push(`verb ${verb} changed its drained-account gate`);
    }
    if (descriptor.earnable !== current.earnable) {
      violations.push(`verb ${verb} changed its earnable flag`);
    }
    if (descriptor.eventName !== current.eventName) {
      violations.push(`verb ${verb} changed its event name`);
    }
    if (stableStringify(descriptor.due) !== stableStringify(current.due)) {
      violations.push(`verb ${verb} changed its due condition`);
    }
    if (
      stableStringify(descriptor.deadline) !== stableStringify(current.deadline)
    ) {
      violations.push(`verb ${verb} changed its admission deadline`);
    }
    if (
      stableStringify(descriptor.decision) !== stableStringify(current.decision)
    ) {
      violations.push(`verb ${verb} changed its provider decision`);
    }
    if (stableStringify(descriptor.port) !== stableStringify(current.port)) {
      violations.push(`verb ${verb} changed its decision port`);
    }
    if (
      stableStringify(descriptor.setsAt) !== stableStringify(current.setsAt)
    ) {
      violations.push(`verb ${verb} changed its computed timestamp`);
    }
  }
  return violations;
}

function diffInput(
  verb: string,
  previous: Readonly<Record<string, EvolutionFieldSnapshot>>,
  next: Readonly<Record<string, EvolutionFieldSnapshot>>,
): string[] {
  const violations: string[] = [];
  for (const [field, descriptor] of Object.entries(previous)) {
    const current = next[field];
    if (!current) {
      // Compiled verb inputs are strict objects, so a removed field starts
      // rejecting every caller that still sends it -- same law as noun fields.
      violations.push(
        `verb ${verb} input field ${field} was removed or renamed`,
      );
      continue;
    }
    if (!descriptor.required && current.required) {
      violations.push(
        `verb ${verb} input field ${field} became required, tightening the verb input`,
      );
    }
    if (
      stableStringify(descriptor.schema) !== stableStringify(current.schema)
    ) {
      violations.push(
        `verb ${verb} input field ${field} schema changed; a live verb input schema is frozen`,
      );
    }
  }
  for (const [field, descriptor] of Object.entries(next)) {
    if (!previous[field] && descriptor.required) {
      violations.push(
        `verb ${verb} input field ${field} was added as required, tightening the verb input`,
      );
    }
  }
  return violations;
}

function diffParties(
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): string[] {
  const violations: string[] = [];
  for (const [role, field] of Object.entries(previous)) {
    const current = next[role];
    if (!current) violations.push(`party role ${role} was removed or renamed`);
    else if (current !== field) {
      violations.push(
        `party role ${role} moved from field ${field} to ${current}`,
      );
    }
  }
  return violations;
}

function diffAggregates(
  previous: NounEvolutionSnapshot,
  next: NounEvolutionSnapshot,
): string[] {
  return [
    ...removedSetEntries(
      previous.aggregateInvariants,
      next.aggregateInvariants,
      (key) => `aggregate invariant [${key}] was removed`,
    ),
    ...next.aggregateInvariants
      .filter((key) => !previous.aggregateInvariants.includes(key))
      .map(
        (key) =>
          `aggregate invariant [${key}] was added, which can reject existing instances`,
      ),
  ];
}

function diffUnwind(previous: unknown, next: unknown): string[] {
  if (previous === null) return [];
  if (next === null) return ["unwind policy was removed"];
  return stableStringify(previous) === stableStringify(next)
    ? []
    : [
        "unwind policy changed; the penalty schedule and refund destination are frozen once live",
      ];
}

function aggregateInvariantKey(invariant: UdlAggregate): string {
  const measure =
    "childField" in invariant
      ? invariant.childField
      : `count${invariant.window ? `[${invariant.window.field} per ${invariant.window.days}d]` : ""}`;
  return `${invariant.childNounId}.${measure} within ${invariant.parentField} via ${invariant.childRefField} while ${[...invariant.childStatuses].sort().join(",")}`;
}

function removedSetEntries(
  previous: readonly string[],
  next: readonly string[],
  message: (entry: string) => string,
): string[] {
  const current = new Set(next);
  return previous.filter((entry) => !current.has(entry)).map(message);
}

function compactStringRecord(
  value: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * The comparison key every diff above is written against. It recurses, so it
 * carries the same depth budget the validator applies to a document: a
 * snapshot is never deeper than the document it came from, and the deepest
 * conformance document reaches 12 of the 24 levels. A cycle is infinite depth
 * and lands here rather than exhausting the call stack.
 */
function stableStringify(value: unknown, depth = 1): string {
  if (depth > UDL_LIMITS.maxDepth) {
    throw new UdlError([
      {
        code: "resource_limit",
        message: `UDL nesting exceeds ${UDL_LIMITS.maxDepth} levels`,
        path: "$",
      },
    ]);
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    // An arrow, not a bare reference: `map` would pass the index as the depth.
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${stableStringify(entry, depth + 1)}`,
    )
    .join(",")}}`;
}
