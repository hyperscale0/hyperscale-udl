import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UdlDocument } from "../src/index.js";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const validRoot = join(import.meta.dir, "..", "conformance", "valid");
const invalidRoot = join(import.meta.dir, "..", "conformance", "invalid");
const product = await mkdtemp(join(tmpdir(), "udl-cli-"));

afterAll(async () => {
  await rm(product, { force: true, recursive: true });
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

/** Copies a conformance document into the scratch product so --write is safe. */
async function scratch(source: string, name: string): Promise<string> {
  const target = join(product, name);
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
      join(invalidRoot, "missing-create-action.udl"),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "UDL3001 $.instruments[0].actions: every instrument must declare the create action",
    );
  });

  test("separates an unreadable file from a refused document", async () => {
    const result = await udl("validate", join(product, "absent.udl"));
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
    expect(result.stderr).toContain("UDL1003 $.udl");
  });
});

describe("udl canon", () => {
  test("prints canonical bytes or their digest", async () => {
    const document = join(validRoot, "hand-edited.udl");
    const canonical = await udl("canon", document);
    expect(canonical.code).toBe(0);
    expect(canonical.stdout).toBe(
      await readFile(join(validRoot, "minimal.udl"), "utf8"),
    );
    const digest = await udl("canon", document, "--digest");
    expect(digest.code).toBe(0);
    expect(digest.stdout.trim()).toBe(
      "c21d198d69e9d4cadb33aaacf37581bb388e4a8964b7fc284606cfa9f65d35bb",
    );
  });
});

describe("udl explain", () => {
  test("prints the catalog row for a stable code", async () => {
    const result = await udl("explain", "UDL5007");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "UDL5007 Reconcile exception child violation",
    );
    expect(result.stdout).toContain("family: gates");
  });

  test("refuses an unknown diagnostic code", async () => {
    const result = await udl("explain", "UDL9999");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown diagnostic code UDL9999");
  });
});

describe("udl diff", () => {
  test("calls an unchanged document additive", async () => {
    const live = join(validRoot, "protection.udl");
    const result = await udl("diff", live, live);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toEndWith("protection.udl: additive");
  });

  test("names the violation when a live instrument loses a lifecycle state", async () => {
    const live = join(validRoot, "minimal.udl");
    const document = JSON.parse(await readFile(live, "utf8")) as UdlDocument;
    document.version = 2;
    document.instruments[0]!.lifecycle.states = ["open"];
    delete (
      document.instruments[0]!.lifecycle.transitions as Record<string, unknown>
    ).close;
    delete (document.instruments[0]!.actions as Record<string, unknown>).close;
    document.instruments[0]!.actionOrder =
      document.instruments[0]!.actionOrder.filter(
        (action) => action !== "close",
      );
    const next = join(product, "shrunk.udl");
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
    for (const command of ["validate", "fmt", "canon", "diff", "explain"]) {
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
