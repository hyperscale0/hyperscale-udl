# Money steps

UDL seals internal ledger work to seven kernel operations. Four instructions create, reserve, post, or void an internal transfer. Three account instructions provision an escrow account, freeze an account, or unfreeze it.

A step names an operation and binds its inputs from action input, constants, or instance fields and refs. `capture` writes selected operation output into durable refs. A later step can read those refs.

```jsonc
{
  "operation": "internal_transfer.reserve",
  "bind": {
    "sourceAccountId": { "from": "instance", "path": "fields.payerAccountId" },
    "destinationAccountId": {
      "from": "instance",
      "path": "refs.escrowAccountId",
    },
    "amount": { "from": "instance", "path": "fields.amount" },
    "currency": { "from": "const", "value": "SAR" },
  },
  "capture": { "transferId": "reservationId" },
}
```

`payout` is an execution intent, not an eighth kernel operation. It reads stored money and beneficiary data, then captures a durable payout reference. A later system action can reconcile that payout against settlement evidence.
