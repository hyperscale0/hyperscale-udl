# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Format version and package version are different numbers. Format 1 is unstable
until the package reaches 1.0.0; any change to what format 1 accepts is listed
here under the release that made it.

## [Unreleased]

## [1.0.0-beta.1] - 2026-08-29

- This is the first beta and has no package behavior changes from
  1.0.0-alpha.5.

## [1.0.0-alpha.5] - 2026-08-29

### Added

- Verbs may declare a camelCase `publicIntent` as their author-approved public
  name while the verb key remains the lifecycle and execution identity. System
  due verbs must omit it. `udlPublicIntentSchema` is exported for consumers
  that admit the same name outside a complete document.
- `captureInput` maps declared verb input fields into durable receipt refs.
  Declare only input properties from that verb and allocate each captured key
  in the noun's shared ref namespace.
- `signedSum` computes stored add and subtract subtotals over typed child money,
  then captures one net amount for exactly one payout or noun transfer. Authors
  must declare the child reference, money field, currency, admitted statuses,
  and explicit negative and zero policies.
- `requiresExposure` gates a child amount against a stored cap, with an optional
  anchor-specific cap, and `setsAt.marker` records occurrence timestamps that
  cannot drive a due condition or deadline. Use these clauses for bounded
  installment writes and per-anchor occurrence markers.
- `distribute` allocates one parent money field or computed money ref across
  typed children selected by status and stored weight. Declare runtime-owned
  money refs in `computedMoneyRefs`; the validator resolves the parent,
  weight, statuses, and pool before admitting the document.
- Nouns may declare up to four `derivedAmounts`. Each rule computes a declared
  money field as 1 through 9,999 basis points of another declared money field
  with floor rounding. Callers supply neither the result nor a fixed or tiered
  rule, and a rule may not derive a field from itself.
- Verbs may declare one `payout` intent that reads stored money, currency,
  source-account, and beneficiary values and captures the payout reference.
  This does not add an operation to the seven-instruction kernel.
- A system-only `requiresSettlement` transition may read a captured payout
  reference and capture the durable evidence record that matched it. The
  validator rejects caller input, decision ports, public intents, due and
  deadline triggers, kernel steps, and money moves on that transition.
- `validateUdlJsonSchema` validates one schema against UDL's sealed JSON Schema
  subset without applying it to a value. `UdlPayout` and
  `UdlRequiresSettlement` expose the new clause types to TypeScript consumers.

### Changed

- Evolution snapshots freeze public intents, captured receipt input,
  distribution rules, exposure gates, signed sums, computed money refs, and
  derived-amount arithmetic once a noun has live instances. Older snapshots
  remain readable when those keys are absent.
- Evolution snapshots freeze both payout intents and settlement evidence gates.
- Receipt refs written by the new clauses share the noun ref namespace with
  kernel captures, input captures, signed sums, subject refs, and unwind refs.

## [1.0.0-alpha.4] - 2026-08-26

### Removed

- `diffUdlEvolution`. It validated both arguments and then handed off to
  `diffValidatedUdlEvolution`, and nothing called it: `udl diff` and the
  engine's composer both take the validated door. Two doors onto one comparison
  meant every caller first had to work out which one it was standing in.
  Validate with `validateUdl` or `assertValidUdl`, then call
  `diffValidatedUdlEvolution`, whose `UdlDocument` parameters keep the compiler
  on the right side of that rule.

## [1.0.0-alpha.3] - 2026-08-25

### Changed

- `diffUdlEvolution` validates both arguments, so a document `validateUdl`
  refuses now throws a `UdlError` carrying that document's issues where
  alpha.2 returned evolution violations. Measured on
  `conformance/valid/protection.udl` with the product renamed to
  `protection_v2` and the live `claim` noun dropped: alpha.2 returned three
  violations, naming the rename, the removed live noun, and the version that
  did not move; this release throws `invalid_semantics` at
  `$.nouns[0].aggregateInvariants[0].childNounId`, because another noun's
  aggregate still references `claim`.

  Read the throw as a refusal to judge, not as a verdict of no violations.
  A `catch` that treats it as a schema problem and carries on has skipped the
  append-only check entirely, and the candidate above is exactly the kind that
  then sails through: dropping a live noun is the headline violation the law
  exists to catch. Fix the document, or use `diffValidatedUdlEvolution`.

  The parameters are `unknown` because the function now accepts input nobody
  has parsed. A caller who wants the compiler checking the call should hold
  two validated documents and use `diffValidatedUdlEvolution`, which keeps the
  `UdlDocument` parameter types.

### Fixed

- The evolution exports no longer route around the validator. `diffUdlEvolution`
  took typed `UdlDocument` arguments and called neither `validateUdl` nor
  `assertValidUdl` before reaching the diff's comparison key, so a caller
  handing it an object it had never parsed got a `RangeError` off the call
  stack where `validateUdl` returns a `resource_limit` issue for the same
  object. It takes `unknown` now and validates both arguments.
- The comparison key behind every diff carries the same depth budget the
  validator applies to a document (`UDL_LIMITS.maxDepth`, 24 levels; the
  deepest conformance document reaches 12). This is what protects
  `diffNounEvolution`, which takes snapshots no validator has seen, and it
  closes the case where `snapshotUdlNoun` returns a cyclic snapshot that only
  detonates when something later stringifies it.

### Added

- `diffValidatedUdlEvolution`, the same comparison for a caller holding two
  documents `validateUdl` has already admitted. It keeps the `UdlDocument`
  parameter types, and it is the door for judging a candidate that is not yet
  valid on its own. It also skips a validation the caller has already paid
  for: on the commerce-escrow fixture `validateUdl` costs 0.57 ms against the
  diff's 0.38 ms, so `udl diff`, which parses both files first, takes this
  door rather than validating four documents to compare two.

## [1.0.0-alpha.2] - 2026-08-23

### Fixed

- `bin` points at the built JavaScript; alpha.1's registry metadata pointed at
  TypeScript source. npm builds the packument from package.json as it sits on
  disk after `postpack`, so the pack-time rewrite never reached `bin`, and
  every install linked `.bin/udl` to `src/cli.ts`, which Node refuses to
  execute.

### Changed

- Licensed AGPL-3.0-only with a commercial license from Hyperscale LLC;
  copyright holder Hyperscale LLC; repository renamed to
  `hyperscale0/hyperscale-udl`.

## [1.0.0-alpha.1] - 2026-08-22

First public release. Format version 1.

### Added

- `spec/udl.schema.json`, JSON Schema 2020-12 generated from the grammar, plus
  `spec/README.md` carrying the ten laws, the canonical form, and the issue
  codes.
- `conformance/`, the format's semantic spec as data: 7 valid documents with
  their canonical bytes and 11 refused documents with the issue codes and JSON
  paths they must report, runnable from any language.
- The `udl` command: `udl validate`, `udl fmt [--write]`, and `udl diff`.
- `bun run spec:check`, which fails when the committed schema drifts from the
  grammar it was generated from.

[Unreleased]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-beta.1...HEAD
[1.0.0-beta.1]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.5...v1.0.0-beta.1
[1.0.0-alpha.5]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.4...v1.0.0-alpha.5
[1.0.0-alpha.4]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.3...v1.0.0-alpha.4
[1.0.0-alpha.3]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.2...v1.0.0-alpha.3
[1.0.0-alpha.2]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.1...v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/hyperscale0/hyperscale-udl/releases/tag/v1.0.0-alpha.1
