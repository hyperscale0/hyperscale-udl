import { expect, test } from "bun:test";
import {
  analyzeInstrumentFinance,
  type UdlAction,
  type UdlDocument,
  type UdlInstrument,
} from "../src/index.js";

type Move = UdlAction["moves"][number];

function action(moves: Move[], extra: Partial<UdlAction> = {}): UdlAction {
  return {
    summary: "Act",
    event: "act",
    actor: "caller",
    input: [],
    requires: [],
    moves,
    ...extra,
  };
}

const move = (key: string, amount: string, from: string, to: string): Move => ({
  key,
  operation: "internal_transfer.create",
  amount: /^\d+$/.test(amount) ? { literal: amount } : { field: amount },
  from,
  to,
});

function instrument(
  shape: Pick<UdlInstrument, "fields" | "calculate"> & {
    transitions: Record<string, [string, string]>;
    actions: Record<string, UdlAction>;
  },
): UdlInstrument {
  const states = [...new Set(Object.values(shape.transitions).flat())];
  return {
    id: "probe",
    title: "Probe",
    summary: "Probe",
    fields: shape.fields,
    calculate: shape.calculate,
    lifecycle: {
      states,
      initial: states[0]!,
      transitions: Object.fromEntries(
        Object.entries(shape.transitions).map(([name, [from, to]]) => [
          name,
          { from: [from], to },
        ]),
      ),
    },
    actions: { create: action([]), ...shape.actions },
    actionOrder: ["create", ...Object.keys(shape.actions)],
  } as UdlInstrument;
}

const held = { name: "held", type: "account", owner: "self", book: "cash" };
const payer = { name: "payer", type: "account", owner: "owner", book: "cash" };
const share = (name: string) => ({ name, type: "money" });
const rate = (target: string, bps: number) => ({
  target,
  op: "rate",
  base: { field: "self.held.balance" },
  bps: { literal: bps },
  rounding: "floor",
});

// Mirrors the HSX lowering of `moves self.held.balance from self.held shares { ... }`.
function trip(remainder: boolean): UdlInstrument {
  const shares = remainder
    ? ["hotel", "airline", "operator"]
    : ["hotel", "airline"];
  return instrument({
    fields: [
      payer,
      held,
      share("price"),
      ...shares.map(share),
    ] as UdlInstrument["fields"],
    calculate: [
      rate("hotel", 5500),
      rate("airline", 3500),
      ...(remainder
        ? [
            {
              target: "operator",
              op: "subtract",
              base: { field: "self.held.balance" },
              subtract: [{ field: "self.hotel" }, { field: "self.airline" }],
            },
          ]
        : []),
    ] as UdlInstrument["calculate"],
    transitions: { pay: ["booked", "paid"], complete: ["paid", "completed"] },
    actions: {
      pay: action([move("in", "self.price", "self.payer", "self.held")]),
      complete: action(
        shares.map((name) =>
          move(name, `self.${name}`, "self.held", "self.payer"),
        ),
      ),
    },
  });
}

function jar(close: Move[]): UdlInstrument {
  return instrument({
    fields: [payer, held] as UdlInstrument["fields"],
    calculate: [],
    transitions: { deposit: ["open", "open"], close: ["open", "closed"] },
    actions: {
      deposit: action([move("in", "input.amount", "self.payer", "self.held")]),
      close: action(close, { allowZero: true }),
    },
  });
}

function stranded(target: UdlInstrument) {
  return analyzeInstrumentFinance(target).map(
    (issue) => issue.stranded?.accounts,
  );
}

// Mutation: stop resolving `self.held.balance` inside calculated shares.
test("a shares split of the whole balance empties the account", () => {
  expect(analyzeInstrumentFinance(trip(true))).toEqual([]);
  expect(stranded(trip(false))).toEqual([["held"]]);
});

// Mutation: keep a joined loop balance unknown through a whole-balance move.
test("a whole-balance move drains a balance a deposit loop made unknown", () => {
  expect(
    analyzeInstrumentFinance(
      jar([move("out", "self.held.balance", "self.held", "self.payer")]),
    ),
  ).toEqual([]);
  expect(stranded(jar([]))).toEqual([["held"]]);
  expect(
    stranded(jar([move("out", "input.amount", "self.held", "self.payer")])),
  ).toEqual([["held"]]);
});

// Mutation: forget every balance on any money `set`, or keep one the set changes.
test("a money set forgets only the balances that depend on it", () => {
  const priced = (set: string) =>
    instrument({
      fields: [
        payer,
        held,
        share("price"),
        share("fee"),
      ] as UdlInstrument["fields"],
      calculate: [],
      transitions: {
        pay: ["booked", "paid"],
        adjust: ["paid", "adjusted"],
        complete: ["adjusted", "completed"],
      },
      actions: {
        pay: action([move("in", "self.price", "self.payer", "self.held")]),
        adjust: action([], { set: { [set]: { literal: "5" } } }),
        complete: action([
          move("out", "self.price", "self.held", "self.payer"),
        ]),
      },
    });
  expect(analyzeInstrumentFinance(priced("fee"))).toEqual([]);
  expect(stranded(priced("price"))).toEqual([["held"]]);
});

function refund(
  pay: UdlAction,
  out: UdlAction,
  fields: object[] = [share("price")],
  calculate: object[] = [],
): UdlInstrument {
  return instrument({
    fields: [payer, held, ...fields] as UdlInstrument["fields"],
    calculate: calculate as UdlInstrument["calculate"],
    transitions: { pay: ["booked", "paid"], out: ["paid", "refunded"] },
    actions: { pay, out },
  });
}
const payIn = action([move("in", "self.price", "self.payer", "self.held")]);
const setPrice = { set: { price: { field: "input.amount" } } };

// Mutation: let a move in the setting action read the field's old symbol.
test("a move after a set in the same action reads the new value", () => {
  const payOut = [move("out", "self.price", "self.held", "self.payer")];
  expect(stranded(refund(payIn, action(payOut, setPrice)))).toEqual([["held"]]);
  expect(
    analyzeInstrumentFinance(
      refund(
        action([move("in", "self.price", "self.payer", "self.held")], setPrice),
        action(payOut),
      ),
    ),
  ).toEqual([]);
  const split = [
    {
      target: "hotel",
      op: "rate",
      base: { field: "self.price" },
      bps: { literal: 9000 },
      rounding: "floor",
    },
    {
      target: "operator",
      op: "subtract",
      base: { field: "self.price" },
      subtract: [{ field: "self.hotel" }],
    },
  ];
  const shares = (extra: Partial<UdlAction>) =>
    refund(
      payIn,
      action(
        ["hotel", "operator"].map((name) =>
          move(name, `self.${name}`, "self.held", "self.payer"),
        ),
        extra,
      ),
      [share("price"), share("hotel"), share("operator")],
      split,
    );
  expect(analyzeInstrumentFinance(shares({}))).toEqual([]);
  expect(stranded(shares(setPrice))).toEqual([["held"]]);
});

// Mutation: skip non-money sets that feed a calculated move amount.
test("a percentage set forgets the balances its calculation fed", () => {
  const fee = [
    {
      target: "fee",
      op: "rate",
      base: { field: "self.price" },
      bps: { field: "self.bps" },
      rounding: "floor",
    },
  ];
  const charged = (set: boolean) =>
    instrument({
      fields: [
        payer,
        held,
        share("price"),
        share("fee"),
        { name: "bps", type: "number" },
      ] as UdlInstrument["fields"],
      calculate: fee as UdlInstrument["calculate"],
      transitions: {
        pay: ["booked", "paid"],
        adjust: ["paid", "adjusted"],
        out: ["adjusted", "refunded"],
      },
      actions: {
        pay: action([move("in", "self.fee", "self.payer", "self.held")]),
        adjust: action([], set ? { set: { bps: { literal: 50 } } } : {}),
        out: action([move("out", "self.fee", "self.held", "self.payer")]),
      },
    });
  expect(analyzeInstrumentFinance(charged(false))).toEqual([]);
  expect(stranded(charged(true))).toEqual([["held"]]);
});

// Mutation: read another account's balance as one symbol across actions.
test("each read of a party balance is its own amount", () => {
  const sweep = action([
    move("in", "self.payer.balance", "self.payer", "self.held"),
  ]);
  expect(
    analyzeInstrumentFinance(
      refund(
        sweep,
        action([move("out", "self.held.balance", "self.held", "self.payer")]),
      ),
    ),
  ).toEqual([]);
  expect(
    stranded(
      refund(
        sweep,
        action([move("out", "self.payer.balance", "self.held", "self.payer")]),
      ),
    ),
  ).toEqual([["held"]]);
});

// Mutation: read a declared subject field as the agreement's one symbol.
test("an action that declares a subject field reads the live object", () => {
  const listed = (declare: boolean) => {
    const extra: Partial<UdlAction> = declare
      ? {
          subject: {
            requirements: [{ field: { name: "price", type: "money" } }],
            adapters: [],
          },
        }
      : {};
    return refund(
      action([move("in", "subject.price", "self.payer", "self.held")], extra),
      action([move("out", "subject.price", "self.held", "self.payer")], extra),
      [],
    );
  };
  expect(analyzeInstrumentFinance(listed(false))).toEqual([]);
  expect(stranded(listed(true))).toEqual([["held"]]);
});

// Mutation: exempt every create, including one a parent action invokes.
test("an invoked child create reads the parent's live subject", () => {
  const deposit = instrument({
    fields: [payer, held, share("amount")] as UdlInstrument["fields"],
    calculate: [
      { target: "amount", op: "sum", values: [{ field: "subject.price" }] },
    ] as UdlInstrument["calculate"],
    transitions: { refund: ["held", "refunded"] },
    actions: {
      create: action([move("in", "self.amount", "self.payer", "self.held")], {
        subject: {
          requirements: [{ field: { name: "price", type: "money" } }],
          adapters: [],
        },
      }),
      refund: action([move("out", "self.amount", "self.held", "self.payer")]),
    },
  });
  const parent = (invoke: boolean) =>
    ({
      instruments: [
        {
          ...deposit,
          id: "deal",
          actions: {
            create: action(
              [],
              invoke
                ? {
                    invoke: [
                      { instrument: "probe", action: "create", input: {} },
                    ],
                  }
                : {},
            ),
          },
        },
        deposit,
      ],
    }) as unknown as UdlDocument;
  expect(analyzeInstrumentFinance(deposit, parent(false))).toEqual([]);
  expect(
    analyzeInstrumentFinance(deposit, parent(true)).map(
      (issue) => issue.stranded?.accounts,
    ),
  ).toEqual([["held"]]);
});
