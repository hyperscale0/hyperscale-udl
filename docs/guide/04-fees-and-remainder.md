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
