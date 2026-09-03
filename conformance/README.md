# The UDL conformance suite

Every file here is data. An implementation in any language can run the suite
without importing the TypeScript reference implementation.

## Layout

```
conformance/
  valid/<case>.udl
  valid/<case>.expected.json
  invalid/<case>.udl
  invalid/<case>.expected.json
  evolution/<case>.live.udl
  evolution/<case>.next.udl
  evolution/<case>.expected.json
```

The runner fails if either half of a case is missing. An evolution case must
have all three named files.

## Expected files

A valid case:

```json
{
  "canonical": "minimal.udl",
  "digest": "c21d198d69e9d4cadb33aaacf37581bb388e4a8964b7fc284606cfa9f65d35bb",
  "summary": "The smallest admitted document.",
  "verdict": "valid"
}
```

`digest` is lowercase SHA-256 over the canonical UTF-8 bytes. A document that
is already canonical names itself.

An invalid case:

```json
{
  "issues": [{ "code": "UDL3001", "path": "$.instruments[0].actions" }],
  "summary": "Every instrument declares create.",
  "verdict": "invalid"
}
```

The runner requires a non-blank `summary`. It never compares messages.

## Conformance levels

An implementation claims the highest level it passes.

1. Verdict. Admit every `valid/` document and refuse every `invalid/` document.
2. Canonical bytes. Serialize every valid document byte for byte as its named
   canonical file, including the trailing line feed, and match its digest.
3. Diagnostics. Report every listed code and path for each invalid document.
   The implementation may report extra issues.
4. Evolution. Admit both documents, then compare the live and next definitions.
   Report every listed UDL7xxx code and path. The implementation may report
   extra issues.

## Path grammar

Issue paths use `$` for the document root, `.name` for an object member, and
`[n]` for a zero-based array index. Evolution paths use the instrument index
from the live document and continue to the changed member, such as
`$.instruments[3].actions.reconcile`. A direct `diffInstrumentEvolution` call
has no document index, so its paths start at `$.instruments`.

## Runner exit rule

The runner exits 0 only if every case at the claimed level passes. A missing
file, malformed expected file, unexpected verdict, byte mismatch, digest
mismatch, or missing issue pair makes it exit nonzero.

## Adding a case

Start from the smallest admitted document that carries the needed clause.
Change one law where possible. Pin codes and paths, never messages. Valid cases
must keep one example of every target in `udlClauseVocabulary`, including
quote, commit, reconcile, checks, updates, dials, effects, and money clauses.
