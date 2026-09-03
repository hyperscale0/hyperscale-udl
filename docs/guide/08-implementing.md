# Implementing UDL

A second implementation needs three independent checks.

1. Validate JSON shape against `spec/udl.schema.json`.
2. Enforce the whole-document laws and report the matching `UDL####` code and JSON path.
3. Serialize admitted documents under the canonical bytes law.

Run every conformance level. Valid cases must admit and match their canonical bytes and SHA-256 digest. Invalid cases must report every listed code and path. Evolution pairs must produce the listed `UDL7xxx` issues. An implementation may report more issues, but it may not omit a listed issue.

Do not key behavior on diagnostic messages. Titles, details, and fixes can become clearer. Codes cannot change once published.

Keep parsing, validation, canonicalization, and evolution comparison separate. That split prevents a diff from judging a candidate that the validator would refuse on its own.
