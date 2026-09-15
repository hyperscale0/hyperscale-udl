# UDL documentation

UDL is the versioned JSON contract between a product definition and an engine that executes it. Start with the document guide, then read the guides in order. Validator authors should also read the canonical bytes law and run the conformance corpus.

1. [A document](guide/01-a-document.md)
2. [Money steps](guide/02-money-steps.md)
3. [The ten laws](guide/03-laws.md)
4. [Fees and remainder](guide/04-fees-and-remainder.md)
5. [Checks, updates, and dials](guide/05-checks-updates-dials.md)
6. [Effects](guide/06-effects.md)
7. [Evolution](guide/07-evolution.md)
8. [Implementing UDL](guide/08-implementing.md)
9. [Schedules, allocation and referenced state](guide/09-schedules-and-allocation.md)

[Piece plans and private action composition](piece-plans.md) is a worked
instrument fragment for `piecePlan`, `pieceStage`, `calls` and `actionLibrary`.

The [clause reference](reference/clauses.md) and [diagnostic reference](reference/diagnostics.md) come from the package tables. The [command reference](reference/cli.md) comes from the CLI usage text. Run `bun run docs:build` in a source checkout. Package builds and prepack generate these ignored files automatically and validate local links.
