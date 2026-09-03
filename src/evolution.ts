import { UDL_LIMITS } from "./limits.js";
import { deriveUdlActionEffects } from "./effects.js";
import type {
  UdlAggregate,
  UdlDocument,
  UdlInstrument,
  UdlAction,
} from "./schema.js";
import { udlClauseVocabulary } from "./schema.js";
import { UdlError } from "./validation.js";
import { issue, type UdlIssue } from "./diagnostics.js";

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

export interface EvolutionActionSnapshot {
  /** Missing on snapshots written before receipt-input capture existed. */
  readonly captureInput?: unknown;
  readonly deadline: unknown;
  readonly decision: unknown;
  /** Missing on snapshots written before UDL completeness. */
  readonly principal?: string | null;
  /** Missing on snapshots written before quote-commit existed. */
  readonly commit?: string | null;
  /** Missing on snapshots written before UDL completeness. */
  readonly remainder?: unknown;
  /** Missing on snapshots written before UDL completeness. */
  readonly requiresChecks?: unknown;
  /** Missing on snapshots written before UDL completeness. */
  readonly sandboxFailurePoint?: string | null;
  /** Missing on snapshots written before UDL completeness. */
  readonly updates?: readonly string[];
  /** Missing on snapshots written before weighted distribution existed. */
  readonly distribute?: unknown;
  readonly due: unknown;
  readonly earnable: boolean;
  /** Missing on snapshots written before derived effect rows entered UDL. */
  readonly effects?: unknown;
  readonly eventName: string | null;
  readonly input: Readonly<Record<string, EvolutionFieldSnapshot>> | null;
  /**
   * Every top-level input schema keyword EXCEPT properties/required (those are
   * diffed field by field). additionalProperties, string and array bounds,
   * numeric bounds, enum, const, pattern, and format change what callers may
   * send, so they are frozen once live.
   */
  readonly inputConstraints: unknown;
  /** Missing on snapshots written before payout intents existed. */
  readonly payout?: unknown;
  readonly port: unknown;
  /** Missing on snapshots written before public action metadata existed. */
  readonly publicAction?: string | null;
  readonly requiresAggregate: unknown;
  readonly requiresDrainedAccount: unknown;
  /** Missing on snapshots written before exposure gates entered open UDL. */
  readonly requiresExposure?: unknown;
  readonly requiresRefs: unknown;
  /** Missing on snapshots written before reconcile expectations existed. */
  readonly reconcile?: unknown;
  readonly setsAt: unknown;
  /** Missing on snapshots written before signed child sums existed. */
  readonly signedSum?: unknown;
  readonly moves: readonly EvolutionMoveSnapshot[];
  readonly steps: readonly EvolutionStepSnapshot[];
}

export interface EvolutionTransitionSnapshot {
  readonly from: readonly string[];
  readonly to: string;
}

/** The complete serializable algebra protected by append-only evolution. */
export interface InstrumentEvolutionSnapshot {
  /** Missing on snapshots written before UDL carried authored action order. */
  readonly actionOrder?: readonly string[];
  readonly aggregateInvariants: readonly string[];
  /** Missing on snapshots written before UDL completeness. */
  readonly callerParkedStates?: Readonly<Record<string, string>>;
  readonly derivedAmounts: readonly string[];
  /** Missing on snapshots written before UDL completeness. */
  readonly dials?: unknown;
  readonly distinctParties?: true;
  /** Missing on snapshots written before unified fee rules entered UDL. */
  readonly feeRules?: unknown;
  readonly fields: Readonly<Record<string, EvolutionFieldSnapshot>>;
  readonly id: string;
  readonly idPrefix: string;
  readonly initial: string;
  /** Missing on snapshots written before UDL completeness. */
  readonly nav?: readonly string[];
  readonly parties: Readonly<Record<string, string>>;
  readonly partitions: readonly string[];
  readonly states: readonly string[];
  readonly subjects: readonly string[];
  /** Missing on snapshots written before UDL completeness. */
  readonly subjectExtensible?: boolean;
  /** Missing on snapshots written before UDL completeness. */
  readonly surfaceVisibility?: string | null;
  /** Missing on snapshots written before UDL completeness. */
  readonly templateId?: string | null;
  readonly transitions: Readonly<Record<string, EvolutionTransitionSnapshot>>;
  /** Every quote-commit pair, keyed by quoting action. */
  readonly quotes: unknown;
  readonly updateFields: readonly string[];
  /** Missing on snapshots written before UDL completeness. */
  readonly updateExamples?: unknown;
  readonly updateStates: readonly string[];
  readonly actions: Readonly<Record<string, EvolutionActionSnapshot>>;
}

/** Project an open .udl instrument into the evolution engine's exact semantic shape. */
export function snapshotUdlInstrument(
  instrument: UdlInstrument,
): InstrumentEvolutionSnapshot {
  const required = new Set(instrument.required);
  return {
    actionOrder: [...instrument.actionOrder],
    aggregateInvariants: (instrument.aggregateInvariants ?? []).map(
      aggregateInvariantKey,
    ),
    callerParkedStates: instrument.callerParkedStates ?? {},
    derivedAmounts: (instrument.derivedAmounts ?? []).map(
      (amount) =>
        `${amount.field}=floor(${amount.sourceField}*${amount.rule.bps}/10000)`,
    ),
    dials: instrument.dials ?? [],
    ...(instrument.distinctParties ? { distinctParties: true as const } : {}),
    ...(instrument.feeRules
      ? {
          feeRules: instrument.feeRules.map((fee) => ({
            ...fee,
            rule:
              fee.rule.kind === "tiered"
                ? {
                    ...fee.rule,
                    tiers: fee.rule.tiers.map((tier) => ({
                      ...tier,
                      rule: { ...tier.rule },
                    })),
                  }
                : { ...fee.rule },
          })),
        }
      : {}),
    fields: Object.fromEntries(
      Object.entries(instrument.fields).map(([field, schema]) => [
        field,
        { required: required.has(field), schema },
      ]),
    ),
    id: instrument.id,
    idPrefix: instrument.idPrefix,
    initial: instrument.lifecycle.initial,
    nav: instrument.nav ?? [],
    parties: compactStringRecord(instrument.parties),
    partitions: (instrument.partitions ?? []).map(
      (partition) =>
        `${partition.totalField} = ${[...partition.pieceFields].sort().join(" + ")}`,
    ),
    states: [...instrument.lifecycle.states],
    subjects: instrument.subject ? [...instrument.subject.kinds] : [],
    subjectExtensible: instrument.subject?.extensible ?? false,
    surfaceVisibility: instrument.surfaceVisibility ?? null,
    templateId: instrument.templateId ?? null,
    transitions: Object.fromEntries(
      Object.entries(instrument.lifecycle.transitions).map(
        ([action, transition]) => [
          action,
          { from: [...transition.from], to: transition.to },
        ],
      ),
    ),
    quotes: Object.fromEntries(
      Object.entries(instrument.actions)
        .filter(([, action]) => action.quote)
        .map(([name, action]) => [name, action.quote]),
    ),
    updateFields: instrument.update?.fields ?? [],
    updateExamples: instrument.update?.examples ?? null,
    updateStates: instrument.update?.states ?? [],
    actions: Object.fromEntries(
      instrument.actionOrder.map((action) => [
        action,
        snapshotUdlAction(instrument.actions[action]!),
      ]),
    ),
  };
}

/**
 * Compare two product definitions under the append-only evolution law.
 *
 * Both documents must already have passed `validateUdl`. The diff walks
 * straight into `stableStringify`, so an unvalidated document with a cycle in
 * it throws a RangeError out of here where the validator would have returned a
 * clean `resource_limit` issue: parse first, then diff.
 */
export function diffValidatedUdlEvolution(
  previous: UdlDocument,
  next: UdlDocument,
): readonly UdlIssue[] {
  return diffValidatedUdlEvolutionMessages(previous, next).map((message) => {
    const instrumentId = /^([^:]+): /.exec(message)?.[1];
    const instrumentIndex = previous.instruments.findIndex(
      (instrument) => instrument.id === instrumentId,
    );
    const base =
      instrumentIndex < 0
        ? "$.instruments"
        : `$.instruments[${instrumentIndex}]`;
    return evolutionIssue(message, base);
  });
}

function diffValidatedUdlEvolutionMessages(
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

  const previousInstruments = new Map(
    previous.instruments.map(
      (instrument) =>
        [instrument.id, snapshotUdlInstrument(instrument)] as const,
    ),
  );
  const nextInstruments = new Map(
    next.instruments.map(
      (instrument) =>
        [instrument.id, snapshotUdlInstrument(instrument)] as const,
    ),
  );
  for (const [id, instrument] of previousInstruments) {
    const current = nextInstruments.get(id);
    if (!current) {
      semanticChange = true;
      violations.push(`${id}: live instrument was removed from the product`);
      continue;
    }
    if (stableStringify(instrument) !== stableStringify(current)) {
      semanticChange = true;
    }
    violations.push(...diffInstrumentEvolutionMessages(instrument, current));
  }
  for (const id of nextInstruments.keys()) {
    if (!previousInstruments.has(id)) semanticChange = true;
  }

  if (semanticChange && next.version <= previous.version) {
    violations.push(
      `product definition changed without increasing version ${previous.version}`,
    );
  }
  return violations;
}

/** Diff one instrument snapshot. An empty result means the change is additive. */
export function diffInstrumentEvolution(
  previous: InstrumentEvolutionSnapshot,
  next: InstrumentEvolutionSnapshot,
): readonly UdlIssue[] {
  return diffInstrumentEvolutionMessages(previous, next).map((message) =>
    evolutionIssue(message, "$.instruments"),
  );
}

function diffInstrumentEvolutionMessages(
  previous: InstrumentEvolutionSnapshot,
  next: InstrumentEvolutionSnapshot,
): readonly string[] {
  if (previous.id !== next.id) {
    return [`instrument id changed from ${previous.id} to ${next.id}`];
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
  for (const [action, transition] of Object.entries(previous.transitions)) {
    const current = next.transitions[action];
    if (!current) {
      violations.push(`transition for action ${action} was removed or renamed`);
      continue;
    }
    if (transition.to !== current.to) {
      violations.push(
        `transition for action ${action} changed its target state from ${transition.to} to ${current.to}`,
      );
    }
    violations.push(
      ...removedSetEntries(
        transition.from,
        current.from,
        (state) =>
          `transition for action ${action} no longer fires from state ${state}`,
      ),
    );
  }

  violations.push(...diffFields(previous.fields, next.fields));
  if (Boolean(previous.distinctParties) !== Boolean(next.distinctParties)) {
    violations.push("distinct-party admission changed after becoming live");
  }
  if (previous.actionOrder) {
    const previousActions = new Set(previous.actionOrder);
    const retainedActionOrder = (next.actionOrder ?? []).filter((action) =>
      previousActions.has(action),
    );
    if (
      stableStringify(previous.actionOrder) !==
      stableStringify(retainedActionOrder)
    ) {
      violations.push("instrument action order changed after becoming live");
    }
  }
  violations.push(...diffActions(previous.actions, next.actions));
  violations.push(...diffParties(previous.parties, next.parties));
  violations.push(...diffAggregates(previous, next));
  if (
    stableStringify(Object.keys(previous.callerParkedStates ?? {}).sort()) !==
    stableStringify(Object.keys(next.callerParkedStates ?? {}).sort())
  ) {
    violations.push("caller-parked state annotations changed");
  }
  if (
    stableStringify(previous.dials ?? []) !== stableStringify(next.dials ?? [])
  ) {
    violations.push("instrument dials changed after becoming live");
  }
  if (
    (previous.surfaceVisibility ?? null) !== (next.surfaceVisibility ?? null)
  ) {
    violations.push(
      "instrument surface visibility changed after becoming live",
    );
  }
  if ((previous.templateId ?? null) !== (next.templateId ?? null)) {
    violations.push(
      "instrument archetype template changed after becoming live",
    );
  }
  if (previous.subjectExtensible && !next.subjectExtensible) {
    violations.push("tenant-defined subject kinds are no longer accepted");
  }
  if (
    stableStringify(previous.derivedAmounts ?? []) !==
    stableStringify(next.derivedAmounts ?? [])
  ) {
    violations.push(
      "derived amount rules changed; derived money arithmetic is frozen once live",
    );
  }
  if (
    stableStringify(previous.feeRules ?? []) !==
    stableStringify(next.feeRules ?? [])
  ) {
    violations.push(
      "feeRules changed; fee calculation and settlement funding are frozen once live",
    );
  }
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
  violations.push(...diffQuotes(previous.quotes, next.quotes));
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

function evolutionIssue(message: string, instrumentBase: string): UdlIssue {
  if (message.startsWith("product id changed"))
    return issue("UDL7001", "$.product", message);
  if (message.startsWith("product version moved backward"))
    return issue("UDL7001", "$.version", message);
  if (message.startsWith("product definition changed"))
    return issue("UDL7002", "$.version", message);
  if (message.startsWith("subject kind "))
    return issue("UDL7001", "$.subjects", message);

  const instrumentMatch = /^([^:]+): (.*)$/.exec(message);
  const detail = instrumentMatch?.[2] ?? message;
  const transitionAction = /^transition for action ([a-z][a-z0-9_]*)/.exec(
    detail,
  )?.[1];
  if (transitionAction)
    return issue(
      "UDL7001",
      `${instrumentBase}.lifecycle.transitions.${transitionAction}`,
      message,
    );
  const action = /^action ([a-z][a-z0-9_]*)/.exec(detail)?.[1];
  if (action)
    return issue("UDL7001", `${instrumentBase}.actions.${action}`, message);
  if (detail.includes("instrument id"))
    return issue("UDL7001", instrumentBase, message);
  if (
    detail.includes("id prefix") ||
    detail.includes("lifecycle") ||
    detail.includes("transition") ||
    detail.includes("initial") ||
    detail.includes("live instrument was removed")
  )
    return issue("UDL7001", `${instrumentBase}.lifecycle`, message);
  if (detail.startsWith("field "))
    return issue("UDL7001", `${instrumentBase}.fields`, message);
  if (
    detail.includes("move") ||
    detail.includes("payout") ||
    detail.includes("fee") ||
    detail.includes("quote") ||
    detail.includes("derived amount") ||
    detail.includes("partition") ||
    detail.includes("distribution") ||
    detail.includes("signed child sum") ||
    detail.includes("earnable")
  )
    return issue("UDL7001", `${instrumentBase}.actions`, message);
  if (
    detail.includes("gate") ||
    detail.includes("check prerequisite") ||
    detail.includes("reconcile expectation") ||
    detail.includes("drained-account") ||
    detail.includes("exposure") ||
    detail.includes("aggregate")
  )
    return issue("UDL7001", `${instrumentBase}.actions`, message);
  if (
    detail.startsWith("action ") ||
    detail.includes("action order") ||
    detail.includes("step count")
  )
    return issue("UDL7001", `${instrumentBase}.actions`, message);
  return issue("UDL7001", instrumentBase, message);
}

function snapshotUdlAction(definition: UdlAction): EvolutionActionSnapshot {
  return {
    captureInput: definition.captureInput ?? null,
    commit: definition.commit ?? null,
    deadline: definition.deadline ?? null,
    decision: definition.decision ?? null,
    principal: definition.principal ?? null,
    remainder: definition.remainder ?? null,
    requiresChecks: definition.requiresChecks ?? [],
    sandboxFailurePoint: definition.sandboxFailurePoint ?? null,
    updates: definition.updates ?? [],
    distribute: definition.distribute ?? null,
    due: definition.due ?? null,
    earnable: definition.earnable ?? false,
    effects:
      definition.effects ??
      deriveUdlActionEffects(definition, udlClauseVocabulary),
    eventName: definition.eventName ?? null,
    input: definition.input ? snapshotJsonSchemaFields(definition.input) : null,
    inputConstraints: definition.input
      ? snapshotJsonSchemaConstraints(definition.input)
      : null,
    payout: definition.payout ?? null,
    port: definition.port ?? null,
    publicAction: definition.publicAction ?? null,
    setsAt: definition.setsAt ?? null,
    signedSum: definition.signedSum ?? null,
    moves: definition.moves.map((move) => ({
      bind: move.bind,
      capture: move.capture ?? {},
      key: move.key,
      operation: move.operation,
    })),
    requiresAggregate: definition.requiresAggregate ?? [],
    requiresDrainedAccount: definition.requiresDrainedAccount ?? null,
    requiresExposure: definition.requiresExposure ?? [],
    requiresRefs: definition.requiresRefs ?? [],
    reconcile: definition.reconcile ?? null,
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

function diffActions(
  previous: Readonly<Record<string, EvolutionActionSnapshot>>,
  next: Readonly<Record<string, EvolutionActionSnapshot>>,
): string[] {
  const violations: string[] = [];
  for (const [action, descriptor] of Object.entries(previous)) {
    const current = next[action];
    if (!current) {
      violations.push(`action ${action} was removed or renamed`);
      continue;
    }
    if (descriptor.moves.length !== current.moves.length) {
      violations.push(
        `action ${action} changed its move count from ${descriptor.moves.length} to ${current.moves.length}; money movement is frozen once live`,
      );
    } else {
      descriptor.moves.forEach((move, index) => {
        const nextMove = current.moves[index] as EvolutionMoveSnapshot;
        if (stableStringify(move) !== stableStringify(nextMove)) {
          violations.push(
            `action ${action} changed move ${move.key} at index ${index}; money movement is frozen once live`,
          );
        }
      });
    }
    if (descriptor.steps.length !== current.steps.length) {
      violations.push(
        `action ${action} changed its step count from ${descriptor.steps.length} to ${current.steps.length}; a live action's steps are frozen`,
      );
    } else {
      descriptor.steps.forEach((step, index) => {
        const nextStep = current.steps[index] as EvolutionStepSnapshot;
        if (stableStringify(step) === stableStringify(nextStep)) return;
        violations.push(
          `action ${action} changed step ${index} (${step.operation}); a live action's steps are frozen`,
        );
      });
    }
    violations.push(
      ...diffInput(action, descriptor.input ?? {}, current.input ?? {}),
    );
    // A action gaining its first input is additive (per-field checks still catch
    // added-as-required); once an input is live, its schema envelope is frozen.
    if (
      descriptor.input !== null &&
      stableStringify(descriptor.inputConstraints) !==
        stableStringify(current.inputConstraints)
    ) {
      violations.push(
        `action ${action} changed its input schema beyond declared fields; a live action input is frozen`,
      );
    }
    if (
      stableStringify(descriptor.requiresRefs) !==
      stableStringify(current.requiresRefs)
    ) {
      violations.push(`action ${action} changed its cross-instrument gates`);
    }
    if (
      stableStringify(descriptor.requiresAggregate) !==
      stableStringify(current.requiresAggregate)
    ) {
      violations.push(`action ${action} changed its aggregate admission gates`);
    }
    if (
      stableStringify(descriptor.requiresDrainedAccount) !==
      stableStringify(current.requiresDrainedAccount)
    ) {
      violations.push(`action ${action} changed its drained-account gate`);
    }
    if (
      descriptor.requiresExposure !== undefined &&
      stableStringify(descriptor.requiresExposure) !==
        stableStringify(current.requiresExposure)
    ) {
      violations.push(`action ${action} changed its exposure admission gates`);
    }
    if (
      descriptor.reconcile !== undefined &&
      stableStringify(descriptor.reconcile) !==
        stableStringify(current.reconcile)
    ) {
      violations.push(`action ${action} changed its reconcile expectations`);
    }
    if (
      stableStringify(descriptor.payout ?? null) !==
      stableStringify(current.payout ?? null)
    ) {
      violations.push(`action ${action} changed its payout intent`);
    }
    if (descriptor.earnable !== current.earnable) {
      violations.push(`action ${action} changed its earnable flag`);
    }
    if (
      descriptor.effects !== undefined &&
      stableStringify(descriptor.effects) !== stableStringify(current.effects)
    ) {
      violations.push(`action ${action} changed its derived effects`);
    }
    if (descriptor.eventName !== current.eventName) {
      violations.push(`action ${action} changed its event name`);
    }
    if (stableStringify(descriptor.due) !== stableStringify(current.due)) {
      violations.push(`action ${action} changed its due condition`);
    }
    if (
      stableStringify(descriptor.deadline) !== stableStringify(current.deadline)
    ) {
      violations.push(`action ${action} changed its admission deadline`);
    }
    if (
      stableStringify(descriptor.decision) !== stableStringify(current.decision)
    ) {
      violations.push(`action ${action} changed its provider decision`);
    }
    if ((descriptor.principal ?? null) !== (current.principal ?? null)) {
      violations.push(`action ${action} changed its caller principal`);
    }
    if (
      stableStringify(descriptor.remainder ?? null) !==
      stableStringify(current.remainder ?? null)
    ) {
      violations.push(`action ${action} changed its remainder rule`);
    }
    if (
      stableStringify(descriptor.requiresChecks ?? []) !==
      stableStringify(current.requiresChecks ?? [])
    ) {
      violations.push(`action ${action} changed its check prerequisites`);
    }
    if (
      (descriptor.sandboxFailurePoint ?? null) !==
      (current.sandboxFailurePoint ?? null)
    ) {
      violations.push(`action ${action} changed its sandbox failure point`);
    }
    if (
      stableStringify(descriptor.updates ?? []) !==
      stableStringify(current.updates ?? [])
    ) {
      violations.push(`action ${action} changed its field updates`);
    }
    if (
      stableStringify(descriptor.distribute) !==
      stableStringify(current.distribute)
    ) {
      violations.push(
        `action ${action} changed its distribution rule; money distribution is frozen once live`,
      );
    }
    if (
      descriptor.captureInput !== undefined &&
      stableStringify(descriptor.captureInput) !==
        stableStringify(current.captureInput)
    ) {
      violations.push(`action ${action} changed its captured receipt input`);
    }
    if (stableStringify(descriptor.port) !== stableStringify(current.port)) {
      violations.push(`action ${action} changed its decision port`);
    }
    if (
      descriptor.publicAction != null &&
      descriptor.publicAction !== current.publicAction
    ) {
      violations.push(`action ${action} changed its public action`);
    }
    if (
      stableStringify(descriptor.setsAt) !== stableStringify(current.setsAt)
    ) {
      violations.push(`action ${action} changed its computed timestamp`);
    }
    if (
      descriptor.signedSum !== undefined &&
      stableStringify(descriptor.signedSum) !==
        stableStringify(current.signedSum)
    ) {
      violations.push(`action ${action} changed its signed child sum`);
    }
  }
  for (const [action, descriptor] of Object.entries(next)) {
    if (previous[action] || descriptor.payout == null) continue;
    violations.push(
      `action ${action} added a payout intent; external money movement is frozen once live`,
    );
  }
  return violations;
}

function diffInput(
  action: string,
  previous: Readonly<Record<string, EvolutionFieldSnapshot>>,
  next: Readonly<Record<string, EvolutionFieldSnapshot>>,
): string[] {
  const violations: string[] = [];
  for (const [field, descriptor] of Object.entries(previous)) {
    const current = next[field];
    if (!current) {
      // Compiled action inputs are strict objects, so a removed field starts
      // rejecting every caller that still sends it -- same law as instrument fields.
      violations.push(
        `action ${action} input field ${field} was removed or renamed`,
      );
      continue;
    }
    if (!descriptor.required && current.required) {
      violations.push(
        `action ${action} input field ${field} became required, tightening the action input`,
      );
    }
    if (
      stableStringify(descriptor.schema) !== stableStringify(current.schema)
    ) {
      violations.push(
        `action ${action} input field ${field} schema changed; a live action input schema is frozen`,
      );
    }
  }
  for (const [field, descriptor] of Object.entries(next)) {
    if (!previous[field] && descriptor.required) {
      violations.push(
        `action ${action} input field ${field} was added as required, tightening the action input`,
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
  previous: InstrumentEvolutionSnapshot,
  next: InstrumentEvolutionSnapshot,
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

function diffQuotes(previous: unknown, next: unknown): string[] {
  if (previous === null || previous === undefined) return [];
  if (next === null || next === undefined) return ["quote policy was removed"];
  return stableStringify(previous) === stableStringify(next)
    ? []
    : [
        "quote policy changed; the charge schedule, the frozen fields, and the refund destination are frozen once live",
      ];
}

function aggregateInvariantKey(invariant: UdlAggregate): string {
  const measure =
    "childField" in invariant
      ? invariant.childField
      : `count${invariant.window ? `[${invariant.window.field} per ${invariant.window.days}d]` : ""}`;
  return `${invariant.childInstrumentId}.${measure} within ${invariant.parentField} via ${invariant.childRefField} while ${[...invariant.childStatuses].sort().join(",")}`;
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
      issue(
        "UDL1004",
        "$",
        `UDL nesting exceeds ${UDL_LIMITS.maxDepth} levels`,
      ),
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
