# Licensing

The code in this repository is Copyright 2026 Hyperscale LLC and is licensed
under the GNU Affero General Public License version 3 only
(`AGPL-3.0-only`). The full text is in [`LICENSE`](./LICENSE).

## What the AGPL asks of you

Two obligations matter in practice.

**If you distribute a copy in object form**, modified or not, you make its
Corresponding Source available under the same license.

**If you run a modified copy as a network service**, section 13 applies: the
users interacting with it over the network get an offer of the source of the
version you are running. Running UDL unmodified behind your own service does
not trigger this. Changing the parser, the validator, or the canonical
serializer and then serving that change does.

Using `@hyperscale0/udl` as a library inside your own program is a combined
work under the AGPL. If that does not fit how you ship, take the commercial
license instead.

## Commercial license

Hyperscale LLC sells a commercial license to organisations that cannot accept
the AGPL, for the usual reasons: a proprietary product that links the library,
a hosted service you will not open, a procurement policy that refuses copyleft.
It grants the same code under ordinary commercial terms with no source
obligation.

Ask through <https://hyperscale0.ai>.

## The license covers code, not marks

"Hyperscale" and "UDL" are trademarks of Hyperscale LLC. A copyright license
says nothing about trademarks in either direction, so
[`TRADEMARKS.md`](./TRADEMARKS.md) draws that boundary.

## The format is not the implementation

UDL the format is separate from this implementation of it. The JSON Schema in
[`spec/`](./spec) and the conformance cases in [`conformance/`](./conformance)
are data describing a format, and anyone may write their own parser, validator,
or serializer against them, in any language, under any license, without
touching this code.

What you may then say about it is a trademark question, not a copyright one.
[`TRADEMARKS.md`](./TRADEMARKS.md) has the rule: claim compatibility with a UDL
version only when your implementation passes that version's published
conformance cases unmodified.
