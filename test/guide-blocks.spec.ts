import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseUdl, UdlError } from "../src/index.js";

const guideRoot = join(import.meta.dir, "..", "docs", "guide");
const blockPattern = /```json(?=[ \t\n])([^\n]*)\n([\s\S]*?)```/g;

describe("UDL guide JSON blocks", async () => {
  const names = (await readdir(guideRoot))
    .filter((name) => name.endsWith(".md"))
    .sort();

  for (const name of names) {
    const text = await Bun.file(join(guideRoot, name)).text();
    const blocks = [...text.matchAll(blockPattern)];
    for (const [index, match] of blocks.entries()) {
      test(`${name} block ${index + 1} has its declared verdict`, () => {
        const info = match[1]?.trim() ?? "";
        expect(info).toMatch(/^(?:expect=UDL\d{4})?$/);
        const expectedCode = info.startsWith("expect=")
          ? info.slice("expect=".length)
          : undefined;
        const source = match[2];
        if (!source) throw new Error(`${name} block ${index + 1} is empty`);
        if (!expectedCode) {
          expect(() => parseUdl(source)).not.toThrow();
          return;
        }
        try {
          parseUdl(source);
          throw new Error(`${name} block ${index + 1} was admitted`);
        } catch (error) {
          if (!(error instanceof UdlError)) throw error;
          expect(error.issues.map((issue) => String(issue.code))).toContain(
            expectedCode,
          );
        }
      });
    }
  }
});
