---
name: udl
description: Read, validate, explain, or write Universal Domain Language documents directly. Use for canonical UDL JSON and format-level diagnostics. SDK and MCP consumers should use their generated contracts instead.
---

# UDL

Use UDL when the task concerns the canonical product document, format conformance, or a validator implementation. Use HSX when authoring a product from reusable modules.

## Read first

1. Read `docs/guide/01-a-document.md` for the document frame.
2. Read `docs/guide/03-laws.md` before changing lifecycle, money, gates, or references.
3. Look up exact fields in `spec/udl.schema.json` and clauses in `docs/reference/clauses.md`.

## Edit loop

1. Change the smallest complete clause.
2. Run `udl validate <file>`.
3. Look up each `UDL####` code with `udl explain UDL####` or `docs/reference/diagnostics.md`.
4. Apply the listed fix. Validate the whole document again.
5. Run `udl canon <file> --digest` before pinning bytes or an identity.

Never hand-author `effects`. Derive them from action clauses. Never represent money as a JSON number. Use an integer minor-unit string and its declared currency. Never add a money move without checking every terminal lifecycle path for a matching drain or unwind.

For a stored definition, validate both documents before `udl diff <live> <next>`. Treat any `UDL7xxx` result as a refused change. A data migration does not make an incompatible document edit additive.

Validator work must run the complete `conformance/` contract and follow `docs/reference/canonical.md` byte for byte.
