# UDL

UDL is the Universal Domain Language, the canonical JSON contract for a financial product. One `.udl` file declares subjects, instruments, lifecycles, actions, and money movement. An engine can admit that document without reading the source language that produced it.

UDL keeps provider machinery below the format. It has no file drops, polling loops, cutoff jobs, scheme messages, or provider statement schemas. The `reconcile` clause names settlement evidence against a declared provider-side row. It does not model the provider file or transport.

This package contains the parser, semantic validator, canonical serializer, append-only evolution diff, JSON Schema, and conformance corpus.

## Install

```bash
npm install @hyperscale0/udl
```

`1.0.0` freezes format 1. Pin version 1.0.0 while testing another implementation.

## Thirty seconds

`note.udl` is the smallest admitted document.

```json
{
  "instruments": [
    {
      "actionOrder": ["close", "create"],
      "fields": { "reference": { "type": "string" } },
      "id": "note",
      "idPrefix": "note",
      "lifecycle": {
        "initial": "open",
        "states": ["open", "closed"],
        "transitions": { "close": { "from": ["open"], "to": "closed" } }
      },
      "required": ["reference"],
      "summary": "A note a tenant files and later closes.",
      "title": "Note",
      "actions": {
        "close": { "moves": [], "steps": [], "summary": "Close the note." },
        "create": { "moves": [], "steps": [], "summary": "File the note." }
      }
    }
  ],
  "product": "minimal",
  "subjects": [],
  "title": "Minimal",
  "udl": 1,
  "version": 1
}
```

```ts
import { readFile, writeFile } from "node:fs/promises";
import {
  canonicalDigest,
  diffValidatedUdlEvolution,
  parseUdl,
  serializeUdl,
  validateUdl,
} from "@hyperscale0/udl";

const document = parseUdl(await readFile("note.udl"));
await writeFile("note.udl", serializeUdl(document));
console.log(await canonicalDigest(document));

const result = validateUdl(document);
if (!result.ok) console.error(result.issues);

const previous = parseUdl(await readFile("note.previous.udl"));
const violations = diffValidatedUdlEvolution(previous, document);
```

Every issue has a stable `UDL####` code, a category, a JSON path, a message, and a fix. Messages may become clearer. Codes do not change once published.

`parseUdl` accepts a string or `Uint8Array` and rejects malformed UTF-8. `serializeUdl` validates before writing. It sorts object keys by UTF-16 code unit, keeps array order, uses two-space indentation, and writes one final line feed. `canonicalDigest` hashes those UTF-8 bytes with SHA-256 and returns a promise for the lowercase hexadecimal digest.

The seven kernel operations are `internal_transfer.create`, `internal_transfer.reserve`, `internal_transfer.post`, `internal_transfer.void`, `account.escrow.provision`, `account.freeze`, and `account.unfreeze`. A `payout` is an execution intent, not another kernel operation.

The compiler derives action `effects` from clauses. The validator rejects a supplied effects object unless every row and its order match. Derived effects do not consume the authored node budget.

## Command line

```bash
udl validate product.udl
udl fmt product.udl --write
udl canon product.udl
udl canon product.udl --digest
udl diff frozen.udl product.udl
udl explain UDL5001
```

Exit code `0` means success. Exit code `1` means the validator or evolution law refused the document. Exit code `2` means the invocation or file read failed.

## Documentation

- [Guide and reading order](docs/README.md)
- [Format specification](spec/README.md)
- [Canonical bytes law](docs/reference/canonical.md)
- [Stable diagnostics](docs/reference/diagnostics.md)
- [Conformance runner contract](conformance/README.md)
- [Agent skill](skills/udl/SKILL.md)

## Versioning

The literal `"udl": 1` is the format version. The version in `package.json` is the package version. They move independently. After package version `1.0.0`, an incompatible format change uses a new format literal and keeps an explicit reader for stored format 1 documents during its stated support window.

## Contributing and license

Hyperscale accepts format proposals as issues with a use case and the conformance case they would add. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and proof commands.

UDL is AGPL-3.0-only. Hyperscale LLC also offers a commercial license. See [LICENSING.md](LICENSING.md) and [TRADEMARKS.md](TRADEMARKS.md).
