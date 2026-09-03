import { expect, test } from "bun:test";

import {
  canonicalDigest,
  parseUdl,
  serializeUdl,
  UDL_FORMAT_VERSION,
  udlDiagnostics,
  udlKernelOperationSchema,
  UdlError,
  validateUdl,
} from "../src/index.js";

const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
const minimal = await Bun.file(
  new URL("../conformance/valid/minimal.udl", import.meta.url),
).text();

test("README pins stable issue fields to the diagnostic table", () => {
  expect(readme).toContain(
    "Every issue has a stable `UDL####` code, a category, a JSON path, a message, and a fix.",
  );
  expect(udlDiagnostics.length).toBeGreaterThan(0);
  for (const entry of udlDiagnostics) {
    expect(entry.code).toMatch(/^UDL\d{4}$/);
    expect(entry.category.length).toBeGreaterThan(0);
    expect(entry.fix.trim().length).toBeGreaterThan(0);
  }
});

test("README pins parser input and UTF-8 refusal", () => {
  expect(readme).toContain(
    "`parseUdl` accepts a string or `Uint8Array` and rejects malformed UTF-8.",
  );
  expect(parseUdl(new TextEncoder().encode(minimal))).toEqual(
    parseUdl(minimal),
  );
  try {
    parseUdl(new Uint8Array([0xc3, 0x28]));
    throw new Error("malformed UTF-8 was admitted");
  } catch (error) {
    if (!(error instanceof UdlError)) throw error;
    expect(error.issues[0]?.code).toBe("UDL1001");
  }
});

test("README pins the seven kernel operations", () => {
  expect(readme).toContain("The seven kernel operations are");
  expect(udlKernelOperationSchema.options).toEqual([
    "account.escrow.provision",
    "account.freeze",
    "account.unfreeze",
    "internal_transfer.create",
    "internal_transfer.reserve",
    "internal_transfer.post",
    "internal_transfer.void",
  ]);
});

test("README pins canonical serialization and digest semantics", async () => {
  expect(readme).toContain(
    "It sorts object keys by UTF-16 code unit, keeps array order, uses two-space indentation, and writes one final line feed.",
  );
  expect(readme).toContain(
    "`canonicalDigest` hashes those UTF-8 bytes with SHA-256 and returns a promise for the lowercase hexadecimal digest.",
  );
  const document = parseUdl(minimal);
  const canonical = serializeUdl(document);
  expect(canonical.endsWith("\n")).toBe(true);
  expect(await canonicalDigest(document)).toMatch(/^[a-f0-9]{64}$/);
});

test("README pins derived effects to validation", () => {
  expect(readme).toContain(
    "The compiler derives action `effects` from clauses. The validator rejects a supplied effects object unless every row and its order match.",
  );
  const changed = structuredClone(parseUdl(minimal));
  changed.instruments[0]!.actions.create!.effects = {
    schedules: [{ signature: "schedules.due", source: "due" }],
  };
  const result = validateUdl(changed);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("mismatched effects were admitted");
  expect(result.issues.map((issue) => issue.code)).toContain("UDL2005");
});

test("README pins package and format versions separately", async () => {
  const packageJson = (await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()) as { readonly version: string };
  expect(readme).toContain(
    'The literal `"udl": 1` is the format version. The version in `package.json` is the package version.',
  );
  expect(UDL_FORMAT_VERSION).toBe(1);
  expect(packageJson.version).toBe("1.0.0");
});
