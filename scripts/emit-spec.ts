/**
 * Emits spec/udl.schema.json from the Zod grammar in src/schema.ts.
 *
 * The banner law is that the schema wins and prose drifts, so the published
 * spec is generated rather than written. `--write` regenerates the file and
 * `--check` fails when the committed content no longer matches the generator,
 * which is what keeps a grammar edit from shipping a stale spec.
 */
import { z } from "zod";

import { UDL_FORMAT_VERSION, udlDocumentSchema } from "../src/schema.js";

const specPath = new URL("../spec/udl.schema.json", import.meta.url);

const SCHEMA_URI =
  "https://raw.githubusercontent.com/hyperscale0/hyperscale-udl/main/spec/udl.schema.json";

/** The one recursive definition the grammar has: an arbitrary JSON value. */
const RECURSIVE_DEF_NAME = "jsonValue";

function emitSpec(): string {
  const generated = z.toJSONSchema(udlDocumentSchema, {
    target: "draft-2020-12",
    // A document is checked as written, before Zod applies any default, so the
    // spec describes what an author may omit rather than what a parser hands
    // back.
    io: "input",
    cycles: "ref",
    // Inlining keeps every field's pattern next to the field instead of behind
    // an anonymous $ref. Only true cycles survive as $defs.
    reused: "inline",
    // A future grammar shape that JSON Schema cannot carry fails the emit
    // instead of vanishing into an empty `{}` nobody notices.
    unrepresentable: "throw",
  }) as Record<string, unknown>;

  const { $schema: _generatedDialect, ...body } = nameRecursiveDefs(generated);

  const spec = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_URI,
    title: `UDL document, format version ${UDL_FORMAT_VERSION}`,
    description:
      "Generated from the Zod grammar in src/schema.ts by scripts/emit-spec.ts. " +
      "Edits belong in the grammar. This schema pins document shape only; the " +
      "semantic laws it cannot express are pinned by conformance/.",
    ...body,
  };
  return `${JSON.stringify(spec, null, 2)}\n`;
}

/**
 * Zod names cycle definitions `__schema0`, `__schema1`, and so on, in
 * traversal order, so a grammar edit anywhere renumbers them. Collapsing the
 * identical recursive JSON-value definitions under one stable name keeps the
 * published $refs from churning on unrelated changes.
 */
function nameRecursiveDefs(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const defs = (schema.$defs ?? {}) as Record<string, unknown>;
  const names = Object.keys(defs);
  const bodies = new Set(
    names.map((name) =>
      JSON.stringify(defs[name]).replaceAll(
        `"#/$defs/${name}"`,
        `"#/$defs/${RECURSIVE_DEF_NAME}"`,
      ),
    ),
  );
  if (bodies.size !== 1) {
    throw new Error(
      `expected one recursive definition, found ${names.length} (${names.join(", ") || "none"}) ` +
        `across ${bodies.size} distinct shapes; name the new one in scripts/emit-spec.ts`,
    );
  }

  let text = JSON.stringify(schema);
  for (const name of names) {
    text = text.replaceAll(
      `"#/$defs/${name}"`,
      `"#/$defs/${RECURSIVE_DEF_NAME}"`,
    );
  }
  const renamed = JSON.parse(text) as Record<string, unknown>;
  const [recursiveBody] = Object.values(
    renamed.$defs as Record<string, unknown>,
  );
  renamed.$defs = { [RECURSIVE_DEF_NAME]: recursiveBody };
  return renamed;
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
