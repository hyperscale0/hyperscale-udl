# Security

## Reporting a vulnerability

Report privately through GitHub, using this repository's
[private vulnerability reporting form](https://github.com/hyperscale0/hyperscale-udl/security/advisories/new).
That is the only intake. There is no security email address, and nothing
security-sensitive belongs in an issue, a pull request, a discussion, or a
commit message.

A report we can act on names the affected version, describes the surface, and
gives us something to run: a UDL document as JSON, an input, a snippet. A
failing test is the most useful shape; it goes straight into the fix.

## What counts

`validateUdl` admits decoded JSON values from untrusted authors, so the
interesting failures are the ones a document can cause:

- A document that gets past `validateUdl` but should not, especially one that
  breaks a money-graph law.
- A document that makes the validator burn unbounded time or memory. The
  admission bounds in `src/limits.ts` (nesting depth, value count, key length,
  total key and string bytes) exist to make this impossible, and a text field
  `pattern` admits only one anchored character class with a fixed repetition.
  A way around either is a vulnerability.
- A document that makes `serializeUdl` produce bytes that decode into a
  different document.

Out of scope: decoding JSON text, which the host does before it calls
`validateUdl`, and anything that requires already controlling the machine
running it.

## Supported versions

Fixes land in the newest published `1.0.N` release. Older releases get no
backports.

## Disclosure

We will confirm receipt, tell you what we found, and agree a disclosure date
with you before publishing an advisory. If a fix is not straightforward we will
say so rather than go quiet.
