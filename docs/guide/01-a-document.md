# A document

A UDL document names one product and contains its subjects and instruments. Each instrument declares stored fields, required fields, a lifecycle, and the actions that create or change an instance.

This is the smallest admitted document. `create` starts at `open`. `close` follows the matching lifecycle transition and ends at `closed`.

```json
{
  "instruments": [
    {
      "actionOrder": ["close", "create"],
      "fields": { "reference": { "type": "string" } },
      "id": "note",
      "idPrefix": "note",
      "lifecycle": {
        "initial": "open",
        "states": ["open", "closed"],
        "transitions": { "close": { "from": ["open"], "to": "closed" } }
      },
      "required": ["reference"],
      "summary": "A note a tenant files and later closes.",
      "title": "Note",
      "actions": {
        "close": { "moves": [], "steps": [], "summary": "Close the note." },
        "create": { "moves": [], "steps": [], "summary": "File the note." }
      }
    }
  ],
  "product": "minimal",
  "subjects": [],
  "title": "Minimal",
  "udl": 1,
  "version": 1
}
```

The JSON Schema checks the written shape. `validateUdl` then checks names, references, lifecycle reachability, and the money graph. A document has no canonical form until both checks pass.
