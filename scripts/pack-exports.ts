/**
 * Pack-time entry-point rewrite (prepack applies, postpack restores).
 *
 * The workspace package.json must keep every entry point on src/index.ts:
 * vite-plus resolves this package with node-like conditions, so any
 * dist-pointing mapping visible to the monorepo would read the untracked
 * (gate-cleaned, potentially stale) dist/ build during `vp test`. The
 * published tarball needs the opposite -- native Node cannot import .ts from
 * node_modules -- so the tarball alone gets dist-pointing entries, the same
 * split pnpm formalizes as publishConfig field overrides.
 */
const packageJsonPath = new URL("../package.json", import.meta.url);

const dataExports = {
  "./spec/*": "./spec/*",
  "./conformance/*": "./conformance/*",
  "./package.json": "./package.json",
};

const sourceEntries = {
  main: "./src/index.ts",
  module: "./src/index.ts",
  types: "./src/index.ts",
  bin: { udl: "./src/cli.ts" },
  exports: { ".": "./src/index.ts", ...dataExports },
};

const distEntries = {
  main: "./dist/index.js",
  module: "./dist/index.js",
  types: "./dist/index.d.ts",
  // Native Node cannot run a .ts bin out of node_modules either.
  bin: { udl: "./dist/cli.js" },
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    ...dataExports,
  },
};

const mode = process.argv[2];
if (mode !== "apply" && mode !== "restore") {
  throw new Error("usage: pack-exports.ts <apply|restore>");
}

const manifest = JSON.parse(await Bun.file(packageJsonPath).text()) as Record<
  string,
  unknown
>;
Object.assign(manifest, mode === "apply" ? distEntries : sourceEntries);
await Bun.write(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
