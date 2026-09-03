import { expect, test } from "bun:test";

test("the package carries public documentation and the UDL skill", async () => {
  const process = Bun.spawn(
    ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const [{ files }] = JSON.parse(stdout) as [
    { readonly files: readonly { readonly path: string }[] },
  ];
  const paths = files.map((file) => file.path);
  expect(paths).toContain("docs/README.md");
  expect(paths).toContain("docs/reference/diagnostics.md");
  expect(paths).toContain("docs/llms.txt");
  expect(paths).toContain("skills/udl/SKILL.md");
});
