# UDL 3.2.0

UDL adds a state-preserving transition target (`to: preserve`), an invoke comparison guard (`guard: { kind: compare, ... }`), an optional per-action `expansionLimit` of 8192 actions, reporting definitions, and a clock `localDay` clause (days, direction, hour, timezone).

# UDL 3.1.0

Licensed under the Hyperscale Intellectual Property and Copyright License 1.0 (`LicenseRef-Hyperscale-IPCL-1.0`), Tier 2 (Source Available). The AGPL-3.0-only grant ends with this release; earlier versions keep it. `LICENSE.md` and `NOTICE.md` replace the previous license, licensing and trademark files; trademark and conformance rules now live in the license. No grammar change.

# UDL 3.0.2

Dependencies: zod 4.6.5. No grammar change.

# UDL 3.0.1

Spec: a move whose amount resolves to zero records nothing, so a payment can fan out across slices until the held balance runs out. No grammar change.

# UDL 3.0.0

Version 3 replaces the previous grammar. Recreate development estates. There is no migration reader.
