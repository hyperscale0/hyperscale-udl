# Checks, updates, and dials

`requiresChecks` asks for current evidence from a declared provider family. The row names the check kind, acceptable statuses, subject field, and optional maximum age. Callers cannot replace the evidence with a boolean.

`update` declares which stored fields an update operation may change. Action-level `updates` assign admitted values. Required creation fields, derived amounts, immutable bindings, and quote-frozen fields remain protected.

Dials are named policy values with bounds. Clauses refer to a dial by id instead of copying a threshold into several actions. The document therefore exposes one reviewable setting for limits such as reconciliation tolerance.
