# UDL

UDL is the Universal Domain Language: a JSON document format for describing
a financial product in business terms. One `.udl` file declares the product's
subjects, its nouns, each noun's lifecycle, the verbs that move instances
through that lifecycle, and how money moves while they do. Everything else,
SDKs, docs, tool surfaces, the running engine, is generated from it or checked
against it.

The language deliberately cannot say certain things. There is no statement
format, no file drop, no polling loop, no cutoff time, no scheme name, no
reconciliation vocabulary. Those are real and they are somebody's problem, but
they are not the product, so they are absorbed below the language and never
surface in a document. What is left is small enough to hold in your head.

This package is the reference implementation: parser, semantic validator,
canonical serializer, evolution diff, and the `udl` command. The format itself
is specified in [`spec/`](./spec/README.md) and pinned by
[`conformance/`](./conformance/README.md).

## Install

```bash
npm install @hyperscale0/udl
```

Every release before 1.0.0 is an alpha, and `latest` follows the newest one, so
a bare install gets it. Pin an exact version if you need one: until 1.0.0 a
change to the surface ships as a minor bump, not a major.

## Thirty seconds

`note.udl`, the smallest document the format accepts:

```json
{
  "nouns": [
    {
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
      "verbs": {
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
  diffUdlEvolution,
  parseUdl,
  serializeUdl,
  validateUdl,
} from "@hyperscale0/udl";

const document = parseUdl(await readFile("note.udl"));

// One document, one byte sequence. Sorted keys, two-space indent, final LF.
await writeFile("note.udl", serializeUdl(document));

// Issues carry a stable code and a JSON path, never just a sentence.
const result = validateUdl(document);
if (!result.ok) console.error(result.issues);

// Is this change legal against the version that already has live instances?
const live = parseUdl(await readFile("note.live.udl"));
const violations = diffUdlEvolution(live, document);
```

`parseUdl` takes a string or a `Uint8Array`; bytes are decoded as strict UTF-8.
`serializeUdl` validates before it writes, so an invalid document has no
canonical form.

## The command

```bash
udl validate product.udl        # parse and report every issue found
udl fmt product.udl             # print the canonical form
udl fmt product.udl --write     # rewrite the file in place
udl diff live.udl product.udl   # is the change additive, or does it break?
```

Exit codes: `0` the document is admissible or the change is additive, `1` the
document was refused or the change breaks the append-only law, `2` the command
line was wrong or a file could not be read. That split matters in CI: a broken
document and a broken invocation are different failures.

## The two things worth knowing

**Evolution is append-only.** Once a definition has live instances, you may add
states, transitions, optional fields, and verbs. You may not remove, rename,
tighten, or change a money step. `udl diff` is not advice; it is the same
function the compiler runs before it will accept a new version.

**Money moves through four instructions and no others.**
`internal_transfer.create`, `.reserve`, `.post`, `.void`. Three account
instructions complete the sealed set. A noun cannot invent a fifth money path,
which is why a document can be checked for stranded value before anything runs.

## The spec

- [`spec/README.md`](./spec/README.md) is the specification: the ten laws, the
  canonical form, the issue codes, and what the schema deliberately cannot say.
- [`spec/udl.schema.json`](./spec/udl.schema.json) is JSON Schema 2020-12,
  generated from the grammar. Where prose and schema disagree, the schema wins.
- [`conformance/`](./conformance/README.md) is the semantic spec: `.udl` inputs
  with expected verdicts, canonical bytes, and issue codes, runnable from any
  language.

## Versioning

Two numbers move independently.

**Format version** is the literal `"udl": 1` inside a document. Format 1 is the
only format that exists.

**Package version** is this package's semver, currently `1.0.0-alpha.1`,
published only under the `alpha` dist-tag.

Format 1 is unstable until the package reaches 1.0.0. Until then an alpha
release may change what format 1 accepts, and every such change is listed in
[`CHANGELOG.md`](./CHANGELOG.md). After 1.0.0, format 1 is frozen and an
incompatible change bumps the literal to `2`.

## Status

Alpha. The format is in use, the API surface is settled enough to build on, and
the version number is honest about the rest. Breaking changes go in the
changelog, not in a footnote.

## Contributing

Issues only. Hyperscale makes the changes to the format and the package; you
propose them in an issue carrying the use case and the conformance case it
would add. [`CONTRIBUTING.md`](./CONTRIBUTING.md) has that model in full, plus
the dev setup, the test commands, and how to regenerate the spec. Conduct:
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Vulnerabilities:
[`SECURITY.md`](./SECURITY.md).

## License

AGPL-3.0-only, with a commercial license available from Hyperscale LLC for
organisations that cannot accept the AGPL. See [`LICENSE`](./LICENSE) for the
text and [`LICENSING.md`](./LICENSING.md) for which one you want and how to ask
for the commercial one. The marks are not covered by either; see
[`TRADEMARKS.md`](./TRADEMARKS.md), which also carries the rule for claiming
UDL compatibility.
