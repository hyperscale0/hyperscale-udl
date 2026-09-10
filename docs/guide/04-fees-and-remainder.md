# Fees and remainder

Fee rules derive named amounts from a stored base amount. Partitions state how cancellation or reversal divides held money. A remainder clause computes one amount after named deductions and captures it under `amountRef`.

```jsonc
{
  "remainder": {
    "amountRef": "sellerNet",
    "from": "fields.amount",
    "subtract": ["refs.platformFee"],
  },
}
```

Computed money has one author. A remainder, signed sum, distribution, quote, or derived amount must not compete with another clause for the same field or ref. A money move consumes the computed value once. The validator rejects missing sources, duplicate outputs, and terminal paths that strand funded value.

## Retained charges

A quote may declare `chargeRetainedBy` with a role (`payer`, `beneficiary`, or `subjectHolder`). The named role keeps the quoted charge instead of moving it through an escrow payout action. The role must be declared under `parties`, its account field must be required and frozen by `fixes`, and the committing refund transfer must source funds directly from that account.

```jsonc
{
  "quote": {
    "baseField": "premiumAmount",
    "chargeRef": "unwindPenalty",
    "chargeRetainedBy": "beneficiary",
    "charges": [{ "bps": 1000 }],
    "expires": { "offset": "PT15M" },
    "fixes": ["insurerAccountId", "policyholderAccountId", "premiumAmount"],
    "netDestinationField": "policyholderAccountId",
    "netRef": "policyRefund",
  },
}
```

The retained remainder stays in the source account and cannot be spent by subsequent instrument actions. Actions cannot consume the charge reference, and no self-transfer is permitted.
