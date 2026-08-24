# The UDL specification

A UDL document describes one product in business terms: its subjects, its
nouns, each noun's lifecycle, the verbs that move instances through it, and how
money moves while they do. Everything generated from a document (SDKs, docs,
tool surfaces, the running engine) is downstream of what is written here.

## The schema is the authority

`udl.schema.json` in this directory is JSON Schema 2020-12, generated from the
Zod grammar in `src/schema.ts` by `scripts/emit-spec.ts`. It is checked in so
that an implementation in any language can read it, and `bun run spec:check`
fails the build when the committed bytes stop matching the generator.

Prose copies of a machine-checked format drift. This document therefore carries
no grammar tables and no field lists. Where anything below disagrees with
`udl.schema.json`, the schema wins.

The schema is generated from the _input_ view of the grammar, so it describes a
document as an author writes it, before any default is filled in. A verb may
omit `moves`; a parser hands it back as `[]`.

## The ten laws

These are judgment, not shape. They explain why the schema refuses what it
refuses.

1. **One-sentence law.** Every concept in UDL is explainable in one sentence to
   someone who has never seen it. A concept that needs a paragraph is
   machinery, and machinery does not belong in the language.
2. **Purity law.** No bank or provider legacy enters UDL: no statement formats,
   no file drops, no polling, no batch windows, no cutoff times, no scheme
   names, no reconciliation vocabulary, no ISO or SWIFT message types. A
   document describes a product, never the plumbing under it.
3. **Event law.** Every state change emits an event. Names derive from the noun
   and the verb's past tense (`escrow_order.released`); the optional
   `eventName` overrides only where the honest past tense is irregular.
4. **One-spine law.** Money moves through four instructions and no others:
   `internal_transfer.create`, `.reserve`, `.post`, `.void`. Three account
   instructions (`account.escrow.provision`, `account.freeze`,
   `account.unfreeze`) complete the sealed set. No noun and no verb adds a
   fifth money path.
5. **Uniform object law.** Every instance carries an opaque prefixed id (from
   the noun's `idPrefix`), a `status` drawn from its declared lifecycle, a
   creation timestamp, and a caller-owned metadata bag. Amounts are
   string-encoded integer minor units paired with a currency code, never JSON
   numbers.
6. **Requirements-as-data law.** Anything a caller must satisfy before a verb
   unlocks is declared data: `due`, `deadline`, `requiresRefs`,
   `requiresAggregate`, `requiresDrainedAccount`. It is queryable and dated,
   never a support process.
7. **Append-only evolution law.** Once a definition has live instances, adding
   states, transitions, optional fields, and verbs is legal; removing,
   renaming, tightening, or changing a money step is not. `diffUdlEvolution`
   decides. `udl diff` runs the same comparison through
   `diffValidatedUdlEvolution`, which skips the validation it already paid for.
8. **Naming law.** Nouns are `snake_case`, singular, plain business English.
   Verbs are single words in imperative present. Operations are `noun.verb`.
   Fields are `camelCase`. The patterns live in the schema.
9. **Time law.** Delays the world imposes (settlement windows, activation
   periods, renewal cycles, retries) surface as honest statuses and timestamps
   on objects, never as processes the caller has to operate.
10. **Closure law.** A document is self-contained. Every lifecycle state is
    reachable from `create`, every reference resolves inside the document,
    every gate names a state that exists, and every funded balance is drained
    on every terminal path.

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

A refusal reports one or more issues, each with a stable code and a JSON path.
The codes are the cross-implementation contract; the messages are not.

| Code                | Meaning                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `invalid_utf8`      | The bytes are not valid UTF-8.                                                            |
| `invalid_json`      | The bytes are UTF-8 but not JSON.                                                         |
| `invalid_shape`     | The JSON does not match `udl.schema.json`, or fails a check the schema cannot express.    |
| `invalid_semantics` | The shape is right and a whole-document law is broken.                                    |
| `resource_limit`    | The document exceeds an admission budget (size, depth, node count, pattern search space). |

Paths are `$`-rooted with dotted keys and bracketed array indices:
`$.nouns[0].lifecycle.states[2]`.

## Canonical form

Every document has exactly one canonical byte sequence, produced by
`serializeUdl`:

- UTF-8, JSON, no byte-order mark.
- Object keys sorted ascending by UTF-16 code unit. Sorting is recursive.
- Two spaces of indentation per level of nesting.
- One space after each `:`. Members separated by `,` then a newline.
- An empty object is `{}` and an empty array is `[]`, both on one line.
- Exactly one line feed at the end of the file, and no other trailing
  whitespace.
- Non-ASCII characters are written literally, not escaped.

Two consequences worth stating outright. Serialization validates first, so an
invalid document has no canonical form. And the round trip is byte-stable:
canonicalizing canonical bytes returns them unchanged, which is what lets a
document be diffed, signed, and stored as its own identity.

## Two version numbers

**Format version** is what a document declares, as the literal `"udl": 1`. A
document that declares any other value is refused. Format 1 is the only format
that exists.

**Package version** is the semver of `@hyperscale0/udl`, currently
`1.0.0-alpha.1`.

They move independently, under one rule: **format 1 is unstable until the
package reaches 1.0.0.** Until then an alpha release may change what format 1
accepts, and the changes are listed in `../CHANGELOG.md`. Once the package
ships 1.0.0, format 1 is frozen and an incompatible format change bumps the
literal to `2`, with both formats readable for as long as the deprecation
window says.
