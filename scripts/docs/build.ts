import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { udlDiagnostics } from "../../src/diagnostics.js";
import {
  udlClauseVocabulary,
  type UdlClauseVocabularyEntry,
} from "../../src/schema.js";

const packageRoot = new URL("../..", import.meta.url).pathname;
const docsRoot = join(packageRoot, "docs");
const packageVersion = (
  (await Bun.file(join(packageRoot, "package.json")).json()) as {
    readonly version: string;
  }
).version;
const mode = process.argv[2];

if (mode !== "--write" && mode !== "--check") {
  throw new Error("usage: bun scripts/docs/build.ts --write|--check");
}

const generated = new Map<string, string>([
  ["reference/clauses.md", await clausesPage()],
  ["reference/diagnostics.md", diagnosticsPage()],
  ["reference/cli.md", await cliPage()],
]);
generated.set("llms.txt", shortMap());
generated.set("llms-full.txt", await fullMap(generated));

const stale: string[] = [];
for (const [relativePath, contents] of generated) {
  const path = join(docsRoot, relativePath);
  if (mode === "--write") {
    await Bun.write(path, contents);
    continue;
  }
  const current = await Bun.file(path)
    .text()
    .catch(() => "");
  if (current !== contents) stale.push(relativePath);
}

if (stale.length > 0) {
  console.error(
    `generated UDL documentation is stale: ${stale.join(", ")}; run bun run docs:build`,
  );
  process.exit(1);
}

await checkLinks();

if (mode === "--check") {
  console.log(
    `generated UDL documentation matches (${generated.size} files); local links resolve`,
  );
}

async function clausesPage(): Promise<string> {
  const examples = await clauseExamples();
  const vocabulary: readonly UdlClauseVocabularyEntry[] = udlClauseVocabulary;
  const sections = vocabulary.map((clause) => {
    const outputs = clause.linearOutputs?.map(code).join(", ") ?? "none";
    const effectRows = clause.effects?.map((effect) => {
      const signature =
        "fixed" in effect.signature
          ? effect.signature.fixed
          : "fromField" in effect.signature
            ? `value from ${effect.signature.fromField}`
            : "movement class";
      return `${effect.kind}.${signature} per ${effect.per}`;
    });
    const effects = effectRows?.length ? effectRows.join("; ") : "none";
    const example = examples.get(clause.target);
    if (example === undefined) {
      throw new Error(
        `no valid conformance case exercises clause target ${clause.target}`,
      );
    }
    return `## ${clause.spelling}\n\n- Scope: ${clause.scope}\n- UDL target: ${code(clause.target)}\n- Cardinality: ${clause.cardinality ?? "one"}\n- Linear outputs: ${outputs}\n- Effects: ${effects}\n- Law: ${lawFor(clause.target)}\n- Conformance source: ${code(example.caseName)}\n\n${clauseNote(clause.target)}${fence(example.value)}\n`;
  });
  return `${header("clauses.md")}# Clause reference\n\nThis page lists every entry in ${code("udlClauseVocabulary")}. The examples are copied from admitted documents under ${code("conformance/valid")}.\n\n${sections.join("\n")}`;
}

function diagnosticsPage(): string {
  const rows = [...udlDiagnostics]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((entry) => [
      code(entry.code),
      entry.family,
      entry.category,
      escapeCell(entry.title),
      escapeCell(entry.fix),
    ]);
  return `${header("diagnostics.md")}# Diagnostic reference\n\nCodes are stable. Titles and messages may become clearer without changing the code. Apply the listed fix, then validate the whole document again.\n\n${markdownTable(["Code", "Family", "Category", "Title", "Fix"], rows)}\n`;
}

async function cliPage(): Promise<string> {
  const source = await Bun.file(join(packageRoot, "src", "cli.ts")).text();
  const usage = source.match(/const USAGE = `([\s\S]*?)`;/)?.[1];
  if (!usage) throw new Error("could not read USAGE from src/cli.ts");
  return `${header("cli.md")}# Command reference\n\nThe installed ${code("udl")} binary exposes the following commands and exit codes.\n\n\`\`\`text\n${usage}\n\`\`\`\n`;
}

function shortMap(): string {
  return `${header("llms.txt")}# UDL documentation\n\n- [Start here](README.md)\n- [Write a document](guide/01-a-document.md)\n- [Understand the laws](guide/03-laws.md)\n- [Evolve a stored document](guide/07-evolution.md)\n- [Implement UDL](guide/08-implementing.md)\n- [Clause reference](reference/clauses.md)\n- [Diagnostic reference](reference/diagnostics.md)\n- [Canonical bytes](reference/canonical.md)\n- [Command reference](reference/cli.md)\n- [Conformance contract](../conformance/README.md)\n`;
}

async function fullMap(
  generated: ReadonlyMap<string, string>,
): Promise<string> {
  const paths = [
    "README.md",
    ...(await readdir(join(docsRoot, "guide")))
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => `guide/${name}`),
    "reference/canonical.md",
    "reference/clauses.md",
    "reference/diagnostics.md",
    "reference/cli.md",
  ];
  const parts: string[] = [
    header("llms-full.txt"),
    "# UDL complete reference\n",
  ];
  for (const path of paths) {
    const contents =
      generated.get(path) ?? (await Bun.file(join(docsRoot, path)).text());
    parts.push(
      `\n<!-- source: ${path} -->\n\n${rebaseLinks(stripGeneratedHeader(contents), path).trim()}\n`,
    );
  }
  return parts.join("");
}

async function checkLinks(): Promise<void> {
  const paths = await markdownFiles(docsRoot);
  const missing: string[] = [];
  for (const path of paths) {
    const text = await Bun.file(path).text();
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
      const fileTarget = target.split("#")[0];
      if (!fileTarget) continue;
      const resolved = resolve(dirname(path), decodeURIComponent(fileTarget));
      if (!(await Bun.file(resolved).exists())) {
        missing.push(`${relative(docsRoot, path)} -> ${target}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`broken local documentation links:\n${missing.join("\n")}`);
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return Promise.resolve(entry.name.endsWith(".md") ? [path] : []);
    }),
  );
  return nested.flat().sort();
}

function rebaseLinks(contents: string, sourcePath: string): string {
  return contents.replaceAll(
    /\[([^\]]*)\]\(([^)]+)\)/g,
    (match, label: string, target: string) => {
      if (/^(?:[a-z]+:|#)/i.test(target)) return match;
      const [path, fragment] = target.split("#");
      if (!path) return match;
      const rebased = relative(
        docsRoot,
        resolve(docsRoot, dirname(sourcePath), path),
      );
      return `[${label}](${rebased}${fragment ? `#${fragment}` : ""})`;
    },
  );
}

type ClauseExample = { readonly caseName: string; readonly value: unknown };

async function clauseExamples(): Promise<Map<string, ClauseExample>> {
  const directory = join(packageRoot, "conformance", "valid");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".udl"))
    .sort();
  const examples = new Map<string, ClauseExample>();
  for (const name of names) {
    const document = await Bun.file(join(directory, name)).json();
    const instruments = recordValue(document)?.instruments;
    if (!Array.isArray(instruments)) continue;
    for (const clause of udlClauseVocabulary) {
      if (examples.has(clause.target)) continue;
      for (const instrument of instruments) {
        const instrumentRecord = recordValue(instrument);
        if (!instrumentRecord) continue;
        const owners =
          clause.scope === "instrument"
            ? [instrumentRecord]
            : Object.values(
                recordValue(instrumentRecord.actions) ?? {},
              ).flatMap((action) => {
                const record = recordValue(action);
                return record ? [record] : [];
              });
        for (const owner of owners) {
          const value = targetValue(owner, clause.target.split("."));
          if (value === undefined) continue;
          examples.set(clause.target, { caseName: name, value });
          break;
        }
        if (examples.has(clause.target)) break;
      }
    }
  }
  return examples;
}

function targetValue(
  owner: Readonly<Record<string, unknown>>,
  target: readonly string[],
): unknown {
  let candidate: unknown = owner;
  for (const segment of target) {
    const record = recordValue(candidate);
    if (!record) return undefined;
    candidate = record[segment];
  }
  return candidate;
}

function recordValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function lawFor(target: string): string {
  if (["eventName", "publicAction"].includes(target))
    return "Event law and naming law";
  if (
    [
      "moves",
      "payout",
      "steps",
      "partitions",
      "feeRules",
      "derivedAmounts",
    ].includes(target)
  )
    return "One-spine law and closure law";
  if (
    [
      "idPrefix",
      "title",
      "summary",
      "description",
      "nav",
      "surfaceVisibility",
      "templateId",
    ].includes(target)
  )
    return "One-sentence law, uniform object law, and naming law";
  if (["due", "deadline", "setsAt", "callerParkedStates"].includes(target))
    return "Time law and closure law";
  if (
    ["aggregateInvariants", "distinctParties", "subject", "update"].includes(
      target,
    )
  )
    return "Closure law";
  return "Requirements-as-data law and closure law";
}

function clauseNote(target: string): string {
  if (target === "commit") {
    return `A commit has no separate effect row. The committing action consumes the quote through its ${code("moves.*")} row.\n\n`;
  }
  if (target === "reconcile") {
    return `${code("exception.amountField")} must name a required money field on the exception child. ${code("exception.reasonField")} must name a required text field on that child. UDL evolution supplies no default for either name.\n\n`;
  }
  return "";
}

function header(output: string): string {
  return `<!-- Generated by scripts/docs/build.ts from @hyperscale0/udl ${packageVersion}. Edit the source, not ${output}. -->\n\n`;
}

function stripGeneratedHeader(value: string): string {
  return value.replace(/^<!-- Generated[^\n]* -->\n\n/, "");
}

function code(value: string): string {
  return `\`${value}\``;
}

function fence(value: unknown): string {
  return `\`\`\`json\n${formatJson(value)}\n\`\`\``;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatJson(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((entry) => entry === null || typeof entry !== "object")) {
      return `[${value.map((entry) => formatJson(entry)).join(", ")}]`;
    }
    const indentation = "  ".repeat(depth + 1);
    return `[\n${value
      .map((entry) => `${indentation}${formatJson(entry, depth + 1)}`)
      .join(",\n")}\n${"  ".repeat(depth)}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const indentation = "  ".repeat(depth + 1);
  return `{\n${entries
    .map(
      ([key, entry]) =>
        `${indentation}${JSON.stringify(key)}: ${formatJson(entry, depth + 1)}`,
    )
    .join(",\n")}\n${"  ".repeat(depth)}}`;
}

function markdownTable(
  headings: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" | ")} |`;
  return [
    line(headings),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ].join("\n");
}
