import { expect, test } from "bun:test";
import {
  validateUdl,
  snapshotUdlInstrument,
  diffInstrumentEvolution,
  serializeUdl,
  parseUdl,
  deriveUdlAmount,
  deriveRemainder,
  matchesOrdered,
  matchesDateOrder,
  matchesSchedule,
  isDueBefore,
  planContributions,
  deriveUdlActionEffects,
  udlClauseVocabulary,
  type UdlInstrument,
  type UdlDocument,
} from "../src/index.js";

const money = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,17})$",
  "x-hyperscale-currency": "SAR",
};
const account = {
  type: "string",
  pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
};
const date = { type: "string", format: "hyperscale-date-time" };
const ref = (prefix: string) => ({
  type: "string",
  pattern: `^${prefix}_(sandbox|live)_[a-z0-9]{8,64}$`,
});
function instrument(id = "cover", prefix = "cvr"): UdlInstrument {
  return {
    id,
    idPrefix: prefix,
    title: id,
    summary: id,
    fields: {},
    required: [],
    actionOrder: ["create", "close"],
    lifecycle: {
      initial: "open",
      states: ["open", "closed"],
      transitions: { close: { from: ["open"], to: "closed" } },
    },
    actions: {
      create: { summary: "Create", steps: [], moves: [] },
      close: { summary: "Close", steps: [], moves: [] },
    },
  };
}
function fields(owner: UdlInstrument, values: UdlInstrument["fields"]) {
  Object.assign(owner.fields, values);
  owner.required.push(...Object.keys(values));
}
function document(...instruments: UdlInstrument[]): UdlDocument {
  return {
    udl: 1,
    version: 1,
    product: "vocabulary",
    title: "Vocabulary",
    subjects: [],
    instruments,
  };
}
function accepted(doc: UdlDocument) {
  const result = validateUdl(doc);
  expect(result).toMatchObject({ ok: true });
  expect(parseUdl(serializeUdl(doc))).toEqual(doc);
}
function refused(doc: UdlDocument, mutate: (doc: UdlDocument) => void) {
  const changed = structuredClone(doc);
  mutate(changed);
  expect(validateUdl(changed).ok).toBe(false);
}

test("field commission uses the stored 500 or 1000 bps rule", () => {
  const owner = instrument();
  fields(owner, {
    premium: money,
    rate: { type: "integer", minimum: 500, maximum: 1000 },
  });
  owner.fields.commission = money;
  owner.derivedAmounts = [
    {
      field: "commission",
      sourceField: "premium",
      rounding: "floor",
      rule: { kind: "percentage_of", bps: { field: "rate" } },
    },
  ];
  const doc = document(owner);
  accepted(doc);
  const amount = owner.derivedAmounts[0]!;
  expect(deriveUdlAmount(amount, { premium: "20000", rate: 1000 })).toBe(
    "2000",
  );
  expect(deriveUdlAmount(amount, { premium: "20000", rate: 500 })).toBe("1000");
  refused(doc, (value) => {
    value.instruments[0]!.fields.rate = { type: "string" };
  });
});

test("field cap computes min(evidenced cost, cap)", () => {
  const owner = instrument();
  fields(owner, { cost: money, cap: money });
  owner.fields.charge = money;
  owner.derivedAmounts = [
    {
      field: "charge",
      sourceField: "cost",
      rounding: "floor",
      rule: { kind: "minimum", capField: "cap" },
    },
  ];
  const doc = document(owner);
  accepted(doc);
  expect(
    ["1200", "2500", "4000"].map((cost) =>
      deriveUdlAmount(owner.derivedAmounts![0]!, { cost, cap: "2500" }),
    ),
  ).toEqual(["1200", "2500", "2500"]);
  refused(doc, (value) => {
    value.instruments[0]!.fields.cap = { type: "integer" };
  });
});

test("stored grace chooses P3D or P7D and rejects unconstrained text", () => {
  const owner = instrument();
  fields(owner, {
    dueAt: date,
    grace: { type: "string", enum: ["P3D", "P7D"] },
  });
  owner.actions.close!.due = { field: "dueAt", offset: { field: "grace" } };
  const doc = document(owner);
  accepted(doc);
  const filter = { field: "dueAt", offset: { field: "grace" } };
  expect(
    isDueBefore(
      filter,
      { dueAt: "2026-01-01T00:00:00Z", grace: "P3D" },
      "2026-01-05T00:00:00Z",
    ),
  ).toBe(true);
  expect(
    isDueBefore(
      filter,
      { dueAt: "2026-01-01T00:00:00Z", grace: "P7D" },
      "2026-01-05T00:00:00Z",
    ),
  ).toBe(false);
  refused(doc, (value) => {
    value.instruments[0]!.fields.grace = { type: "string" };
  });
});

test("own date order refuses reversed cover bounds", () => {
  const owner = instrument();
  fields(owner, { start: date, end: date });
  owner.dateOrder = [
    { beforeField: "start", afterField: "end", operator: "<" },
  ];
  const doc = document(owner);
  accepted(doc);
  expect(
    matchesDateOrder(owner.dateOrder[0]!, {
      start: "2026-01-01T00:00:00Z",
      end: "2027-01-01T00:00:00Z",
    }),
  ).toBe(true);
  expect(
    matchesDateOrder(owner.dateOrder[0]!, {
      start: "2027-01-01T00:00:00Z",
      end: "2026-01-01T00:00:00Z",
    }),
  ).toBe(false);
  refused(doc, (value) => {
    value.instruments[0]!.dateOrder![0]!.afterField = "missing";
  });
});

test("two parent date gates preserve both bounds on the same reference", () => {
  const parent = instrument();
  fields(parent, { start: date, end: date });
  const slice = instrument("slice", "slc");
  fields(slice, { coverId: ref("cvr"), start: date, end: date });
  slice.actions.create!.requiresRefs = [
    {
      field: "coverId",
      statuses: ["open"],
      dateComparison: {
        localPath: "fields.start",
        operator: ">=",
        referencedPath: "fields.start",
      },
    },
    {
      field: "coverId",
      statuses: ["open"],
      dateComparison: {
        localPath: "fields.end",
        operator: "<=",
        referencedPath: "fields.end",
      },
    },
  ];
  const doc = document(parent, slice);
  accepted(doc);
  refused(doc, (value) => {
    const gates = value.instruments[1]!.actions.create!.requiresRefs!;
    gates[1] = structuredClone(gates[0]!);
  });
});

test("same-parent aggregate gates reject unrelated parent references", () => {
  const parent = instrument();
  const slice = instrument("slice", "slc");
  const claim = instrument("claim", "clm");
  fields(slice, { coverId: ref("cvr"), dueAt: date, premium: money });
  fields(claim, { coverId: ref("cvr") });
  claim.actions.create!.requiresAggregate = [
    {
      instrumentId: "slice",
      anchorField: "coverId",
      refField: "coverId",
      over: "siblings",
      statuses: ["open"],
      check: { kind: "count_exactly", value: 0 },
      dueBefore: { field: "dueAt" },
    },
  ];
  const doc = document(parent, slice, claim);
  accepted(doc);
  expect(
    isDueBefore(
      { field: "dueAt" },
      { dueAt: "2026-02-01T00:00:00Z", premium: "20000" },
      "2026-02-01T00:00:00Z",
    ),
  ).toBe(true);
  refused(doc, (value) => {
    value.instruments[2]!.fields.coverId = ref("slc");
  });
  refused(doc, (value) => {
    value.instruments[1]!.fields.dueAt = money;
  });
});

test("count aggregates use an integer target for one missed slice", () => {
  const parent = instrument();
  fields(parent, { minimumMissed: { type: "integer", minimum: 1 } });
  const slice = instrument("slice", "slc");
  fields(slice, { coverId: ref("cvr") });
  parent.actions.close!.requiresAggregate = [
    {
      instrumentId: "slice",
      refField: "coverId",
      over: "children",
      statuses: ["closed"],
      check: { kind: "count_at_least", targetField: "minimumMissed" },
    },
  ];
  const doc = document(parent, slice);
  accepted(doc);
  refused(doc, (value) => {
    value.instruments[0]!.fields.minimumMissed = money;
  });
});

test("exact signed schedule fixes dates, positions and first-slice remainder", () => {
  const parent = instrument();
  fields(parent, {
    dates: { type: "array", items: date, minItems: 1, maxItems: 366 },
    principal: money,
    profit: money,
  });
  const slice = instrument("slice", "slc");
  fields(slice, {
    coverId: ref("cvr"),
    dueAt: date,
    position: { type: "integer", minimum: 1 },
    principal: money,
    profit: money,
  });
  const check = {
    kind: "schedule" as const,
    positionField: "position",
    dateField: "dueAt",
    datesField: "dates",
    amounts: [
      { amountField: "principal", totalField: "principal" },
      { amountField: "profit", totalField: "profit" },
    ],
    remainder: "first" as const,
  };
  parent.actions.close!.requiresAggregate = [
    {
      instrumentId: "slice",
      refField: "coverId",
      over: "children",
      statuses: ["open"],
      check,
    },
  ];
  const doc = document(parent, slice);
  accepted(doc);
  const dates = Array.from(
    { length: 6 },
    (_, i) => `2026-0${i + 1}-01T00:00:00Z`,
  );
  const values = { dates, principal: "4800000", profit: "240000" };
  const rows = dates.map((dueAt, i) => ({
    dueAt,
    position: i + 1,
    principal: "800000",
    profit: "40000",
  }));
  expect(matchesSchedule(check, values, rows)).toBe(true);
  expect(
    matchesSchedule(
      check,
      values,
      rows.map((row, i) => ({ ...row, dueAt: dates[5 - i]! })),
    ),
  ).toBe(false);
  expect(
    matchesSchedule(check, { ...values, principal: "4800001" }, rows),
  ).toBe(false);
  expect(
    matchesSchedule(
      check,
      { ...values, principal: "4800001" },
      rows.map((row, i) => ({
        ...row,
        principal: i === 0 ? "800001" : row.principal,
      })),
    ),
  ).toBe(true);
  refused(doc, (value) => {
    value.instruments[1]!.fields.position = money;
  });
});

test("unique kind uses one namespace across aliases and rejects mutable keys", () => {
  const parent = instrument();
  const charge = instrument("charge", "chg");
  fields(charge, {
    sliceId: ref("cvr"),
    kind: { type: "string", enum: ["fine", "cost"] },
  });
  charge.actions.create!.requiresRefs = [
    {
      field: "sliceId",
      statuses: ["open"],
      unique: { namespace: "assessment", byFields: ["kind"] },
    },
  ];
  const doc = document(parent, charge);
  accepted(doc);
  refused(doc, (value) => {
    value.instruments[1]!.update = { fields: ["kind"], states: ["open"] };
  });
});

test("referenced lifecycle effects reject cycles and cash-bearing target actions", () => {
  const parent = instrument();
  const slice = instrument("slice", "slc");
  fields(slice, { coverId: ref("cvr") });
  slice.actions.close!.transitionsRefs = [
    { field: "coverId", action: "close" },
  ];
  const doc = document(parent, slice);
  accepted(doc);
  expect(
    deriveUdlActionEffects(slice.actions.close!, udlClauseVocabulary)
      .decides?.[0]?.signature,
  ).toBe("decides.referenced_transition");
  refused(doc, (value) => {
    const p = value.instruments[0]!;
    fields(p, { sliceId: ref("slc") });
    p.actions.close!.transitionsRefs = [{ field: "sliceId", action: "close" }];
  });
  refused(doc, (value) => {
    value.instruments[0]!.actions.close!.steps = [
      {
        operation: "account.freeze",
        bind: { accountId: { from: "const", value: "acct_sandbox_frozen001" } },
      },
    ];
  });
});

test("contributions conserve O02 and refund each immutable origin", () => {
  const clause = {
    field: "contributions",
    amountKey: "amount",
    accountKey: "origin",
    totalField: "price",
  };
  const values = {
    price: "6000000",
    contributions: [
      { amount: "1200000", origin: "buyer" },
      { amount: "4800000", origin: "funder" },
    ],
  };
  expect(
    planContributions(clause, values, "hold", "fund").map((row) => [
      row.amount,
      row.destinationAccountId,
    ]),
  ).toEqual([
    [1200000n, "hold"],
    [4800000n, "hold"],
  ]);
  expect(
    planContributions(clause, values, "hold", "refund").map((row) => [
      row.amount,
      row.destinationAccountId,
    ]),
  ).toEqual([
    [1200000n, "buyer"],
    [4800000n, "funder"],
  ]);
  expect(() =>
    planContributions(
      clause,
      { ...values, price: "6000001" },
      "hold",
      "refund",
    ),
  ).toThrow("contribution total mismatch");
});

test("multi-operand remainder refuses negative results and undeclared operands", () => {
  const owner = instrument();
  fields(owner, {
    total: money,
    paid: money,
    rebate: money,
    payer: account,
    receiver: account,
  });
  owner.actions.close!.remainder = {
    totalPath: "fields.total",
    subtractPaths: ["fields.paid", "fields.rebate"],
    amountRef: "remaining",
    onZero: "refuse",
  };
  owner.actions.close!.moves = [
    {
      key: "pay",
      operation: "internal_transfer.create",
      bind: {
        amount: { from: "instance", path: "refs.remaining" },
        sourceAccountId: { from: "instance", path: "fields.payer" },
        destinationAccountId: { from: "instance", path: "fields.receiver" },
        currency: { from: "const", value: "SAR" },
      },
    },
  ];
  const doc = document(owner);
  accepted(doc);
  expect(
    deriveRemainder(owner.actions.close!.remainder, {
      fields: { total: "5040000", paid: "840000", rebate: "200000" },
    }),
  ).toBe("4000000");
  expect(() =>
    deriveRemainder(owner.actions.close!.remainder!, {
      fields: { total: "500", paid: "400", rebate: "200" },
    }),
  ).toThrow();
  refused(doc, (value) => {
    value.instruments[0]!.actions.close!.remainder!.subtractPaths = [
      "fields.absent",
    ];
  });
});

test("aggregate date order refuses repeated positions and reversed dates", () => {
  const check = {
    kind: "ordered" as const,
    field: "dueAt",
    positionField: "position",
  };
  const rows = [
    { position: 1, dueAt: "2026-01-01T00:00:00Z" },
    { position: 2, dueAt: "2026-02-01T00:00:00Z" },
  ];
  expect(matchesOrdered(check, rows)).toBe(true);
  expect(matchesOrdered(check, [rows[0]!, { ...rows[1]!, position: 1 }])).toBe(
    false,
  );
  expect(
    matchesOrdered(check, [
      rows[0]!,
      { ...rows[1]!, dueAt: "2025-12-01T00:00:00Z" },
    ]),
  ).toBe(false);
  const parent = instrument();
  const child = instrument("slice", "slc");
  fields(child, {
    coverId: ref("cvr"),
    dueAt: date,
    position: { type: "integer" },
  });
  parent.actions.close!.requiresAggregate = [
    {
      instrumentId: "slice",
      refField: "coverId",
      over: "children",
      statuses: ["open"],
      check,
    },
  ];
  const doc = document(parent, child);
  accepted(doc);
  refused(doc, (value) => {
    value.instruments[1]!.fields.dueAt = money;
  });
});

test("allocation binds the shared obligation and immutable payment identity", () => {
  const parent = instrument();
  fields(parent, {
    earning: { type: "string", enum: ["per_slice_on_due", "on_disbursement"] },
  });
  const child = instrument("slice", "slc");
  fields(child, {
    coverId: ref("cvr"),
    dueAt: date,
    position: { type: "integer" },
    principal: money,
    profit: money,
    receiver: account,
  });
  parent.allocation = {
    sliceInstrumentId: "slice",
    sliceRefField: "coverId",
    sliceStatuses: ["open"],
    dueField: "dueAt",
    positionField: "position",
    earningRuleField: "earning",
    buckets: [
      {
        key: "principal",
        source: {
          from: "slice",
          amountField: "principal",
          destinationField: "receiver",
        },
      },
      {
        key: "profit",
        source: {
          from: "slice",
          amountField: "profit",
          destinationField: "receiver",
        },
      },
    ],
  };
  const payment = instrument("payment", "pmt");
  fields(payment, {
    coverId: ref("cvr"),
    amount: money,
    payer: account,
    paymentIdentity: { type: "string", minLength: 1 },
  });
  payment.actions.close!.allocate = {
    refField: "coverId",
    mode: "payment",
    amountField: "amount",
    sourceAccountField: "payer",
    paymentIdentityField: "paymentIdentity",
    capture: "receipt",
  };
  const doc = document(parent, child, payment);
  accepted(doc);
  refused(doc, (value) => {
    value.instruments[2]!.fields.paymentIdentity = { type: "integer" };
  });
  refused(doc, (value) => {
    value.instruments[0]!.fields.earning = {
      type: "string",
      enum: ["daily_accrual"],
    };
  });
});

test("attests requires one typed instance-bound approval and engine-only consumption", () => {
  const owner = instrument("request", "req");
  const approval = instrument("approval", "apr");
  fields(owner, { approvalId: ref("apr") });
  fields(approval, {
    requestInstrument: { type: "string" },
    deciderAccount: account,
    actionName: { type: "string" },
    digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    role: { type: "string" },
    expiry: date,
    requestId: { type: "string" },
  });
  approval.parties = { decider: "deciderAccount" };
  approval.actions.close!.engineOwned = true;
  approval.actions.close!.captureEngine = {
    consumedByOperationId: "operationId",
  };
  owner.actions.close!.requiresRefs = [
    {
      field: "approvalId",
      statuses: ["open"],
      match: { instrumentInstanceId: "fields.requestId" },
      attests: {
        instrument: "fields.requestInstrument",
        party: "decider",
        action: "fields.actionName",
        digest: "fields.digest",
        role: "fields.role",
        expiresAt: "fields.expiry",
        consume: "close",
      },
    },
  ];
  const doc = document(owner, approval);
  accepted(doc);
  for (const mutate of [
    (d: UdlDocument) => {
      d.instruments[0]!.actions.close!.requiresRefs![0]!.statuses = [];
    },
    (d: UdlDocument) => {
      delete d.instruments[0]!.actions.close!.requiresRefs![0]!.match;
    },
    (d: UdlDocument) => {
      d.instruments[0]!.actions.close!.requiresRefs!.push(
        structuredClone(owner.actions.close!.requiresRefs![0]!),
      );
    },
    (d: UdlDocument) => {
      delete d.instruments[1]!.actions.close!.engineOwned;
    },
    (d: UdlDocument) => {
      d.instruments[1]!.actions.close!.publicAction = "consumeApproval";
    },
    (d: UdlDocument) => {
      d.instruments[1]!.actions.create!.input = {
        type: "object",
        properties: { supplied: { type: "string" } },
      };
      d.instruments[1]!.actions.create!.captureInput = {
        consumedByOperationId: "supplied",
      };
    },
    (d: UdlDocument) => {
      d.instruments[0]!.actions.close!.requiresRefs![0]!.statuses = ["closed"];
    },
  ])
    refused(doc, mutate);
  for (const key of [
    "action",
    "digest",
    "role",
    "expiresAt",
    "instrument",
  ] as const)
    refused(doc, (d) => {
      d.instruments[0]!.actions.close!.requiresRefs![0]!.attests![key] =
        "fields.absent";
    });
  expect(
    deriveUdlActionEffects(owner.actions.close!, udlClauseVocabulary).decides,
  ).toEqual([
    {
      signature: "decides.referenced_transition",
      source: "transitionsRefs[0]",
    },
  ]);
});

test("subject uniqueness requires immutable typed keys and one namespace definition", () => {
  const owner = instrument();
  fields(owner, {
    borrower: account,
    currency: { type: "string" },
    serial: { type: "integer" },
  });
  owner.actions.create!.unique = {
    namespace: "limit_subject",
    byFields: ["borrower", "currency", "serial"],
  };
  const alias = structuredClone(owner);
  alias.id = "alias";
  alias.idPrefix = "als";
  const doc = document(owner, alias);
  accepted(doc);
  refused(doc, (d) => {
    d.instruments[0]!.actions.close!.unique = owner.actions.create!.unique;
  });
  refused(doc, (d) => {
    d.instruments[0]!.actions.create!.unique!.byFields = [];
  });
  refused(doc, (d) => {
    d.instruments[0]!.actions.create!.unique!.byFields =
      Array(9).fill("borrower");
  });
  refused(doc, (d) => {
    d.instruments[0]!.actions.create!.unique!.byFields = [
      "borrower",
      "borrower",
    ];
  });
  refused(doc, (d) => {
    d.instruments[0]!.required = ["currency", "serial"];
  });
  refused(doc, (d) => {
    d.instruments[0]!.fields.borrower = { type: "boolean" };
  });
  refused(doc, (d) => {
    d.instruments[0]!.actions.close!.updates = ["borrower"];
  });
  refused(doc, (d) => {
    d.instruments[1]!.actions.create!.unique!.byFields = ["currency"];
  });
  refused(doc, (d) => {
    const a = d.instruments[1]!;
    delete a.actions.create!.unique;
    fields(a, { ownerId: ref("cvr") });
    a.actions.create!.requiresRefs = [
      {
        field: "ownerId",
        statuses: ["open"],
        unique: owner.actions.create!.unique,
      },
    ];
  });
});

test("port capture is a declared account that callers cannot write", () => {
  const owner = instrument();
  fields(owner, { decider: account });
  owner.fields.decidedBy = account;
  owner.parties = { decider: "decider" };
  owner.actions.close!.port = {
    allowedParties: ["decider"],
    capture: "decidedBy",
  };
  const doc = document(owner);
  accepted(doc);
  refused(doc, (d) => {
    d.instruments[0]!.fields.decidedBy = { type: "integer" };
  });
  refused(doc, (d) => {
    d.instruments[0]!.actions.close!.port!.capture = "absent";
  });
  refused(doc, (d) => {
    d.instruments[0]!.actions.create!.captureInput = { decidedBy: "actor" };
  });
  refused(doc, (d) => {
    d.instruments[0]!.actions.close!.updates = ["decidedBy"];
  });
  refused(doc, (d) => {
    d.instruments[0]!.required.push("decidedBy");
  });
});

test("exposure measures only the gross scheduled for its child allocation bucket", async () => {
  const doc = (await Bun.file(
    new URL("../conformance/valid/vocabulary.udl", import.meta.url),
  ).json()) as UdlDocument;
  accepted(doc);
  const owner = (d: UdlDocument) =>
    d.instruments.find((i) => i.id === "cover")!;
  refused(doc, (d) => {
    owner(d).actions.create!.requiresExposure![0]!.measure!.allocation =
      "absent";
  });
  refused(doc, (d) => {
    owner(d).actions.create!.requiresExposure![0]!.measure!.allocation =
      "profit";
  });
  refused(doc, (d) => {
    delete owner(d).allocation;
  });
  refused(doc, (d) => {
    owner(d).actions.close!.requiresAggregate = owner(
      d,
    ).actions.close!.requiresAggregate!.filter(
      (r) => r.check.kind !== "schedule",
    );
  });
  const gross = structuredClone(doc);
  delete owner(gross).actions.create!.requiresExposure![0]!.measure;
  accepted(gross);
});

test("evolution retains subject uniqueness, deciding capture and allocation measure", async () => {
  for (const name of ["vocabulary", "attested"]) {
    const doc = (await Bun.file(
      new URL(`../conformance/valid/${name}.udl`, import.meta.url),
    ).json()) as UdlDocument;
    for (const original of doc.instruments) {
      for (const [actionName, action] of Object.entries(original.actions)) {
        for (const key of [
          "unique",
          "port",
          "requiresExposure",
          "requiresRefs",
        ] as const) {
          if (!action[key]) continue;
          const changed = structuredClone(original);
          delete changed.actions[actionName]![key];
          expect(
            diffInstrumentEvolution(
              snapshotUdlInstrument(original),
              snapshotUdlInstrument(changed),
            ).length,
          ).toBeGreaterThan(0);
        }
      }
    }
  }
});

test("self allocation requires an owner contract and template selectors check every matching alias", async () => {
  const doc = (await Bun.file(
    new URL("../conformance/valid/vocabulary.udl", import.meta.url),
  ).json()) as UdlDocument;
  accepted(doc);
  const owner = doc.instruments.find((row) => row.id === "cover")!;
  expect(owner.actions.write_off!.allocate).toEqual({
    mode: "write_off",
    capture: "loss",
  });
  refused(doc, (changed) => {
    const payment = changed.instruments.find((row) => row.id === "payment")!;
    payment.actions.close!.allocate = { mode: "write_off", capture: "loss" };
  });
  for (const id of ["first_cost", "second_cost"]) {
    refused(doc, (changed) => {
      changed.instruments.find((row) => row.id === id)!.fields.amount = {
        type: "string",
      };
    });
  }
  const excluded = structuredClone(doc);
  excluded.instruments.find((row) => row.id === "fine_only")!.fields.amount = {
    type: "string",
  };
  accepted(excluded);
  const original = doc.instruments.find((row) => row.id === "first_cost")!;
  const changed = structuredClone(original);
  changed.templateBinding!.parameters.cost = false;
  expect(
    diffInstrumentEvolution(
      snapshotUdlInstrument(original),
      snapshotUdlInstrument(changed),
    ),
  ).not.toEqual([]);
});

test("allocation gates and action operands reject ambiguous or foreign bindings", async () => {
  const doc = (await Bun.file(
    new URL("../conformance/valid/vocabulary.udl", import.meta.url),
  ).json()) as UdlDocument;
  accepted(doc);
  const get = (d: UdlDocument, id: string) =>
    d.instruments.find((item) => item.id === id)!;
  refused(doc, (d) => {
    get(d, "slice").actions.close!.requiresAllocation!.buckets = ["fine"];
  });
  refused(doc, (d) => {
    get(d, "slice").actions.close!.requiresAllocation!.refField = "absent";
  });
  refused(doc, (d) => {
    get(d, "cover").allocation!.sliceInstrumentId = "payment";
  });
  refused(doc, (d) => {
    get(d, "cover").actions.payoff!.input!.required = ["payerAccount"];
  });
  refused(doc, (d) => {
    get(d, "cover").fields.paymentIdentity = { type: "string" };
    get(d, "cover").required.push("paymentIdentity");
  });
  refused(doc, (d) => {
    get(d, "first_cost").actions.collect!.input!.required = [];
  });
  refused(doc, (d) => {
    const clause = get(d, "first_cost").actions.refund!.allocate!;
    if (clause.mode === "refund") clause.action = "create";
  });
  // A refund without an action must name the allocation owner of this assessment.
  refused(doc, (d) => {
    const clause = get(d, "first_cost").actions.refund!.allocate!;
    if (clause.mode === "refund") delete clause.action;
  });
  // A payment may omit its amount only when it collects its own assessment.
  refused(doc, (d) => {
    const clause = get(d, "first_cost").actions.collect!.allocate!;
    if (clause.mode === "payment") {
      delete clause.amountField;
      delete clause.assessment;
    }
  });
});
