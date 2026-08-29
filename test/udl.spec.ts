import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  analyzeNounFinance,
  parseUdl,
  serializeUdl,
  UdlError,
  validateUdl,
  validateUdlSchemaValue,
  type UdlDocument,
} from "../src/index.js";
import { financeAdmissionProblem } from "../src/finance.js";
import { UDL_LIMITS } from "../src/limits.js";
import {
  diffNounEvolution,
  diffValidatedUdlEvolution,
  snapshotUdlNoun,
  type EvolutionVerbSnapshot,
  type NounEvolutionSnapshot,
} from "../src/index.js";

const fixtureRoot = join(import.meta.dir, "..", "conformance", "valid");

async function readFixture(name: string): Promise<string> {
  return Bun.file(join(fixtureRoot, name)).text();
}

async function parsedFixture(name: string): Promise<UdlDocument> {
  return parseUdl(await readFixture(name));
}

describe("UDL canonical artifacts", () => {
  test("uses sorted keys, two spaces, and one final line feed", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    document.title = "\u062d\u0645\u0627\u064a\u0629";

    const serialized = serializeUdl(document);
    expect(serialized.startsWith('{\n  "nouns":')).toBe(true);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
    expect(parseUdl(new TextEncoder().encode(serialized)).title).toBe(
      document.title,
    );
  });
});

describe("UDL grammar validation", () => {
  test("rejects oversized source before decoding or parsing", () => {
    const atLimit = capturedError(() =>
      parseUdl(new Uint8Array(UDL_LIMITS.maxSourceBytes)),
    );
    expect(atLimit.issues[0]?.code).toBe("invalid_json");

    const error = capturedError(() =>
      parseUdl(new Uint8Array(UDL_LIMITS.maxSourceBytes + 1)),
    );

    expect(error.issues).toEqual([
      {
        code: "resource_limit",
        message: `UDL source exceeds ${UDL_LIMITS.maxSourceBytes} bytes`,
        path: "$",
      },
    ]);
  });

  test("rejects excessive structure before grammar validation", () => {
    let atLimit: Record<string, unknown> = {};
    for (let depth = 1; depth < UDL_LIMITS.maxDepth; depth += 1) {
      atLimit = { nested: atLimit };
    }
    const admitted = validateUdl(atLimit);
    expect(
      !admitted.ok &&
        admitted.issues.every((issue) => issue.code !== "resource_limit"),
    ).toBe(true);

    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < UDL_LIMITS.maxDepth; depth += 1) {
      nested = { nested };
    }

    const result = validateUdl(nested);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        code: "resource_limit",
        message: `UDL nesting exceeds ${UDL_LIMITS.maxDepth} levels`,
      }),
    );
  });

  test("caps the number of parsed JSON values", () => {
    const admitted = validateUdl(
      Array.from({ length: UDL_LIMITS.maxNodes - 1 }, () => null),
    );
    expect(
      !admitted.ok &&
        admitted.issues.every((issue) => issue.code !== "resource_limit"),
    ).toBe(true);

    const result = validateUdl(
      Array.from({ length: UDL_LIMITS.maxNodes }, () => null),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues[0]).toEqual({
      code: "resource_limit",
      message: `UDL contains more than ${UDL_LIMITS.maxNodes} values`,
      path: "$",
    });
  });

  test("counts queued children before expanding another container", () => {
    const value: unknown[] = Array.from({ length: 5_000 }, () => null);
    value[0] = Array.from({ length: 5_000 }, () => null);

    const result = validateUdl(value);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues[0]).toEqual({
      code: "resource_limit",
      message: "UDL contains more than 10000 values",
      path: "$[0]",
    });
  });

  test("counts repeated JSON subtrees independently and rejects only cycles", () => {
    const shared = { value: "same JSON subtree" };
    const aliased = validateUdl({ first: shared, second: shared });
    expect(
      !aliased.ok &&
        aliased.issues.every((issue) => issue.code !== "resource_limit"),
    ).toBe(true);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cycle = validateUdl(cyclic);
    expect(cycle).toEqual({
      issues: [
        {
          code: "resource_limit",
          message: "UDL must not contain object cycles",
          path: "$.self",
        },
      ],
      ok: false,
    });
  });

  test("the public schema-value validator returns errors for non-JSON inputs", () => {
    const invalidSchemas = [
      { const: () => "not JSON" },
      { enum: [Symbol("not JSON")] },
      { const: Number.NaN },
      { const: Number.POSITIVE_INFINITY },
    ];
    for (const schema of invalidSchemas) {
      const invalidSchema = validateUdlSchemaValue(schema, null);
      expect(invalidSchema.valid).toBe(false);
      expect(invalidSchema.errors[0]).toEqual(
        expect.objectContaining({
          error: "UDL must contain only JSON values",
          keyword: "invalid_schema",
          keywordLocation: "$",
        }),
      );
    }

    const invalidValue = validateUdlSchemaValue({}, 1n);
    expect(invalidValue.errors[0]).toEqual({
      error: "UDL must contain only JSON values",
      instanceLocation: "$",
      keyword: "invalid_value",
      keywordLocation: "$",
    });
  });

  test("pins structural string and key budgets at N and N+1", () => {
    const atLimit = [
      validateUdl("x".repeat(UDL_LIMITS.maxStringLength)),
      validateUdl({ ["k".repeat(UDL_LIMITS.maxKeyLength)]: null }),
      validateUdl(
        Array.from(
          {
            length:
              UDL_LIMITS.maxTotalStringLength / UDL_LIMITS.maxStringLength,
          },
          () => "x".repeat(UDL_LIMITS.maxStringLength),
        ),
      ),
    ];
    expect(
      atLimit.every(
        (result) =>
          !result.ok &&
          result.issues.every((issue) => issue.code !== "resource_limit"),
      ),
    ).toBe(true);

    const totalOver = Array.from(
      {
        length: UDL_LIMITS.maxTotalStringLength / UDL_LIMITS.maxStringLength,
      },
      () => "x".repeat(UDL_LIMITS.maxStringLength),
    );
    totalOver.push("x");
    const overLimit = [
      validateUdl("x".repeat(UDL_LIMITS.maxStringLength + 1)),
      validateUdl({ ["k".repeat(UDL_LIMITS.maxKeyLength + 1)]: null }),
      validateUdl(totalOver),
    ];
    expect(
      overLimit.every(
        (result) => !result.ok && result.issues[0]?.code === "resource_limit",
      ),
    ).toBe(true);
  });

  test("rejects invalid UTF-8 before parsing JSON", () => {
    const invalidUtf8 = Uint8Array.from([0xc3, 0x28]);
    const error = capturedError(() => parseUdl(invalidUtf8));

    expect(error.issues).toEqual([
      {
        code: "invalid_utf8",
        message: "UDL bytes must be valid UTF-8",
        path: "$",
      },
    ]);
  });

  test("reports malformed JSON separately from grammar failures", () => {
    const error = capturedError(() => parseUdl('{"udl":1'));

    expect(error.issues[0]?.code).toBe("invalid_json");
    expect(error.issues[0]?.path).toBe("$");
  });

  test("rejects unknown keys and unsupported format versions", async () => {
    const document = await parsedFixture("protection.udl");
    const unknownKey = validateUdl({ ...document, extension: true });
    const nextVersion = validateUdl({ ...document, udl: 2 });

    expect(unknownKey.ok).toBe(false);
    expect(nextVersion.ok).toBe(false);
    if (unknownKey.ok || nextVersion.ok)
      throw new Error("expected invalid UDL");
    expect(unknownKey.issues[0]?.path).toBe("$");
    expect(nextVersion.issues[0]?.path).toBe("$.udl");
  });

  test("admits only bounded JSON Schema regexes and the sealed schema subset", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    document.nouns[0]!.fields.hostile = {
      pattern: "^(a+)+$",
      type: "string",
    };
    document.nouns[0]!.fields.extension = {
      oneOf: [{ type: "string" }],
    };
    document.nouns[0]!.fields.tooLong = {
      pattern: `^${"a".repeat(319)}$`,
      type: "string",
    };
    // The two catastrophic-backtracking constructions: ambiguous alternation
    // groups in sequence, and variable-width quantifiers in sequence. Both are
    // a product of branch factors, and both are refused by the same budget.
    document.nouns[0]!.fields.exponentialAlternation = {
      pattern: `^${"(?:a|aa)".repeat(13)}$`,
      type: "string",
    };
    document.nouns[0]!.fields.quantifierProduct = {
      pattern: "^a{0,64}a{0,64}b$",
      type: "string",
    };
    document.nouns[0]!.fields.stackedQuantifier = {
      pattern: "^a{1,2}{1,2}$",
      type: "string",
    };
    document.nouns[0]!.fields.unsupportedFormat = {
      format: "regex",
      type: "string",
    };
    document.nouns[0]!.fields.invalidSyntax = {
      pattern: "^[z-a]$",
      type: "string",
    };
    document.nouns[0]!.fields.malformedEnum = {
      enum: "not-an-array",
      type: "string",
    };
    document.nouns[0]!.fields.malformedItems = {
      items: "not-a-schema",
      type: "array",
    };
    document.nouns[0]!.fields.malformedFeeCollectionPort = {
      type: "string",
      "x-hyperscale-fee-collection-port": false,
    };
    document.nouns[0]!.fields.negativeLength = {
      maxLength: -1,
      type: "string",
    };
    document.nouns[0]!.fields.topLevelAlternation = {
      pattern: "^foo|bar$",
      type: "string",
    };
    document.nouns[0]!.fields.escapedTerminalAnchor = {
      pattern: "^money\\$",
      type: "string",
    };

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          code: "invalid_semantics",
          message: "JSON Schema pattern may not contain unbounded quantifiers",
          path: "$.nouns[0].fields.hostile.pattern",
        },
        {
          code: "invalid_semantics",
          message: "JSON Schema keyword oneOf is not in the UDL schema subset",
          path: "$.nouns[0].fields.extension.oneOf",
        },
        {
          code: "invalid_semantics",
          message: "JSON Schema pattern exceeds 320 characters",
          path: "$.nouns[0].fields.tooLong.pattern",
        },
        {
          code: "invalid_semantics",
          message: `JSON Schema pattern may branch more than ${UDL_LIMITS.maxPatternPaths} ways`,
          path: "$.nouns[0].fields.exponentialAlternation.pattern",
        },
        {
          code: "invalid_semantics",
          message: `JSON Schema pattern may branch more than ${UDL_LIMITS.maxPatternPaths} ways`,
          path: "$.nouns[0].fields.quantifierProduct.pattern",
        },
        {
          code: "invalid_semantics",
          message: "JSON Schema pattern contains an ambiguous quantifier",
          path: "$.nouns[0].fields.stackedQuantifier.pattern",
        },
        {
          code: "invalid_semantics",
          message: expect.stringContaining(
            "JSON Schema format must be one of hyperscale-date, hyperscale-date-time, hyperscale-email, hyperscale-uri",
          ),
          path: "$.nouns[0].fields.unsupportedFormat.format",
        },
        {
          code: "invalid_semantics",
          message: "JSON Schema pattern is not valid ECMAScript syntax",
          path: "$.nouns[0].fields.invalidSyntax.pattern",
        },
        {
          code: "invalid_semantics",
          message: "JSON Schema enum must be a non-empty array",
          path: "$.nouns[0].fields.malformedEnum.enum",
        },
        {
          code: "invalid_semantics",
          message: "JSON Schema items require an array schema and object value",
          path: "$.nouns[0].fields.malformedItems.items",
        },
        {
          code: "invalid_semantics",
          message:
            "x-hyperscale-fee-collection-port must be true on a string schema",
          path: '$.nouns[0].fields.malformedFeeCollectionPort["x-hyperscale-fee-collection-port"]',
        },
        {
          code: "invalid_semantics",
          message:
            "JSON Schema maxLength must be a non-negative integer on the matching schema type",
          path: "$.nouns[0].fields.negativeLength.maxLength",
        },
        {
          code: "invalid_semantics",
          message:
            "JSON Schema pattern alternation must be enclosed in a group",
          path: "$.nouns[0].fields.topLevelAlternation.pattern",
        },
        {
          code: "invalid_semantics",
          message:
            "JSON Schema pattern must be explicitly anchored with ^ and $",
          path: "$.nouns[0].fields.escapedTerminalAnchor.pattern",
        },
      ]),
    );
  });

  test("enforces sealed Hyperscale formats without regex fallbacks", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.nouns[0];
    const example = policy?.verbs.create?.examples?.[0];
    if (!policy || !example) throw new Error("policy create example missing");
    policy.fields.exactTime = {
      format: "hyperscale-date-time",
      type: "string",
    };
    policy.fields.exactDate = {
      format: "hyperscale-date",
      type: "string",
    };
    policy.fields.exactEmail = {
      format: "hyperscale-email",
      maxLength: 254,
      type: "string",
    };
    policy.fields.exactUri = {
      format: "hyperscale-uri",
      maxLength: 2_000,
      type: "string",
    };
    policy.fields.contacts = {
      additionalProperties: {
        format: "hyperscale-email",
        maxLength: 254,
        type: "string",
      },
      type: "object",
    };
    policy.fields.notificationEmails = {
      items: {
        format: "hyperscale-email",
        maxLength: 254,
        type: "string",
      },
      type: "array",
    };
    Object.assign(example.input, {
      contacts: { owner: "owner@example.com" },
      exactDate: "2026-07-23",
      exactEmail: "owner@example.com",
      exactTime: "2026-07-23T12:00:00.000Z",
      exactUri: "https://hyperscale0.ai/docs",
      notificationEmails: ["owner@example.com"],
    });
    expect(validateUdl(document).ok).toBe(true);

    const invalidValues = [
      ["exactDate", "2026-02-30", "hyperscale-date"],
      ["exactTime", "2026-07-23T15:00:00+03:00", "hyperscale-date-time"],
      ["exactTime", "2026-07-23t12:00:00.000z", "hyperscale-date-time"],
      ["exactTime", "2026-07-23 12:00:00.000Z", "hyperscale-date-time"],
      ["exactEmail", "a@b", "hyperscale-email"],
      ["exactUri", "/relative", "hyperscale-uri"],
      ["contacts", { owner: "a@b" }, "hyperscale-email"],
      ["notificationEmails", ["a@b"] as string[], "hyperscale-email"],
    ] as const;
    for (const [field, value, format] of invalidValues) {
      example.input[field] = value;
      const result = validateUdl(document);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected invalid UDL");
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining(
            `String does not match format "${format}"`,
          ),
          path: "$.nouns[0].verbs.create.examples[0].input",
        }),
      );
      if (field === "exactDate") {
        example.input.exactDate = "2026-07-23";
      } else if (field === "exactTime") {
        example.input.exactTime = "2026-07-23T12:00:00.000Z";
      } else if (field === "exactEmail") {
        example.input.exactEmail = "owner@example.com";
      } else {
        if (field === "exactUri") {
          example.input.exactUri = "https://hyperscale0.ai/docs";
        } else if (field === "contacts") {
          example.input.contacts = { owner: "owner@example.com" };
        } else {
          example.input.notificationEmails = ["owner@example.com"];
        }
      }
    }
  });

  test("rejects every format token outside the sealed four", async () => {
    const retiredFormats = [
      // The standard JSON Schema tokens: retired in favour of sealed ones so
      // that two implementations cannot disagree about what "email" means.
      "date",
      "date-time",
      "email",
      "uri",
      // The near miss an author actually makes.
      "hyperscale-datetime",
    ];
    for (const retiredFormat of retiredFormats) {
      const document = structuredClone(await parsedFixture("protection.udl"));
      document.nouns[0]!.fields.retiredFormat = {
        format: retiredFormat,
        type: "string",
      };

      const result = validateUdl(document);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected invalid UDL");
      expect(result.issues).toContainEqual({
        code: "invalid_semantics",
        message:
          "JSON Schema format must be one of hyperscale-date, hyperscale-date-time, hyperscale-email, hyperscale-uri",
        path: "$.nouns[0].fields.retiredFormat.format",
      });
    }
  });

  test("pins the regex branch budget at N and N+1", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    document.nouns[0]!.fields.patternLengthAtLimit = {
      pattern: `^${"a".repeat(UDL_LIMITS.maxPatternLength - 2)}$`,
      type: "string",
    };
    // 2^12 ways exactly. One more group doubles past the budget.
    document.nouns[0]!.fields.branchesAtLimit = {
      pattern: `^${"(?:a|b)".repeat(12)}$`,
      type: "string",
    };
    // Fixed-width quantifiers never branch, so any number of them is admitted.
    document.nouns[0]!.fields.fixedQuantifiers = {
      pattern: `^${"a{1}".repeat(64)}$`,
      type: "string",
    };
    document.nouns[0]!.fields.variableWidthAtLimit = {
      pattern: `^a{0,${UDL_LIMITS.maxStringLength}}$`,
      type: "string",
    };
    expect(validateUdl(document).ok).toBe(true);

    document.nouns[0]!.fields.branchesOverLimit = {
      pattern: `^${"(?:a|b)".repeat(13)}$`,
      type: "string",
    };
    document.nouns[0]!.fields.variableWidthOverLimit = {
      pattern: `^a{0,${UDL_LIMITS.maxStringLength + 1}}$`,
      type: "string",
    };
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: `JSON Schema pattern may branch more than ${UDL_LIMITS.maxPatternPaths} ways`,
          path: "$.nouns[0].fields.branchesOverLimit.pattern",
        }),
        expect.objectContaining({
          message: `JSON Schema pattern quantifier upper bound must not exceed ${UDL_LIMITS.maxStringLength}`,
          path: "$.nouns[0].fields.variableWidthOverLimit.pattern",
        }),
      ]),
    );
  });

  test("refuses the backtracking bomb before any value is matched against it", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.nouns[0];
    const example = policy?.verbs.create?.examples?.[0];
    if (!policy || !example) throw new Error("policy create example missing");
    // 53 ambiguous alternations at exactly maxPatternLength, paired with the
    // input that makes every one of the 2^53 splits fail: the construction the
    // old syntactic gate admitted because it counted quantifiers, not branches.
    policy.fields.bomb = {
      pattern: `^${"(?:a|)".repeat(53)}$`,
      type: "string",
    };
    example.input.bomb = `${"a".repeat(80)}b`;

    const started = performance.now();
    const result = validateUdl(document);
    const elapsedMs = performance.now() - started;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual({
      code: "invalid_semantics",
      message: `JSON Schema pattern may branch more than ${UDL_LIMITS.maxPatternPaths} ways`,
      path: "$.nouns[0].fields.bomb.pattern",
    });
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("pays for each reference-shape check once, and caps the total", async () => {
    const widened = async (
      gateField: (index: number) => string,
    ): Promise<ReturnType<typeof validateUdl>> => {
      const document = structuredClone(await parsedFixture("protection.udl"));
      const policy = document.nouns[0];
      if (!policy) throw new Error("policy noun missing");
      for (let index = 0; index < 46; index += 1) {
        document.nouns.push({
          description: `Filler noun ${index}.`,
          fields: {},
          id: `filler_${index}`,
          idPrefix: `f${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
          lifecycle: { initial: "open", states: ["open"], transitions: {} },
          required: [],
          summary: "Filler",
          title: `Filler ${index}`,
          verbs: {
            create: {
              description: "Creates a filler.",
              moves: [],
              steps: [],
              summary: "Create",
            },
          },
        });
      }
      for (let index = 0; index < 46; index += 1) {
        policy.fields[gateField(index)] = {
          pattern: "^clm_(sandbox|live)_[a-z0-9]{8,64}$",
          type: "string",
        };
        policy.verbs[`gate_verb_${index}`] = {
          description: "Gate verb.",
          moves: [],
          requiresRefs: [{ field: gateField(index), statuses: ["filed"] }],
          steps: [],
          summary: "Gate",
        };
      }
      return validateUdl(document);
    };

    const overBudget = {
      code: "resource_limit" as const,
      message: `document exceeds ${UDL_LIMITS.maxSchemaProbes} reference-shape checks; declare fewer nouns, reference gates, or payout intents`,
      path: "$.nouns",
    };

    // 46 gates on ONE field over 46 nouns is one answer per noun, not per gate.
    const sharedField = await widened(() => "sharedGateId");
    expect(sharedField.ok).toBe(false);
    if (sharedField.ok) throw new Error("expected invalid UDL");
    expect(sharedField.issues).not.toContainEqual(overBudget);

    // 46 distinct gate fields over 46 nouns is a genuine 2116-answer product,
    // and that is where validation refuses to keep paying.
    const distinctFields = await widened((index) => `gate${index}Id`);
    expect(distinctFields.ok).toBe(false);
    if (distinctFields.ok) throw new Error("expected invalid UDL");
    expect(distinctFields.issues).toEqual([overBudget]);
  });

  test("requires one create verb and a transition for every other verb", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    delete document.nouns[0]?.verbs.create;
    delete document.nouns[0]?.lifecycle.transitions.expire;
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual({
      code: "invalid_semantics",
      message: "every noun must declare the create verb",
      path: "$.nouns[0].verbs",
    });
    expect(result.issues).toContainEqual({
      code: "invalid_semantics",
      message: "verb expire must declare a lifecycle transition",
      path: "$.nouns[0].verbs.expire",
    });
  });

  test("checks lifecycle states and cross-noun gates", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const listing = document.nouns.find((noun) => noun.id === "listing");
    if (!listing) throw new Error("listing fixture missing");
    listing.lifecycle.transitions.sell!.to = "missing";
    listing.verbs.sell!.requiresRefs![0]!.statuses = ["missing"];
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.nouns[0].lifecycle.transitions.sell.to",
        "$.nouns[0].verbs.sell.requiresRefs[0].statuses[0]",
      ]),
    );
  });

  test("optional opts out only over optional references and optional bind targets", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    if (!escrow) throw new Error("escrow_order fixture missing");
    const nounIndex = document.nouns.indexOf(escrow);
    escrow.verbs.create!.requiresRefs![0]!.optional = true;
    escrow.verbs.fund!.requiresRefs![0]!.optional = true;

    const held = validateUdl(document);
    expect(held.ok).toBe(false);
    if (held.ok) throw new Error("expected invalid UDL");
    expect(held.issues).toContainEqual({
      code: "invalid_semantics",
      message:
        "optional declares an opt-out on listingId, which required lists",
      path: `$.nouns[${nounIndex}].verbs.fund.requiresRefs[0].optional`,
    });
    expect(held.issues).toContainEqual({
      code: "invalid_semantics",
      message:
        "an optional reference can only bind optional fields; required lists amount",
      path: `$.nouns[${nounIndex}].verbs.create.requiresRefs[0].bind.amount`,
    });

    delete escrow.verbs.create!.requiresRefs![0]!.optional;
    escrow.required = escrow.required.filter((field) => field !== "listingId");
    expect(validateUdl(document).ok).toBe(true);
  });

  test("checks deadline fields, offsets, and exclusion with due", async () => {
    const document = structuredClone(await parsedFixture("insured-travel.udl"));
    const flight = document.nouns.find((noun) => noun.id === "flight_booking");
    if (!flight?.verbs.confirm?.deadline) {
      throw new Error("flight_booking confirm fixture missing deadline");
    }
    flight.verbs.confirm.deadline.field = "missingField";
    flight.verbs.confirm.deadline.offset = "P1M";
    // A due verb also declaring a deadline would race itself: one facet fires
    // AT the moment, the other refuses AFTER it.
    flight.verbs.expire!.deadline = { field: "holdExpiresAt" };
    flight.verbs.expire!.due!.offset = "P1Y";
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const nounIndex = document.nouns.indexOf(flight);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        `$.nouns[${nounIndex}].verbs.confirm.deadline.field`,
        `$.nouns[${nounIndex}].verbs.confirm.deadline.offset`,
        `$.nouns[${nounIndex}].verbs.expire.deadline`,
        `$.nouns[${nounIndex}].verbs.expire.due.offset`,
      ]),
    );
    expect(result.issues).toContainEqual({
      code: "invalid_semantics",
      message: "a verb cannot declare both a due condition and a deadline",
      path: `$.nouns[${nounIndex}].verbs.expire.deadline`,
    });
  });

  test("requires a due verb to leave every source state", async () => {
    const document = structuredClone(await parsedFixture("insured-travel.udl"));
    const flight = document.nouns.find((noun) => noun.id === "flight_booking");
    const transition = flight?.lifecycle.transitions.expire;
    if (!flight?.verbs.expire?.due || !transition) {
      throw new Error("flight_booking expire fixture missing due transition");
    }
    transition.to = transition.from[0]!;

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const nounIndex = document.nouns.indexOf(flight);
    expect(result.issues).toContainEqual({
      code: "invalid_semantics",
      message:
        "a due verb must leave every source state so the maintenance loop fires its anchor exactly once",
      path: `$.nouns[${nounIndex}].verbs.expire.due`,
    });
  });

  test("keeps public intent distinct from verb identity and private on due verbs", async () => {
    const document = structuredClone(await parsedFixture("cards.udl"));
    const authorization = document.nouns.find(
      (noun) => noun.id === "card_authorization",
    );
    if (!authorization?.verbs.approve || !authorization.verbs.expire?.due) {
      throw new Error("card authorization public-intent fixture missing");
    }
    authorization.verbs.approve.publicIntent = "approveCardPayment";
    expect(validateUdl(document).ok).toBe(true);
    expect(authorization.lifecycle.transitions.approve).toBeDefined();

    authorization.verbs.expire.publicIntent = "expireCardPayment";
    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const nounIndex = document.nouns.indexOf(authorization);
    expect(result.issues).toContainEqual({
      code: "invalid_semantics",
      message: "a system due verb cannot declare a public intent",
      path: `$.nouns[${nounIndex}].verbs.expire.publicIntent`,
    });
  });

  test("requires computed time anchors to be immutable, positive, and dominant", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.nouns.find((noun) => noun.id === "policy");
    if (!policy?.verbs.bind || !policy.verbs.activate?.due) {
      throw new Error("policy timing fixture missing");
    }
    const nounIndex = document.nouns.indexOf(policy);
    policy.fields.activationAt = {
      format: "hyperscale-date-time",
      type: "string",
    };
    policy.verbs.bind.setsAt = { field: "activationAt", offset: "PT1H" };
    policy.verbs.activate.due.field = "activationAt";

    expect(validateUdl(document).ok).toBe(true);

    const createExample = policy.verbs.create?.examples?.[0];
    if (!createExample) throw new Error("policy create example missing");
    createExample.input.activationAt = "2026-07-23T12:00:00.000Z";
    const callerAuthoredAnchor = validateUdl(document);
    expect(callerAuthoredAnchor.ok).toBe(false);
    if (callerAuthoredAnchor.ok) throw new Error("expected invalid UDL");
    expect(callerAuthoredAnchor.issues).toContainEqual(
      expect.objectContaining({
        path: `$.nouns[${nounIndex}].verbs.create.examples[0].input`,
      }),
    );
    delete createExample.input.activationAt;

    policy.required.push("activationAt");
    policy.update = { fields: ["activationAt"], states: ["quoted"] };
    policy.verbs.bind.setsAt.offset = "PT0S";
    policy.verbs.preview!.setsAt = {
      field: "activationAt",
      offset: "PT30M",
    };
    policy.verbs.create!.setsAt = {
      field: "activationAt",
      offset: "PT15M",
    };
    policy.lifecycle.transitions.bypass = {
      from: ["quoted"],
      to: "bound",
    };
    policy.verbs.bypass = {
      moves: [],
      steps: [],
      summary: "Bypass the writer",
    };

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          code: "invalid_semantics",
          message: "setsAt target must be optional at create",
          path: `$.nouns[${nounIndex}].verbs.bind.setsAt.field`,
        },
        {
          code: "invalid_semantics",
          message: "setsAt target cannot also be mutable",
          path: `$.nouns[${nounIndex}].verbs.bind.setsAt.field`,
        },
        {
          code: "invalid_semantics",
          message: "setsAt.offset must be a positive fixed ISO-8601 duration",
          path: `$.nouns[${nounIndex}].verbs.bind.setsAt.offset`,
        },
        {
          code: "invalid_semantics",
          message:
            "verb activate can read activationAt before writers bind or create or preview",
          path: `$.nouns[${nounIndex}].verbs.activate`,
        },
        {
          code: "invalid_semantics",
          message:
            "activationAt has multiple writers without one shared one-way destination",
          path: `$.nouns[${nounIndex}].verbs.preview.setsAt.field`,
        },
        {
          code: "invalid_semantics",
          message:
            "setsAt requires a lifecycle transition and cannot run on create",
          path: `$.nouns[${nounIndex}].verbs.create.setsAt`,
        },
      ]),
    );
  });

  test("freeze steps take an instance-held account and no monetary legs", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const listing = document.nouns.find((noun) => noun.id === "listing");
    if (!listing?.verbs.reserve) throw new Error("listing fixture missing");
    listing.verbs.reserve.steps = [
      {
        operation: "account.freeze",
        bind: {
          accountId: { from: "const", value: "acct_live_0000000000000000" },
          amount: { from: "const", value: "100" },
          reason: { from: "const", value: "Frozen by verb" },
        },
      },
    ];
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const nounIndex = document.nouns.indexOf(listing);
    expect(result.issues).toContainEqual({
      code: "invalid_semantics",
      message: "account.freeze must bind accountId from an instance path",
      path: `$.nouns[${nounIndex}].verbs.reserve.steps[0].bind.accountId`,
    });
    expect(result.issues).toContainEqual({
      code: "invalid_semantics",
      message: "account.freeze must not bind amount",
      path: `$.nouns[${nounIndex}].verbs.reserve.steps[0].bind.amount`,
    });
  });

  test("rejects earnable on refund-shaped unwind verbs", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    if (!escrow?.unwind) throw new Error("escrow_order fixture missing unwind");
    // The release verb is legitimately earnable; the unwind confirm verb
    // (refund) moves money BACK and must never fund a workspace earn rate.
    escrow.verbs[escrow.unwind.confirm]!.earnable = true;
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const nounIndex = document.nouns.indexOf(escrow);
    expect(result.issues).toEqual([
      {
        code: "invalid_semantics",
        message:
          "unwind confirm verb refund is refund-shaped and cannot be earnable",
        path: `$.nouns[${nounIndex}].verbs.refund.earnable`,
      },
    ]);
  });

  test("requires a stored date-time anchor for before-relative penalties", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    if (!escrow?.unwind) throw new Error("escrow_order fixture missing unwind");
    const nounIndex = document.nouns.indexOf(escrow);

    escrow.unwind.beforeField = "fundBy";
    escrow.required.push("fundBy");
    expect(validateUdl(document).ok).toBe(true);

    escrow.required = escrow.required.filter((field) => field !== "fundBy");
    const optional = validateUdl(document);
    expect(optional.ok).toBe(false);
    if (optional.ok) throw new Error("expected invalid UDL");
    expect(optional.issues).toContainEqual({
      code: "invalid_semantics",
      message: "beforeField must be required",
      path: `$.nouns[${nounIndex}].unwind.beforeField`,
    });

    escrow.required.push("fundBy");
    escrow.unwind.beforeField = "amount";
    const money = validateUdl(document);
    expect(money.ok).toBe(false);
    if (money.ok) throw new Error("expected invalid UDL");
    expect(money.issues).toContainEqual({
      code: "invalid_semantics",
      message: "beforeField must be a date-time field",
      path: `$.nouns[${nounIndex}].unwind.beforeField`,
    });
  });

  test("rejects unfixed unwind windows and unfunded refund bases", async () => {
    const calendarDocument = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const calendarEscrow = calendarDocument.nouns.find(
      (noun) => noun.id === "escrow_order",
    );
    if (!calendarEscrow?.unwind) {
      throw new Error("escrow_order fixture missing unwind");
    }
    calendarEscrow.unwind.penalty = [{ bps: 2500, withinOffset: "P1M" }];
    const calendar = validateUdl(calendarDocument);
    expect(calendar.ok).toBe(false);
    if (calendar.ok) throw new Error("expected invalid UDL");
    expect(calendar.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("fixed ISO-8601 duration"),
        path: expect.stringContaining("unwind.penalty[0].withinOffset"),
      }),
    );

    const unfundedDocument = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const unfundedEscrow = unfundedDocument.nouns.find(
      (noun) => noun.id === "escrow_order",
    );
    if (!unfundedEscrow?.unwind || !unfundedEscrow.verbs.fund) {
      throw new Error("escrow_order funding fixture missing");
    }
    unfundedEscrow.verbs.fund.moves = [];
    const unfunded = validateUdl(unfundedDocument);
    expect(unfunded.ok).toBe(false);
    if (unfunded.ok) throw new Error("expected invalid UDL");
    expect(unfunded.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "cannot refund fields.amount from refs.escrowAccountId",
        ),
        path: expect.stringContaining("verbs.refund.moves[0]"),
      }),
    );

    const misplacedSourceDocument = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const misplacedSourceEscrow = misplacedSourceDocument.nouns.find(
      (noun) => noun.id === "escrow_order",
    );
    if (!misplacedSourceEscrow?.unwind) {
      throw new Error("escrow_order unwind fixture missing");
    }
    const confirm =
      misplacedSourceEscrow.verbs[misplacedSourceEscrow.unwind.confirm];
    const refund = confirm?.moves.find(
      (move) => move.operation === "internal_transfer.create",
    );
    if (!confirm || !refund) throw new Error("refund transfer fixture missing");
    delete refund.bind.sourceAccountId;
    confirm.steps.push({
      operation: "account.escrow.provision",
      bind: {
        sourceAccountId: {
          from: "instance",
          path: "refs.escrowAccountId",
        },
      },
    });
    const misplaced = validateUdl(misplacedSourceDocument);
    expect(misplaced.ok).toBe(false);
    if (misplaced.ok) throw new Error("expected invalid UDL");
    expect(misplaced.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("source comes from the noun instance"),
        path: expect.stringContaining("verbs.refund.moves"),
      }),
    );
  });

  test("rejects lifecycle states unreachable from create", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const claim = document.nouns.find((noun) => noun.id === "claim");
    if (!claim) throw new Error("claim fixture missing");
    claim.lifecycle.transitions.assess!.from = ["paid"];
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "lifecycle state assessed is unreachable from filed",
          path: "$.nouns[1].lifecycle.states[1]",
        }),
      ]),
    );
  });

  test("rejects a noun-owned account debit reachable before funding", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    const release = escrow?.verbs.release?.moves[0];
    if (!escrow?.verbs.cancel || !release) {
      throw new Error("escrow_order cancel or release fixture missing");
    }
    escrow.verbs.cancel.moves = [
      {
        ...structuredClone(release),
        bind: {
          ...structuredClone(release.bind),
          destinationAccountId: {
            from: "instance",
            path: "fields.buyerAccountId",
          },
        },
      },
    ];

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const nounIndex = document.nouns.indexOf(escrow);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_semantics",
        message: "verb cancel can debit unfunded refs.escrowAccountId",
        path: `$.nouns[${nounIndex}].verbs.cancel.moves[0].bind.sourceAccountId`,
      }),
    );
  });

  test("rejects an escrow debit when one lifecycle path bypasses funding", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    if (!escrow) throw new Error("escrow_order fixture missing");
    escrow.lifecycle.transitions.skip_fund = {
      from: ["created"],
      to: "funded",
    };
    escrow.verbs.skip_fund = {
      moves: [],
      summary: "Enter the funded state without moving money.",
      steps: [],
    };

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "verb release can debit unfunded refs.escrowAccountId",
        ),
        path: expect.stringContaining(
          "verbs.release.moves[0].bind.sourceAccountId",
        ),
      }),
    );
  });

  test("consumes escrow funding after a debit", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    const release = escrow?.verbs.release;
    if (!escrow || !release) throw new Error("escrow_order release missing");
    escrow.lifecycle.states.push("released_again");
    escrow.lifecycle.transitions.release_again = {
      from: ["released"],
      to: "released_again",
    };
    escrow.verbs.release_again = structuredClone(release);

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "verb release_again can debit unfunded refs.escrowAccountId",
        ),
        path: expect.stringContaining(
          "verbs.release_again.moves[0].bind.sourceAccountId",
        ),
      }),
    );
  });

  test("rejects terminal paths that strand escrow value", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    const release = escrow?.verbs.release;
    if (!escrow || !release) throw new Error("escrow_order release missing");
    release.moves = [];
    delete release.earnable;

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "terminal state released can strand value in refs.escrowAccountId",
        ),
      }),
    );
  });

  test("rejects an input-sized debit after the refund drains escrow", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    if (!escrow) throw new Error("escrow_order fixture missing");
    escrow.lifecycle.states.push("drained");
    escrow.lifecycle.transitions.drain = {
      from: ["penalty_collected"],
      to: "drained",
    };
    escrow.verbs.drain = {
      summary: "Drain the emptied escrow account.",
      steps: [],
      moves: [
        {
          key: "transfer",
          operation: "internal_transfer.create",
          bind: {
            sourceAccountId: {
              from: "instance",
              path: "refs.escrowAccountId",
            },
            destinationAccountId: {
              from: "instance",
              path: "fields.buyerAccountId",
            },
            amount: { from: "input", path: "amount" },
          },
        },
      ],
    };

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "verb drain can debit unfunded refs.escrowAccountId",
        ),
        path: expect.stringContaining(
          "verbs.drain.moves[0].bind.sourceAccountId",
        ),
      }),
    );
  });

  test("accepts partitioned escrow funding drained piece by piece on every exit", () => {
    const issues = analyzeNounFinance(partitionedEscrowNoun());

    expect(issues).toEqual([]);
  });

  test("rejects a partitioned escrow exit that strands one funded piece", () => {
    const noun = partitionedEscrowNoun();
    const verbs = { ...noun.verbs };
    delete (verbs as Record<string, unknown>).keep_piece_b;
    const transitions = { ...noun.lifecycle.transitions };
    delete (transitions as Record<string, unknown>).keep_piece_b;
    transitions.refund_piece_a = { from: ["cancel_started"], to: "canceled" };

    const issues = analyzeNounFinance({
      ...noun,
      lifecycle: { ...noun.lifecycle, transitions },
      verbs,
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "terminal state canceled can strand value in refs.escrowAccountId",
        ),
      }),
    );
  });

  test("stops financial graph exploration at the path-variant budget", () => {
    const issues = analyzeNounFinance(twoAccountBranchingNoun(7));

    expect(issues).toContainEqual({
      message: "financial analysis exceeds 256 distinct path variants",
      path: ["lifecycle"],
    });
  });

  test("rejects financial graphs over the lifecycle-state budget", () => {
    const noun = minimalFinancialNoun();
    const issues = analyzeNounFinance({
      ...noun,
      lifecycle: {
        ...noun.lifecycle,
        states: Array.from({ length: 33 }, (_, index) => `state_${index}`),
      },
    });

    expect(issues).toEqual([
      {
        message: "financial analysis exceeds 32 lifecycle states",
        path: ["lifecycle"],
      },
    ]);
  });

  test("charges every financial effect to one noun-wide work budget", () => {
    const issues = analyzeNounFinance(twoAccountWorkBudgetNoun());

    expect(issues).toContainEqual({
      message: "financial analysis exceeds 4096 deterministic work units",
      path: ["lifecycle"],
    });
  });

  test("pins every static finance graph budget at N and N+1", () => {
    const base = minimalFinancialNoun();
    const step = { operation: "account.freeze", bind: {} } as const;
    const cases = [
      {
        exact: {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            states: Array.from(
              { length: UDL_LIMITS.financeStates },
              (_, index) => `state_${index}`,
            ),
          },
        },
        over: {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            states: Array.from(
              { length: UDL_LIMITS.financeStates + 1 },
              (_, index) => `state_${index}`,
            ),
          },
        },
        message: `financial analysis exceeds ${UDL_LIMITS.financeStates} lifecycle states`,
      },
      {
        exact: {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            transitions: Object.fromEntries(
              Array.from(
                { length: UDL_LIMITS.financeTransitions },
                (_, index) => [
                  `verb_${index}`,
                  { from: ["state"], to: "state" },
                ],
              ),
            ),
          },
        },
        over: {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            transitions: Object.fromEntries(
              Array.from(
                { length: UDL_LIMITS.financeTransitions + 1 },
                (_, index) => [
                  `verb_${index}`,
                  { from: ["state"], to: "state" },
                ],
              ),
            ),
          },
        },
        message: `financial analysis exceeds ${UDL_LIMITS.financeTransitions} lifecycle transitions`,
      },
      {
        exact: {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            transitions: {
              edge: {
                from: Array.from(
                  { length: UDL_LIMITS.financeTransitionEdges },
                  () => "state",
                ),
                to: "state",
              },
            },
          },
        },
        over: {
          ...base,
          lifecycle: {
            ...base.lifecycle,
            transitions: {
              edge: {
                from: Array.from(
                  { length: UDL_LIMITS.financeTransitionEdges + 1 },
                  () => "state",
                ),
                to: "state",
              },
            },
          },
        },
        message: `financial analysis exceeds ${UDL_LIMITS.financeTransitionEdges} lifecycle transition edges`,
      },
      {
        exact: {
          ...base,
          verbs: Object.fromEntries(
            Array.from({ length: UDL_LIMITS.financeVerbs }, (_, index) => [
              `verb_${index}`,
              { steps: [] },
            ]),
          ),
        },
        over: {
          ...base,
          verbs: Object.fromEntries(
            Array.from({ length: UDL_LIMITS.financeVerbs + 1 }, (_, index) => [
              `verb_${index}`,
              { steps: [] },
            ]),
          ),
        },
        message: `financial analysis exceeds ${UDL_LIMITS.financeVerbs} verbs`,
      },
      {
        exact: {
          ...base,
          verbs: {
            create: {
              steps: Array.from(
                { length: UDL_LIMITS.financeEffects },
                () => step,
              ),
            },
          },
        },
        over: {
          ...base,
          verbs: {
            create: {
              steps: Array.from(
                { length: UDL_LIMITS.financeEffects + 1 },
                () => step,
              ),
            },
          },
        },
        message: `financial analysis exceeds ${UDL_LIMITS.financeEffects} kernel effects`,
      },
    ] as const;

    for (const entry of cases) {
      expect(financeAdmissionProblem(entry.exact)).toBeUndefined();
      expect(financeAdmissionProblem(entry.over)).toBe(entry.message);
    }

    expect(
      analyzeNounFinance(trackedAccountsNoun(UDL_LIMITS.financeAccounts)).some(
        (issue) => issue.message.includes("tracked accounts"),
      ),
    ).toBe(false);
    expect(
      analyzeNounFinance(trackedAccountsNoun(UDL_LIMITS.financeAccounts + 1)),
    ).toContainEqual({
      message: `financial analysis exceeds ${UDL_LIMITS.financeAccounts} tracked accounts`,
      path: ["verbs"],
    });
  });

  test("leaves caller-sized balance limits to runtime balance checks", () => {
    const issues = analyzeNounFinance({
      lifecycle: {
        initial: "created",
        states: ["created", "active", "closed"],
        transitions: {
          activate: { from: ["created"], to: "active" },
          topup: { from: ["active"], to: "active" },
          withdraw: { from: ["active"], to: "active" },
          close: { from: ["active"], to: "closed" },
        },
      },
      verbs: {
        create: {
          steps: [
            {
              operation: "account.escrow.provision",
              bind: { role: { from: "const", value: "workspace_escrow" } },
              capture: { balanceAccountId: "accountId" },
            },
          ],
        },
        activate: { steps: [] },
        topup: {
          steps: [],
          moves: [
            {
              key: "transfer",
              operation: "internal_transfer.create",
              bind: {
                sourceAccountId: {
                  from: "instance",
                  path: "fields.holderAccountId",
                },
                destinationAccountId: {
                  from: "instance",
                  path: "refs.balanceAccountId",
                },
                amount: { from: "input", path: "amount" },
              },
            },
          ],
        },
        withdraw: {
          steps: [],
          moves: [
            {
              key: "transfer",
              operation: "internal_transfer.create",
              bind: {
                sourceAccountId: {
                  from: "instance",
                  path: "refs.balanceAccountId",
                },
                destinationAccountId: {
                  from: "instance",
                  path: "fields.holderAccountId",
                },
                amount: { from: "input", path: "amount" },
              },
            },
          ],
        },
        close: { steps: [] },
      },
    });

    expect(issues).toEqual([]);
  });

  test("rejects a reserve smaller than the proven escrow balance", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    const release = escrow?.verbs.release;
    if (!escrow || !release) throw new Error("escrow_order release missing");
    release.steps = [];
    release.moves = [
      {
        key: "transfer",
        operation: "internal_transfer.reserve",
        bind: {
          sourceAccountId: {
            from: "instance",
            path: "refs.escrowAccountId",
          },
          destinationAccountId: {
            from: "instance",
            path: "fields.sellerAccountId",
          },
          amount: { from: "const", value: "1" },
        },
        capture: { releaseTransferId: "transferId" },
      },
    ];

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "cannot reserve const:1 from refs.escrowAccountId",
        ),
        path: expect.stringContaining(
          "verbs.release.moves[0].bind.sourceAccountId",
        ),
      }),
    );
  });

  test("rejects a second refundable-base credit before unwind", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    const fund = escrow?.verbs.fund;
    if (!escrow || !fund) throw new Error("escrow_order fund missing");
    escrow.lifecycle.transitions.fund_again = {
      from: ["funded"],
      to: "funded",
    };
    escrow.verbs.fund_again = structuredClone(fund);

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "unwind funding must establish exactly one refundable balance",
        ),
        path: expect.stringContaining(
          "verbs.fund_again.moves[0].bind.destinationAccountId",
        ),
      }),
    );
  });

  test("checks subject policies, update fields, and aggregate references", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.nouns.find((noun) => noun.id === "policy");
    if (!policy?.subject || !policy.aggregateInvariants?.[0]) {
      throw new Error("policy fixture missing subject or aggregate");
    }
    policy.subject.kinds = ["missing_subject"];
    policy.aggregateInvariants[0].childRefField = "coverageLimit";
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.nouns[0].subject.kinds[0]",
        "$.nouns[0].aggregateInvariants[0].childRefField",
      ]),
    );
  });

  test("checks aggregate money fields, consuming statuses, and immutability", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.nouns.find((noun) => noun.id === "policy");
    const claim = document.nouns.find((noun) => noun.id === "claim");
    if (!policy?.aggregateInvariants?.[0] || !claim) {
      throw new Error("protection fixture missing aggregate nouns");
    }
    policy.fields.coverageLimit = { type: "string" };
    claim.fields.claimAmount = { type: "string" };
    claim.update = { fields: ["claimAmount"], states: ["filed"] };
    policy.aggregateInvariants[0].childStatuses = [
      "approved",
      "approved",
      "missing",
    ];
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.nouns[0].aggregateInvariants[0].parentField",
        "$.nouns[0].aggregateInvariants[0].childField",
        "$.nouns[0].aggregateInvariants[0].childStatuses[1]",
        "$.nouns[0].aggregateInvariants[0].childStatuses[2]",
      ]),
    );
  });

  test("validates authored examples against create inputs", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const listing = document.nouns.find((noun) => noun.id === "listing");
    if (!listing?.verbs.create) throw new Error("listing create verb missing");
    listing.verbs.create.examples = [
      { input: { askingPrice: -1 }, name: "invalid_listing" },
    ];
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(
      result.issues.filter(
        (issue) => issue.path === "$.nouns[0].verbs.create.examples[0].input",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("rejects envelope fields, unknown required fields, and duplicate noun ids", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    document.nouns[0]!.fields.status = { type: "string" };
    document.nouns[0]!.required.push("missing");
    document.nouns[1]!.id = document.nouns[0]!.id;
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.nouns[0].fields.status",
        "$.nouns[0].required[8]",
        "$.nouns[1]",
      ]),
    );
  });
});

function partitionedEscrowNoun(): Parameters<typeof analyzeNounFinance>[0] {
  const transfer = (amountField: string, source: string, destination: string) =>
    ({
      steps: [],
      moves: [
        {
          key: "transfer",
          operation: "internal_transfer.create",
          bind: {
            sourceAccountId: { from: "instance", path: source },
            destinationAccountId: { from: "instance", path: destination },
            amount: { from: "instance", path: `fields.${amountField}` },
          },
        },
      ],
    }) as const;

  return {
    lifecycle: {
      initial: "created",
      states: [
        "created",
        "piece_a_funded",
        "funded",
        "piece_a_paid",
        "completed",
        "cancel_started",
        "piece_a_refunded",
        "canceled",
      ],
      transitions: {
        fund_piece_a: { from: ["created"], to: "piece_a_funded" },
        fund_piece_b: { from: ["piece_a_funded"], to: "funded" },
        pay_piece_a: { from: ["funded"], to: "piece_a_paid" },
        pay_piece_b: { from: ["piece_a_paid"], to: "completed" },
        cancel: { from: ["funded"], to: "cancel_started" },
        refund_piece_a: { from: ["cancel_started"], to: "piece_a_refunded" },
        keep_piece_b: { from: ["piece_a_refunded"], to: "canceled" },
      },
    },
    verbs: {
      create: {
        steps: [
          {
            operation: "account.escrow.provision",
            bind: { role: { from: "const", value: "workspace_escrow" } },
            capture: { escrowAccountId: "accountId" },
          },
        ],
      },
      fund_piece_a: transfer(
        "pieceA",
        "fields.buyerAccountId",
        "refs.escrowAccountId",
      ),
      fund_piece_b: transfer(
        "pieceB",
        "fields.buyerAccountId",
        "refs.escrowAccountId",
      ),
      pay_piece_a: transfer(
        "pieceA",
        "refs.escrowAccountId",
        "fields.sellerAccountId",
      ),
      pay_piece_b: transfer(
        "pieceB",
        "refs.escrowAccountId",
        "fields.platformAccountId",
      ),
      cancel: { steps: [] },
      refund_piece_a: transfer(
        "pieceA",
        "refs.escrowAccountId",
        "fields.buyerAccountId",
      ),
      keep_piece_b: transfer(
        "pieceB",
        "refs.escrowAccountId",
        "fields.platformAccountId",
      ),
    },
  };
}

function minimalFinancialNoun(): Parameters<typeof analyzeNounFinance>[0] {
  return {
    lifecycle: {
      initial: "state",
      states: ["state"],
      transitions: {},
    },
    verbs: {
      create: { steps: [] },
    },
  };
}

function trackedAccountsNoun(
  count: number,
): Parameters<typeof analyzeNounFinance>[0] {
  return {
    lifecycle: {
      initial: "state",
      states: ["state"],
      transitions: {},
    },
    verbs: {
      create: {
        steps: Array.from({ length: count }, (_, index) => ({
          operation: "account.escrow.provision",
          bind: { role: { from: "const" as const, value: "workspace_escrow" } },
          capture: { [`escrow${index}`]: "accountId" },
        })),
        moves: Array.from({ length: count }, (_, index) => ({
          key: `fund_${index}`,
          operation: "internal_transfer.create",
          bind: {
            sourceAccountId: {
              from: "instance" as const,
              path: "fields.payerAccountId",
            },
            destinationAccountId: {
              from: "instance" as const,
              path: `refs.escrow${index}`,
            },
            amount: {
              from: "instance" as const,
              path: `fields.amount${index}`,
            },
          },
        })),
      },
    },
  };
}

function twoAccountBranchingNoun(
  layers: number,
): Parameters<typeof analyzeNounFinance>[0] {
  const states = Array.from(
    { length: layers + 1 },
    (_, index) => `state_${index}`,
  );
  const transitions: Record<
    string,
    { readonly from: readonly string[]; readonly to: string }
  > = {};
  const verbs: Record<string, unknown> = {
    create: {
      steps: [
        {
          operation: "account.escrow.provision",
          bind: { role: { from: "const", value: "workspace_escrow" } },
          capture: { escrowA: "accountId" },
        },
        {
          operation: "account.escrow.provision",
          bind: { role: { from: "const", value: "workspace_escrow" } },
          capture: { escrowB: "accountId" },
        },
      ],
      moves: [
        {
          key: "base_a",
          operation: "internal_transfer.create",
          bind: {
            sourceAccountId: {
              from: "instance",
              path: "fields.payerAccountId",
            },
            destinationAccountId: {
              from: "instance",
              path: "refs.escrowA",
            },
            amount: { from: "instance", path: "fields.baseAmountA" },
          },
        },
        {
          key: "base_b",
          operation: "internal_transfer.create",
          bind: {
            sourceAccountId: {
              from: "instance",
              path: "fields.payerAccountId",
            },
            destinationAccountId: {
              from: "instance",
              path: "refs.escrowB",
            },
            amount: { from: "instance", path: "fields.baseAmountB" },
          },
        },
      ],
    },
  };
  for (let index = 0; index < layers; index += 1) {
    const from = states[index] as string;
    const to = states[index + 1] as string;
    transitions[`skip_${index}`] = { from: [from], to };
    transitions[`add_${index}`] = { from: [from], to };
    verbs[`skip_${index}`] = { steps: [], moves: [] };
    verbs[`add_${index}`] = {
      steps: [],
      moves: [
        {
          key: `piece_a_${index}`,
          operation: "internal_transfer.create",
          bind: {
            sourceAccountId: {
              from: "instance",
              path: "fields.payerAccountId",
            },
            destinationAccountId: {
              from: "instance",
              path: "refs.escrowA",
            },
            amount: { from: "instance", path: `fields.amountA${index}` },
          },
        },
        {
          key: `piece_b_${index}`,
          operation: "internal_transfer.create",
          bind: {
            sourceAccountId: {
              from: "instance",
              path: "fields.payerAccountId",
            },
            destinationAccountId: {
              from: "instance",
              path: "refs.escrowB",
            },
            amount: { from: "instance", path: `fields.amountB${index}` },
          },
        },
      ],
    };
  }

  return {
    lifecycle: { initial: states[0] as string, states, transitions },
    verbs,
  } as Parameters<typeof analyzeNounFinance>[0];
}

function twoAccountWorkBudgetNoun(): Parameters<typeof analyzeNounFinance>[0] {
  const base = twoAccountBranchingNoun(5);
  const transitions = { ...base.lifecycle.transitions };
  const verbs = { ...base.verbs };
  const heavyMoves = Array.from({ length: 110 }, (_, index) => ({
    key: `heavy_${index}`,
    operation: "internal_transfer.create" as const,
    bind: {
      sourceAccountId: {
        from: "instance" as const,
        path: "refs.escrowA",
      },
      destinationAccountId: {
        from: "instance" as const,
        path: "refs.escrowB",
      },
      amount: {
        from: "instance" as const,
        path: `fields.heavyAmount${index}`,
      },
    },
  }));
  transitions.heavy = { from: ["state_5"], to: "finished" };
  verbs.heavy = { steps: [], moves: heavyMoves };

  return {
    lifecycle: {
      initial: base.lifecycle.initial,
      states: [...base.lifecycle.states, "finished"],
      transitions,
    },
    verbs,
  } as Parameters<typeof analyzeNounFinance>[0];
}

function capturedError(run: () => unknown): UdlError {
  try {
    run();
  } catch (error) {
    if (error instanceof UdlError) return error;
    throw error;
  }
  throw new Error("expected UdlError");
}

function payoutSettlementDocument(): UdlDocument {
  return {
    nouns: [
      {
        fields: {
          amount: {
            pattern: "^[1-9][0-9]{0,17}$",
            type: "string",
          },
          currency: {
            maxLength: 3,
            minLength: 3,
            pattern: "^[A-Z]{3}$",
            type: "string",
          },
          destinationPartyAccountId: {
            pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
            type: "string",
          },
          payoutBeneficiaryId: {
            pattern: "^ben_(sandbox|live)_[a-z0-9]{8,64}$",
            type: "string",
          },
          sourceAccountId: {
            pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
            type: "string",
          },
        },
        id: "payout_batch",
        idPrefix: "pbat",
        lifecycle: {
          initial: "approved",
          states: ["approved", "instructed", "acknowledged", "reconciled"],
          transitions: {
            acknowledge: { from: ["instructed"], to: "acknowledged" },
            instruct: { from: ["approved"], to: "instructed" },
            reconcile: {
              from: ["instructed", "acknowledged"],
              to: "reconciled",
            },
          },
        },
        parties: { beneficiary: "destinationPartyAccountId" },
        required: [
          "amount",
          "currency",
          "destinationPartyAccountId",
          "payoutBeneficiaryId",
          "sourceAccountId",
        ],
        summary: "One payout batch with evidence-backed settlement.",
        title: "Payout batch",
        verbs: {
          acknowledge: {
            moves: [],
            steps: [],
            summary: "Record a separate tenant acknowledgement.",
          },
          create: { moves: [], steps: [], summary: "Create the batch." },
          instruct: {
            moves: [],
            payout: {
              amount: "fields.amount",
              beneficiaryField: "payoutBeneficiaryId",
              beneficiaryPartyField: "destinationPartyAccountId",
              capture: "payoutId",
              currencyField: "currency",
              sourceAccountField: "sourceAccountId",
              speed: "standard",
            },
            steps: [],
            summary: "Create the payout instruction.",
          },
          reconcile: {
            moves: [],
            requiresSettlement: {
              capture: "settlementEvidenceId",
              payoutRef: "payoutId",
            },
            steps: [],
            summary: "Record matched settlement evidence.",
          },
        },
      },
    ],
    product: "payout_evidence",
    subjects: [],
    title: "Payout evidence",
    udl: 1,
    version: 1,
  };
}

describe("payout settlement evidence", () => {
  test("admits a payout intent followed by a system-only settlement gate", () => {
    const result = validateUdl(payoutSettlementDocument());
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  test("checks payout value shapes and the shared ref namespace", () => {
    const document = payoutSettlementDocument();
    const noun = document.nouns[0]!;
    const instruct = noun.verbs.instruct!;
    if (!instruct.payout) throw new Error("fixture payout missing");
    instruct.payout.amount = "refs.unknownAmount";
    instruct.payout.beneficiaryField = "amount";
    instruct.payout.currencyField = "amount";
    instruct.payout.sourceAccountField = "amount";
    instruct.payout.capture = "settlementEvidenceId";

    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "payout amount refs.unknownAmount must name a declared money field or money ref",
        "payout beneficiaryField amount must name a beneficiary-id field",
        "payout currencyField amount must name a currency field",
        "payout sourceAccountField amount must name an account-id field",
        "settlement capture settlementEvidenceId collides with an existing noun ref key",
      ]),
    );
  });

  test("binds a payout beneficiary to the declared destination party", () => {
    const withoutParty = payoutSettlementDocument();
    delete withoutParty.nouns[0]!.parties;

    const missingResult = validateUdl(withoutParty);
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) throw new Error("expected invalid UDL");
    expect(missingResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "payout requires parties.beneficiary to bind its destination party",
        path: "$.nouns[0].verbs.instruct.payout.beneficiaryPartyField",
      }),
    );

    const mismatchedParty = payoutSettlementDocument();
    const noun = mismatchedParty.nouns[0]!;
    const payout = noun.verbs.instruct!.payout;
    if (!payout) throw new Error("fixture payout missing");
    noun.fields.otherPartyAccountId = {
      pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
      type: "string",
    };
    payout.beneficiaryPartyField = "otherPartyAccountId";

    const mismatchResult = validateUdl(mismatchedParty);
    expect(mismatchResult.ok).toBe(false);
    if (mismatchResult.ok) throw new Error("expected invalid UDL");
    expect(mismatchResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "payout beneficiaryPartyField otherPartyAccountId must equal parties.beneficiary destinationPartyAccountId",
        path: "$.nouns[0].verbs.instruct.payout.beneficiaryPartyField",
      }),
    );
  });

  test("rejects a payout intent on create to match core admission", () => {
    const document = payoutSettlementDocument();
    const noun = document.nouns[0]!;
    const payout = noun.verbs.instruct!.payout;
    if (!payout) throw new Error("fixture payout missing");
    noun.verbs.create!.payout = payout;
    delete noun.verbs.instruct!.payout;

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: "create cannot declare a payout intent",
        path: "$.nouns[0].verbs.create.payout",
      }),
    );
  });

  test("rejects a payout intent combined with kernel steps or moves", () => {
    const document = payoutSettlementDocument();
    const instruct = document.nouns[0]!.verbs.instruct!;
    instruct.steps.push({
      bind: {
        accountId: {
          from: "instance",
          path: "fields.sourceAccountId",
        },
      },
      operation: "account.freeze",
    });

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message:
          "verb instruct payout intent cannot combine with kernel steps or moves",
        path: "$.nouns[0].verbs.instruct.payout",
      }),
    );
  });

  test("rejects a ref-backed payout before its signed-sum writer", () => {
    const document = payoutSettlementDocument();
    const noun = document.nouns[0]!;
    const instruct = noun.verbs.instruct!;
    const acknowledge = noun.verbs.acknowledge!;
    if (!instruct.payout) throw new Error("fixture payout missing");
    instruct.payout.amount = "refs.payoutAmount";
    acknowledge.signedSum = {
      amountRef: "payoutAmount",
      onNegative: "refuse",
      onZero: "refuse",
      sources: [
        {
          amountField: "amount",
          nounId: "payout_item",
          refField: "payoutBatchId",
          sign: "add",
          statuses: ["ready"],
          subtotalRef: "readyAmount",
        },
      ],
    };
    document.nouns.push({
      fields: {
        amount: {
          pattern: "^[1-9][0-9]{0,17}$",
          type: "string",
        },
        currency: {
          maxLength: 3,
          minLength: 3,
          pattern: "^[A-Z]{3}$",
          type: "string",
        },
        payoutBatchId: {
          pattern: "^pbat_(sandbox|live)_[a-z0-9]{8,64}$",
          type: "string",
        },
      },
      id: "payout_item",
      idPrefix: "pitm",
      lifecycle: {
        initial: "ready",
        states: ["ready"],
        transitions: {},
      },
      required: ["amount", "currency", "payoutBatchId"],
      summary: "One amount contributing to a payout batch.",
      title: "Payout item",
      verbs: {
        create: { moves: [], steps: [], summary: "Create the item." },
      },
    });

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message:
          "payout amount refs.payoutAmount can be read before money writers acknowledge",
        path: "$.nouns[0].verbs.instruct.payout.amount",
      }),
    );
  });

  test("requires exactly one settlement gate for a payout-owning noun", () => {
    const withoutGate = payoutSettlementDocument();
    delete withoutGate.nouns[0]!.verbs.reconcile!.requiresSettlement;

    const missingResult = validateUdl(withoutGate);
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) throw new Error("expected invalid UDL");
    expect(missingResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "payout-owning noun must declare exactly one settlement gate; found 0",
        path: "$.nouns[0].verbs",
      }),
    );

    const withTwoGates = payoutSettlementDocument();
    withTwoGates.nouns[0]!.verbs.acknowledge!.requiresSettlement = {
      capture: "acknowledgementEvidenceId",
      payoutRef: "payoutId",
    };

    const duplicateResult = validateUdl(withTwoGates);
    expect(duplicateResult.ok).toBe(false);
    if (duplicateResult.ok) throw new Error("expected invalid UDL");
    expect(duplicateResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "payout-owning noun must declare exactly one settlement gate; found 2",
        path: "$.nouns[0].verbs",
      }),
    );

    const uncoveredPayout = payoutSettlementDocument();
    const secondPayout = structuredClone(
      uncoveredPayout.nouns[0]!.verbs.instruct!.payout,
    );
    if (!secondPayout) throw new Error("fixture payout missing");
    secondPayout.capture = "secondPayoutId";
    uncoveredPayout.nouns[0]!.verbs.acknowledge!.payout = secondPayout;

    const uncoveredResult = validateUdl(uncoveredPayout);
    expect(uncoveredResult.ok).toBe(false);
    if (uncoveredResult.ok) throw new Error("expected invalid UDL");
    expect(uncoveredResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "verb acknowledge payout capture secondPayoutId is not covered by settlement payoutRef payoutId",
        path: "$.nouns[0].verbs.acknowledge.payout.capture",
      }),
    );
  });

  test("refuses a settlement gate without a dominating payout capture", () => {
    const document = payoutSettlementDocument();
    const noun = document.nouns[0]!;
    const reconcile = noun.verbs.reconcile!;
    if (!reconcile.requiresSettlement) {
      throw new Error("fixture settlement gate missing");
    }
    reconcile.requiresSettlement.payoutRef = "missingPayout";
    noun.lifecycle.transitions.reconcile!.from = ["approved"];

    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues.map((issue) => issue.message)).toContain(
      "requiresSettlement payoutRef missingPayout is not captured by a payout intent",
    );

    reconcile.requiresSettlement.payoutRef = "payoutId";
    const early = validateUdl(document);
    expect(early.ok).toBe(false);
    if (early.ok) throw new Error("expected invalid UDL");
    expect(early.issues.map((issue) => issue.message)).toContain(
      "requiresSettlement can read payoutId before payout writers instruct",
    );
  });

  test("keeps settlement-gated transitions private and effect-free", () => {
    const document = payoutSettlementDocument();
    const reconcile = document.nouns[0]!.verbs.reconcile!;
    reconcile.input = { properties: {}, type: "object" };
    reconcile.captureInput = { callerClaim: "claim" };
    reconcile.publicIntent = "reconcilePayout";
    reconcile.port = { allowedParties: ["payer"] };
    reconcile.due = { field: "currency" };
    reconcile.deadline = { field: "currency" };
    reconcile.steps.push({
      bind: { accountId: { from: "instance", path: "fields.sourceAccountId" } },
      operation: "account.freeze",
    });
    reconcile.moves.push({
      bind: {
        amount: { from: "instance", path: "fields.amount" },
        destinationAccountId: {
          from: "instance",
          path: "fields.sourceAccountId",
        },
        sourceAccountId: {
          from: "instance",
          path: "fields.sourceAccountId",
        },
      },
      key: "claim",
      operation: "internal_transfer.create",
    });

    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    for (const facet of [
      "input",
      "captureInput",
      "publicIntent",
      "port",
      "due",
      "deadline",
    ]) {
      expect(result.issues.map((issue) => issue.message)).toContain(
        `requiresSettlement is system-only and cannot declare ${facet}`,
      );
    }
    expect(result.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "requiresSettlement cannot add kernel steps",
        "requiresSettlement cannot move money",
      ]),
    );
  });

  test("freezes payout and settlement clauses in evolution snapshots", () => {
    const previous = snapshotUdlNoun(payoutSettlementDocument().nouns[0]!);
    const next = structuredClone(previous);
    const instruct = next.verbs.instruct!;
    const reconcile = next.verbs.reconcile!;
    (instruct as { payout?: unknown }).payout = {
      ...(instruct.payout as Record<string, unknown>),
      speed: "changed",
    };
    (reconcile as { requiresSettlement?: unknown }).requiresSettlement = {
      ...(reconcile.requiresSettlement as Record<string, unknown>),
      payoutRef: "changedPayout",
    };

    expect(diffNounEvolution(previous, next)).toEqual(
      expect.arrayContaining([
        "payout_batch: verb instruct changed its payout intent",
        "payout_batch: verb reconcile changed its settlement evidence gate",
      ]),
    );
  });

  test("classifies a payout on a newly added verb as breaking", () => {
    const previous = snapshotUdlNoun(payoutSettlementDocument().nouns[0]!);
    const next = structuredClone(previous);
    (next.verbs as Record<string, EvolutionVerbSnapshot>).disburse = {
      ...structuredClone(next.verbs.instruct!),
      eventName: "payout_batch.disbursed",
    };

    expect(diffNounEvolution(previous, next)).toContain(
      "payout_batch: verb disburse added a payout intent; external money movement is frozen once live",
    );

    const legacyPrevious = structuredClone(previous);
    delete (legacyPrevious.verbs.instruct as { payout?: unknown }).payout;
    expect(diffNounEvolution(legacyPrevious, next)).toContain(
      "payout_batch: verb instruct changed its payout intent",
    );
  });
});

describe("signed sum validation", () => {
  test("rejects an amount ref that collides with captured input", async () => {
    const document = await signedSumDocument();
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    const release = escrow?.verbs.release;
    if (!release) throw new Error("escrow_order release missing");
    release.input = {
      properties: { claimedAmount: { type: "string" } },
      required: ["claimedAmount"],
      type: "object",
    };
    release.captureInput = { releaseAmount: "claimedAmount" };

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message:
          "signed sum ref releaseAmount collides with an existing noun ref key",
        path: "$.nouns[2].verbs.release.signedSum.amountRef",
      }),
    );
  });

  test("rejects overlapping status sets for the same signed source", async () => {
    const document = await signedSumDocument();
    const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
    const release = escrow?.verbs.release;
    if (!release?.signedSum) throw new Error("release signed sum missing");
    release.signedSum.sources.push({
      amountField: "askingPrice",
      nounId: "listing",
      refField: "escrowOrderId",
      sign: "add",
      statuses: ["active", "reserved"],
      subtotalRef: "activeAndReservedSubtotal",
    });

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: "signed sum source overlaps source 0 on statuses reserved",
        path: "$.nouns[2].verbs.release.signedSum.sources[1].statuses",
      }),
    );
  });
});

async function signedSumDocument(): Promise<UdlDocument> {
  const document = structuredClone(await parsedFixture("commerce-escrow.udl"));
  const escrow = document.nouns.find((noun) => noun.id === "escrow_order");
  const release = escrow?.verbs.release;
  const payout = release?.moves[0];
  if (!release || !payout) throw new Error("escrow_order release missing");
  release.signedSum = {
    amountRef: "releaseAmount",
    onNegative: "refuse",
    onZero: "refuse",
    sources: [
      {
        amountField: "askingPrice",
        nounId: "listing",
        refField: "escrowOrderId",
        sign: "add",
        statuses: ["reserved"],
        subtotalRef: "reservedSubtotal",
      },
    ],
  };
  payout.bind.amount = {
    from: "instance",
    path: "refs.releaseAmount",
  };
  return document;
}

// --------------------------------------------------------------------------
// Merged from open/udl/test/evolution.spec.ts
// --------------------------------------------------------------------------
describe("evolution", () => {
  async function fixture(name = "protection"): Promise<UdlDocument> {
    return parseUdl(await Bun.file(join(fixtureRoot, `${name}.udl`)).text());
  }

  async function evolved(
    change: (document: UdlDocument) => void,
    version = 2,
    name = "protection",
  ): Promise<{ next: UdlDocument; previous: UdlDocument }> {
    const previous = await fixture(name);
    const next = structuredClone(previous);
    next.version = version;
    change(next);
    return { next, previous };
  }

  function refundInput(document: UdlDocument): {
    additionalProperties?: boolean;
    properties: Record<string, unknown>;
    required?: string[];
  } {
    const transaction = document.nouns.find(
      (noun) => noun.id === "card_transaction",
    );
    const input = transaction?.verbs.refund?.input;
    if (!input) throw new Error("cards refund input fixture missing");
    return input as ReturnType<typeof refundInput>;
  }

  async function policySnapshot(): Promise<NounEvolutionSnapshot> {
    const document = await fixture();
    const policy = document.nouns.find((noun) => noun.id === "policy");
    if (!policy) throw new Error("policy fixture missing");
    return snapshotUdlNoun(policy);
  }

  function changed(
    snapshot: NounEvolutionSnapshot,
    patch: Partial<NounEvolutionSnapshot>,
  ): NounEvolutionSnapshot {
    return { ...snapshot, ...patch };
  }

  // The evolution exports take snapshots and documents the validator has
  // already admitted, and the diff walks them through stableStringify. A cycle
  // that reaches this far must still stop at a resource_limit issue rather than
  // a RangeError out of the call stack.
  describe("evolution admission", () => {
    /** The protection fixture with one noun's field map pointing at itself. */
    async function cyclic(): Promise<UdlDocument> {
      const document = await fixture();
      const noun = document.nouns[0];
      if (!noun) throw new Error("protection fixture has no nouns");
      (noun.fields as Record<string, unknown>).loop = noun.fields;
      return document;
    }

    test("bounds stableStringify even when validation is skipped", async () => {
      const [live, broken] = [await fixture(), await cyclic()];
      const error = capturedError(() =>
        diffValidatedUdlEvolution(live, broken),
      );
      expect(error.issues[0]?.code).toBe("resource_limit");
      expect(error.issues[0]?.message).toContain("nesting exceeds");
    });

    test("bounds a snapshot handed straight to diffNounEvolution", async () => {
      const noun = (await cyclic()).nouns[0];
      if (!noun) throw new Error("protection fixture has no nouns");
      const error = capturedError(() =>
        diffNounEvolution(snapshotUdlNoun(noun), snapshotUdlNoun(noun)),
      );
      expect(error.issues[0]?.code).toBe("resource_limit");
    });
  });

  describe("append-only UDL product evolution", () => {
    test("accepts unchanged and versioned additive product changes", async () => {
      const previous = await fixture();
      expect(
        diffValidatedUdlEvolution(previous, structuredClone(previous)),
      ).toEqual([]);

      const evolvedProduct = await evolved((document) => {
        const claim = document.nouns.find((noun) => noun.id === "claim");
        if (!claim) throw new Error("claim fixture missing");
        claim.fields.note = { type: "string" };
        claim.lifecycle.states.push("closed");
        claim.lifecycle.transitions.close = {
          from: ["paid", "denied"],
          to: "closed",
        };
        claim.verbs.close = {
          moves: [],
          steps: [],
          summary: "Close the resolved claim.",
        };
      });
      expect(
        diffValidatedUdlEvolution(evolvedProduct.previous, evolvedProduct.next),
      ).toEqual([]);
    });

    test("requires a product version increase for any semantic change", async () => {
      const { next, previous } = await evolved((document) => {
        document.nouns[1]!.fields.note = { type: "string" };
      }, 1);
      expect(diffValidatedUdlEvolution(previous, next)).toContain(
        "product definition changed without increasing version 1",
      );
    });

    test("freezes product identity, live nouns, and subject definitions", async () => {
      const { next, previous } = await evolved((document) => {
        document.product = "renamed_product";
        const policyRisk = document.subjects.find(
          (subject) => subject.kind === "policy_risk",
        );
        if (!policyRisk) throw new Error("policy_risk subject fixture missing");
        policyRisk.version += 1;
        document.nouns = document.nouns.filter((noun) => noun.id !== "claim");
      });
      // Dropping a noun other nouns still reference leaves a document
      // `validateUdl` refuses outright; the evolution law is what is under
      // test here, not admission.
      expect(diffValidatedUdlEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "product id changed from protection to renamed_product",
          "subject kind policy_risk changed after becoming live",
          "claim: live noun was removed from the product",
        ]),
      );
    });
  });

  describe("append-only verb input evolution", () => {
    test("rejects removing a live verb input field", async () => {
      const { next, previous } = await evolved(
        (document) => {
          const input = refundInput(document);
          delete input.properties.reason;
          input.required = [];
        },
        2,
        "cards",
      );
      // A move still binds the deleted input field, so `validateUdl` refuses
      // this document before the evolution law gets a word in.
      expect(diffValidatedUdlEvolution(previous, next)).toContain(
        "card_transaction: verb refund input field reason was removed or renamed",
      );
    });

    test("freezes the input schema envelope beyond declared fields", async () => {
      const { next, previous } = await evolved(
        (document) => {
          refundInput(document).additionalProperties = true;
        },
        2,
        "cards",
      );
      expect(diffValidatedUdlEvolution(previous, next)).toContain(
        "card_transaction: verb refund changed its input schema beyond declared fields; a live verb input is frozen",
      );
    });

    test("accepts an added optional input field and a verb's first input", async () => {
      const { next, previous } = await evolved(
        (document) => {
          refundInput(document).properties.note = { type: "string" };
          const dispute = document.nouns.find(
            (noun) => noun.id === "card_dispute",
          );
          if (!dispute?.verbs.review)
            throw new Error("dispute fixture missing");
          dispute.verbs.review.input = {
            additionalProperties: false,
            properties: { note: { type: "string" } },
            type: "object",
          };
        },
        2,
        "cards",
      );
      expect(diffValidatedUdlEvolution(previous, next)).toEqual([]);
    });
  });

  describe("append-only UDL noun evolution", () => {
    test("freezes instance identity and lifecycle", async () => {
      const previous = await policySnapshot();
      const next = changed(previous, {
        idPrefix: "cover",
        initial: "bound",
        states: previous.states.filter((state) => state !== "expired"),
        transitions: {
          ...previous.transitions,
          activate: { from: [], to: "expired" },
        },
      });
      expect(diffNounEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "policy: instance id prefix changed from pol to cover",
          "policy: initial lifecycle state changed from quoted to bound",
          "policy: lifecycle state expired was removed or renamed",
          "policy: transition for verb activate changed its target state from active to expired",
          "policy: transition for verb activate no longer fires from state bound",
        ]),
      );
    });

    test("allows only optional noun fields to be added", async () => {
      const previous = await policySnapshot();
      const next = changed(previous, {
        fields: {
          ...previous.fields,
          premiumAmount: {
            ...previous.fields.premiumAmount!,
            schema: { minLength: 2, type: "string" },
          },
          termsSummary: { required: true, schema: { type: "string" } },
          requiredNew: { required: true, schema: { type: "string" } },
        },
      });
      delete (next.fields as Record<string, unknown>).currency;
      expect(diffNounEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "policy: field currency was removed or renamed",
          "policy: field termsSummary became required, tightening the schema",
          "policy: field premiumAmount schema changed; a live field schema is frozen",
          "policy: field requiredNew was added as required, which rejects existing instances (only optional fields are additive)",
        ]),
      );
    });

    test("freezes live verbs, steps, inputs, gates, and execution facets", async () => {
      const previous = await policySnapshot();
      const bind = previous.verbs.bind!;
      const activate = previous.verbs.activate!;
      const next = changed(previous, {
        verbs: {
          ...previous.verbs,
          bind: {
            ...bind,
            decision: { ...record(bind.decision), deadlineMs: 1 },
            eventName: "policy.rebound",
            input: {
              approvalCode: { required: true, schema: { type: "string" } },
            },
            requiresRefs: [{ field: "policyId", statuses: ["active"] }],
            moves: bind.moves.map((move, index) =>
              index === 0 ? { ...move, bind: { changed: true } } : move,
            ),
            setsAt: { field: "expiresAt", offset: "P14D" },
          },
          activate: {
            ...activate,
            deadline: { field: "expiresAt", offset: "P1D" },
            due: { field: "expiresAt" },
            earnable: false,
          },
        },
      });
      delete (next.verbs as Record<string, unknown>).withdraw;
      expect(diffNounEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "policy: verb withdraw was removed or renamed",
          "policy: verb bind changed move transfer at index 0; money movement is frozen once live",
          "policy: verb bind input field approvalCode was added as required, tightening the verb input",
          "policy: verb bind changed its cross-noun gates",
          "policy: verb bind changed its event name",
          "policy: verb bind changed its provider decision",
          "policy: verb bind changed its computed timestamp",
          "policy: verb activate changed its earnable flag",
          "policy: verb activate changed its due condition",
          "policy: verb activate changed its admission deadline",
        ]),
      );
    });

    test("a gate's optional marker is part of its frozen identity", async () => {
      const previous = await policySnapshot();
      const bind = previous.verbs.bind!;
      const gated = (optional: boolean) =>
        changed(previous, {
          verbs: {
            ...previous.verbs,
            bind: {
              ...bind,
              requiresRefs: [
                {
                  field: "policyId",
                  ...(optional ? { optional: true as const } : {}),
                  statuses: ["active"],
                },
              ],
            },
          },
        });
      const violation = "policy: verb bind changed its cross-noun gates";
      expect(diffNounEvolution(gated(false), gated(true))).toEqual(
        expect.arrayContaining([violation]),
      );
      expect(diffNounEvolution(gated(true), gated(false))).toEqual(
        expect.arrayContaining([violation]),
      );
      expect(diffNounEvolution(gated(true), gated(true))).toEqual([]);
    });

    test("freezes the complete admission-gate algebra", async () => {
      const previous = await policySnapshot();
      const bind = previous.verbs.bind!;
      const gate = {
        bind: { policyholderAccountId: "fields.ownerAccountId" },
        field: "policyId",
        match: { "fields.currency": "fields.currency" },
        statuses: ["active"],
        unique: true as const,
      };
      const baseline = changed(previous, {
        verbs: {
          ...previous.verbs,
          bind: {
            ...bind,
            requiresAggregate: [
              {
                check: { kind: "all_in" },
                over: "siblings",
                refField: "policyId",
                statuses: ["active"],
              },
            ],
            requiresDrainedAccount: { path: "refs.escrowAccountId" },
            requiresRefs: [gate],
          },
        },
      });
      const changeBind = (requiresRefs: unknown) =>
        changed(baseline, {
          verbs: {
            ...baseline.verbs,
            bind: { ...baseline.verbs.bind!, requiresRefs },
          },
        });
      const crossNounViolation =
        "policy: verb bind changed its cross-noun gates";
      expect(
        diffNounEvolution(
          baseline,
          changeBind([{ ...gate, bind: { changed: "fields.ownerAccountId" } }]),
        ),
      ).toContain(crossNounViolation);
      expect(
        diffNounEvolution(
          baseline,
          changeBind([{ ...gate, match: { changed: "fields.currency" } }]),
        ),
      ).toContain(crossNounViolation);
      expect(
        diffNounEvolution(
          baseline,
          changeBind([{ ...gate, unique: undefined }]),
        ),
      ).toContain(crossNounViolation);

      const relaxed = changed(baseline, {
        verbs: {
          ...baseline.verbs,
          bind: {
            ...baseline.verbs.bind!,
            requiresAggregate: [],
            requiresDrainedAccount: null,
          },
        },
      });
      expect(diffNounEvolution(baseline, relaxed)).toEqual(
        expect.arrayContaining([
          "policy: verb bind changed its aggregate admission gates",
          "policy: verb bind changed its drained-account gate",
        ]),
      );
    });

    test("freezes parties, aggregates, unwind, subjects, and update permissions", async () => {
      const previous = await policySnapshot();
      const next = changed(previous, {
        aggregateInvariants: [],
        parties: { payer: "insurerAccountId" },
        subjects: [],
        unwind: { ...record(previous.unwind), confirm: "withdraw" },
        updateFields: previous.updateFields.filter(
          (field) => field !== "termsSummary",
        ),
        updateStates: [],
      });
      expect(diffNounEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "policy: party role payer moved from field policyholderAccountId to insurerAccountId",
          "policy: party role beneficiary was removed or renamed",
          expect.stringContaining("policy: aggregate invariant ["),
          "policy: unwind policy changed; the penalty schedule and refund destination are frozen once live",
          "policy: subject kind policy_risk was removed, rejecting linked instances",
          "policy: update policy no longer permits field termsSummary",
          "policy: update policy no longer permits state quoted",
        ]),
      );
    });

    test("freezes a derived amount percentage after the noun becomes live", async () => {
      const snapshot = await policySnapshot();
      const previous = changed(snapshot, {
        derivedAmounts: ["serviceAmount=floor(premiumAmount*250/10000)"],
      });
      const next = changed(previous, {
        derivedAmounts: ["serviceAmount=floor(premiumAmount*9900/10000)"],
      });

      expect(diffNounEvolution(previous, next)).toContain(
        "policy: derived amount rules changed; derived money arithmetic is frozen once live",
      );
    });

    test("freezes every weighted distribution selector after the verb becomes live", async () => {
      const previous = await policySnapshot();
      const bind = previous.verbs.bind!;
      const baseline = changed(previous, {
        verbs: {
          ...previous.verbs,
          bind: {
            ...bind,
            distribute: {
              amountRef: "distributionAmount",
              onZero: "refuse",
              pool: { from: "parent", path: "refs.distributionPool" },
              refField: "policyId",
              statuses: ["eligible"],
              weightField: "weight",
            },
          },
        },
      });
      const violation =
        "policy: verb bind changed its distribution rule; money distribution is frozen once live";
      const changedDistributions = [
        {
          ...record(baseline.verbs.bind!.distribute),
          pool: { from: "parent", path: "refs.replacementPool" },
        },
        {
          ...record(baseline.verbs.bind!.distribute),
          weightField: "replacementWeight",
        },
        {
          ...record(baseline.verbs.bind!.distribute),
          statuses: ["approved"],
        },
      ];

      for (const distribute of changedDistributions) {
        const next = changed(baseline, {
          verbs: {
            ...baseline.verbs,
            bind: { ...baseline.verbs.bind!, distribute },
          },
        });
        expect(diffNounEvolution(baseline, next)).toContain(violation);
      }
    });

    test("rejects an aggregate added to an already-live noun", async () => {
      const previous = await policySnapshot();
      const key =
        "claim.claimAmount within coverageLimit via policyId while approved";
      const next = changed(previous, {
        aggregateInvariants: [...previous.aggregateInvariants, key],
      });
      expect(diffNounEvolution(previous, next)).toContain(
        `policy: aggregate invariant [${key}] was added, which can reject existing instances`,
      );
    });
  });

  function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
});
