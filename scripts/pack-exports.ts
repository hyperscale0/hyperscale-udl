/** Publish JavaScript entry points while source checkouts resolve TypeScript. */
const packageJsonPath = new URL("../package.json", import.meta.url);

const dataExports = {
  "./spec/*": "./spec/*",
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
