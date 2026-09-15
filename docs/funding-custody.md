# Funding custody and receipt distributions

These optional UDL clauses preserve documents that do not emit them. Existing document shapes do not gain default fields. A host without their
admission implementation must refuse them before a transition or posting.

## Admission order and locks

Resolve requiresRefs.bind from stored referenced instances before validating
bound required fields or deadlines. Wallet ownership must match the investor.
A non-party product_escrow account field needs exactly one mandatory create-time
refs binding, no caller action input and no later update. Account role alone grants
no custody authority.

requiresExposure.groupField selects only child tickets whose stored investor
account equals the candidate's investor. minimumField selects the anchor's
minimum amount. Under the anchor lock, candidate amount must meet that minimum,
and live matching tickets plus the candidate must not exceed the anchor cap.
The existing total-target aggregate remains separate. closeBy is authoritative;
committedAt cannot extend admission. A withdrawn ticket cannot be collected or
refunded again. Failure returns every remaining committed ticket to its bound wallet.

## Funding

Lock the round, selected committed tickets, target obligation and source/destination
accounts together. Require the target total and a created obligation. Compare every
terms mapping against the stored obligation. Claim the obligation for exactly one
funding snapshot across rounds. Freeze sorted ticket identities, investor accounts,
original wallet accounts, amounts, total principal, currency and target obligation.
Post that principal once from the captured round hold into its bound funding account.
Retire each selected ticket through engineOwned collect in the same transaction.
Collection cannot run from a public action, scheduler or separate posting path.
Activation marks target success only and moves no principal. Priced disbursement
still requires the priced authority; funding never pays the borrower.

## Receipt distribution

Lock the distribution, immutable funding snapshot, allocation receipt and all affected
accounts. The receipt must belong to the snapshot's obligation and currency. Consume
its identity globally once per mode, independent of distribution instance or alias.
Reject caller-provided principal, profit, ticket weights and replacement wallet accounts.
Only allocation receipt principal and earned profit participate; fines and evidenced
cost are excluded. Require the source accounts recorded by the receipt to hold those
amounts. The receipt identifies principal and profit source accounts; consume each
component once and post all destinations atomically.

For cash, fee = floor(profit * feeBps / 10000), VAT = floor(fee * vatBps / 10000).
Distributable = principal + profit - fee - VAT. Each ticket gets
floor(distributable * ticketAmount / snapshotPrincipal). Pay fee, VAT and the remaining
minor units to the immutable named beneficiary accounts. New receipts may distribute
again; a repeated receipt may not. The public arithmetic helper returns these amounts,
not a payment authority or consumed receipt.

For loss, accept only a write_off receipt's consumed principal. Fee and VAT must be
zero. Use exact frozen ticket ratios and assign remaining minor units by largest
remainder, breaking ties by ticket identity. Record investor loss rows without any
cash posting. Unearned profit cancellation is not investor principal loss.

## Emitted shapes

### Commitment admission

```json
{
  "requiresRefs": [
    {
      "bind": {
        "walletAccountId": "refs.walletAccountId"
      },
      "field": "walletId",
      "match": {
        "fields.investorAccountId": "fields.holderAccountId",
        "fields.currency": "fields.currency"
      },
      "statuses": ["active"]
    },
    {
      "bind": {
        "currency": "fields.currency",
        "escrowAccountId": "refs.escrowAccountId",
        "closeBy": "fields.closeBy"
      },
      "field": "fundingRoundId",
      "statuses": ["open"]
    }
  ],
  "requiresExposure": [
    {
      "groupField": "investorAccountId",
      "minimumField": "minimumTicket",
      "amountField": "amount",
      "anchorField": "fundingRoundId",
      "capField": "maximumTicket",
      "capOnAnchor": true,
      "childInstrumentId": "funding_commitment",
      "statuses": ["committed"]
    }
  ],
  "deadline": {
    "field": "closeBy"
  }
}
```

### Funding

```json
{
  "obligationField": "obligationId",
  "ticketInstrumentId": "funding_commitment",
  "ticketRefField": "fundingRoundId",
  "ticketAmountField": "amount",
  "ticketInvestorField": "investorAccountId",
  "ticketAccountField": "walletAccountId",
  "ticketStatus": "committed",
  "collectAction": "collect",
  "principalField": "targetAmount",
  "sourceAccountPath": "refs.escrowAccountId",
  "destinationAccountField": "fundingAccountId",
  "terms": {
    "targetAmount": "principal",
    "fixedProfit": "fixedProfit",
    "installmentCount": "installmentCount",
    "earningRule": "earningRule",
    "borrowerAccountId": "borrowerAccountId",
    "currency": "currency"
  },
  "capture": "fundingSnapshot"
}
```

### Cash distribution

```json
{
  "roundField": "roundId",
  "snapshotRef": "fundingSnapshot",
  "receiptField": "receiptId",
  "receiptPath": "refs.allocationReceipt",
  "mode": "cash",
  "feeBps": 100,
  "vatBps": 1500,
  "feeAccountField": "feeAccountId",
  "taxAccountField": "taxAccountId",
  "residualAccountField": "residualAccountId",
  "capture": "distributionReceipt"
}
```

### Loss distribution

```json
{
  "roundField": "roundId",
  "snapshotRef": "fundingSnapshot",
  "receiptField": "receiptId",
  "receiptPath": "refs.writeOffReceipt",
  "mode": "loss",
  "feeBps": 0,
  "vatBps": 0,
  "feeAccountField": "feeAccountId",
  "taxAccountField": "taxAccountId",
  "residualAccountField": "residualAccountId",
  "capture": "distributionReceipt"
}
```
