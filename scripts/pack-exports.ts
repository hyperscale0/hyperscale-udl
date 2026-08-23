/**
 * Pack-time entry-point rewrite (prepack applies, postpack restores).
 *
 * The workspace package.json keeps main/module/types/exports on src/index.ts:
 * vite-plus resolves this package with node-like conditions, so any
 * dist-pointing mapping visible to the monorepo would read the untracked
 * (gate-cleaned, potentially stale) dist/ build during `vp test`. The
 * published tarball needs the opposite -- native Node cannot import .ts from
 * node_modules -- so the tarball alone gets dist-pointing entries, the same
 * split pnpm formalizes as publishConfig field overrides.
 *
 * The rewrite reaches those four fields because a consumer reads them from the
 * package.json INSIDE the installed tarball. It cannot reach `bin`: npm links
 * node_modules/.bin from the registry packument, and publish.js re-reads
 * package.json from disk AFTER postpack has already restored it. 1.0.0-alpha.1
 * shipped that way, so every install got a .bin/udl pointing at src/cli.ts and
 * Node refused to execute it. `bin` stays dist-pointing at rest and is absent
 * from both entry sets below; scripts/check-bin.ts holds it there.
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
  exports: { ".": "./src/index.ts", ...dataExports },
};

const distEntries = {
  main: "./dist/index.js",
  module: "./dist/index.js",
  types: "./dist/index.d.ts",
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
