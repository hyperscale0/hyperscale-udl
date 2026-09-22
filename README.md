# UDL 4

UDL, the Universal Domain Language, describes a company's objects, agreements,
actions and money rules. HSX compiles to this typed contract. An executor reads
UDL and enforces its actors, lifecycle transitions, requirements and effects.
The UDL package parses, validates and serializes contracts; it executes no actions.
This version supports SAR only.

Read the [specification](spec/README.md) for the contract and its runtime obligations.
The [JSON schema](spec/udl.schema.json) defines every field and default.

Install `@hyperscale0/udl` to use the `udl` executable with Node.js 22 or later.
Given `rental.udl.json` from `hsx build rental.hsx --out rental.udl.json`:

```sh
npx udl validate rental.udl.json
npx udl canon rental.udl.json --digest
```

Validation checks the contract, not an account balance or a deployed executor.
The digest identifies canonical bytes. `udl explain UDL####` explains a diagnostic
code printed by validation; replace `UDL####` with the reported code.

From the public source checkout, run `bun install`, then `bun run build`.
`bun run check` checks schema freshness, types and package tests. Edit prose in
`spec/README.md`; `bun run docs:build` copies it to `docs/README.md` and
`llms-full.txt` and writes the `llms.txt` index. Those copies are generated.
