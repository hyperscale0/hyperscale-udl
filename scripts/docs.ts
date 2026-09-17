import { mkdir, readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const source = await readFile(new URL("spec/README.md", root), "utf8");
await mkdir(new URL("docs/", root), { recursive: true });
await writeFile(new URL("docs/README.md", root), source);
await writeFile(
  new URL("llms.txt", root),
  "# UDL 3\n\n- [Specification](spec/README.md)\n- [Schema](spec/udl.schema.json)\n",
);
await writeFile(new URL("llms-full.txt", root), source);
