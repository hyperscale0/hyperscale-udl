Requested by a Hyperscale maintainer in issue #___. Unsolicited pull requests
are closed with a pointer to CONTRIBUTING.md.

## What this changes

<!-- One paragraph. What is different after this merges? -->

## Why

<!-- The problem, not the solution. Link the issue if there is one. -->

## Checklist

- [ ] `bun run check` passes.
- [ ] A format change carries a `conformance/` case (a `valid/` case for
      something newly admitted, an `invalid/` case naming the issue code and
      path for something newly refused).
- [ ] A grammar change was followed by `bun run spec` and the regenerated
      `spec/udl.schema.json` is committed.
- [ ] A change that affects documents with live instances says so here, and
      says which way `udl diff` now rules.
