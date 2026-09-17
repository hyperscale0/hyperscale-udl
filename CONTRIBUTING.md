# Contributing to UDL

Hyperscale accepts proposals through issues. Describe the contract rule and a
small document mutation that changes admission. Hyperscale requests pull requests
when it plans to accept a contribution; contributors sign [the CLA](CLA.md).

`src/schema.ts` owns the grammar. Generate the checked-in JSON schema with
`bun run spec`. `src/validation.ts` checks typed references and admission clauses;
`src/finance.ts` checks local account and reservation paths. Runtime locking,
provider work and balances belong to the executor.

Run `bun run check` for schema drift, docs, types, builds and package tests.
Run `bun src/cli.ts validate spec/darb.udl.json` to validate the handwritten sale
witness. It is one sale, not the complete company contract.

Read [the ten laws](spec/README.md) before proposing a clause. Complex flows use
accounts, calculations, requirements and moves. They do not add domain clauses.
Report security defects through [SECURITY.md](SECURITY.md).
