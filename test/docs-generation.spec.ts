import { expect, test } from "bun:test";

test("generated documentation matches package source", async () => {
  const process = Bun.spawn(["bun", "scripts/docs/build.ts", "--check"], {
    cwd: new URL("..", import.meta.url).pathname,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("generated UDL documentation matches (5 files)");
});
