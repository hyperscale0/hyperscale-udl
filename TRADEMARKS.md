# Trademarks

"Hyperscale" and "UDL" are trademarks of Hyperscale LLC.

The AGPL covers the code in this repository and nothing else. It grants no
rights to the marks, and it never mentions them: a copyright license says
nothing about trademarks either way. This file draws that boundary so nobody
has to guess where it sits.

What that means in practice:

- **Yes.** Say your project uses UDL, reads UDL, or is compatible with UDL.
  Say it in your README, your docs, your talk, and your package description.
  Fork this repository and keep the notices intact.
- **Yes.** Publish a UDL implementation in another language, and name it in a
  way that describes what it does: `udl-rs`, `udl-parser`, `python-udl`.
- **No.** Name your project, company, or product in a way that suggests
  Hyperscale LLC published it or endorses it. `@hyperscale0/*` on npm and the
  `hyperscale0` GitHub organisation are ours.
- **No.** Use the marks or our logo in a way that implies affiliation,
  sponsorship, or certification we have not given.

## Claiming compatibility

An independent implementation may say it "implements UDL version X" or "passes
the UDL conformance suite version X" only while it passes the published
conformance cases for that version, unmodified. The cases in
[`conformance/`](./conformance) are the whole test: no skipped case, no edited
expectation, no local fork of the fixtures.

That claim is a statement about your implementation, so keep the marks out of
its name and off its logo, and do not present it as endorsement or
certification by Hyperscale LLC. We certify nothing; the suite does.

If you are unsure, open an issue and ask. Nobody has ever regretted asking.
