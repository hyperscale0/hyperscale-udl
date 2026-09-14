# Piece plans and private action composition

UDL preserves the authored graph and the order needed to interpret it.
`piecePlan` declares a finite partition, `pieceStage` names a stage, `calls`
binds private actions, and `actionLibrary` supplies their definitions. HSX
spells these clauses `piece_plan`, `piece_stage`, `calls` and `action_library`.
The shapes live in [`schema.ts`](../src/schema.ts); resolution and finance
validation live in [`validation.ts`](../src/validation.ts). The
[clause reference](reference/clauses.md) describes the complete vocabulary.

## Worked sale example

The following decoded instrument fragment uses the sale settlement's price
partition and refund action. Add it to an instrument with its required
immutable fields, matching partition, lifecycle and captured escrow account.
It omits the surrounding document and other actions. It is formatted for
reading; canonical serialization sorts object keys and retains array order.

```json
{
  "piecePlan": {
    "id": "price",
    "total": "price",
    "pieces": [
      {
        "id": "seller",
        "amount": "piece1Amount",
        "release_to": "sellerAccountId",
        "refund_to": "buyerAccountId"
      },
      {
        "id": "platform_fee",
        "amount": "piece2Amount",
        "release_to": "platformAccountId",
        "refund_to": "buyerAccountId"
      },
      {
        "id": "seller_cancel_fee",
        "amount": "piece3Amount",
        "release_to": "platformAccountId",
        "refund_to": "sellerAccountId"
      }
    ],
    "fund_order": ["seller", "platform_fee", "seller_cancel_fee"],
    "release_order": ["platform_fee", "seller_cancel_fee"],
    "refund_order": ["platform_fee", "seller_cancel_fee"],
    "unfund_order": ["seller_cancel_fee", "platform_fee", "seller"]
  },
  "actionLibrary": {
    "settlement_piece": {
      "actionOrder": ["move"],
      "actions": {
        "move": {
          "parameters": {
            "piece": { "kind": "piece" },
            "source": { "kind": "account" },
            "destination": { "kind": "account" }
          },
          "principal": "api_key",
          "approval": "inherit",
          "recovery": "local",
          "order": ["transfer"],
          "calls": [],
          "leaves": [
            {
              "id": "transfer",
              "operation": "internal_transfer.create",
              "bind": {
                "amount": "$piece.amount",
                "currency": "$piece.currency",
                "sourceAccountId": "$source",
                "destinationAccountId": "$destination"
              },
              "effects": [
                { "kind": "moves", "signature": "moves.transfer.internal" }
              ],
              "evidence": "transferId"
            }
          ]
        }
      }
    }
  },
  "actions": {
    "refund_piece": {
      "pieceStage": { "plan": "price", "stage": "refund" },
      "calls": [
        {
          "id": "move_piece",
          "action": "settlement_piece.move",
          "bind": {
            "piece": "$piece",
            "source": "$instance.refs.escrowAccountId",
            "destination": "$piece.refund_to"
          }
        }
      ],
      "steps": [],
      "summary": "Refund a piece of a sale settlement"
    }
  }
}
```

The containing instrument's `actionOrder` includes `refund_piece` at its
authored position. Both library `actionOrder` and private action `order` must
be exact permutations of their members. The stage derives a required
`pieceId` enum, here `platform_fee` or `seller_cancel_fee`. The selector does
not add another transfer; the private leaf moves its amount once.

For the sale's example amounts, `piece1Amount` is `245000`, `piece2Amount` is
`3750`, and `piece3Amount` is `1250`, all SAR minor units. They partition
`price` of `250000`. Cancellation's separate decision action returns the seller
piece to the buyer. The refund stage then returns `3750` to the buyer and pays
`1250` to the seller. Unfund follows its reverse order and returns every funded
piece to the buyer instead. The service fee stays outside the price partition.

`resolveUdlActionPlans` returns plans and issues. A plan identifies its action
and optional piece ID, with resolved effects and leaves. Each leaf retains
`originPath`, step, effects and evidence. Resolution expands static calls; it
does not replace the source graph in canonical UDL. A private library entry is
not a public action. [`refactor-clauses.spec.ts`](../test/refactor-clauses.spec.ts)
checks piece constraints, graph order, cycles, bindings, authority and evidence.

## Conservation and diagnostics

UDL 2.3.0 checks funded amounts over piece progress. A partially funded path
must return only the pieces actually funded; selecting one piece is not proof
that a whole stage completed. For a piece plan, `expandPieceProgress` bounds the reachable lifecycle/progress
states at 256. Instruments without a piece plan use the separate action-plan
combination bound. These bounds belong to the proof, not to a runtime retry
loop. [`udl.spec.ts`](../test/udl.spec.ts) includes the stranded-funded-piece
refusal; [`validation.ts`](../src/validation.ts) owns the progress expansion.

[`diagnostics.ts`](../src/diagnostics.ts) defines the refusal codes:

| Code      | Refusal                | Repair                                                                                   |
| --------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `UDL4001` | Money graph violation  | Balance each funded amount and close every hold on each lifecycle path                   |
| `UDL5013` | Piece stage violation  | Select a declared plan/stage, valid ordered piece IDs and a call-based stage action      |
| `UDL2010` | Action graph violation | Resolve targets and remove cycles, collisions or invalid order within depth/count limits |

A partition mismatch or incompatible immutable field is `UDL4002`. A typed
binding failure is `UDL2011`; an authority boundary is `UDL2012`; incomplete
effects or evidence are `UDL2013`. These failures are not permission to skip
the independent conservation oracle. Keep actions that need another principal,
independent approval or external recovery as separate calls at the public
boundary, not flattened private work.
