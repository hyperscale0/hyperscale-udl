import type {
  SemanticAccount,
  SemanticAction,
  SemanticInstrument,
} from "./object-semantics-schema.js";

const hasMoney = (instrument: SemanticInstrument) =>
  instrument.actions.some((action) => action.moneyEffects.length > 0);
const timed = (action: SemanticAction) =>
  action.due !== null || action.deadline !== null;
const sameAccount = (left: SemanticAccount, right: SemanticAccount) =>
  left.book === right.book &&
  left.key === right.key &&
  JSON.stringify(left.owner) === JSON.stringify(right.owner);

/** Select only structures proved by declarations. Names, families and prose carry no authority. */
export function projectStructures(
  instrument: SemanticInstrument,
  instruments: SemanticInstrument[],
): void {
  const actions = instrument.actions;
  const effects = actions.flatMap((action) => action.moneyEffects);
  const precedes = (before: SemanticAction, after: SemanticAction) => {
    const pending = before.to === null ? [] : [before.to];
    const seen = new Set<string>();
    while (pending.length) {
      const state = pending.pop()!;
      if (after.from.includes(state)) return true;
      if (seen.has(state)) continue;
      seen.add(state);
      for (const next of actions)
        if (next !== after && next.from.includes(state) && next.to !== null)
          pending.push(next.to);
    }
    return false;
  };
  const returnsMoney = (action: SemanticAction) => {
    for (const effect of action.moneyEffects) {
      if (
        effect.operation === "internal_transfer.void" &&
        effect.reservations.length
      )
        return true;
      if (effect.operation !== "internal_transfer.create") continue;
      for (const prior of actions) {
        if (prior === action || !precedes(prior, action)) continue;
        for (const earlier of prior.moneyEffects) {
          if (earlier.operation !== "internal_transfer.create") continue;
          if (
            effect.from.some((from) =>
              earlier.to.some((to) => sameAccount(from, to)),
            ) &&
            effect.to.some((to) =>
              earlier.from.some((from) => sameAccount(to, from)),
            )
          )
            return true;
        }
      }
    }
    return false;
  };
  const abandonsInitial = (action: SemanticAction) =>
    action.from.includes(instrument.initialState) &&
    !action.moneyEffects.length &&
    !action.invokes.length &&
    !actions.find((candidate) => candidate.name === "create")?.moneyEffects
      .length &&
    actions.some(
      (alternative) =>
        alternative !== action &&
        alternative.moneyEffects.length > 0 &&
        alternative.from.some((from) => action.from.includes(from)),
    );
  const cancellation = actions.filter(
    (action) =>
      action.from.length &&
      instrument.lifecycle.states.some(
        (state) => state.name === action.to && state.terminal,
      ) &&
      (returnsMoney(action) || abandonsInitial(action)),
  );
  instrument.lifecycle.cancellationActions = cancellation.map(
    (action) => action.name,
  );

  const linked = instruments.filter((candidate) =>
    instrument.relationships.some(
      (relationship) =>
        relationship.kind === "child" &&
        relationship.targets.includes(candidate.id),
    ),
  );
  const calendar = (candidate: SemanticInstrument) =>
    hasMoney(candidate) &&
    candidate.actions.some((action) => action.due !== null) &&
    candidate.relationships.some(
      (relationship) =>
        relationship.kind === "reference" &&
        relationship.targetKind === "instrument",
    );
  const hasParent = instruments.some((parent) =>
    parent.relationships.some(
      (relationship) =>
        relationship.kind === "child" &&
        relationship.targets.includes(instrument.id),
    ),
  );
  const reserved = actions.some((action) =>
    action.moneyEffects.some(
      (reserve) =>
        reserve.operation === "internal_transfer.reserve" &&
        ["internal_transfer.post", "internal_transfer.void"].every(
          (operation) =>
            effects.some(
              (effect) =>
                effect.operation === operation &&
                effect.reservations.some(
                  (reference) =>
                    reference.instrument === instrument.id &&
                    reference.action === action.name &&
                    reference.key === reserve.key,
                ),
            ),
        ),
    ),
  );
  const contributions = [
    ...[
      ...instrument.invariants,
      ...actions.flatMap((action) => action.prerequisites),
    ].flatMap((requirement) =>
      requirement.kind === "aggregate" ? [requirement.selection] : [],
    ),
    ...[
      ...instrument.calculations,
      ...actions.flatMap((action) => action.calculations),
    ].flatMap((calculation) =>
      calculation.op === "aggregate" ? [calculation.selection] : [],
    ),
    ...actions.flatMap((action) =>
      action.invokes.flatMap((call) =>
        "selection" in call ? [call.selection] : [],
      ),
    ),
  ];
  const fundedAccount = instrument.accounts.filter(
    (account) => account.owner.kind === "instrument" && account.book === "cash",
  );
  const funding = contributions.some((selection) => {
    if (selection.anchor !== "self.id") return false;
    const ids =
      typeof selection.instrument === "string"
        ? [selection.instrument]
        : selection.instrument;
    const children = instruments.filter(
      (candidate) =>
        ids.includes(candidate.id) &&
        candidate.relationships.some(
          (reference) =>
            reference.name === selection.reference &&
            reference.targets.includes(instrument.id),
        ),
    );
    const receivesContribution = children.some((child) =>
      child.actions.some((action) =>
        action.moneyEffects.some(
          (effect) =>
            effect.operation === "internal_transfer.create" &&
            effect.to.some((to) =>
              fundedAccount.some((account) => sameAccount(to, account)),
            ),
        ),
      ),
    );
    const balanceTarget = actions.some((action) =>
      action.prerequisites.some((requirement) => {
        if (requirement.kind !== "compare") return false;
        const values = [requirement.left, requirement.right];
        return (
          values.some(
            (value) =>
              "field" in value &&
              fundedAccount.some(
                (account) => value.field === `${account.path}.balance`,
              ),
          ) &&
          values.some(
            (value) =>
              "field" in value &&
              instrument.fields.some(
                (field) =>
                  field.type === "money" &&
                  value.field === `self.${field.name}`,
              ),
          )
        );
      }),
    );
    return receivesContribution && balanceTarget;
  });
  const structures: SemanticInstrument["structures"] = [];
  if (actions.some((action) => action.alias !== null && action.from.length))
    structures.push("stage_and_decisions");
  if (
    effects.some(
      (effect) =>
        effect.from.length &&
        effect.to.length &&
        effect.operation !== "internal_transfer.void",
    )
  )
    structures.push("payment_review");
  if (
    fundedAccount.some((account) =>
      actions.some(
        (action) =>
          action.from.length &&
          action.moneyEffects.some((effect) =>
            [...effect.from, ...effect.to].some((endpoint) =>
              sameAccount(account, endpoint),
            ),
          ),
      ),
    )
  )
    structures.push("held_funds");
  if (reserved) structures.push("reserved_payment");
  if ((hasParent && calendar(instrument)) || linked.some(calendar))
    structures.push("payment_calendar");
  if (funding) structures.push("funding_progress");
  if (
    cancellation.some((action) =>
      actions.some(
        (alternative) =>
          alternative !== action &&
          alternative.from.some((state) => action.from.includes(state)) &&
          (timed(action) || timed(alternative)),
      ),
    )
  )
    structures.push("cancellation_review");
  if (
    actions.some(
      (action) =>
        action.subject?.adapters.length ||
        action.prerequisites.some(
          (requirement) => requirement.kind === "evidence",
        ),
    )
  )
    structures.push("external_checks");
  if (instrument.reports.length) structures.push("report_view");
  instrument.structures = structures;
}
