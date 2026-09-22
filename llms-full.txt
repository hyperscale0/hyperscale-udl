# UDL 4

UDL is the typed contract between an HSX program and its executor. The grammar
lives in `src/schema.ts`. Generate `udl.schema.json` with
`bun scripts/emit-spec.ts --write`. There is no migration reader for earlier UDL.

## JSON admission and canonical bytes

The parser refuses duplicate JSON member names, including escaped spellings of
one name. Decoded documents must contain finite JSON data. Accessors, cycles,
sparse arrays, symbol keys, hidden properties and `__proto__` members refuse
before schema parsing. Shared values count once per occurrence toward the budget.
Admission permits at most 100,000 visited values, 32 nesting levels, 240 code units
per key and 1 MiB of UTF-8 key and string data. Source text has a separate 1 MiB
byte limit. These bounds live in `src/limits.ts`.

Canonical JSON sorts object keys recursively, preserves array order and ends
with a newline. Schema defaults are part of the admitted document. Equivalent
key insertion orders and explicit defaults have the same digest. Object field
compatibility and evolution comparisons use the same key ordering.

## Objects and subjects

An object kind declares identity, title, authored field names, normalized fields
and display columns. Each attachment freezes its instrument identity and party
parameter bindings to `owner`, `actor`, `operator`, or a declared Product party. Core resolves role bindings from the object row, session and Product, and
declared parties from the Product party binding. `authoredFields` records only names declared in the HSX
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
creation remains internal; an attached create action may expose a public name.
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

The host owns transport routes for object discovery, creation, listing,
retrieval, action availability, execution and agreement evidence.
`src/object-contract.ts` defines the language package's object projections.

Execution binds `productBuildId`, `digest`, `target` and `expectedRevision`.
The target identifies an attachment or an existing instance on that attachment.
The optional `fields` collect subject metadata; optional `input` carries the action's typed input.
Missing requirements refuse execution. Callers reuse an idempotency key only for
retries of the same request. Staff Create for may name `ownerPrincipalId` through
its authorized path; ordinary ownership comes from the session.

## Accounts and money

A document declares SAR once. Money is a nonnegative minor-unit decimal string
of at most 18 digits. Percentages are basis points, durations are positive integer
milliseconds, and dates are timestamps with explicit offsets.

An account field binds a party, the instrument itself, or an adapter. Party owners
are names; `owner: "self"` provisions an account per instance. An adapter owner
is `{ "adapter": "insurer" }`, where `insurer` names an adapter declared in one
of the instrument's action subjects. The agreement retains that declaration's
provider identity. Missing or conflicting bindings refuse with
`subject_adapter_unbound`; changing an existing account binding refuses with
`account_binding_changed`. A null declaration can describe a draft but cannot
create an adapter-owned account.

Account creation and binding are executor work. Callers never supply account IDs.
Accounts declare `book: "cash" | "claim"`, defaulting to cash. Moves never cross books.
Only claim accounts may declare `contra: true` and permit a negative balance.
Party and adapter accounts share owner, book and key within a Product; the key
defaults to `balance`. Adapter aliases for the same provider share that account. Transfers between
known aliases of one account refuse, including self fields with the same key.
The executor scopes provider accounts to the tenant and Product, with the Product
participant as ledger custodian. Providers are not parties. An account owned by
self defaults its key to the field name. Named capital, premium, income, debt and
loss balances use explicit keys. `party.buyer` is the buyer's default cash account.

A plain move to an adapter account credits its ledger balance. It does not prove
an external payout. Provider confirmation still uses a boundary reservation and
instruction-bound evidence. Account ownership adds no settlement operation.

Disbursement moves cash from lender to borrower and claims from borrower debt to
principal and profit receivables. Repayment moves borrower cash to lender cash and
the same claim amounts from receivables back to borrower debt. Unearned profit is
cancelled by the claim move alone. Write-off moves the principal claim to the
lender's loss account, with no cash movement. The library declares when profit
is earned: on payment, by schedule or at disbursement.
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
accounts must agree on owner, key, book and contra flags, and enums must
have the same values. A comparison or selection anchor must share a possible
reference target. An invoked input must accept every possible supplied target.
The executor checks the actual instance type at admission.

## Calculation and movement

Calculations form a finite dependency graph. `sum`, `subtract` and `minimum`
operate on money or integer fields, with operands of the same type as the target.
`rate`, `multiply`, `divide` and `shift` retain their typed operands. A shift's
`milliseconds` operand is a duration field or a non-negative safe integer literal.
Zero leaves the date unchanged; duration fields still require positive values. Rate and
division round down. Weighted shares also round down; residual minor units go
to the declared residual account. Cash and loss use this one rounding rule.
There is no largest-remainder allocation. Subtraction refuses a negative result. Integer results must
be safe integers. No calculation evaluates source text.

The only move instructions are `internal_transfer.create`,
`internal_transfer.reserve`, `internal_transfer.post` and `internal_transfer.void`.
Create and reserve declare an amount, from account and to account. Reserve captures
its executor-produced transfer identity into a declared self text field. Post and
void consume that identity. Callers cannot create or replace captured identities.
Adapter-owned endpoints use the same move vocabulary.

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
a zero create move refuses unless the action declares `allowZero: true`.
With that permission it records no transfer or capture. A reserve amount must
always be positive.
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
account or text id. The executor selects the newest matching subject binding,
checks its retained Build, protected input digest and adapter declaration, then
requires the declared result and age. A newer matching refusal or pending result
prevents reuse of an older success.

`invoke` supplies typed inputs to a linked action or bounded selection. Its graph
is acyclic and bounded. Public names grant no authority; clock and parent actors
remain executor-owned. A public action on a subject instrument requires an
attachment on that object kind. State requirements refer to instrument instances;
objects have no instrument lifecycle. List extraction preserves the reference
namespace and target. Selection anchors and filters participate in calculation
cycle detection. Literal assignments must satisfy the destination field's constraints.

A captured transfer exposes its executor-owned `.status`. A boundary payout
reserves before dispatch. Only matching terminal confirmation can post or void
the reservation. An acknowledgement, transport failure or missing response
keeps the reservation. A refund is a separately funded move. Account balances
alone do not prove an external effect. The language adds no automatic
provider-failure reversal or deadline settlement policy.

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

The generated [JSON schema](../spec/udl.schema.json) owns the complete field
inventory, defaults and constraints. `src/schema.ts` is its source.

`calculate.aggregate` reads a typed selection and yields its count or a money sum. `calculate.ratio` computes floor(amount * numerator / denominator) with arbitrary-precision intermediates and refuses a zero denominator. Numerator and denominator share a numeric type. Selection order is a list of typed ascending paths, followed by identity as the final tie-break. `invoke {instrument, action: "create", input}` creates a child record in the same transaction; its inputs resolve in the caller, and the ordinary create actor and requirements still apply.

`calculate.at` reads a typed list at a one-based position and refuses an out-of-range index. Its result has the list item type. Integer divide accepts integer operands and rounds down. Every move may capture its transfer identity into a declared self text field; reserve requires a capture. Captures and their status paths are executor-owned.

## Reporting definitions

An instrument may declare `reports`, a bounded array of strict ReportDefinition
values. Each definition contains identity/version, scope, datasets, time,
selection, calculation, validation, output and authority. The JSON schema defines
all fields. Expressions form an ordered graph with backward references, typed
money in integer minor units, explicit ratios and date operations. Source fields
must exist in every bound instrument. A scalar field cannot acquire a suffix;
account balances use the declared `<account>.balance` path. Company instrument reports require
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
