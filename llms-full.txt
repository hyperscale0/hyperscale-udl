# UDL 4

UDL is the typed contract between an HSX program and its executor. The grammar
lives in `src/schema.ts`. Generate `udl.schema.json` with
`bun scripts/emit-spec.ts --write`. There is no migration reader for earlier UDL.

## Objects and subjects

An object kind declares identity, title, authored field names, normalized fields
and display columns. Each attachment freezes its instrument identity and party
parameter bindings to `owner`, `actor`, or `operator`. Core resolves these roles
from the object row, authenticated session and product respectively. `authoredFields` records only names declared in the HSX
object block. `fields` is their union with attached action requirements. Matching
names must have matching types and constraints. Account fields belong to
instruments, never objects.

An instrument may name its object kind with `subject`. An action's `subject`
contains its requirements and any frozen adapter binding. Each requirement keeps
its source field and optional `objectField` rename. Adapter snapshots contain
provider, capability, operation, declaration digest and requirements. A null snapshot
marks an unbound adapter. It permits discovery but blocks that action. No provider
requirement is inferred from an operation name.

Object creation accepts `{}`. Its optional `fields` property accepts every
normalized field as optional. Requirements become mandatory only when the
attached action runs. Object creation performs no financial action. Instrument
creation remains an internal agreement operation and has no public action.
Attachment parties resolve from authenticated authority, never from party account
IDs supplied in a caller body.

`object-contract.ts` projects `ObjectDiscovery` for
`GET /v1/products/{productId}/objects`. It exports the discovery, instance, list
and action response types. Discovery preserves Build identity, authored field
names, the full optional create schema and each exposed action's requirements.
Object instances carry `objectId`, `kind`, `revision`, optional `externalId`,
`fields` and `productBuildId`. Action responses carry the object and either a
financial instrument outcome or null.

## Object operations

The Product API uses six routes below `/v1/products/{productId}/objects`.

| Method | Suffix                                | Result                                         |
| ------ | ------------------------------------- | ---------------------------------------------- |
| GET    | root                                  | Object discovery for the Build                 |
| POST   | `/{kind}`                             | New object with optional metadata              |
| GET    | `/{kind}`                             | Cursor-paginated objects of a kind             |
| GET    | `/{kind}/{objectId}`                  | Object metadata, revision and Build ID         |
| GET    | `/{kind}/{objectId}/actions`          | Availability and missing `requiredNow` fields  |
| POST   | `/{kind}/{objectId}/actions/{action}` | Updated object and optional instrument outcome |

Execution binds `productBuildId` and `expectedRevision`. The optional `fields`
collect subject metadata; optional `input` carries the action's typed input.
Missing requirements refuse execution. Callers reuse an idempotency key only for
retries of the same request. Staff Create for may name `ownerPrincipalId` through
its authorized path; ordinary ownership comes from the session.

## Accounts and money

A document declares SAR once. Money is a nonnegative minor-unit decimal string
of at most 18 digits. Percentages are basis points, durations are positive integer
milliseconds, and dates are timestamps with explicit offsets.

An account field either binds a party or declares an account owned by the
instrument. `owner: "self"` replaces the separate custody concept. Wallet, pool,
receivable and entitlement are uses of accounts, not different field types.
An external account is marked `external: true`. Its bank binding belongs to the
executor; programs and callers never supply bank beneficiary ids. Account
creation and binding are executor work, not caller-controlled instructions.
Accounts declare `book: "cash" | "claim"`, defaulting to cash. Moves never cross books.
Only claim accounts may declare `contra: true` and permit a negative balance.
An external account must bind a party and use the cash book. A party-bound field
is keyed by owner, book and key across the product. Its optional key defaults
to `balance`, so payer and borrower can alias the same party account. An account
owned by self defaults its key to the field name and is provisioned per instance.
Named capital, profit income, debt and loss accounts declare explicit keys. `party.buyer` is the buyer's default cash account.

Disbursement moves cash from lender to borrower and claims from borrower debt to
principal and profit receivables. Repayment moves borrower cash to lender cash and
the same claim amounts from receivables back to borrower debt. Unearned profit is
cancelled by the claim move alone. Write-off moves the principal claim to the
lender's loss account, with no cash movement. Profit is earned when a piece is paid.
These are ordinary paired moves in HSX, not executor loan rules.

A value is `{literal: value}` or `{field: path}`. Paths start with `self`, `input`, `subject`
or `party`. Reference fields allow typed traversal. Account paths expose locked,
read-only `.balance` and `.reserved` money values. `self.id`, `self.status`,
`self.createdAt` and `self.now` are sealed executor values. Callers cannot set
constants, calculated fields, account bindings or capture fields. Create supplies
declared typed references; later actions cannot replace them. A ref declares `targetKind: "object" | "instrument"` and one target id or
a list of 1 to 16 distinct target ids in that namespace. Its stored value is an
identity from one listed target. Path traversal exposes only fields
with compatible types on every target. Nested refs combine their target sets;
accounts must agree on owner, key, book, contra and external flags, and enums must
have the same values. A comparison or selection anchor must share a possible
reference target. An invoked input must accept every possible supplied target.
The executor checks the actual instance type at admission.

## Calculation and movement

Calculations form a finite dependency graph. `sum`, `subtract` and `minimum`
operate on money or integer fields, with operands of the same type as the target.
`rate`, `multiply`, `divide` and `shift` retain their typed operands. Rate and
division round down. Weighted shares also round down; residual minor units go
to the declared residual account. Cash and loss use this one rounding rule.
There is no largest-remainder allocation. Subtraction refuses a negative result. Integer results must
be safe integers. No calculation evaluates source text.

The only move instructions are `internal_transfer.create`,
`internal_transfer.reserve`, `internal_transfer.post` and `internal_transfer.void`.
Create and reserve declare an amount, from account and to account. Reserve captures
its executor-produced transfer identity into a declared self text field. Post and
void consume that identity. Callers cannot create or replace captured identities.
An external destination uses the same move vocabulary.

A loan, refund, payoff, write-off or distribution is library behavior built from
accounts, calculations and ordered moves. None has a privileged executor clause.
Outstanding principal is an account balance. A schedule consists of explicit
dated child records, with positions 1 through n in declaration order. The library
uses ordinary comparisons and aggregates to constrain those records. There is no
recurrence process, allocation bucket, partition expander or schedule requirement
in the UDL kernel.

## Admission and lifecycle

Actions declare typed input lists, requirements, an actor and an event. Lifecycle
edges name their source and destination states. Requirements and effects execute
atomically under the same account and reference locks. `set` copies typed values
to mutable fields. Action calculations read the locked snapshot and populate the
action draft before requirements. Ordered moves and invocations follow admission;
a move whose amount resolves to zero records nothing.
Invariants check the completed transaction. A due instant
is inclusive; a deadline is exclusive. Clock delays never extend deadlines.

Requirements are compare, state, unique, aggregate, evidence and hours.
A typed selection names one instrument or a bounded union, a reference field,
anchor, accepted states and row limit. Exceeding the limit refuses rather than
truncates. Optional equality filters apply to every selected type. An optional
window selects date values between `self.now - milliseconds` and `self.now`.
Aggregate sums use typed paths on the selected records, including account
balances. An invariant holds before and after every affected transaction.

`hours` converts a date path to its literal IANA timezone and accepts `[start,end)`.
A start greater than end wraps midnight; equal endpoints admit no time.
`evidence` declares subject, family, check, result and maxAge. The subject is an
account or text id. The executor selects the newest completed check for that
subject, family and kind, refuses stale evidence and requires the declared result.

`invoke` supplies typed inputs to a linked action or bounded selection. Its graph
is acyclic and bounded. Public names grant no authority; clock and parent actors
remain executor-owned.

A captured move exposes a sealed `.status` path with reserved, posted, settled,
reversed or voided. Voided means a reservation was released. Settled means the outbox received provider confirmation. Reversed
means provider failure produced a reversal move. A library payout reconciliation
compares that status with settled at its deadline. Account balances reflect the
immediate internal ledger and cannot prove an individual bank completion.
Aggregate bank reconciliation is an operations concern outside the contract.
There is no special reconciliation or exception-creation clause.

## Ten laws

1. Each concept has one concrete meaning.
2. Provider transport and credentials stay outside the contract.
3. Every state change emits its declared event.
4. Four transfer instructions are the only money movement vocabulary.
5. Instances have an opaque identity and money uses integer minor units.
6. Typed requirements and effects execute atomically.
7. Live additions preserve existing meaning; development estates may recreate.
8. Business names identify object kinds, attached instruments and public actions.
9. Waiting uses lifecycle states and clocks. Before admission, the executor
   catches up actor: clock actions with due instants on the locked instance,
   references and selected rows, in chronological order. Catch-up commits its
   own transaction and events before the caller request is evaluated. A refused
   caller request rolls back only its own drafts. Caller deadlines are refusal
   boundaries; they never execute the caller action. Separate clock actions
   carry expiry consequences. Requirements and selections observe the resulting
   clock state.
10. References close, states are reachable, captures are linear, and terminal
    instances have no remaining owned-account balances or reservations.

## Clause inventory

Document: `udl`, `version`, `product`, `title`, `currency`, `parties`, `objects`, `instruments`.
Object: `id`, `title`, `authoredFields`, `fields`, `columns`, `attachments`.
Instrument: `id`, `subject`, `title`, `summary`, `fields`, `calculate`, `lifecycle`, `actions`,
`actionOrder`, `invariants`, `examples`.
Action: `summary`, `publicAction`, `event`, `actor`, `subject`, `input`, `requires`, `due`,
`deadline`, `set`, `calculate`, `moves`, `invoke`.

The owner reduced the kernel on 17 September 2026. `allocation`, `allocate`,
`distribute`, `payout`, `reconcile`, `partitions`, `steps`, `drained`, the allocation
requirement and the schedule requirement were removed. They described library
work or duplicated accounts, comparisons and moves. The earlier UDL dialect's
JSON Schema fields, x-extensions, bind maps, pieceStage, contributionStage,
templateBinding, piecePlan, signedSum, engineOwned and captureEngine are absent.
Typed fields, calculations, account ownership and linear captures replace them.

`calculate.aggregate` reads a typed selection and yields its count or a money sum. `calculate.ratio` computes floor(amount * numerator / denominator) with arbitrary-precision intermediates and refuses a zero denominator. Numerator and denominator share a numeric type. Selection order is a list of typed ascending paths, followed by identity as the final tie-break. `invoke {instrument, action: "create", input}` creates a child record in the same transaction; its inputs resolve in the caller, and the ordinary create actor and requirements still apply.

`calculate.at` reads a typed list at a one-based position and refuses an out-of-range index. Its result has the list item type. Integer divide accepts integer operands and rounds down. Every move may capture its transfer identity into a declared self text field; reserve requires a capture. Captures and their status paths are executor-owned.

## Reporting definitions

An instrument may declare `reports`, a bounded array of strict ReportDefinition
values. Each definition contains identity/version, scope, datasets, time,
selection, calculation, validation, output and authority. The JSON schema defines
all fields. Expressions form an ordered graph with backward references, typed
money in integer minor units, explicit ratios and date operations. Source fields
must exist in every bound instrument. Company instrument reports require
cross-Build bindings and are not admitted in this version.

Joins declare one-or-many cardinality, missing-record policy and aggregates;
implicit row multiplication is forbidden. Compilation checks currencies, column
and expression types, output columns and sort keys. Execution must check complete
source populations, required facts, unique row and sort identities, reconciliation
and declared limits before publishing any result. Empty-population behavior and
unavailable facts are definition data. Request, read and release roles are
separate. Independent activation and retained deterministic replay belong to the
host; language acceptance alone does not authorize an artifact or external release.

Reporting source selections and foreign join keys must be computable from
PostgreSQL facts; ledger balances and ratios belong after capture. Aggregate
names are unique across stages. `average` requires an explicit `rounding` policy
(`floor` or `halfUp`) to retain integer and money minor-unit types. Numeric and
min/max aggregates skip nulls, return null for all-null inputs, and emit per-row
`_skippedNulls_<name>` counters in JSON and CSV. Required facts still refuse nulls.
