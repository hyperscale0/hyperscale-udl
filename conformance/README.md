# The UDL conformance suite

Every file here is data. Nothing in this directory imports the reference
implementation, so a UDL implementation in any language can run the suite by
reading files and comparing bytes.

`../test/conformance.spec.ts` is the reference runner. Read it if a rule below
is ambiguous.

## Layout

```
conformance/
  valid/    documents the format accepts, each with its canonical form
  invalid/  documents the format refuses, each with the issues it must report
```

Every `<case>.udl` has a sibling `<case>.expected.json`. A file without its
sibling is a case that silently stopped running, so the runner fails on
orphans in either direction.

## Expected files

A valid case:

```json
{
  "canonical": "minimal.udl",
  "summary": "Compact, reverse-ordered bytes canonicalize to minimal.udl.",
  "verdict": "valid"
}
```

`canonical` names the file in `valid/` holding the canonical bytes for this
input. A document that is already canonical names itself.

An invalid case:

```json
{
  "issues": [{ "code": "invalid_semantics", "path": "$.nouns[0].verbs" }],
  "summary": "Every noun declares create: nothing else can bring an instance into being.",
  "verdict": "invalid"
}
```

`summary` is for humans reading a failure. Nothing asserts against it beyond
requiring it to be present and non-blank.

## The three levels

An implementation claims conformance at the highest level it passes.

**Level 1, verdict.** Read the file as bytes. Every `valid/` case is admitted
and every `invalid/` case is refused. This is the whole contract for a
validator.

**Level 2, canonical bytes.** For each `valid/` case, serialize the parsed
document and compare it byte for byte against the file named by `canonical`.
Any implementation that writes UDL must pass this, or two tools will disagree
about what the same document is.

**Level 3, issues.** For each `invalid/` case, every listed `code` and `path`
pair appears among the reported issues. Extra issues are allowed, because
implementations legitimately differ on how many problems they report before
giving up. Messages are never compared; they are prose and they are free to
change.

## Adding a case

Write the `.udl` and its `.expected.json`, then run `bun test`. Keep new cases
small and single-purpose: the point of `invalid/blank-title.udl` is that it
differs from `valid/minimal.udl` in exactly one key. `valid/minimal.udl` is the
smallest document both the grammar and the semantic laws accept, and it is the
right base to mutate.

The five domain documents in `valid/` are the real thing, projected from a
shipped product catalog. They are large on purpose: they are what catches a
regression the minimal case cannot see.
