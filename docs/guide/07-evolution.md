# Evolution

`diffValidatedUdlEvolution(live, next)` compares two admitted documents. The CLI exposes the same check as `udl diff live.udl next.udl`.

Once instances exist, a new version may add optional fields, states, transitions, and actions. It may not remove or rename stored structure, tighten an admitted schema, change a money step, or reuse an existing version number for different executable meaning. The diff returns `UDL7xxx` issues with JSON paths.

A migration is work outside the format. It reads stored instances under their original document, writes data required by a new document, and changes the pinned definition only after that work succeeds. Editing the document does not migrate data.

Keep old canonical documents with stored instances. A format bump changes the literal `udl` value. A reader must keep explicit decoders for supported older formats rather than silently treating old bytes as the newest grammar.

Evolution does not invent defaults for executable clause fields. In particular, it does not guess `reconcile.exception.amountField` or `reasonField` for an older snapshot. A candidate must name both fields and pass the current validator before the diff can judge it.
