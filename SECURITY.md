# Security

## Reporting a vulnerability

Report privately through GitHub, using this repository's
[private vulnerability reporting form](https://github.com/hyperscale0/hyperscale-udl/security/advisories/new).
That is the only intake. There is no security email address, and nothing
security-sensitive belongs in an issue, a pull request, a discussion, or a
commit message.

A report we can act on names the affected version, describes the surface, and
gives us something to run: a `.udl` file, an input, a snippet. If you can shape
it as a conformance case, do that; it goes straight into the fix.

## What counts

This package parses untrusted documents, so the interesting failures are the
ones a document can cause:

- A document that gets past `validateUdl` but should not, especially one that
  breaks a money-graph law.
- A document that makes the parser or validator burn unbounded time or memory.
  Admission budgets (source bytes, nesting depth, node count, string length,
  regex search space) exist precisely to make this impossible; a way around one
  is a vulnerability.
- A document that makes `serializeUdl` produce bytes that reparse into a
  different document.
- An evolution diff that reports a breaking change as additive.

Out of scope: the `udl` command reading a file you told it to read, and
anything that requires already controlling the machine running it.

## Supported versions

Alpha releases are supported at the newest published `alpha` version only.
Fixes land there; there is no backport branch before 1.0.0.

## Disclosure

We will confirm receipt, tell you what we found, and agree a disclosure date
with you before publishing an advisory. If a fix is not straightforward we will
say so rather than go quiet.
