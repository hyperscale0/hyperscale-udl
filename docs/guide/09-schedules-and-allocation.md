# Schedules, allocation and referenced state

These clauses describe product laws. An engine must implement their admission semantics before accepting a document that uses them. The pure planners exported by this package calculate from trusted snapshots. They do not authenticate a caller, acquire locks, post money or claim an operation identity.

## Fields and dates

`derivedAmounts` retains its ordered list of computations. `percentage_of.bps` accepts a literal rate or `{field}`. The field must be required, immutable and bounded to integer basis points between 1 and 9999. `minimum` reads `sourceField` and `capField` in one currency. Both operands must be immutable money available at creation, supplied as required fields, derived earlier or bound from a reference. Bind a referenced cap into a local field through `requiresRefs.bind`. Floor rounding still applies. A derived operand must appear before its consumer.

For a SAR 200 premium, 1000 bps produces SAR 20 and 500 bps produces SAR 10. Costs of SAR 12, 25 and 40 with a stored SAR 25 cap produce SAR 12, 25 and 25.

`due.offset`, `deadline.offset` and an aggregate's `dueBefore.offset` accept a literal duration or `{field}`. A stored duration must enumerate positive fixed ISO durations. It cannot contain months or a runtime expression. The enclosing record supplies the field: a due-clock aggregate reads each candidate child's date and duration. The engine compares date plus offset to one authoritative admission time, including when the scheduler has not updated the child's status.

`dateOrder` compares two immutable date fields on one instrument with `<` or `<=`. Distinct `requiresRefs` gates may constrain the same reference. Engines apply all gates as a conjunction, including both interval bounds. Repeating an identical gate remains invalid.

## Aggregates and exact schedules

`requiresAggregate.anchorField` selects the owner's parent reference. Candidate rows have their own `refField` pointing to that same parent. This lets a claim inspect premium slices of its cover without pretending those slices reference the claim. The engine locks the shared parent and the relevant row set. A `dueBefore` predicate applies before the aggregate check. A zero `count_exactly` over unpaid due slices refuses cover immediately at the clock boundary.

`count_at_least.targetField` is an integer count. `ordered` checks strictly ascending dates in contiguous integer position order starting at 1. `schedule` additionally requires exact membership in the parent's immutable signed date list. No missing, extra or duplicate position is admitted. Every signed date must be strictly later than its predecessor. The engine reads the complete child set and checks statuses without discarding extra rows.

For every declared schedule amount, each child receives integer division of the parent total by the signed date count. The first position receives the remainder. SAR 48,000 principal and SAR 2,400 profit over six dates therefore produce six SAR 8,000 principal and SAR 400 profit slices. Adding one minor unit to principal adds it to the first slice only. The date list is bounded to 366 entries.

## Held partitions and contributions

A `partitions` declaration is an exact equality, not a spending allowance. Admission verifies numeric equality and immutability. The finance proof can replace one complete funded partition with another partition of the same total on the same held account. Partial funding and already spent pieces do not establish the total. The proof permits one substitution per funded batch, with no active holds or unrelated balance. Draining the account resets that limit.

`contributions` declares a required immutable list, its positive amount and origin-account keys, and a total money field. The list contains at most 256 entries. `contributionStage` funds every entry into one held account atomically or refunds every entry from that account to its original origin. Origins cannot equal the held account. The sum must equal the declared total. The engine derives operation identity from the instrument, stage and entry index and records the same entries for recovery.

The SAR 60,000 witness receives SAR 12,000 and SAR 48,000. Its outgoing partition is SAR 59,310 seller net, SAR 600 fee and SAR 90 tax. A refund returns SAR 12,000 and SAR 48,000 to the respective origins. Evidence attachment remains a separate action; do not update financial inputs during a cash action.

## Shared allocation and refunds

An obligation's `allocation` declares its slice instrument, reference and eligible statuses, due date, position, earning-rule field and bucket sources. Principal and profit come from the slice. Cost and fine may come from separately assessed child records of that slice. Bucket array order is payment priority. Engines always walk slices by due date ascending, then declared position. There is no company-supplied sorting option. Multiple assessments of the same bucket use ascending stable assessment identity.

A children bucket can select a concrete `instrumentId` or declare `template` and `parameters`. A template selector matches every instrument whose `templateBinding.id` equals that template and whose bound parameters include the requested scalar values. HSX retains string, integer and boolean arguments in `templateBinding.parameters` when it instantiates a template. Every matching alias must supply the declared slice reference, statuses, amount and destination fields. An uninstantiated selector contributes no assessments to a catalogue. The composed document validates the matching product instances.

For `payoff` and `write_off`, omitting `allocate.refField` selects the executing instance. That instance must declare `allocation`. This does not introduce a caller-supplied self reference. Refund may also omit the reference and name its own earlier allocating action. Payment requires an explicit reference.

An action's `allocate` references this declaration. Payment and payoff resolve amount, source account and payment identity from required immutable fields. Self payoff and assessment payment may instead use required action input keys. An operand must resolve to exactly one source. Self payoff may omit amountField so the planner computes the amount; a supplied amount must equal that figure. Assessment payment may omit amountField so the planner collects the assessment's whole remaining balance; a supplied amount above that balance refuses. The engine claims the identity under the obligation, reads remaining balances from prior allocation records and posts only positive allocations. It commits postings, consumption records, receipt and lifecycle state together. Recovery replays the recorded result. Direct collection and agency recovery must use the same declaration and assessment identities. A new channel or alias must not restore debt already consumed.

A SAR 4,000 payment against an SAR 8,400 slice consumes principal only. A later SAR 4,400 consumes the remaining SAR 4,000 principal and SAR 400 profit. Cost and fine follow when the authored priority puts them after principal and profit. An overpayment refuses rather than disappearing into an unspecified balance.

`allocate.mode: refund` names the original allocating action on self or through a typed instrument reference. An assessment record may omit `action` and reference its allocation owner instead: the engine reverses every consumption recorded against that assessment across the receipts that consumed it, its own collection, a repayment, a recovery or a payoff, each amount back to that receipt's payer, once. An optional immutable assessment identity selects one assessment's recorded allocation. The engine reverses those recorded postings to the original payer once. It does not accept new destinations or amounts and does not reopen consumed assessment debt. The refund identity is the original receipt plus assessment identity. A second refund refuses across aliases and lifecycle states.

## Earning and noncash cancellation

The immutable earning-rule field chooses one of two language-defined rules:

- `per_slice_on_due`: profit earns when its slice becomes due or is paid, whichever comes first.
- `on_disbursement`: all profit earns when the obligation advances.

The engine proves the advance and supplies trusted paid/consumed facts to the planner. `payoff` collects outstanding principal, earned profit and assessed charges. It cancels unearned future profit without a cash refund. After one SAR 8,400 slice is paid, the six-slice example has SAR 40,000 principal and SAR 2,000 future profit remaining. Under `per_slice_on_due`, payoff collects SAR 40,000 and cancels SAR 2,000. Under `on_disbursement`, payoff collects SAR 42,000.

`write_off` posts no money. Cancellation rows distinguish principal loss and earned charges from unearned-profit cancellation. No daily accrual rule exists: UDL does not yet define an authoritative day-count convention.

`remainder.subtractPaths` is a bounded list of immutable money operands subtracted alongside existing collected sums from `totalPath`. Negative results refuse; zero follows `onZero`. It is not unrestricted arithmetic over money.

## Referenced state and admission authority

`transitionsRefs` invokes named noncash lifecycle actions on referenced instruments in the same transaction. The engine applies every target gate, authority check and lifecycle precondition. Cycles, repeated target actions and cash-bearing or input-dependent target actions refuse. A child can lapse its cover; a refund can cancel a referenced funding record and prevent future actions through that record's lifecycle gates. This does not replace durable approval consumption tied to a downstream operation.

`cascade` executes a named lifecycle action on linked instances of another instrument inside the same transaction before evaluating the parent action's own admission gates. Target instances are identified either through caller input IDs via `inputField` or by matching a parent reference on target rows via `refField` filtered by lifecycle statuses. The cascading action cannot be create and cannot declare a decision. The target action must exist in lifecycle, cannot be create or engine-owned, cannot declare a decision, and cannot declare a cascade of its own. Because the cascade runs before the parent's admission gates, child status transitions take effect in time for parent aggregate requirements.

`requiresRefs.unique` accepts `{namespace, byFields}`. The uniqueness key contains the Product, namespace, referenced instance identity and immutable key values. It excludes instrument aliases and current status. A waived or refunded fine still occupies its key; cost uses a different kind value. The engine enforces this key under a shared constraint or lock.

Decision authentication, attestation verification and request hashing are admission concerns. The decision record must carry the requested instrument kind, instance, action, canonical input digest, deciding role and actor, expiry, verdict and evidence references. The engine computes the digest from the admitted request, authenticates the authority, checks expiry and revocation under locks, and binds consumption to the durable operation identity. Submitted actor and operation fields are not proof.

## Effects and classification budget

Canonical JSON preserves every clause and array order. Allocation and referenced transitions add explicit effects. Hosts must price `decides.allocation`, `moves.allocation` and `decides.referenced_transition` before compiling products that use them. Write-off has no movement effect. Contribution transfers use the existing internal-transfer effect signature.

Reference classification reads the sealed ID pattern text; it never executes an authored regular expression or compiles a JSON Schema validator per candidate prefix. HSX supplies the published prefix when a typed reference omits its pattern. The 131,072 distinct-pair budget is a safety limit, not a catalogue-size target. The memo counts a schema/prefix pair once and fails closed after the limit.

## Attested requests

An action may declare one `requiresRefs` gate with `attests`. The gate must
require a status and match `instrumentInstanceId` to a field on the referenced
record. It cannot be optional. The block declares `action`, `digest`, `role`,
`expiresAt` and `consume`. HSX accepts `expires_at` and emits `expiresAt`.
Action and role paths name text fields, digest names a lowercase SHA-256 field
with pattern `^[a-f0-9]{64}$`, and expiry names a date field.

Admission compares the stored action to the admitted lifecycle action name.
It computes the stored digest's expected value as
`bindResolvedRequestHash(operationExecutionIdentity({ name, environment, body }))`
for the downstream operation as admitted. The role must belong to the
authenticated deciding principal. A caller-supplied actor or role is not proof.
Admission refuses at or after expiry.

Stored terms are absent from the request body. An attested action therefore
puts its material terms in required input and declares `requiresInput`, a map
from input key to stored `fields.*` path. Admission checks equality before
updates or money movement. Changing a premium from 240000 to 180000 minor
units changes the request digest and fails the stored-term equality law.

The `consume` action must be reachable from every admitted status and declare
`engineOwned: true`. It cannot be public, accept input or update caller fields.
`captureEngine: { consumedByOperationId: "operationId" }` declares a ref written
from the admitting operation identity. These keys cannot be fields, input,
caller captures or move captures. The marker controls invocation authority;
the capture map names engine facts and their destination keys.

Consumption reuses referenced-transition effects and cycle checks. An ordinary
`transitionsRefs` entry cannot invoke an engine-owned action. The engine must
lock the decision and execute its transition inside the admitting transaction,
so a refusal rolls back consumption and one approval cannot authorize two
operations. This ABI declares those obligations; validation is not runtime
proof of their enforcement.

## Subject uniqueness

An action's `unique: { namespace, byFields }` claims one key at creation without a reference gate. Keys contain one to eight distinct required immutable string, account or integer fields. Every use of a namespace must carry the same ordered field names and types. Reference-keyed and subject-keyed claims cannot share a namespace. The engine must claim the key tenant-wide, across instrument aliases, and never release it on closure. Raising a limit updates the existing record. The effect is `decides.subject_unique`, priced at zero without a price-version change.

## Allocation exposure

`requiresExposure.measure: { allocation: "principal" }` selects a bucket on the child instrument. Its gross operand is the parent money field named by an exact `requiresAggregate.check.kind: "schedule"` mapping to that bucket's slice amount field. The relation must use the allocation's slice instrument and reference. A bucket sourced from other children has no such mapping and cannot be measured by this clause.

For qualifying children, the engine sums `amountField` and subtracts consumed amounts of the selected bucket over those same children. Payment, payoff and write-off share that consumption record. Refunds must be reflected by that record. The admitted instance contributes its full `amountField`. Omitting `measure` preserves the existing gross sum.

## Recorded decider

`attests.instrument` is a required text-field path on the referenced decision. Admission compares that stored value with the admitted instrument's id. Required `attests.party` names a declared party on the referenced decision. Admission compares the recorded deciding account with that party's bound account.

A decision action declares `port.capture` as the name of an optional account field on its own instrument. The engine writes the admitted actor account there after checking `allowedParties`. Callers cannot populate it through `captureInput`, action input, step captures or updates. It cannot be required at creation. This records the tenant backend's assertion of the actor account; it does not independently authenticate that account.

## Slice consumption and assessment collection

`requiresAllocation: { refField, slice: "self", buckets, check }` reads the referenced obligation's shared consumption for the executing slice. `settled` requires every listed bucket to equal its gross amount. `outstanding` requires at least one bucket below gross. The reference is required and immutable, and the owner must allocate over this slice instrument or its template alias.

Payment on an assessment may declare `assessment: "self"`. Admission matches the executing record to exactly one children bucket, then restricts payment to that record's remaining balance. An amount above that balance refuses. Refund without `action` reverses the assessment's consumption across every receipt that consumed it, once, and never reopens its consumed debt.

An anchor exposure cap may be updatable only when its anchor update clause names the cap field and the exposure declares `measure`. Other exposure caps remain immutable.
