# Changelog

## Since 1.0.123

Releases after 1.0.123 shipped without per-release entries. This entry
summarises what changed in the package surface since then.

Added:

- `calculate.annuity` returns the principal or interest part of one row of a
  monthly amortization table. It is the only calculation that rounds half up.
- Selections accept `overlaps { start, end, from, until }` to keep rows whose
  half-open date period meets a range.
- Adapter subject snapshots may declare `onboarding` as `person`,
  `organization` or both.
- New exports: `sarCurrency`, `sarMinorUnitExponent`, `currencySchema`,
  `sameAccount` and `isTerminalState`.

Changed:

- SAR is the only currency. Report money types and report scopes take
  `currencySchema` instead of any three-letter code.
- An action calculation may read its own stored target as its prior value, so
  `count = count + 1` is no longer a cycle. Cross-field cycles still refuse.
- The UDL4001 money check proves that whole-balance moves drain owned accounts,
  reads a field fresh after the action sets it, and treats each read of another
  party's balance as its own value.
- A refused date value names the accepted form, an ISO 8601 date-time with an
  offset.

Removed:

- The `product_party_unbound` diagnostic, which nothing emitted.
- The unused type exports `UdlParty`, `UdlMove`, `UdlLifecycle` and
  `UdlKernelOperation`.

## 1.0.123

First unified release. Every public Hyperscale package now ships under one
version that follows the platform release number, so release 123 is 1.0.123.
The compiled contract format is UDL 1 and the HSX header-manifest edition is
HSX 1.
