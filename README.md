# UDL 1

UDL, the Universal Domain Language, describes a company's objects, agreements,
actions and money rules. HSX compiles to this typed contract. An executor reads
UDL and enforces its actors, lifecycle transitions, requirements and effects.
The UDL package parses, validates and serializes contracts; it executes no actions.
This version supports SAR only.

Read the [specification](spec/README.md) for the contract and its runtime obligations.
The [JSON schema](spec/udl.schema.json) defines every field and default.

Install `@hyperscale0/udl` with Node.js 22 or later. `validateUdl` checks a
contract, not an account balance or a deployed executor. `canonicalDigest`
identifies its canonical bytes.

From the public source checkout, run `bun install`, then `bun run build`.
`bun run check` checks schema freshness, types and package tests. Edit prose in
`spec/README.md`.
