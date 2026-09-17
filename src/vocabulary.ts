import { referencePatternPrefix } from "./reference.js";
import type { UdlInstrument, UdlAggregateCondition } from "./schema.js";
import { fixedIsoDurationMs } from "./duration.js";

type Field = Record<string, unknown>;
type Add = (path: PropertyKey[], message: string) => void;
const dates = new Set([
  "date",
  "date-time",
  "hyperscale-date",
  "hyperscale-date-time",
]);
const moneyPatterns = new Set(["^[1-9][0-9]{0,17}$", "^(0|[1-9][0-9]{0,17})$"]);
const money = (field: Field | undefined) =>
  field?.type === "string" && moneyPatterns.has(String(field.pattern));
const date = (field: Field | undefined) =>
  field?.type === "string" && dates.has(String(field.format));
const account = (field: Field | undefined) =>
  field !== undefined && referencePatternPrefix(field) === "acct";
const object = (value: unknown): Field =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Field)
    : {};
const options = (field: Field | undefined): unknown[] =>
  field?.const !== undefined
    ? [field.const]
    : Array.isArray(field?.enum)
      ? field.enum
      : [];
const mutable = (instrument: UdlInstrument, field: string) =>
  instrument.update?.fields.includes(field) ||
  Object.values(instrument.actions).some((action) =>
    action.updates?.includes(field),
  );
function instrumentInstanceKey(instrumentId: string): string {
  const camel = instrumentId.replaceAll(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
  return `${camel}Id`;
}

/** Validate product laws independently of any instrument catalogue. */
/** The children buckets of an allocation owner that select this instrument or its template alias. */
function assessmentBuckets(
  owner: UdlInstrument | undefined,
  instrument: UdlInstrument,
) {
  return (
    owner?.allocation?.buckets.filter((bucket) => {
      const source = bucket.source;
      return (
        source.from === "children" &&
        ("instrumentId" in source
          ? source.instrumentId === instrument.id
          : instrument.templateBinding?.id === source.template &&
            Object.entries(source.parameters).every(
              ([key, value]) =>
                instrument.templateBinding?.parameters[key] === value,
            ))
      );
    }) ?? []
  );
}

export function validateVocabulary(
  instruments: readonly UdlInstrument[],
  add: Add,
): void {
  const byId = new Map(
    instruments.map((instrument) => [instrument.id, instrument]),
  );
  const byPrefix = new Map(
    instruments.map((instrument) => [instrument.idPrefix, instrument]),
  );
  const targets = (field: Field | undefined): UdlInstrument[] => {
    const prefix = field ? referencePatternPrefix(field) : undefined;
    const target = prefix ? byPrefix.get(prefix) : undefined;
    return target ? [target] : [];
  };
  const reference = (
    owner: UdlInstrument,
    field: string,
    path: PropertyKey[],
  ) => {
    const matches = targets(owner.fields[field]);
    if (matches.length !== 1)
      add(path, `${owner.id}.${field} must reference exactly one instrument`);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const required = (
    owner: UdlInstrument,
    field: string,
    predicate: (field: Field | undefined) => boolean,
    kind: string,
    path: PropertyKey[],
  ) => {
    if (
      !predicate(owner.fields[field]) ||
      !(
        owner.required.includes(field) ||
        owner.derivedAmounts?.some((amount) => amount.field === field) ||
        owner.feeRules?.some((amount) => amount.amountField === field) ||
        owner.actions.create?.requiresRefs?.some((gate) =>
          Object.hasOwn(gate.bind ?? {}, field),
        )
      ) ||
      mutable(owner, field)
    ) {
      add(
        path,
        `${owner.id}.${field} must be a required immutable ${kind} field`,
      );
    }
  };
  const currency = (
    owner: UdlInstrument,
    fields: readonly string[],
    path: PropertyKey[],
  ) => {
    const tags = fields.map(
      (field) => owner.fields[field]?.["x-hyperscale-currency"],
    );
    if (new Set(tags).size > 1)
      add(path, "money operands must use the same currency");
  };
  const duration = (
    owner: UdlInstrument,
    offset: string | { field: string } | undefined,
    path: PropertyKey[],
  ) => {
    if (offset === undefined) return;
    if (typeof offset === "string") {
      if (fixedIsoDurationMs(offset) === null)
        add(path, "offset must be a fixed ISO duration");
      return;
    }
    required(
      owner,
      offset.field,
      (field) => field?.type === "string",
      "duration",
      path,
    );
    const values = options(owner.fields[offset.field]);
    if (
      values.length === 0 ||
      values.some(
        (value) =>
          typeof value !== "string" || (fixedIsoDurationMs(value) ?? 0) <= 0,
      )
    )
      add(path, "duration field must enumerate positive fixed ISO durations");
  };
  const namespaces = new Map<string, string>();
  const edges = new Map<string, string[]>();
  instruments.forEach((instrument, index) => {
    const base: PropertyKey[] = ["instruments", index];
    const partitionEdges = new Map<string, string[]>();
    const computed = new Set([
      ...(instrument.derivedAmounts ?? []).map((value) => value.field),
      ...(instrument.feeRules ?? []).map((value) => value.amountField),
      ...Object.keys(
        instrument.actions.create?.requiresRefs?.reduce<Record<string, string>>(
          (result, gate) => ({ ...result, ...gate.bind }),
          {},
        ) ?? {},
      ),
    ]);
    for (const [i, partition] of (instrument.partitions ?? []).entries()) {
      const path = [...base, "partitions", i];
      const names = [partition.totalField, ...partition.pieceFields];
      if (new Set(names).size !== names.length)
        add(path, "partition total and piece fields must be distinct");
      for (const field of names) {
        if (
          !money(instrument.fields[field]) ||
          mutable(instrument, field) ||
          (!instrument.required.includes(field) && !computed.has(field))
        )
          add(
            path,
            "partition operands must be immutable money available at creation",
          );
      }
      currency(instrument, names, path);
      partitionEdges.set(partition.totalField, [
        ...(partitionEdges.get(partition.totalField) ?? []),
        ...partition.pieceFields,
      ]);
    }
    const partitionVisited = new Set<string>();
    const partitionActive = new Set<string>();
    const visitPartition = (field: string): void => {
      if (partitionActive.has(field)) {
        add(
          [...base, "partitions"],
          "partition identities cannot contain cycles",
        );
        return;
      }
      if (partitionVisited.has(field)) return;
      partitionActive.add(field);
      for (const child of partitionEdges.get(field) ?? [])
        visitPartition(child);
      partitionActive.delete(field);
      partitionVisited.add(field);
    };
    for (const field of partitionEdges.keys()) visitPartition(field);
    // Frozen prices and computed shares must fit each declared partition before admission.
    const constants = new Map<string, bigint>();
    for (const [field, schema] of Object.entries(instrument.fields))
      if (
        money(schema) &&
        typeof schema.const === "string" &&
        /^\d+$/.test(schema.const)
      )
        constants.set(field, BigInt(schema.const));
    for (const amount of instrument.derivedAmounts ?? []) {
      const source = constants.get(amount.sourceField);
      if (source === undefined) continue;
      if (amount.rule.kind === "minimum") {
        const cap = constants.get(amount.rule.capField);
        if (cap !== undefined)
          constants.set(amount.field, source < cap ? source : cap);
      } else {
        const bps =
          typeof amount.rule.bps === "number"
            ? amount.rule.bps
            : instrument.fields[amount.rule.bps.field]?.const;
        if (typeof bps === "number" && Number.isSafeInteger(bps))
          constants.set(amount.field, (source * BigInt(bps)) / 10000n);
      }
    }
    for (const [i, partition] of (instrument.partitions ?? []).entries()) {
      const total = constants.get(partition.totalField);
      if (total === undefined) continue;
      const known = partition.pieceFields.flatMap((field) => {
        const value = constants.get(field);
        return value === undefined ? [] : [value];
      });
      const minimum = partition.pieceFields.reduce(
        (sum, field) =>
          sum +
          (constants.get(field) ??
            (instrument.fields[field]?.pattern === "^[1-9][0-9]{0,17}$"
              ? 1n
              : 0n)),
        0n,
      );
      if (
        minimum > total ||
        (known.length === partition.pieceFields.length && minimum !== total)
      )
        add(
          [...base, "partitions", i],
          "constant partition pieces exceed or differ from their total",
        );
    }

    for (const [i, order] of (instrument.dateOrder ?? []).entries()) {
      const path = [...base, "dateOrder", i];
      required(instrument, order.beforeField, date, "date", path);
      required(instrument, order.afterField, date, "date", path);
      if (order.beforeField === order.afterField)
        add(path, "date order needs two distinct fields");
    }
    for (const [i, amount] of (instrument.derivedAmounts ?? []).entries()) {
      const path = [...base, "derivedAmounts", i];
      required(instrument, amount.sourceField, money, "money", path);
      if (mutable(instrument, amount.field))
        add(path, "derived amount must be immutable");
      const sourceIndex = (instrument.derivedAmounts ?? []).findIndex(
        (other) => other.field === amount.sourceField,
      );
      if (sourceIndex >= i)
        add(path, "derived source must precede its consumer");
      if (amount.rule.kind === "minimum") {
        required(instrument, amount.rule.capField, money, "money", path);
        if (amount.rule.capField === amount.field)
          add(path, "minimum cannot read its own output");
        const capIndex = (instrument.derivedAmounts ?? []).findIndex(
          (other) =>
            amount.rule.kind === "minimum" &&
            other.field === amount.rule.capField,
        );
        if (capIndex >= i) add(path, "derived cap must precede its consumer");
        currency(
          instrument,
          [amount.sourceField, amount.field, amount.rule.capField],
          path,
        );
      } else if (typeof amount.rule.bps !== "number") {
        required(
          instrument,
          amount.rule.bps.field,
          (field) => {
            if (field?.type !== "integer") return false;
            const values = options(field);
            if (values.length)
              return values.every(
                (value) =>
                  typeof value === "number" &&
                  Number.isInteger(value) &&
                  value >= 1 &&
                  value <= 9999,
              );
            return (
              typeof field.minimum === "number" &&
              field.minimum >= 1 &&
              typeof field.maximum === "number" &&
              field.maximum <= 9999
            );
          },
          "integer rate between 1 and 9999",
          path,
        );
      }
      currency(instrument, [amount.sourceField, amount.field], path);
    }
    for (const [name, action] of Object.entries(instrument.actions)) {
      const path = [...base, "actions", name];
      if (action.requestAuthority) {
        const clause = action.requestAuthority;
        const ap = [...path, "requestAuthority"];
        if (name !== "create" || action.moves.length || action.steps.length)
          add(ap, "request authority is create-only and moves no money");
        for (const field of [
          clause.instrumentField,
          clause.instanceField,
          clause.actionField,
          clause.roleField,
        ])
          required(
            instrument,
            field,
            (schema) => schema?.type === "string",
            "text",
            ap,
          );
        required(instrument, clause.expiresField, date, "date", ap);
        const party = instrument.parties?.[clause.party];
        if (!party) add(ap, "request authority must bind a declared party");
        else required(instrument, party, account, "account", ap);
        if (
          instrument.fields[clause.digestField]?.pattern !== "^[a-f0-9]{64}$" ||
          mutable(instrument, clause.digestField)
        )
          add(
            ap,
            "request authority digest must be an immutable lowercase SHA-256 field",
          );
        if (
          instrument.fields[clause.inputField]?.type !== "object" ||
          mutable(instrument, clause.inputField)
        )
          add(
            ap,
            "request authority material input must be an immutable object field",
          );
      }

      for (const gate of action.requiresRefs ?? []) {
        if (!gate.dueBefore) continue;
        const target = reference(instrument, gate.field, path);
        if (target) required(target, gate.dueBefore.field, date, "date", path);
        if (fixedIsoDurationMs(gate.dueBefore.offset) === null)
          add(path, "reference age must use a fixed ISO duration");
      }
      for (const exposure of action.requiresExposure ?? []) {
        if (!exposure.groupField && !exposure.minimumField) continue;
        const anchor = reference(instrument, exposure.anchorField, path);
        const children = byId.get(exposure.childInstrumentId);
        if (exposure.groupField) {
          required(instrument, exposure.groupField, account, "account", path);
          if (children)
            required(children, exposure.groupField, account, "account", path);
        }
        if (exposure.minimumField && anchor)
          required(anchor, exposure.minimumField, money, "money", path);
        if (!exposure.capOnAnchor || exposure.measure)
          add(path, "grouped admission uses an anchor cap over stored money");
      }
      if (action.funding) {
        const funding = action.funding;
        const obligation = reference(instrument, funding.obligationField, path);
        const tickets = byId.get(funding.ticketInstrumentId);
        required(instrument, funding.principalField, money, "money", path);
        required(
          instrument,
          funding.destinationAccountField,
          account,
          "account",
          path,
        );
        if (!tickets)
          add(path, "funding must select a declared ticket instrument");
        else {
          if (
            reference(tickets, funding.ticketRefField, path)?.id !==
            instrument.id
          )
            add(path, "funding tickets must reference their snapshot owner");
          required(tickets, funding.ticketAmountField, money, "money", path);
          required(
            tickets,
            funding.ticketInvestorField,
            account,
            "account",
            path,
          );
          required(
            tickets,
            funding.ticketAccountField,
            account,
            "account",
            path,
          );
          const collect = tickets.actions[funding.collectAction];
          if (
            !collect?.engineOwned ||
            collect.publicAction ||
            collect.due ||
            collect.moves.length ||
            collect.steps.length
          )
            add(path, "funding must own the ticket collection action");
          if (
            !tickets.lifecycle.transitions[
              funding.collectAction
            ]?.from.includes(funding.ticketStatus)
          )
            add(
              path,
              "funding collection must consume the selected ticket state",
            );
        }
        if (!obligation?.allocation)
          add(path, "funding requires an allocation-backed obligation");
        const sourceCapture = funding.sourceAccountPath.replace(/^refs\./, "");
        if (
          !funding.sourceAccountPath.startsWith("refs.") ||
          !instrument.actions.create?.steps.some(
            (step) => step.capture?.[sourceCapture] === "accountId",
          )
        )
          add(
            path,
            "funding source must be an account captured when the round opens",
          );
        if (!funding.terms[funding.principalField])
          add(
            path,
            "funding must bind its principal forward to the obligation",
          );
        if (obligation)
          for (const [local, remote] of Object.entries(funding.terms)) {
            if (
              !instrument.fields[local] ||
              !obligation.fields[remote] ||
              mutable(instrument, local) ||
              mutable(obligation, remote)
            )
              add(path, "funding terms must bind immutable declared fields");
          }
        if (name === "create" || action.moves.length || action.steps.length)
          add(path, "funding owns its postings on an existing round");
      }
      if (action.receiptDistribution) {
        const distribution = action.receiptDistribution;
        if (distribution.feeBps * (10000 + distribution.vatBps) > 10000 * 10000)
          add(
            [...path, "receiptDistribution"],
            "fee and VAT must not exceed distributable profit",
          );
        const round = reference(instrument, distribution.roundField, path);
        const receipt = reference(instrument, distribution.receiptField, path);
        if (
          !round ||
          !Object.values(round.actions).some(
            (candidate) =>
              candidate.funding?.capture === distribution.snapshotRef,
          )
        )
          add(path, "distribution requires a funding snapshot on its round");
        const capture = distribution.receiptPath.replace(/^refs\./, "");
        if (
          !distribution.receiptPath.startsWith("refs.") ||
          !receipt ||
          !Object.values(receipt.actions).some(
            (candidate) => candidate.allocate?.capture === capture,
          )
        )
          add(path, "distribution must consume an allocation receipt capture");
        if (
          receipt &&
          !Object.values(receipt.actions).some(
            (candidate) =>
              candidate.allocate?.capture === capture &&
              (distribution.mode === "loss"
                ? candidate.allocate.mode === "write_off"
                : ["payment", "payoff"].includes(candidate.allocate.mode)),
          )
        )
          add(path, "distribution mode must match its allocation receipt");
        for (const field of [
          distribution.feeAccountField,
          distribution.taxAccountField,
          distribution.residualAccountField,
        ])
          required(instrument, field, account, "account", path);
        if (
          distribution.mode === "loss" &&
          (distribution.feeBps || distribution.vatBps)
        )
          add(path, "loss distribution cannot charge fee or VAT");
        if (action.moves.length || action.steps.length)
          add(path, "receipt distribution owns its postings");
      }

      for (const [key, valuePath] of Object.entries(
        action.requiresInput ?? {},
      )) {
        const inputField = object(object(action.input?.properties)[key]);
        const field = valuePath.startsWith("fields.")
          ? instrument.fields[valuePath.slice(7)]
          : undefined;
        if (
          !field ||
          !Array.isArray(action.input?.required) ||
          !action.input.required.includes(key) ||
          !["type", "format", "pattern", "x-hyperscale-currency"].every(
            (tag) => inputField[tag] === field[tag],
          )
        )
          add(
            [...path, "requiresInput", key],
            "requiresInput must bind a required input to a stored field of the same type",
          );
        if (action.updates?.includes(valuePath.slice(7)))
          add(
            [...path, "requiresInput", key],
            "requiresInput cannot update the field it compares",
          );
      }
      const portKeys = Object.values(instrument.actions).flatMap((a) =>
        a.port?.capture ? [a.port.capture] : [],
      );
      if (
        action.port?.capture &&
        !account(instrument.fields[action.port.capture])
      )
        add(
          [...path, "port", "capture"],
          "port capture must name a declared account field",
        );
      for (const key of portKeys) {
        if (
          Object.hasOwn(action.captureInput ?? {}, key) ||
          action.updates?.includes(key) ||
          instrument.update?.fields.includes(key) ||
          Object.hasOwn(object(action.input?.properties), key) ||
          [...action.steps, ...action.moves].some((step) =>
            Object.hasOwn(step.capture ?? {}, key),
          )
        )
          add(
            [...path, "port", "capture"],
            "port capture is engine-written and cannot be supplied or updated by a caller",
          );
        if (instrument.required.includes(key))
          add(
            [...path, "port", "capture"],
            "port capture cannot be required at creation",
          );
      }
      const engineKeys = new Set(
        Object.values(instrument.actions).flatMap((a) =>
          Object.keys(a.captureEngine ?? {}),
        ),
      );
      for (const key of engineKeys)
        if (instrument.fields[key])
          add(
            [...path, "captureEngine", key],
            "engine-owned capture cannot be a caller-created stored field",
          );
      if (
        action.engineOwned &&
        (name === "create" ||
          action.publicAction ||
          action.port ||
          action.decision ||
          action.input ||
          action.captureInput ||
          action.updates)
      )
        add(
          path,
          "engine-owned actions cannot be created, exposed, or accept caller input",
        );
      if (action.captureEngine && !action.engineOwned)
        add(path, "captureEngine requires an engine-owned action");
      for (const key of [
        ...Object.keys(action.captureInput ?? {}),
        ...Object.keys(object(action.input?.properties)),
        ...(action.updates ?? []),
        ...[...action.steps, ...action.moves].flatMap((step) =>
          Object.keys(step.capture ?? {}),
        ),
      ])
        if (engineKeys.has(key))
          add(
            [...path, "captureInput", key],
            "engine-owned capture cannot be supplied by a caller",
          );
      if ((action.requiresRefs ?? []).filter((gate) => gate.attests).length > 1)
        add(
          [...path, "attests"],
          "an action can declare only one attests gate",
        );
      for (const [i, gate] of (action.requiresRefs ?? []).entries()) {
        if (!gate.attests) continue;
        const ap = [...path, "requiresRefs", i, "attests"];
        const target = reference(instrument, gate.field, ap);
        if (
          gate.attests.forAction &&
          !instrument.actions[gate.attests.forAction]
        )
          add(
            [...ap, "forAction"],
            "attests forAction must name an action on this instrument",
          );
        if (
          name === "create" ||
          gate.optional ||
          !gate.match?.instrumentInstanceId
        )
          add(
            ap,
            "attests requires a mandatory instance-bound gate on an existing instance",
          );
        if (!target) continue;
        for (const key of [
          "action",
          "digest",
          "role",
          "expiresAt",
          "instrument",
        ] as const) {
          const valuePath = gate.attests[key];
          const field = valuePath.startsWith("fields.")
            ? target.fields[valuePath.slice(7)]
            : undefined;
          const valid =
            key === "expiresAt"
              ? date(field)
              : field?.type === "string" &&
                (key !== "digest" || field.pattern === "^[a-f0-9]{64}$");
          if (!valid)
            add(
              [...ap, key],
              `attests ${key} must name a declared ${key === "expiresAt" ? "date" : key === "digest" ? "lowercase SHA-256" : "text"} field`,
            );
        }
        if (!Object.hasOwn(target.parties ?? {}, gate.attests.party))
          add(
            [...ap, "party"],
            "attests party must name a declared party on the referenced instrument",
          );
        const consume = target.actions[gate.attests.consume];
        const edge = target.lifecycle.transitions[gate.attests.consume];
        if (!consume?.engineOwned)
          add([...ap, "consume"], "attests consume must be engine-owned");
        if (
          !edge ||
          gate.statuses.some((status) => !edge.from.includes(status))
        )
          add(
            [...ap, "consume"],
            "attests consume must be reachable from every admitted status",
          );
      }
      // Literal offsets retain their existing action diagnostics.
      if (typeof action.due?.offset === "object")
        duration(instrument, action.due.offset, [...path, "due", "offset"]);
      if (typeof action.deadline?.offset === "object")
        duration(instrument, action.deadline.offset, [
          ...path,
          "deadline",
          "offset",
        ]);
      if (action.unique) {
        const up = [...path, "unique"];
        if (name !== "create") add(up, "subject unique is create-only");
        for (const field of action.unique.byFields) {
          required(
            instrument,
            field,
            (value) => value?.type === "string" || value?.type === "integer",
            "uniqueness key",
            up,
          );
          if (
            Object.values(instrument.actions).some(
              (a) =>
                a.port?.capture === field ||
                Object.hasOwn(a.captureInput ?? {}, field),
            )
          )
            add(up, "uniqueness key cannot be captured after creation");
        }
        if (
          new Set(action.unique.byFields).size !== action.unique.byFields.length
        )
          add(up, "uniqueness fields must be distinct");
        const signature = JSON.stringify([
          "subject",
          action.unique.byFields.map((field) => [
            field,
            instrument.fields[field]?.type,
            account(instrument.fields[field]),
          ]),
        ]);
        const prior = namespaces.get(action.unique.namespace);
        if (prior && prior !== signature)
          add(
            up,
            "uniqueness namespace must use one key definition and cannot mix subject and reference claims",
          );
        namespaces.set(action.unique.namespace, signature);
      }
      for (const [i, gate] of (action.requiresRefs ?? []).entries()) {
        if (typeof gate.unique !== "object") continue;
        const target = reference(instrument, gate.field, [
          ...path,
          "requiresRefs",
          i,
        ]);
        for (const field of gate.unique.byFields)
          required(
            instrument,
            field,
            (value) => value?.type === "string" || value?.type === "integer",
            "uniqueness key",
            path,
          );
        if (new Set(gate.unique.byFields).size !== gate.unique.byFields.length)
          add(path, "uniqueness fields must be distinct");
        const signature = JSON.stringify([
          target?.id,
          gate.unique.byFields.map((field) => [
            field,
            instrument.fields[field]?.type,
          ]),
        ]);
        const prior = namespaces.get(gate.unique.namespace);
        if (prior && prior !== signature)
          add(
            path,
            "uniqueness namespace must use one reference target and key definition across aliases",
          );
        namespaces.set(gate.unique.namespace, signature);
      }
      for (const [i, exposure] of (action.requiresExposure ?? []).entries()) {
        if (!exposure.measure) continue;
        const ep = [...path, "requiresExposure", i, "measure"];
        const child = byId.get(exposure.childInstrumentId);
        const allocation = child?.allocation;
        const bucket = allocation?.buckets.find(
          (b) => b.key === exposure.measure!.allocation,
        );
        if (!child || !allocation || !bucket) {
          add(
            ep,
            "exposure measure must name a bucket declared by the child allocation",
          );
          continue;
        }
        // The parent total is the gross operand, tied to the slice source by an exact schedule.
        const source = bucket.source;
        const scheduled =
          source.from === "slice" &&
          Object.values(child.actions).some((a) =>
            a.requiresAggregate?.some(
              (r) =>
                r.instrumentId === allocation.sliceInstrumentId &&
                r.refField === allocation.sliceRefField &&
                r.over === "children" &&
                !r.anchorField &&
                !r.dueBefore &&
                r.check.kind === "schedule" &&
                r.check.amounts.some(
                  (amount) =>
                    amount.amountField === source.amountField &&
                    amount.totalField === exposure.amountField,
                ),
            ),
          );
        if (!scheduled)
          add(
            ep,
            "exposure amountField must be the parent total scheduled against the allocation slice bucket",
          );
        required(child, exposure.amountField, money, "money", ep);
      }
      for (const [i, relation] of (action.requiresAggregate ?? []).entries()) {
        const rp = [...path, "requiresAggregate", i];
        // Older self-sibling clauses omit instrumentId. Their measured rows are the owner.
        const rows = relation.instrumentId
          ? byId.get(relation.instrumentId)
          : instrument;
        if (!rows) {
          add(rp, "aggregate instrument does not exist");
          continue;
        }
        const anchor = relation.anchorField
          ? reference(instrument, relation.anchorField, rp)
          : relation.over === "siblings"
            ? reference(instrument, relation.refField, rp)
            : instrument;
        if (relation.anchorField)
          required(
            instrument,
            relation.anchorField,
            (value) => targets(value).length === 1,
            "reference",
            rp,
          );
        const rowTarget = reference(rows, relation.refField, rp);
        if (anchor && rowTarget && anchor.id !== rowTarget.id)
          add(rp, "aggregate rows must reference the same anchor as the owner");
        if (mutable(rows, relation.refField))
          add(rp, "aggregate reference must be immutable");
        for (const status of relation.statuses)
          if (!rows.lifecycle.states.includes(status))
            add(rp, `aggregate status ${status} does not exist`);
        if (relation.dueBefore) {
          required(rows, relation.dueBefore.field, date, "date", rp);
          duration(rows, relation.dueBefore.offset, rp);
        }
        const check = relation.check;
        if (check.kind === "count_at_least")
          required(
            instrument,
            check.targetField,
            (field) => field?.type === "integer",
            "integer count",
            rp,
          );
        if (check.kind === "ordered" || check.kind === "schedule") {
          required(
            rows,
            check.positionField,
            (field) => field?.type === "integer",
            "integer position",
            rp,
          );
          required(
            rows,
            check.kind === "ordered" ? check.field : check.dateField,
            date,
            "date",
            rp,
          );
        }
        if (check.kind === "schedule") {
          if (
            relation.over !== "children" ||
            relation.anchorField ||
            relation.dueBefore
          )
            add(
              rp,
              "exact schedule must inspect all children of the owner without a clock filter",
            );
          required(
            instrument,
            check.datesField,
            (field) =>
              field?.type === "array" &&
              date(object(field.items)) &&
              typeof field.minItems === "number" &&
              field.minItems >= 1 &&
              typeof field.maxItems === "number" &&
              field.maxItems <= 366,
            "bounded date list",
            rp,
          );
          const keys = check.amounts.map((amount) => amount.amountField);
          if (new Set(keys).size !== keys.length)
            add(rp, "schedule amount fields must be distinct");
          for (const amount of check.amounts) {
            required(rows, amount.amountField, money, "money", rp);
            required(instrument, amount.totalField, money, "money", rp);
            if (
              rows.fields[amount.amountField]?.["x-hyperscale-currency"] !==
              instrument.fields[amount.totalField]?.["x-hyperscale-currency"]
            )
              add(rp, "schedule amounts must share a currency");
          }
        }
      }
      const outgoing: string[] = [];
      const transitioned = new Set<string>();
      for (const [i, transition] of [
        ...(action.transitionsRefs ?? []),
        ...(action.requiresRefs ?? []).flatMap((gate) =>
          gate.attests
            ? [{ field: gate.field, action: gate.attests.consume }]
            : [],
        ),
      ].entries()) {
        const tp = [...path, "transitionsRefs", i];
        if (i < (action.transitionsRefs?.length ?? 0))
          required(
            instrument,
            transition.field,
            (value) => targets(value).length === 1,
            "reference",
            tp,
          );
        const target = reference(instrument, transition.field, tp);
        const next = target?.actions[transition.action];
        const edge = target?.lifecycle.transitions[transition.action];
        if (!target || !next || !edge || transition.action === "create") {
          add(
            tp,
            "referenced transition must name an existing lifecycle action",
          );
          continue;
        }
        if (next.engineOwned && i < (action.transitionsRefs?.length ?? 0))
          add(tp, "engine-owned consumption requires an attests gate");
        if (
          next.moves.length ||
          next.steps.length ||
          next.payout ||
          next.calls?.length ||
          next.allocate ||
          next.contributionStage ||
          next.pieceStage ||
          next.captureInput ||
          next.updates?.length ||
          (Array.isArray(next.input?.required) &&
            next.input.required.length > 0)
        )
          add(
            tp,
            "referenced transition must be noncash and cannot call kernel actions",
          );
        const transitionKey = `${transition.field}.${transition.action}`;
        if (transitioned.has(transitionKey))
          add(
            tp,
            "referenced transition cannot repeat the same reference and action",
          );
        transitioned.add(transitionKey);
        outgoing.push(`${target.id}.${transition.action}`);
      }
      edges.set(`${instrument.id}.${name}`, outgoing);
      if (action.cascade) {
        const ap = [...path, "cascade"];
        if (name === "create" || action.decision) {
          add(
            ap,
            "cascade is not allowed on create or actions with a decision",
          );
        }
        const seenInputFields = new Set<string>();
        for (const [i, entry] of action.cascade.entries()) {
          const ep = [...ap, i];
          const hasInput =
            "inputField" in entry && entry.inputField !== undefined;
          const hasRef = "refField" in entry && entry.refField !== undefined;
          if ((!hasInput && !hasRef) || (hasInput && hasRef)) {
            add(
              ep,
              "cascade must specify exactly one of inputField or refField",
            );
          }
          const target = byId.get(entry.instrumentId);
          if (!target) {
            add(
              ep,
              "cascade target instrument must be declared in the document",
            );
          } else {
            const targetAction = target.actions[entry.action];
            const targetTransition = target.lifecycle.transitions[entry.action];
            if (
              !targetAction ||
              !targetTransition ||
              entry.action === "create"
            ) {
              add(
                ep,
                "cascade target action must exist in lifecycle and cannot be create",
              );
            } else {
              if (targetAction.engineOwned) {
                add(ep, "cascade target action cannot be engine-owned");
              }
              if (targetAction.cascade) {
                add(
                  ep,
                  "cascade target action cannot have a cascade of its own",
                );
              }
              if (targetAction.decision) {
                add(ep, "cascade target action cannot have a decision");
              }
              if (targetAction.port && !action.port) {
                add(
                  ep,
                  `cascade target action ${entry.action} declares a port; the parent action ${name} must declare a port so the actor is forwarded`,
                );
              }
              if (
                Array.isArray(targetAction.input?.required) &&
                targetAction.input.required.length > 0
              ) {
                add(ep, "cascade target action cannot have required inputs");
              }
            }
            if ("refField" in entry && entry.refField !== undefined) {
              if (!entry.statuses || entry.statuses.length === 0) {
                add(ep, "cascade with refField requires statuses");
              }
              const targetRef = reference(target, entry.refField, ep);
              if (targetRef && targetRef.id !== instrument.id) {
                add(
                  ep,
                  "cascade target refField must reference this instrument",
                );
              }
              if (targetTransition) {
                for (const status of entry.statuses ?? []) {
                  if (!targetTransition.from.includes(status)) {
                    add(
                      ep,
                      `cascade status ${status} is not an allowed from-state for ${target.id}.${entry.action}`,
                    );
                  }
                }
              }
            }
          }
          if ("inputField" in entry && entry.inputField !== undefined) {
            const reservedFields = new Set([
              "tenantId",
              "productId",
              "actorAccountId",
              instrumentInstanceKey(instrument.id),
            ]);
            if (reservedFields.has(entry.inputField)) {
              add(
                ep,
                `cascade inputField ${entry.inputField} collides with a reserved field`,
              );
            }
            if (Object.hasOwn(instrument.fields, entry.inputField)) {
              add(
                ep,
                `cascade inputField ${entry.inputField} collides with an instrument field`,
              );
            }
            if (
              Object.hasOwn(object(action.input?.properties), entry.inputField)
            ) {
              add(
                ep,
                `cascade inputField ${entry.inputField} collides with an action input property`,
              );
            }
            if (seenInputFields.has(entry.inputField)) {
              add(ep, `cascade inputField ${entry.inputField} is repeated`);
            }
            seenInputFields.add(entry.inputField);
          }
        }
      }
      if (action.allocate || action.contributionStage) {
        if (
          name === "create" ||
          action.moves.length ||
          action.steps.length ||
          action.payout ||
          action.calls?.length ||
          action.pieceStage ||
          action.updates?.length ||
          action.remainder ||
          action.signedSum ||
          action.distribute ||
          action.quote ||
          action.commit ||
          action.captureInput ||
          (action.allocate && action.contributionStage)
        )
          add(
            path,
            "allocation and contribution stages need a separate action without other money, capture or update clauses",
          );
        const transition = instrument.lifecycle.transitions[name];
        if (!transition || transition.from.includes(transition.to))
          add(path, "money stage requires a consuming lifecycle transition");
      }
      if (action.requiresAllocation) {
        const clause = action.requiresAllocation;
        const ap = [...path, "requiresAllocation"];
        const parent = clause.refField
          ? reference(instrument, clause.refField, ap)
          : instrument;
        if (clause.refField)
          required(
            instrument,
            clause.refField,
            (value) => targets(value).length === 1,
            "reference",
            ap,
          );
        const allocation = parent?.allocation;
        const slice =
          clause.slice === "self"
            ? instrument
            : reference(instrument, clause.slice.field, ap);
        if (
          !allocation ||
          (allocation.sliceInstrumentId !== slice?.id &&
            allocation.sliceInstrumentId !== slice?.templateBinding?.id)
        )
          add(
            ap,
            "allocation gate must select the executing slice's obligation",
          );
        if (
          new Set(clause.buckets).size !== clause.buckets.length ||
          clause.buckets.some(
            (key) => !allocation?.buckets.some((bucket) => bucket.key === key),
          )
        )
          add(ap, "allocation gate must name distinct declared buckets");
      }
      if (action.allocate) {
        const ap = [...path, "allocate"];
        const parent =
          action.allocate.refField === undefined
            ? instrument
            : reference(instrument, action.allocate.refField, ap);
        if (action.allocate.mode === "refund") {
          if (action.allocate.action === undefined) {
            // No action: reverse this assessment's recorded consumption across
            // every receipt that consumed it. The reference names the owner.
            if (
              action.allocate.refField === undefined ||
              assessmentBuckets(parent, instrument).length !== 1
            )
              add(
                ap,
                "refund without an action must reference the allocation owner of exactly one assessment bucket",
              );
          } else {
            const prior = parent?.actions[action.allocate.action]?.allocate;
            if (!prior || (prior.mode !== "payment" && prior.mode !== "payoff"))
              add(
                ap,
                "refund must reference a payment or payoff allocation receipt",
              );
          }
          if (action.allocate.assessmentField)
            required(
              instrument,
              action.allocate.assessmentField,
              (value) =>
                value?.type === "string" &&
                typeof value.minLength === "number" &&
                value.minLength > 0,
              "assessment identity",
              ap,
            );
        } else if (!parent?.allocation)
          add(
            ap,
            "allocate must reference an instrument that declares allocation",
          );
        if (action.allocate.refField !== undefined)
          required(
            instrument,
            action.allocate.refField,
            (value) => targets(value).length === 1,
            "reference",
            ap,
          );
        if (
          action.allocate.mode === "payment" ||
          action.allocate.mode === "payoff"
        ) {
          const allocation = action.allocate;
          const allowInput =
            (allocation.mode === "payoff" &&
              allocation.refField === undefined) ||
            (allocation.mode === "payment" && allocation.assessment === "self");
          const operand = (
            field: string,
            predicate: (field: Field | undefined) => boolean,
            kind: string,
          ) => {
            const input = object(action.input);
            const properties = object(input.properties);
            const inInput =
              Array.isArray(input.required) && input.required.includes(field);
            const inFields = Object.hasOwn(instrument.fields, field);
            if (allowInput && inInput && !inFields) {
              if (!predicate(object(properties[field])))
                add(ap, `${field} must be a required input ${kind}`);
            } else if (
              inInput ||
              (!allowInput && Object.hasOwn(properties, field))
            ) {
              add(
                ap,
                `${field} must resolve to exactly one permitted allocation operand`,
              );
            } else required(instrument, field, predicate, kind, ap);
          };
          if (allocation.amountField !== undefined)
            operand(allocation.amountField, money, "money");
          else if (
            allocation.mode === "payment" &&
            allocation.assessment !== "self"
          )
            add(ap, "payment without amountField requires assessment self");
          operand(allocation.sourceAccountField, account, "account");
          operand(
            action.allocate.paymentIdentityField,
            (value) =>
              value?.type === "string" &&
              typeof value.minLength === "number" &&
              value.minLength > 0,
            "nonempty payment identity",
          );
          if (
            allocation.mode === "payment" &&
            allocation.assessment === "self"
          ) {
            if (assessmentBuckets(parent, instrument).length !== 1)
              add(
                ap,
                "assessment self must match exactly one children allocation bucket",
              );
          }
          // Account provisioning may alias a field through a capture. A variable payout cannot use a held balance without a separate proof.
          const source = `fields.${action.allocate.sourceAccountField}`;
          for (const candidate of Object.values(instrument.actions))
            for (const step of candidate.steps) {
              if (
                step.operation === "account.escrow.provision" &&
                Object.keys(step.capture ?? {}).some(
                  (key) => `fields.${key}` === source,
                )
              )
                add(ap, "allocation source cannot alias a provisioned account");
            }
        }
      }
    }
    const allocation = instrument.allocation;
    if (allocation) {
      const path = [...base, "allocation"];
      const slice = byId.get(allocation.sliceInstrumentId);
      if (!slice) add(path, "allocation slice instrument does not exist");
      required(
        instrument,
        allocation.earningRuleField,
        (field) => {
          const values = options(field);
          return (
            field?.type === "string" &&
            values.length > 0 &&
            values.every(
              (value) =>
                value === "per_slice_on_due" || value === "on_disbursement",
            )
          );
        },
        "earning rule",
        path,
      );
      const keys = allocation.buckets.map((bucket) => bucket.key);
      if (
        new Set(keys).size !== keys.length ||
        !keys.includes("principal") ||
        !keys.includes("profit")
      )
        add(
          path,
          "allocation needs distinct buckets including principal and profit",
        );
      if (slice) {
        for (const status of allocation.sliceStatuses)
          if (!slice.lifecycle.states.includes(status))
            add(path, "allocation slice status does not exist");
        if (
          reference(slice, allocation.sliceRefField, path)?.id !== instrument.id
        )
          add(path, "allocation slices must reference this obligation");
        required(slice, allocation.dueField, date, "date", path);
        required(
          slice,
          allocation.positionField,
          (field) => field?.type === "integer",
          "integer position",
          path,
        );
        for (const bucket of allocation.buckets) {
          const source = bucket.source;
          const owners =
            source.from === "slice"
              ? [slice]
              : "instrumentId" in source
                ? [byId.get(source.instrumentId)]
                : instruments.filter(
                    (candidate) =>
                      candidate.templateBinding?.id === source.template &&
                      Object.entries(source.parameters).every(
                        ([key, value]) =>
                          candidate.templateBinding?.parameters[key] === value,
                      ),
                  );
          if (
            (bucket.key === "principal" || bucket.key === "profit") &&
            source.from !== "slice"
          )
            add(path, "principal and profit must be declared on the slice");
          // A catalogue may declare a template selector before a product instantiates it.
          // Every matching instance must satisfy the same bucket contract.
          for (const owner of owners) {
            if (!owner) {
              add(path, "allocation bucket instrument does not exist");
              continue;
            }
            if (source.from === "children") {
              if (reference(owner, source.refField, path)?.id !== slice.id)
                add(path, "allocation assessment must reference its slice");
              for (const status of source.statuses)
                if (!owner.lifecycle.states.includes(status))
                  add(path, "allocation assessment status does not exist");
            }
            required(owner, source.amountField, money, "money", path);
            const principal = allocation.buckets.find(
              (candidate) => candidate.key === "principal",
            )?.source;
            if (
              principal?.from === "slice" &&
              owner.fields[source.amountField]?.["x-hyperscale-currency"] !==
                slice.fields[principal.amountField]?.["x-hyperscale-currency"]
            )
              add(path, "allocation buckets must share the principal currency");
            required(owner, source.destinationField, account, "account", path);
          }
        }
      }
    }
    const contributions = instrument.contributions;
    if (contributions) {
      const path = [...base, "contributions"];
      required(instrument, contributions.totalField, money, "money", path);
      required(
        instrument,
        contributions.field,
        (field) =>
          field?.type === "array" &&
          typeof field.minItems === "number" &&
          field.minItems >= 1 &&
          typeof field.maxItems === "number" &&
          field.maxItems <= 256,
        "bounded contribution list",
        path,
      );
      const item = object(instrument.fields[contributions.field]?.items);
      const properties = object(item.properties);
      const amount = object(properties[contributions.amountKey]);
      if (
        item.type !== "object" ||
        item.additionalProperties !== false ||
        !Array.isArray(item.required) ||
        !item.required.includes(contributions.amountKey) ||
        !item.required.includes(contributions.accountKey) ||
        !money(amount) ||
        amount.pattern !== "^[1-9][0-9]{0,17}$" ||
        !account(object(properties[contributions.accountKey]))
      )
        add(
          path,
          "contribution entries require positive money and origin account in a closed object",
        );
      if (
        amount["x-hyperscale-currency"] !==
        instrument.fields[contributions.totalField]?.["x-hyperscale-currency"]
      )
        add(path, "contributions must share the total currency");
      const stages = Object.entries(instrument.actions).filter(
        ([, action]) => action.contributionStage,
      );
      const funds = stages.filter(
        ([, action]) => action.contributionStage?.stage === "fund",
      );
      if (funds.length !== 1)
        add(path, "contribution list needs exactly one funding action");
      const hold = funds[0]?.[1].contributionStage?.accountPath;
      const heldAccounts = new Set(
        (instrument.actions.create?.steps ?? [])
          .filter((step) => step.operation === "account.escrow.provision")
          .flatMap((step) =>
            Object.entries(step.capture ?? {})
              .filter(([, output]) => output === "accountId")
              .map(([name]) => `refs.${name}`),
          ),
      );
      if (!hold || !heldAccounts.has(hold))
        add(
          path,
          "contribution stages require an escrow account provisioned at creation",
        );
      for (const [, action] of stages)
        if (action.contributionStage?.accountPath !== hold)
          add(
            path,
            "contribution refunds must use the original funded account",
          );
    } else if (
      Object.values(instrument.actions).some(
        (action) => action.contributionStage,
      )
    )
      add(base, "contribution stage needs an instrument contribution list");
  });
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (key: string): void => {
    if (active.has(key)) {
      add(["instruments"], `referenced transition cycle at ${key}`);
      return;
    }
    if (visited.has(key)) return;
    active.add(key);
    for (const next of edges.get(key) ?? []) visit(next);
    active.delete(key);
    visited.add(key);
  };
  for (const key of edges.keys()) visit(key);
}

function instant(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))?$/.test(
      value,
    )
  )
    throw new Error("invalid date");
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
      value.slice(0, 10)
  )
    throw new Error("invalid date");
  return time;
}
const integerMoney = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(value))
    throw new Error("invalid money");
  return BigInt(value);
};

export function deriveUdlAmount(
  amount: NonNullable<UdlInstrument["derivedAmounts"]>[number],
  fields: Readonly<Record<string, unknown>>,
): string {
  const source = integerMoney(fields[amount.sourceField]);
  if (amount.rule.kind === "minimum") {
    const cap = integerMoney(fields[amount.rule.capField]);
    return (source < cap ? source : cap).toString();
  }
  const bps =
    typeof amount.rule.bps === "number"
      ? amount.rule.bps
      : fields[amount.rule.bps.field];
  if (
    typeof bps !== "number" ||
    !Number.isInteger(bps) ||
    bps < 1 ||
    bps > 9999
  )
    throw new Error("invalid basis-point rate");
  return ((source * BigInt(bps)) / 10000n).toString();
}

export function matchesDateOrder(
  order: NonNullable<UdlInstrument["dateOrder"]>[number],
  fields: Readonly<Record<string, unknown>>,
): boolean {
  const before = instant(fields[order.beforeField]);
  const after = instant(fields[order.afterField]);
  return order.operator === "<" ? before < after : before <= after;
}

/** Engine supplies the complete locked child set, before status filtering. */
export function matchesSchedule(
  check: Extract<UdlAggregateCondition["check"], { kind: "schedule" }>,
  parent: Readonly<Record<string, unknown>>,
  rows: readonly Readonly<Record<string, unknown>>[],
): boolean {
  const values = parent[check.datesField];
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > 366 ||
    values.length !== rows.length
  )
    return false;
  const signed = values.map(instant);
  if (signed.some((time, i) => i > 0 && time <= signed[i - 1]!)) return false;
  const sorted = [...rows].sort(
    (a, b) => Number(a[check.positionField]) - Number(b[check.positionField]),
  );
  return sorted.every(
    (row, i) =>
      row[check.positionField] === i + 1 &&
      instant(row[check.dateField]) === signed[i] &&
      check.amounts.every((amount) => {
        const total = integerMoney(parent[amount.totalField]);
        const count = BigInt(sorted.length);
        const expected = total / count + (i === 0 ? total % count : 0n);
        return integerMoney(row[amount.amountField]) === expected;
      }),
  );
}

export function isDueBefore(
  filter: NonNullable<UdlAggregateCondition["dueBefore"]>,
  fields: Readonly<Record<string, unknown>>,
  asOf: string,
): boolean {
  const offset =
    typeof filter.offset === "object"
      ? fields[filter.offset.field]
      : filter.offset;
  const duration =
    offset === undefined
      ? 0
      : typeof offset === "string"
        ? fixedIsoDurationMs(offset)
        : null;
  if (duration === null) throw new Error("invalid due offset");
  return instant(fields[filter.field]) + duration <= instant(asOf);
}

/** All entries fund together or return to their immutable origins together. */
export function planContributions(
  contract: NonNullable<UdlInstrument["contributions"]>,
  fields: Readonly<Record<string, unknown>>,
  holdAccountId: string,
  stage: "fund" | "refund",
) {
  const rows = fields[contract.field];
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    rows.length > 256 ||
    !holdAccountId ||
    (stage !== "fund" && stage !== "refund")
  )
    throw new Error("invalid contribution stage");
  const entries = rows.map((row) => {
    const record = object(row);
    const origin = record[contract.accountKey];
    const amount = integerMoney(record[contract.amountKey]);
    if (
      typeof origin !== "string" ||
      !origin ||
      origin === holdAccountId ||
      amount <= 0n
    )
      throw new Error("invalid contribution origin or amount");
    return { origin, amount };
  });
  if (
    entries.reduce((sum, entry) => sum + entry.amount, 0n) !==
    integerMoney(fields[contract.totalField])
  )
    throw new Error("contribution total mismatch");
  return entries.map((entry, index) => ({
    index,
    amount: entry.amount,
    sourceAccountId: stage === "fund" ? entry.origin : holdAccountId,
    destinationAccountId: stage === "fund" ? holdAccountId : entry.origin,
  }));
}

export function matchesOrdered(
  check: Extract<UdlAggregateCondition["check"], { kind: "ordered" }>,
  rows: readonly Readonly<Record<string, unknown>>[],
): boolean {
  const sorted = [...rows].sort(
    (a, b) => Number(a[check.positionField]) - Number(b[check.positionField]),
  );
  return (
    sorted.length > 0 &&
    sorted.every(
      (row, i) =>
        row[check.positionField] === i + 1 &&
        (i === 0 ||
          instant(sorted[i - 1]![check.field]) < instant(row[check.field])),
    )
  );
}

export function deriveRemainder(
  clause: NonNullable<UdlInstrument["actions"][string]["remainder"]>,
  fields: Readonly<Record<string, unknown>>,
  collected: readonly string[] = [],
): string | null {
  const read = (path: string) => {
    const [root, key] = path.split(".");
    return integerMoney(object(fields[root!])[key!]);
  };
  const result =
    read(clause.totalPath) -
    (clause.subtractPaths ?? []).reduce((sum, path) => sum + read(path), 0n) -
    collected.reduce((sum, value) => sum + integerMoney(value), 0n);
  if (result < 0n || (result === 0n && clause.onZero === "refuse"))
    throw new Error("remainder is not positive");
  return result === 0n ? null : result.toString();
}
