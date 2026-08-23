# Contributing to UDL

## How changes get made

This repository is issues-only. Hyperscale makes the changes to the format and
to the package; the public proposes them in an issue. That is the whole model,
and it is stated up front so nobody spends a weekend on a branch that was never
going to be merged.

A proposal is an issue carrying two things: the use case, in the words of
whoever hit it, and the conformance case it would add. `conformance/README.md`
has the file shape. An issue with both is a design discussion; an issue with
neither is a wish.

Hyperscale accepts a pull request rarely, and only after asking for one. When
that happens the maintainer who asked sends the CLA and the author signs it
before the merge. The AGPL on its own does not let
Hyperscale LLC offer a contribution under the commercial license it sells, so
the CLA is what makes a merge possible at all.

The setup below is here because reading the code, running the suite, and
building the case for a proposal all need it.

## Setup

UDL builds with [Bun](https://bun.sh). Nothing else is required.

```bash
bun install
bun run check      # spec drift check, then tests, then typecheck
```

Individually:

```bash
bun run spec:check   # spec/udl.schema.json still matches the grammar
bun test             # the unit suite and the conformance suite
bun run typecheck    # tsc, no emit
bun run build        # tsc to dist/
```

The `udl` command runs straight from source while you work:

```bash
bun src/cli.ts validate conformance/valid/minimal.udl
```

## The spec is generated

`spec/udl.schema.json` is emitted from the Zod grammar in `src/schema.ts` by
`scripts/emit-spec.ts`. Never edit it by hand. After any grammar change:

```bash
bun run spec      # regenerate
```

and commit the result. `bun run spec:check` fails the build if the committed
bytes drift from the generator, which is how a grammar change and a stale spec
stop being able to ship together.

If the emit throws `expected one recursive definition`, the grammar grew a
shape the generator does not know how to name. Name it in
`scripts/emit-spec.ts` rather than working around the error.

## Changing the format

Two things make a format change real, and a proposal needs both:

1. **The grammar or the validator**, in `src/`.
2. **A conformance case**, in `conformance/`. A change that admits something
   new gets a `valid/` case; a change that refuses something gets an
   `invalid/` case naming the issue code and path. `conformance/README.md` has
   the file shape.

Prose comes third and it is not authoritative. `spec/README.md` carries laws
and judgment. It carries no field lists, no grammar tables, and no worked
schemas, because a prose copy of a machine-checked format is drift waiting to
happen.

Before opening an issue against the format itself, read the ten laws in
`spec/README.md`. Most rejected proposals are rejected by law 2, the purity
law: the thing being asked for is provider or bank machinery, and it belongs
below the language rather than in it.

## Evolution

Documents already in production are governed by the append-only law: adding
states, transitions, optional fields, and verbs is legal, and removing,
renaming, tightening, or changing a money step is not. A change to
`src/evolution.ts` changes what production systems are allowed to do. Expect
that discussion to be slow, and bring the conformance case that proves the new
verdict.

## Style

Match the file you are editing. Comments explain constraints the code cannot
show; they never narrate the next line. Tests assert behavior, not
implementation. Every test that reads a document reads it from `conformance/`,
so there is one place fixtures live.

## Contributor licence agreement

In the rare case Hyperscale accepts a pull request, the author signs
[the CLA](./CLA.md) first, and it only has to happen once. Two reasons. The
AGPL alone does not let Hyperscale LLC offer the contribution under the
commercial license it sells alongside it, and a mixed-copyright file cannot be
dual-licensed by anyone. And the AGPL says nothing about patents, so the patent
terms live in the CLA too.

## Reporting

Bugs and proposals go through the issue templates. Security vulnerabilities do
not: see `SECURITY.md`.
