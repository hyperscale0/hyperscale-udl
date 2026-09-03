# The UDL specification

A UDL document describes one product in business terms: its subjects, its
instruments, each instrument's lifecycle, the actions that move instances through it, and how
money moves while they do. Everything generated from a document (SDKs, docs,
tool surfaces, the running engine) is downstream of what is written here.

UDL is the platform's header files and driver framework. Its grammar is the
complete instrument vocabulary and the ABI between authored programs and the
engine. An instrument definition can round-trip through UDL without dropping a
clause.

## The schema is the authority

`udl.schema.json` in this directory is JSON Schema 2020-12, generated from the
Zod grammar in `src/schema.ts` by `scripts/emit-spec.ts`. It is checked in so
that an implementation in any language can read it, and `bun run spec:check`
fails the build when the committed bytes stop matching the generator.

Prose copies of a machine-checked format drift. This document therefore carries
no grammar tables and no field lists. Where anything below disagrees with
`udl.schema.json`, the schema wins.

The schema is generated from the _input_ view of the grammar, so it describes a
document as an author writes it, before any default is filled in. A action may
omit `moves`; a parser hands it back as `[]`.

## The ten laws

These are judgment, not shape. They explain why the schema refuses what it
refuses.

1. **One-sentence law.** Every concept in UDL is explainable in one sentence to
   someone who has never seen it. A concept that needs a paragraph is
   machinery, and machinery does not belong in the language.
2. **Purity law.** No bank or provider legacy enters UDL: no provider statement
   schemas, file drops, polling, batch windows, cutoff times, scheme names,
   currency reconciliation rules, or ISO or SWIFT message types. A `reconcile`
   clause names settlement evidence against a declared provider-side row. It
   does not model the provider file, transport, or matching machinery.
3. **Event law.** Every state change emits an event. Names derive from the instrument
   and the action's past tense (`escrow_order.released`); the optional
   `eventName` overrides only where the honest past tense is irregular.
4. **One-spine law.** Internal ledger money moves through four instructions and no others:
   `internal_transfer.create`, `.reserve`, `.post`, `.void`. Three account
   instructions (`account.escrow.provision`, `account.freeze`,
   `account.unfreeze`) complete the sealed kernel set. A `payout` intent hands
   a stored amount and beneficiary reference to the execution core. It is not
   a kernel instruction and cannot disguise an internal ledger move.
5. **Uniform object law.** Every instance carries an opaque prefixed id (from
   the instrument's `idPrefix`), a `status` drawn from its declared lifecycle, a
   creation timestamp, and a caller-owned metadata bag. Amounts are
   string-encoded integer minor units paired with a currency code, never JSON
   numbers.
6. **Requirements-as-data law.** Anything a caller must satisfy before a action
   unlocks is declared data: `due`, `deadline`, `requiresRefs`,
   `requiresChecks`, `requiresExposure`, `requiresAggregate`, `remainder`,
   `requiresDrainedAccount`, `commit`, `reconcile`. A reconcile declares one
   expectation: the amount, the currency, `credit` or `debit`, the ref naming
   the provider-side row, exactly one evidence source, a match law of `exact`,
   `tolerance` bounded by a named dial, or `window`, and a window given as a
   fixed duration or a stored deadline field. It ends matched or as a capped
   exception child, never as a silent wait; the child is declared and validated
   at admission rather than materialized, so past the window the transition
   refuses naming it. Settlement evidence for a payout is one reconcile against
   a debit statement line under any match law, reading the reference an earlier
   payout intent captured. No caller may assert that match. An action that carries `quote` prices a base into a charge
   and a net, names the fields the price depends on, and declares when the offer
   dies, as a fixed duration or a stored deadline field. Exactly one other
   action names it back through `commit`, and that action is the only one that
   may move the net. A `commit` gate reads the offer the quoting action priced
   and refuses once its deadline has passed or any frozen field has changed. It
   spends what the quote wrote instead of pricing again, so the number a caller
   is shown is the number they pay.
7. **Append-only evolution law.** Once a definition has live instances, adding
   states, transitions, optional fields, and actions is legal; removing,
   renaming, tightening, or changing a money step is not.
   `diffValidatedUdlEvolution` decides, on two documents the validator has
   already admitted; `udl diff` parses both files and then calls it. Evolution
   snapshots retain navigation, update examples, and parked-state reasons for
   complete inspection. The diff treats their prose as editable presentation
   and protects the parked state keys that carry lifecycle meaning.
8. **Naming law.** Instruments are `snake_case`, singular, plain business English.
   Actions are single words in imperative present. Operations are `instrument.action`.
   Fields are `camelCase`. The patterns live in the schema.
9. **Time law.** Delays the world imposes (settlement windows, activation
   periods, renewal cycles, retries) surface as honest statuses and timestamps
   on objects, never as processes the caller has to operate.
10. **Closure law.** A document is self-contained. Every lifecycle state is
    reachable from `create`, every reference resolves inside the document,
    every gate names a state that exists, and every funded balance is drained
    on every terminal path.

## Admission budgets and derived effects

The 10,000-node limit bounds authored program complexity. The compiler derives
`effects` rows from action clauses, so the node counter excludes every action
`effects` subtree. Admission still checks those subtrees for shape, exact
agreement with the clauses including row order, nesting depth, string limits,
JSON-only values, and cycles.

The canonical 33-instrument catalog measured 10,270 nodes with derived effects
and 9,321 authored nodes without the effect subtrees on 2026-09-02. The fixed
10,000-node limit therefore leaves 679 authored nodes of headroom. The full
effectful document validates as one document.

## What the schema cannot say

JSON Schema pins shape. It does not pin meaning, and four classes of law live
outside it:

- **Blankness.** The schema says `"type": "string"` where the grammar says a
  string whose trimmed length is non-zero. A title of `"   "` passes the schema
  and is refused by the parser.
- **Closure and reference resolution.** Reachability, gate targets, party
  bindings, aggregate links, and authored-example validation are whole-document
  properties.
- **Money-graph admission.** Whether a debit can be reached before its funding,
  and whether any terminal path strands value, is decided by walking the
  lifecycle.
- **Evolution.** The legality of a change is a property of two documents, not
  one.

All four are pinned as data in `../conformance/`. An implementation that reads
only `udl.schema.json` will admit documents this one refuses; the conformance
suite is what makes two implementations agree.

## Issue codes

A refusal reports one or more issues, each with a stable `UDL####` code, a
category, a fix, and a JSON path. Codes and paths form the conformance
contract. Messages may become clearer. The generated
[diagnostic reference](../docs/reference/diagnostics.md) lists every code.

Paths are `$`-rooted with dotted keys and bracketed array indices:
`$.instruments[0].lifecycle.states[2]`.

## Canonical form

Every admitted document has one canonical byte sequence. The normative
[canonical bytes law](../docs/reference/canonical.md) defines key and array
order, number and string encoding, empty containers, the trailing line feed,
and the SHA-256 digest. Serialization validates first, so an invalid document
has no canonical form.

## Two version numbers

**Format version** is what a document declares, as the literal `"udl": 1`. A
document that declares any other value is refused. Format 1 is the only format
that exists.

**Package version** is the semver of `@hyperscale0/udl`, declared in
`package.json`.

They move independently, under one rule: **format 1 freezes when the package
reaches 1.0.0.** The release candidate may still change what format 1 accepts,
and every change appears in `../CHANGELOG.md`.

After 1.0.0, an incompatible grammar change uses a new format literal. Readers
keep an explicit decoder and validator for each supported old literal. A
stored format 1 document remains readable under the format 1 rules. It does
not acquire new required fields from the current package. Passing an old
document to an evolution comparison can raise the matching `UDL7xxx` removal,
tightening, lifecycle, or executable-change code, but a package upgrade alone
does not rewrite its bytes. A product migration must validate and store its new
document as a separate version before switching instances to it.

The evolution codes are explicit. `UDL7001` protects stored identities,
subjects, instruments, fields, lifecycles, actions, money clauses, gates, and
policy. `UDL7002` requires a version increase for a semantic change.
Evolution comparison admits the previous document first. A stored document
that fails admission is `invalid_previous`, not an evolution issue.
