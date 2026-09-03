# Canonical bytes

An admitted UDL document has one canonical byte sequence.

- Encode JSON as UTF-8 without a byte-order mark.
- Sort every object's keys by ascending UTF-16 code unit. Compare code units, not locale order or Unicode collation order.
- Preserve array order exactly as authored. Never sort an array.
- Indent nested values with two ASCII spaces. Write one ASCII space after each colon.
- Write empty objects as `{}` and empty arrays as `[]`.
- Serialize JSON numbers with JavaScript `JSON.stringify` semantics. An admitted integer uses base-10 digits with an optional leading minus and no leading zeros. Negative zero serializes as `0`. UDL money is not a JSON number. It is a base-10 integer minor-unit string paired with a currency code.
- Apply ECMAScript well-formed `JSON.stringify` string escaping. Escape U+0000 through U+001F. Escape every lone surrogate as `\uXXXX`. Write every other code point literally, including U+007F and U+2028.
- End the document with exactly one line feed byte, `0A`. Write no other trailing whitespace.

`serializeUdl(document)` validates and writes these bytes. `canonicalizeUdl(input)` parses, validates, and writes them. Canonicalizing canonical bytes returns the same bytes.

`canonicalDigest(document)` computes SHA-256 over the canonical UTF-8 bytes and returns a promise for the lowercase hexadecimal digest. `udl canon file.udl --digest` prints that digest. It does not hash the source bytes before canonicalization.
