/**
 * Emits spec/udl.schema.json from the Zod grammar in src/schema.ts.
 *
 * `--write` regenerates the file; `--check` fails when the committed spec no
 * longer matches the grammar.
 */
import * as z from "zod";

import { UDL_FORMAT_VERSION, udlDocumentSchema } from "../src/schema.js";

const specPath = new URL("../spec/udl.schema.json", import.meta.url);

const SCHEMA_URI =
  "https://raw.githubusercontent.com/hyperscale0/hyperscale-udl/main/spec/udl.schema.json";

function emitSpec(): string {
  const generated = z.toJSONSchema(udlDocumentSchema, {
    target: "draft-2020-12",
    // A document is checked as written, before Zod applies any default, so the
    // spec describes what an author may omit rather than what a parser hands
    // back.
    io: "input",
    cycles: "ref",
    reused: "ref",
    // A future grammar shape that JSON Schema cannot carry fails the emit
    // instead of vanishing into an empty `{}` nobody notices.
    unrepresentable: "throw",
  }) as Record<string, unknown>;

  const { $schema: _generatedDialect, ...body } = generated;

  const spec = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_URI,
    title: `UDL document, format version ${UDL_FORMAT_VERSION}`,
    description:
      "Generated from the Zod grammar in src/schema.ts by scripts/emit-spec.ts. " +
      "Edits belong in the grammar. This schema pins document shape only; the " +
      "semantic laws it cannot express are checked by src/validation.ts and test/.",
    ...body,
  };
  return `${JSON.stringify(spec, null, 2)}\n`;
}

const mode = process.argv[2];
if (
  mode !== "check" &&
  mode !== "--check" &&
  mode !== "write" &&
  mode !== "--write"
) {
  console.error("usage: emit-spec.ts <--write|--check>");
  process.exit(2);
}

/**
 * Whitespace-only differences are ignored so that a JSON formatter running over
 * the repository cannot turn a correct spec into a failing build. Key order is
 * still compared, because it is what makes the generated file reviewable.
 */
function contentOf(json: string): string | null {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return null;
  }
}

const emitted = emitSpec();
if (mode === "write" || mode === "--write") {
  await Bun.write(specPath, emitted);
  console.log(`wrote ${specPath.pathname}`);
} else {
  const committed = await Bun.file(specPath)
    .text()
    .catch(() => "");
  if (contentOf(committed) !== contentOf(emitted)) {
    console.error(
      "spec/udl.schema.json is stale: the Zod grammar changed. Run `bun run spec` and commit the result.",
    );
    process.exit(1);
  }
  console.log("spec/udl.schema.json matches the grammar");
}
