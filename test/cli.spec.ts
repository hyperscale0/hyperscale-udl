import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UdlDocument } from "../src/index.js";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const validRoot = join(import.meta.dir, "..", "conformance", "valid");
const invalidRoot = join(import.meta.dir, "..", "conformance", "invalid");
const workspace = await mkdtemp(join(tmpdir(), "udl-cli-"));

afterAll(async () => {
  await rm(workspace, { force: true, recursive: true });
});

async function udl(
  ...args: string[]
): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout };
}

/** Copies a conformance document into the scratch workspace so --write is safe. */
async function scratch(source: string, name: string): Promise<string> {
  const target = join(workspace, name);
  await Bun.write(target, Bun.file(source));
  return target;
}

describe("udl validate", () => {
  test("admits a conformance document", async () => {
    const result = await udl("validate", join(validRoot, "minimal.udl"));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toEndWith("minimal.udl: ok");
  });

  test("reports the issue code and path of a refused document", async () => {
    const result = await udl(
      "validate",
      join(invalidRoot, "missing-create-verb.udl"),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "invalid_semantics $.nouns[0].verbs: every noun must declare the create verb",
    );
  });

  test("separates an unreadable file from a refused document", async () => {
    const result = await udl("validate", join(workspace, "absent.udl"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read");
  });
});

describe("udl fmt", () => {
  test("prints the canonical bytes of a hand-edited document", async () => {
    const canonical = await readFile(join(validRoot, "minimal.udl"), "utf8");
    const result = await udl("fmt", join(validRoot, "hand-edited.udl"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(canonical);
  });

  test("--write rewrites a hand-edited document in place", async () => {
    const file = await scratch(
      join(validRoot, "hand-edited.udl"),
      "rewrite.udl",
    );
    const result = await udl("fmt", file, "--write");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toEndWith("rewrite.udl: formatted");
    expect(await readFile(file, "utf8")).toBe(
      await readFile(join(validRoot, "minimal.udl"), "utf8"),
    );
  });

  test("--write leaves an already-canonical document untouched", async () => {
    const file = await scratch(join(validRoot, "minimal.udl"), "stable.udl");
    const result = await udl("fmt", file, "--write");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("refuses to format a document the grammar rejects", async () => {
    const result = await udl("fmt", join(invalidRoot, "format-version.udl"));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid_shape $.udl");
  });
});

describe("udl diff", () => {
  test("calls an unchanged document additive", async () => {
    const live = join(validRoot, "protection.udl");
    const result = await udl("diff", live, live);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toEndWith("protection.udl: additive");
  });

  test("names the violation when a live noun loses a lifecycle state", async () => {
    const live = join(validRoot, "minimal.udl");
    const document = JSON.parse(await readFile(live, "utf8")) as UdlDocument;
    document.version = 2;
    document.nouns[0]!.lifecycle.states = ["open"];
    delete (document.nouns[0]!.lifecycle.transitions as Record<string, unknown>)
      .close;
    delete (document.nouns[0]!.verbs as Record<string, unknown>).close;
    const next = join(workspace, "shrunk.udl");
    await Bun.write(next, `${JSON.stringify(document, null, 2)}\n`);

    const result = await udl("diff", live, next);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "lifecycle state closed was removed or renamed",
    );
  });
});

describe("udl usage", () => {
  test("help exits clean and names every command", async () => {
    const result = await udl("help");
    expect(result.code).toBe(0);
    for (const command of ["validate", "fmt", "diff"]) {
      expect(result.stdout).toContain(`udl ${command}`);
    }
  });

  test("an unknown command is a usage error, not a validation failure", async () => {
    const result = await udl("lint", "whatever.udl");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command lint");
  });

  test("a missing argument is a usage error", async () => {
    const result = await udl("diff", join(validRoot, "minimal.udl"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: udl diff <live> <next>");
  });
});
