# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Format version and package version are different numbers. Format 1 is unstable
until the package reaches 1.0.0; any change to what format 1 accepts is listed
here under the release that made it.

## [Unreleased]

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

[Unreleased]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.3...HEAD
[1.0.0-alpha.3]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.2...v1.0.0-alpha.3
[1.0.0-alpha.2]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.1...v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/hyperscale0/hyperscale-udl/releases/tag/v1.0.0-alpha.1
