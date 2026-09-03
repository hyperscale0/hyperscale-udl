# Effects

Effects are derived ABI rows. Authors declare clauses such as moves, decisions, schedules, reads, and notifications. The compiler derives the `effects` object from those clauses in vocabulary order.

Each row records its source and a stable signature. Movement signatures include their cost class. Schedule signatures identify a deadline or due trigger. Read signatures identify the gate family. Notification rows retain channel and role.

The validator derives the rows again and compares the complete object, including row order. A missing, extra, changed, or reordered row is a refusal. Derived effect subtrees do not count toward the authored node budget, but they still pass JSON, depth, and string limits.

Cost tooling reads the same movement and hold signatures. Runtime hints may read the effect rows, but they cannot change the clauses that produced them.

`quote` derives `holds.quote` and `schedules.expiry`. `reconcile` derives one `reads.reconcile` row per expectation. `commit` has no separate effect row. The committing action consumes the held quote through its `moves.*` row, so another consumption row would count the same work twice.
