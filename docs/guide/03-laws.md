# The ten laws

The schema defines shape. These laws define meaning.

1. Every UDL concept fits in one sentence.
2. Provider formats and operating machinery stay below UDL. `reconcile` names settlement evidence against a declared provider-side row. It does not model the provider file or transport.
3. Every state change emits an event.
4. Internal ledger money uses the seven sealed operations.
5. Every instance has the same identity, status, timestamp, and metadata frame. Money uses integer minor-unit strings plus a currency.
6. Requirements such as due time, checks, references, quote commitment, and reconciliation are data.
7. A stored definition evolves by additive change only.
8. Instruments, actions, operations, and fields follow their declared naming patterns.
9. Real delays appear as statuses and timestamps.
10. Every state, reference, gate, and funded path closes inside the document.

A reconcile exception names the child fields that receive the unmatched amount and its reason. `exception.amountField` must be a required money field on the child. `exception.reasonField` must be a required plain text field. A plain text field has `type: "string"` and no `pattern`, `format`, or `enum`. Admission rejects a missing or optional field, the wrong type, or a child that does not belong to the declaring instrument.

The [diagnostic reference](../reference/diagnostics.md) lists every stable `UDL####` refusal code. The [specification](../../spec/README.md) carries the normative prose for each law.
