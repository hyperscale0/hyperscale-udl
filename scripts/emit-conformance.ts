import { basename, dirname, join } from "node:path";
import { canonicalDigest, parseUdl, serializeUdl } from "../src/index.js";
const path = process.argv[2];
const summary = process.argv[3];
if (!path?.endsWith(".udl") || !summary)
  throw new Error("usage: bun scripts/emit-conformance.ts CASE.udl SUMMARY");
const document = parseUdl(await Bun.file(path).text());
await Bun.write(path, serializeUdl(document));
await Bun.write(
  join(dirname(path), basename(path, ".udl") + ".expected.json"),
  JSON.stringify(
    {
      canonical: basename(path),
      digest: await canonicalDigest(document),
      summary,
      verdict: "valid",
    },
    null,
    2,
  ) + "\n",
);
