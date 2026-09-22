# UDL 4.3.0

Subject requirements carry optional `when` conditions (alternatives of
scoped comparison guards), object attachments carry an optional `parent`,
and object discovery reports `requirementConditions` so a portal can skip
a prompt whose guard is already known false. The README and spec README
drop stale statements about subject evidence and adapter bindings.

# UDL 4.2.1

A bare `subject.<name>` resolves to the action's declared requirement, so
evidence collected at the action no longer has to exist as a field on the
subject object. Deeper paths still resolve through the object.

# UDL 4.2.0

Actions may declare `allowZero: true`; a create move of zero without it is a
`zero_money` refusal. The finance helpers gain exact posted-fee collection and
a remaining-target calculation for pools. Object contracts carry per-action
subject evidence. Diagnostics gain evidence codes that reach callers directly.

# UDL 4.1.0

Second-person approval is deleted: approval requirements, distinct-member rules and their diagnostics leave the schema, the object contract and validation. A document that still declares them is rejected. Permissions are unchanged. Recreate development estates.

# UDL 4.0.0

UDL 4 adds objects, attachment role bindings, action subject requirements, frozen adapter snapshots and typed object references. UDL 3 is rejected, the vehicles header is deleted from HSX, and public instrument create actions are gone. Object creation accepts optional metadata without entering an agreement; exposed attachment actions collect requirements when invoked. Recreate development estates; there is no migration reader.

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
