# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Format version and package version are different numbers. Format 1 is unstable
until the package reaches 1.0.0; any change to what format 1 accepts is listed
here under the release that made it.

## [Unreleased]

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

[Unreleased]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.2...HEAD
[1.0.0-alpha.2]: https://github.com/hyperscale0/hyperscale-udl/compare/v1.0.0-alpha.1...v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/hyperscale0/hyperscale-udl/releases/tag/v1.0.0-alpha.1
