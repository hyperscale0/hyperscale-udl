import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  analyzeInstrumentFinance as analyzeInstrumentFinanceRaw,
  deriveUdlActionEffects,
  movementClass,
  openReferenceShapeBudget,
  parseUdl,
  serializeUdl,
  udlClauseVocabulary,
  UdlError,
  validateUdl as validateUdlRaw,
  validateUdlSchemaValue,
  type UdlDocument,
} from "../src/index.js";
import { financeAdmissionProblem } from "../src/finance.js";
import { UDL_LIMITS } from "../src/limits.js";
import {
  diffInstrumentEvolution as diffInstrumentEvolutionRaw,
  diffValidatedUdlEvolution as diffValidatedUdlEvolutionRaw,
  snapshotUdlInstrument,
  type EvolutionActionSnapshot,
  type InstrumentEvolutionSnapshot,
} from "../src/index.js";

const fixtureRoot = join(import.meta.dir, "..", "conformance", "valid");

const compactIssue = <
  T extends {
    readonly code: string;
    readonly message: string;
    readonly path: unknown;
  },
>(
  value: T,
) => ({ code: value.code, message: value.message, path: value.path });

function validateUdl(...args: Parameters<typeof validateUdlRaw>) {
  const result = validateUdlRaw(...args);
  return result.ok
    ? result
    : { ...result, issues: result.issues.map(compactIssue) };
}

function analyzeInstrumentFinance(
  ...args: Parameters<typeof analyzeInstrumentFinanceRaw>
) {
  return analyzeInstrumentFinanceRaw(...args).map(({ message, path }) => ({
    message,
    path,
  }));
}

function diffInstrumentEvolution(
  ...args: Parameters<typeof diffInstrumentEvolutionRaw>
): readonly string[] {
  return diffInstrumentEvolutionRaw(...args).map((entry) => entry.message);
}

function diffValidatedUdlEvolution(
  ...args: Parameters<typeof diffValidatedUdlEvolutionRaw>
): readonly string[] {
  return diffValidatedUdlEvolutionRaw(...args).map((entry) => entry.message);
}

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
    expect(serialized.startsWith('{\n  "instruments":')).toBe(true);
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
    expect(atLimit.issues[0]?.code).toBe("UDL1002");

    const error = capturedError(() =>
      parseUdl(new Uint8Array(UDL_LIMITS.maxSourceBytes + 1)),
    );

    expect(error.issues.map(compactIssue)).toEqual([
      {
        code: "UDL1004",
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
        admitted.issues.every((issue) => issue.code !== "UDL1004"),
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
        code: "UDL1004",
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
        admitted.issues.every((issue) => issue.code !== "UDL1004"),
    ).toBe(true);

    const result = validateUdl(
      Array.from({ length: UDL_LIMITS.maxNodes }, () => null),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues[0]).toEqual({
      code: "UDL1004",
      message: `UDL contains more than ${UDL_LIMITS.maxNodes} values`,
      path: "$",
    });
  });

  test("counts queued children before expanding another container", () => {
    const half = UDL_LIMITS.maxNodes / 2;
    const value: unknown[] = Array.from({ length: half }, () => null);
    value[0] = Array.from({ length: half }, () => null);

    const result = validateUdl(value);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues[0]).toEqual({
      code: "UDL1004",
      message: `UDL contains more than ${UDL_LIMITS.maxNodes} values`,
      path: "$[0]",
    });
  });

  test("counts repeated JSON subtrees independently and rejects only cycles", () => {
    const shared = { value: "same JSON subtree" };
    const aliased = validateUdl({ first: shared, second: shared });
    expect(
      !aliased.ok && aliased.issues.every((issue) => issue.code !== "UDL1004"),
    ).toBe(true);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cycle = validateUdl(cyclic);
    expect(cycle).toEqual({
      issues: [
        {
          code: "UDL1004",
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
          result.issues.every((issue) => issue.code !== "UDL1004"),
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
        (result) => !result.ok && result.issues[0]?.code === "UDL1004",
      ),
    ).toBe(true);
  });

  test("rejects invalid UTF-8 before parsing JSON", () => {
    const invalidUtf8 = Uint8Array.from([0xc3, 0x28]);
    const error = capturedError(() => parseUdl(invalidUtf8));

    expect(error.issues.map(compactIssue)).toEqual([
      {
        code: "UDL1001",
        message: "UDL bytes must be valid UTF-8",
        path: "$",
      },
    ]);
  });

  test("reports malformed JSON separately from grammar failures", () => {
    const error = capturedError(() => parseUdl('{"udl":1'));

    expect(error.issues[0]?.code).toBe("UDL1002");
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
    document.instruments[0]!.fields.hostile = {
      pattern: "^(a+)+$",
      type: "string",
    };
    document.instruments[0]!.fields.extension = {
      oneOf: [{ type: "string" }],
    };
    document.instruments[0]!.fields.tooLong = {
      pattern: `^${"a".repeat(319)}$`,
      type: "string",
    };
    // The two catastrophic-backtracking constructions: ambiguous alternation
    // groups in sequence, and variable-width quantifiers in sequence. Both are
    // a product of branch factors, and both are refused by the same budget.
    document.instruments[0]!.fields.exponentialAlternation = {
      pattern: `^${"(?:a|aa)".repeat(13)}$`,
      type: "string",
    };
    document.instruments[0]!.fields.quantifierProduct = {
      pattern: "^a{0,64}a{0,64}b$",
      type: "string",
    };
    document.instruments[0]!.fields.stackedQuantifier = {
      pattern: "^a{1,2}{1,2}$",
      type: "string",
    };
    document.instruments[0]!.fields.unsupportedFormat = {
      format: "regex",
      type: "string",
    };
    document.instruments[0]!.fields.invalidSyntax = {
      pattern: "^[z-a]$",
      type: "string",
    };
    document.instruments[0]!.fields.malformedEnum = {
      enum: "not-an-array",
      type: "string",
    };
    document.instruments[0]!.fields.malformedItems = {
      items: "not-a-schema",
      type: "array",
    };
    document.instruments[0]!.fields.malformedFeeCollectionPort = {
      type: "string",
      "x-hyperscale-fee-collection-port": false,
    };
    document.instruments[0]!.fields.negativeLength = {
      maxLength: -1,
      type: "string",
    };
    document.instruments[0]!.fields.topLevelAlternation = {
      pattern: "^foo|bar$",
      type: "string",
    };
    document.instruments[0]!.fields.escapedTerminalAnchor = {
      pattern: "^money\\$",
      type: "string",
    };

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          code: "UDL6001",
          message: "JSON Schema pattern may not contain unbounded quantifiers",
          path: "$.instruments[0].fields.hostile.pattern",
        },
        {
          code: "UDL6001",
          message: "JSON Schema keyword oneOf is not in the UDL schema subset",
          path: "$.instruments[0].fields.extension.oneOf",
        },
        {
          code: "UDL6001",
          message: "JSON Schema pattern exceeds 320 characters",
          path: "$.instruments[0].fields.tooLong.pattern",
        },
        {
          code: "UDL6001",
          message: `JSON Schema pattern may branch more than ${UDL_LIMITS.maxPatternPaths} ways`,
          path: "$.instruments[0].fields.exponentialAlternation.pattern",
        },
        {
          code: "UDL6001",
          message: `JSON Schema pattern may branch more than ${UDL_LIMITS.maxPatternPaths} ways`,
          path: "$.instruments[0].fields.quantifierProduct.pattern",
        },
        {
          code: "UDL6001",
          message: "JSON Schema pattern contains an ambiguous quantifier",
          path: "$.instruments[0].fields.stackedQuantifier.pattern",
        },
        {
          code: "UDL6001",
          message: expect.stringContaining(
            "JSON Schema format must be one of hyperscale-date, hyperscale-date-time, hyperscale-email, hyperscale-uri",
          ),
          path: "$.instruments[0].fields.unsupportedFormat.format",
        },
        {
          code: "UDL6001",
          message: "JSON Schema pattern is not valid ECMAScript syntax",
          path: "$.instruments[0].fields.invalidSyntax.pattern",
        },
        {
          code: "UDL6001",
          message: "JSON Schema enum must be a non-empty array",
          path: "$.instruments[0].fields.malformedEnum.enum",
        },
        {
          code: "UDL6001",
          message: "JSON Schema items require an array schema and object value",
          path: "$.instruments[0].fields.malformedItems.items",
        },
        {
          code: "UDL6001",
          message:
            "x-hyperscale-fee-collection-port must be true on a string schema",
          path: '$.instruments[0].fields.malformedFeeCollectionPort["x-hyperscale-fee-collection-port"]',
        },
        {
          code: "UDL6001",
          message:
            "JSON Schema maxLength must be a non-negative integer on the matching schema type",
          path: "$.instruments[0].fields.negativeLength.maxLength",
        },
        {
          code: "UDL6001",
          message:
            "JSON Schema pattern alternation must be enclosed in a group",
          path: "$.instruments[0].fields.topLevelAlternation.pattern",
        },
        {
          code: "UDL6001",
          message:
            "JSON Schema pattern must be explicitly anchored with ^ and $",
          path: "$.instruments[0].fields.escapedTerminalAnchor.pattern",
        },
      ]),
    );
  });

  test("enforces sealed Hyperscale formats without regex fallbacks", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.instruments[0];
    const example = policy?.actions.create?.examples?.[0];
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
    // Any RFC 3339 offset is a valid date-time; the host stores it as UTC.
    example.input.exactTime = "2026-07-23T15:00:00+03:00";
    expect(validateUdl(document).ok).toBe(true);
    example.input.exactTime = "2026-07-23T12:00:00.000Z";

    const invalidValues = [
      ["exactDate", "2026-02-30", "hyperscale-date"],
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
          path: "$.instruments[0].actions.create.examples[0].input",
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
      document.instruments[0]!.fields.retiredFormat = {
        format: retiredFormat,
        type: "string",
      };

      const result = validateUdl(document);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected invalid UDL");
      expect(result.issues).toContainEqual({
        code: "UDL6001",
        message:
          "JSON Schema format must be one of hyperscale-date, hyperscale-date-time, hyperscale-email, hyperscale-uri",
        path: "$.instruments[0].fields.retiredFormat.format",
      });
    }
  });

  test("pins the regex branch budget at N and N+1", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    document.instruments[0]!.fields.patternLengthAtLimit = {
      pattern: `^${"a".repeat(UDL_LIMITS.maxPatternLength - 2)}$`,
      type: "string",
    };
    // 2^12 ways exactly. One more group doubles past the budget.
    document.instruments[0]!.fields.branchesAtLimit = {
      pattern: `^${"(?:a|b)".repeat(12)}$`,
      type: "string",
    };
    // Fixed-width quantifiers never branch, so any number of them is admitted.
    document.instruments[0]!.fields.fixedQuantifiers = {
      pattern: `^${"a{1}".repeat(64)}$`,
      type: "string",
    };
    document.instruments[0]!.fields.variableWidthAtLimit = {
      pattern: `^a{0,${UDL_LIMITS.maxStringLength}}$`,
      type: "string",
    };
    expect(validateUdl(document).ok).toBe(true);

    document.instruments[0]!.fields.branchesOverLimit = {
      pattern: `^${"(?:a|b)".repeat(13)}$`,
      type: "string",
    };
    document.instruments[0]!.fields.variableWidthOverLimit = {
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
          path: "$.instruments[0].fields.branchesOverLimit.pattern",
        }),
        expect.objectContaining({
          message: `JSON Schema pattern quantifier upper bound must not exceed ${UDL_LIMITS.maxStringLength}`,
          path: "$.instruments[0].fields.variableWidthOverLimit.pattern",
        }),
      ]),
    );
  });

  test("refuses the backtracking bomb before any value is matched against it", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.instruments[0];
    const example = policy?.actions.create?.examples?.[0];
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
      code: "UDL6001",
      message: `JSON Schema pattern may branch more than ${UDL_LIMITS.maxPatternPaths} ways`,
      path: "$.instruments[0].fields.bomb.pattern",
    });
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("classifies references without the catalogue exhausting the safety budget", async () => {
    expect(UDL_LIMITS.maxSchemaProbes).toBe(131_072);
    const widened = async (
      gateField: (index: number) => string,
    ): Promise<ReturnType<typeof validateUdl>> => {
      const document = structuredClone(await parsedFixture("protection.udl"));
      const policy = document.instruments[0];
      if (!policy) throw new Error("policy instrument missing");
      for (let index = 0; index < 46; index += 1) {
        document.instruments.push({
          actionOrder: ["create"],
          description: `Filler instrument ${index}.`,
          fields: {},
          id: `filler_${index}`,
          idPrefix: `f${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
          lifecycle: { initial: "open", states: ["open"], transitions: {} },
          required: [],
          summary: "Filler",
          title: `Filler ${index}`,
          actions: {
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
        policy.actions[`gate_action_${index}`] = {
          description: "Gate action.",
          moves: [],
          requiresRefs: [{ field: gateField(index), statuses: ["filed"] }],
          steps: [],
          summary: "Gate",
        };
      }
      return validateUdl(document);
    };

    const overBudget = {
      code: "UDL1004" as const,
      message: `document exceeds ${UDL_LIMITS.maxSchemaProbes} reference-shape checks; declare fewer instruments, reference gates, or payout intents`,
      path: "$.instruments",
    };

    // 46 gates on ONE field over 46 instruments is one answer per instrument, not per gate.
    const sharedField = await widened(() => "sharedGateId");
    expect(sharedField.ok).toBe(false);
    if (sharedField.ok) throw new Error("expected invalid UDL");
    expect(sharedField.issues).not.toContainEqual(overBudget);

    // The former 2116-pair refusal now fits, with room for company instruments.
    const distinctFields = await widened((index) => `gate${index}Id`);
    expect(distinctFields.ok).toBe(false);
    if (distinctFields.ok) throw new Error("expected invalid UDL");
    expect(distinctFields.issues).not.toContainEqual(overBudget);
    const budget = openReferenceShapeBudget();
    for (let i = 0; i < UDL_LIMITS.maxSchemaProbes; i++) {
      expect(
        budget.accepts(
          { type: "string", pattern: "^clm_(sandbox|live)_[a-z0-9]{8,64}$" },
          "clm",
        ),
      ).toBe(true);
    }
    expect(budget.exhausted).toBe(false);
    expect(
      budget.accepts(
        { type: "string", pattern: "^clm_(sandbox|live)_[a-z0-9]{8,64}$" },
        "clm",
      ),
    ).toBe(false);
    expect(budget.exhausted).toBe(true);
  });

  test("requires one create action and a transition for every other action", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    delete document.instruments[0]?.actions.create;
    delete document.instruments[0]?.lifecycle.transitions.expire;
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual({
      code: "UDL3001",
      message: "every instrument must declare the create action",
      path: "$.instruments[0].actions",
    });
    expect(result.issues).toContainEqual({
      code: "UDL3001",
      message: "action expire must declare a lifecycle transition",
      path: "$.instruments[0].actions.expire",
    });
  });

  test("checks lifecycle states and cross-instrument gates", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const listing = document.instruments.find(
      (instrument) => instrument.id === "listing",
    );
    if (!listing) throw new Error("listing fixture missing");
    listing.lifecycle.transitions.sell!.to = "missing";
    listing.actions.sell!.requiresRefs![0]!.statuses = ["missing"];
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.instruments[0].lifecycle.transitions.sell.to",
        "$.instruments[0].actions.sell.requiresRefs[0].statuses[0]",
      ]),
    );
  });

  test("optional opts out only over optional references and optional bind targets", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    if (!escrow) throw new Error("escrow_order fixture missing");
    const instrumentIndex = document.instruments.indexOf(escrow);
    escrow.actions.create!.requiresRefs![0]!.optional = true;
    escrow.actions.fund!.requiresRefs![0]!.optional = true;

    const held = validateUdl(document);
    expect(held.ok).toBe(false);
    if (held.ok) throw new Error("expected invalid UDL");
    expect(held.issues).toContainEqual({
      code: "UDL5001",
      message:
        "optional declares an opt-out on listingId, which required lists",
      path: `$.instruments[${instrumentIndex}].actions.fund.requiresRefs[0].optional`,
    });
    expect(held.issues).toContainEqual({
      code: "UDL5001",
      message:
        "an optional reference can only bind optional fields; required lists amount",
      path: `$.instruments[${instrumentIndex}].actions.create.requiresRefs[0].bind.amount`,
    });

    delete escrow.actions.create!.requiresRefs![0]!.optional;
    escrow.required = escrow.required.filter((field) => field !== "listingId");
    expect(validateUdl(document).ok).toBe(true);

    // Optional is a runtime opt-out, never permission to omit the target kind.
    document.instruments = document.instruments.filter(
      (instrument) => instrument.id !== "listing",
    );
    const missingTarget = validateUdl(document);
    expect(missingTarget.ok).toBe(false);
    if (missingTarget.ok)
      throw new Error("expected a closed-document reference refusal");
    expect(missingTarget.issues).toContainEqual({
      code: "UDL5001",
      message:
        "gate field listingId must identify exactly one instrument (found 0)",
      path: `$.instruments[${document.instruments.indexOf(escrow)}].actions.fund.requiresRefs[0].field`,
    });
  });

  test("checks deadline fields, offsets, and exclusion with due", async () => {
    const document = structuredClone(await parsedFixture("insured-travel.udl"));
    const flight = document.instruments.find(
      (instrument) => instrument.id === "flight_booking",
    );
    if (!flight?.actions.confirm?.deadline) {
      throw new Error("flight_booking confirm fixture missing deadline");
    }
    flight.actions.confirm.deadline.field = "missingField";
    flight.actions.confirm.deadline.offset = "P1M";
    // A due action also declaring a deadline would race itself: one facet fires
    // AT the moment, the other refuses AFTER it.
    flight.actions.expire!.deadline = { field: "holdExpiresAt" };
    flight.actions.expire!.due!.offset = "P1Y";
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const instrumentIndex = document.instruments.indexOf(flight);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        `$.instruments[${instrumentIndex}].actions.confirm.deadline.field`,
        `$.instruments[${instrumentIndex}].actions.confirm.deadline.offset`,
        `$.instruments[${instrumentIndex}].actions.expire.deadline`,
        `$.instruments[${instrumentIndex}].actions.expire.due.offset`,
      ]),
    );
    expect(result.issues).toContainEqual({
      code: "UDL3001",
      message: "a action cannot declare both a due condition and a deadline",
      path: `$.instruments[${instrumentIndex}].actions.expire.deadline`,
    });
  });

  test("requires a due action to leave every source state", async () => {
    const document = structuredClone(await parsedFixture("insured-travel.udl"));
    const flight = document.instruments.find(
      (instrument) => instrument.id === "flight_booking",
    );
    const transition = flight?.lifecycle.transitions.expire;
    if (!flight?.actions.expire?.due || !transition) {
      throw new Error("flight_booking expire fixture missing due transition");
    }
    transition.to = transition.from[0]!;

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const instrumentIndex = document.instruments.indexOf(flight);
    expect(result.issues).toContainEqual({
      code: "UDL3001",
      message:
        "a due action must leave every source state so the maintenance loop fires its anchor exactly once",
      path: `$.instruments[${instrumentIndex}].actions.expire.due`,
    });
  });

  test("keeps public action distinct from action identity and private on due actions", async () => {
    const document = structuredClone(await parsedFixture("cards.udl"));
    const authorization = document.instruments.find(
      (instrument) => instrument.id === "card_authorization",
    );
    if (!authorization?.actions.approve || !authorization.actions.expire?.due) {
      throw new Error("card authorization public-action fixture missing");
    }
    authorization.actions.approve.publicAction = "approveCardPayment";
    expect(validateUdl(document).ok).toBe(true);
    expect(authorization.lifecycle.transitions.approve).toBeDefined();

    authorization.actions.expire.publicAction = "expireCardPayment";
    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const instrumentIndex = document.instruments.indexOf(authorization);
    expect(result.issues).toContainEqual({
      code: "UDL3001",
      message: "a system due action cannot declare a public action",
      path: `$.instruments[${instrumentIndex}].actions.expire.publicAction`,
    });
  });

  test("requires computed time anchors to be immutable, positive, and dominant", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.instruments.find(
      (instrument) => instrument.id === "policy",
    );
    if (!policy?.actions.bind || !policy.actions.activate?.due) {
      throw new Error("policy timing fixture missing");
    }
    const instrumentIndex = document.instruments.indexOf(policy);
    policy.fields.activationAt = {
      format: "hyperscale-date-time",
      type: "string",
    };
    policy.actions.bind.setsAt = { field: "activationAt", offset: "PT1H" };
    policy.actions.activate.due.field = "activationAt";

    expect(validateUdl(document).ok).toBe(true);

    const createExample = policy.actions.create?.examples?.[0];
    if (!createExample) throw new Error("policy create example missing");
    createExample.input.activationAt = "2026-07-23T12:00:00.000Z";
    const callerAuthoredAnchor = validateUdl(document);
    expect(callerAuthoredAnchor.ok).toBe(false);
    if (callerAuthoredAnchor.ok) throw new Error("expected invalid UDL");
    expect(callerAuthoredAnchor.issues).toContainEqual(
      expect.objectContaining({
        path: `$.instruments[${instrumentIndex}].actions.create.examples[0].input`,
      }),
    );
    delete createExample.input.activationAt;

    policy.required.push("activationAt");
    policy.update = { fields: ["activationAt"], states: ["quoted"] };
    policy.actions.bind.setsAt.offset = "PT0S";
    policy.actions.preview!.setsAt = {
      field: "activationAt",
      offset: "PT30M",
    };
    policy.actions.create!.setsAt = {
      field: "activationAt",
      offset: "PT15M",
    };
    policy.lifecycle.transitions.bypass = {
      from: ["quoted"],
      to: "bound",
    };
    policy.actions.bypass = {
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
          code: "UDL3001",
          message: "setsAt target must be optional at create",
          path: `$.instruments[${instrumentIndex}].actions.bind.setsAt.field`,
        },
        {
          code: "UDL3001",
          message: "setsAt target cannot also be mutable",
          path: `$.instruments[${instrumentIndex}].actions.bind.setsAt.field`,
        },
        {
          code: "UDL3001",
          message: "setsAt.offset must be a positive fixed ISO-8601 duration",
          path: `$.instruments[${instrumentIndex}].actions.bind.setsAt.offset`,
        },
        {
          code: "UDL3001",
          message:
            "action activate can read activationAt before writers bind or create or preview",
          path: `$.instruments[${instrumentIndex}].actions.activate`,
        },
        {
          code: "UDL3001",
          message:
            "activationAt has multiple writers without one shared one-way destination",
          path: `$.instruments[${instrumentIndex}].actions.preview.setsAt.field`,
        },
        {
          code: "UDL3001",
          message:
            "setsAt requires a lifecycle transition and cannot run on create",
          path: `$.instruments[${instrumentIndex}].actions.create.setsAt`,
        },
      ]),
    );
  });

  test("freeze steps take an instance-held account and no monetary legs", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const listing = document.instruments.find(
      (instrument) => instrument.id === "listing",
    );
    if (!listing?.actions.reserve) throw new Error("listing fixture missing");
    listing.actions.reserve.steps = [
      {
        operation: "account.freeze",
        bind: {
          accountId: { from: "const", value: "acct_live_0000000000000000" },
          amount: { from: "const", value: "100" },
          reason: { from: "const", value: "Frozen by action" },
        },
      },
    ];
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const instrumentIndex = document.instruments.indexOf(listing);
    expect(result.issues).toContainEqual({
      code: "UDL5008",
      message: "account.freeze must bind accountId from an instance path",
      path: `$.instruments[${instrumentIndex}].actions.reserve.steps[0].bind.accountId`,
    });
    expect(result.issues).toContainEqual({
      code: "UDL5008",
      message: "account.freeze must not bind amount",
      path: `$.instruments[${instrumentIndex}].actions.reserve.steps[0].bind.amount`,
    });
  });

  test("rejects earnable on both halves of a quote-commit pair", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    if (!escrow?.actions.quote?.quote) {
      throw new Error("escrow_order fixture missing quote");
    }
    // The release action is legitimately earnable; the committing action
    // (refund) moves money BACK and must never fund a product earn rate.
    escrow.actions.refund!.earnable = true;
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    const instrumentIndex = document.instruments.indexOf(escrow);
    expect(result.issues).toEqual([
      {
        code: "UDL5006",
        message:
          "commit action refund spends a quoted refund and cannot be earnable",
        path: `$.instruments[${instrumentIndex}].actions.refund.earnable`,
      },
    ]);

    // The quoting half prices that same refund, so it is barred too.
    delete escrow.actions.refund!.earnable;
    escrow.actions.quote.earnable = true;
    const quoting = validateUdl(document);
    expect(quoting.ok).toBe(false);
    if (quoting.ok) throw new Error("expected invalid UDL");
    expect(quoting.issues).toContainEqual({
      code: "UDL5006",
      message: "quoting action quote prices a refund and cannot be earnable",
      path: `$.instruments[${instrumentIndex}].actions.quote.earnable`,
    });
  });

  test("refuses a freeze set missing the base or the net destination", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const quote = escrow?.actions.quote?.quote;
    if (!escrow || !quote) {
      throw new Error("escrow_order fixture missing quote");
    }
    const instrumentIndex = document.instruments.indexOf(escrow);

    quote.fixes = ["buyerAccountId"];
    const withoutBase = validateUdl(document);
    expect(withoutBase.ok).toBe(false);
    if (withoutBase.ok) throw new Error("expected invalid UDL");
    expect(withoutBase.issues).toContainEqual({
      code: "UDL5006",
      message: "quoting action quote must freeze its base field amount",
      path: `$.instruments[${instrumentIndex}].actions.quote.quote.baseField`,
    });

    quote.fixes = ["amount"];
    const withoutDestination = validateUdl(document);
    expect(withoutDestination.ok).toBe(false);
    if (withoutDestination.ok) throw new Error("expected invalid UDL");
    expect(withoutDestination.issues).toContainEqual({
      code: "UDL5006",
      message:
        "quoting action quote must freeze its net destination field buyerAccountId",
      path: `$.instruments[${instrumentIndex}].actions.quote.quote.netDestinationField`,
    });

    quote.fixes = ["amount", "buyerAccountId"];
    expect(validateUdl(document).ok).toBe(true);
  });

  test("refuses a quoting action that writes a field it froze", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const quoting = escrow?.actions.quote;
    if (!escrow || !quoting?.quote) {
      throw new Error("escrow_order fixture missing quote");
    }
    const instrumentIndex = document.instruments.indexOf(escrow);

    // `memo` is already an updatable field on this instrument, so the only new
    // fact is that the quote froze it.
    quoting.updates = ["memo"];
    quoting.quote.fixes = [...quoting.quote.fixes, "memo"];
    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual({
      code: "UDL5006",
      message:
        "quoting action quote freezes memo and writes it in the same action",
      path: `$.instruments[${instrumentIndex}].actions.quote.updates`,
    });
  });

  test("refuses a charge ref that collides with the offer's own refs", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const quote = escrow?.actions.quote?.quote;
    if (!escrow || !quote) {
      throw new Error("escrow_order fixture missing quote");
    }
    const instrumentIndex = document.instruments.indexOf(escrow);

    // The machinery seeds `<netRef>Frozen` and `<netRef>ExpiresAt`. An author
    // who names the charge either one would have the fingerprint overwrite the
    // penalty, and core would seed four keys where the grammar counted two.
    quote.chargeRef = `${quote.netRef}Frozen`;
    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual({
      code: "UDL5006",
      message:
        "quote ref unwindRefundFrozen is seeded twice: quote charge and quote frozen fingerprint",
      path: `$.instruments[${instrumentIndex}].actions.quote.quote.netRef`,
    });
  });

  test("requires a stored date-time anchor for before-relative charges", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const quote = escrow?.actions.quote?.quote;
    if (!escrow || !quote)
      throw new Error("escrow_order fixture missing quote");
    const instrumentIndex = document.instruments.indexOf(escrow);
    const anchorPath = `$.instruments[${instrumentIndex}].actions.quote.quote.anchorField`;

    quote.anchorField = "fundBy";
    escrow.required.push("fundBy");
    // A required fundBy makes the existing due action an unconditional exit
    // from created, so the contract no longer permits a caller-parked marker.
    if (escrow.callerParkedStates) {
      delete escrow.callerParkedStates.created;
    }
    expect(validateUdl(document).ok).toBe(true);

    escrow.required = escrow.required.filter((field) => field !== "fundBy");
    const optional = validateUdl(document);
    expect(optional.ok).toBe(false);
    if (optional.ok) throw new Error("expected invalid UDL");
    expect(optional.issues).toContainEqual({
      code: "UDL5006",
      message: "anchorField must be required",
      path: anchorPath,
    });

    escrow.required.push("fundBy");
    quote.anchorField = "amount";
    const money = validateUdl(document);
    expect(money.ok).toBe(false);
    if (money.ok) throw new Error("expected invalid UDL");
    expect(money.issues).toContainEqual({
      code: "UDL5006",
      message: "anchorField must be a date-time field",
      path: anchorPath,
    });
  });

  test("holds the offer to a fixed life and one committing action", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const quote = escrow?.actions.quote?.quote;
    if (!escrow || !quote)
      throw new Error("escrow_order fixture missing quote");
    const instrumentIndex = document.instruments.indexOf(escrow);
    const quoteBase = `$.instruments[${instrumentIndex}].actions.quote.quote`;

    // A month is not a fixed number of milliseconds, so an offer priced
    // against it has no computable deadline.
    quote.expires = { offset: "P1M" };
    const calendar = validateUdl(document);
    expect(calendar.ok).toBe(false);
    if (calendar.ok) throw new Error("expected invalid UDL");
    expect(calendar.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("fixed ISO-8601 duration"),
        path: `${quoteBase}.expires.offset`,
      }),
    );

    // A stored deadline is the other admitted form, and it has to be a
    // date-time the caller always supplies.
    quote.expires = { field: "fundBy" };
    const optionalDeadline = validateUdl(document);
    expect(optionalDeadline.ok).toBe(false);
    if (optionalDeadline.ok) throw new Error("expected invalid UDL");
    expect(optionalDeadline.issues).toContainEqual({
      code: "UDL5006",
      message: "the offer's deadline field must be required",
      path: `${quoteBase}.expires.field`,
    });

    escrow.required.push("fundBy");
    if (escrow.callerParkedStates) delete escrow.callerParkedStates.created;
    expect(validateUdl(document).ok).toBe(true);

    // Two spenders would let the same offer be consumed twice.
    escrow.lifecycle.transitions.refund_again = {
      from: ["refund_quoted"],
      to: "refunded",
    };
    escrow.actions.refund_again = structuredClone(escrow.actions.refund!);
    escrow.actionOrder.splice(
      escrow.actionOrder.indexOf("refund") + 1,
      0,
      "refund_again",
    );
    const twoCommits = validateUdl(document);
    expect(twoCommits.ok).toBe(false);
    if (twoCommits.ok) throw new Error("expected invalid UDL");
    expect(twoCommits.issues).toContainEqual(
      expect.objectContaining({
        message:
          "quoting action quote must be committed by exactly one action, not 2",
        path: quoteBase,
      }),
    );
  });

  test("validates retained charge quotes against parties, fixes, and refund source", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.instruments.find(
      (instrument) => instrument.id === "policy",
    );
    if (!policy) throw new Error("protection fixture missing policy");
    const instrumentIndex = document.instruments.indexOf(policy);

    policy.lifecycle.states.push("refund_quoted");
    policy.lifecycle.transitions.quote_refund = {
      from: ["active"],
      to: "refund_quoted",
    };
    policy.lifecycle.transitions.confirm_refund = {
      from: ["refund_quoted"],
      to: "canceled",
    };
    policy.callerParkedStates = {
      ...policy.callerParkedStates,
      refund_quoted: "decision",
    };
    policy.actions.quote_refund = {
      summary: "Quote active policy refund",
      steps: [],
      moves: [],
      quote: {
        baseField: "premiumAmount",
        chargeRef: "activeUnwindPenalty",
        chargeRetainedBy: "beneficiary",
        charges: [{ bps: 0 }],
        expires: { offset: "PT15M" },
        fixes: ["insurerAccountId", "policyholderAccountId", "premiumAmount"],
        netDestinationField: "policyholderAccountId",
        netRef: "policyRefund",
      },
    };
    policy.actions.confirm_refund = {
      summary: "Confirm active policy refund",
      commit: "quote_refund",
      steps: [],
      moves: [
        {
          key: "transfer",
          operation: "internal_transfer.create",
          bind: {
            amount: { from: "instance", path: "refs.policyRefund" },
            currency: { from: "instance", path: "fields.currency" },
            destinationAccountId: {
              from: "instance",
              path: "fields.policyholderAccountId",
            },
            productId: { from: "instance", path: "productId" },
            sourceAccountId: {
              from: "instance",
              path: "fields.insurerAccountId",
            },
          },
        },
      ],
      requiresDrainedAccount: { path: "refs.premiumReserveAccountId" },
    };
    policy.actionOrder.push("quote_refund", "confirm_refund");

    expect(validateUdl(document).ok).toBe(true);

    // Undeclared role rejection:
    const undeclaredRoleDoc = structuredClone(document);
    const undeclaredPolicy = undeclaredRoleDoc.instruments[instrumentIndex]!;
    undeclaredPolicy.actions.quote_refund!.quote!.chargeRetainedBy =
      "subjectHolder";
    const undeclaredResult = validateUdl(undeclaredRoleDoc);
    expect(undeclaredResult.ok).toBe(false);
    if (undeclaredResult.ok) throw new Error("expected invalid UDL");
    expect(undeclaredResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "quoting action quote_refund retains charge by undeclared party role subjectHolder",
      }),
    );

    // Unfrozen party field rejection:
    const unfrozenDoc = structuredClone(document);
    const unfrozenPolicy = unfrozenDoc.instruments[instrumentIndex]!;
    unfrozenPolicy.actions.quote_refund!.quote!.fixes =
      unfrozenPolicy.actions.quote_refund!.quote!.fixes.filter(
        (field) => field !== "insurerAccountId",
      );
    const unfrozenResult = validateUdl(unfrozenDoc);
    expect(unfrozenResult.ok).toBe(false);
    if (unfrozenResult.ok) throw new Error("expected invalid UDL");
    expect(unfrozenResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "quoting action quote_refund must freeze its charge-retaining party field insurerAccountId",
      }),
    );

    // Wrong refund source (product escrow ref) rejection:
    const wrongSourceDoc = structuredClone(document);
    const wrongSourcePolicy = wrongSourceDoc.instruments[instrumentIndex]!;
    wrongSourcePolicy.actions.confirm_refund!.moves[0]!.bind.sourceAccountId = {
      from: "instance",
      path: "refs.premiumReserveAccountId",
    };
    const wrongSourceResult = validateUdl(wrongSourceDoc);
    expect(wrongSourceResult.ok).toBe(false);
    if (wrongSourceResult.ok) throw new Error("expected invalid UDL");
    expect(wrongSourceResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "commit action confirm_refund refund source cannot be a product escrow ref for a retained quote",
      }),
    );

    // Consuming retained charge ref rejection:
    const consumerDoc = structuredClone(document);
    const consumerPolicy = consumerDoc.instruments[instrumentIndex]!;
    consumerPolicy.actions.claim_fee = {
      moves: [
        {
          bind: {
            amount: { from: "instance", path: "refs.activeUnwindPenalty" },
            destinationAccountId: {
              from: "instance",
              path: "fields.insurerAccountId",
            },
            sourceAccountId: {
              from: "instance",
              path: "fields.insurerAccountId",
            },
          },
          key: "penalty_fee",
          operation: "internal_transfer.create",
        },
      ],
      steps: [],
      summary: "Consume retained penalty",
    };
    consumerPolicy.actionOrder.push("claim_fee");
    const consumerResult = validateUdl(consumerDoc);
    expect(consumerResult.ok).toBe(false);
    if (consumerResult.ok) throw new Error("expected invalid UDL");
    expect(consumerResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "charge refs.activeUnwindPenalty is retained by beneficiary and cannot be consumed by an action",
      }),
    );
  });

  test("rejects check kinds without a tenant-gateable evidence profile", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    if (!escrow) throw new Error("escrow_order fixture missing");
    const instrumentIndex = document.instruments.indexOf(escrow);

    escrow.actions.create!.requiresChecks = [
      {
        checkKind: "identity_verification",
        family: "national_identity",
        statuses: ["completed"],
        subjectField: "listingId",
      },
    ];
    Object.assign(escrow.actions.create!.requiresChecks[0]!, {
      checkKind: "made_up",
    });

    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual({
      code: "UDL1003",
      message: "Invalid input",
      path: `$.instruments[${instrumentIndex}].actions.create.requiresChecks[0]`,
    });
  });

  test("rejects statuses outside the check evidence profile", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    if (!escrow) throw new Error("escrow_order fixture missing");
    const instrumentIndex = document.instruments.indexOf(escrow);

    escrow.actions.create!.requiresChecks = [
      {
        checkKind: "identity_verification",
        family: "national_identity",
        statuses: ["completed"],
        subjectField: "listingId",
      },
    ];
    Object.assign(escrow.actions.create!.requiresChecks[0]!, {
      statuses: ["made_up"],
    });

    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual({
      code: "UDL1003",
      message: "Invalid input",
      path: `$.instruments[${instrumentIndex}].actions.create.requiresChecks[0]`,
    });
  });

  test("rejects unfixed charge windows and unfunded refund bases", async () => {
    const calendarDocument = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const calendarEscrow = calendarDocument.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const calendarQuote = calendarEscrow?.actions.quote?.quote;
    if (!calendarQuote) {
      throw new Error("escrow_order fixture missing quote");
    }
    calendarQuote.charges = [{ bps: 2500, withinOffset: "P1M" }];
    const calendar = validateUdl(calendarDocument);
    expect(calendar.ok).toBe(false);
    if (calendar.ok) throw new Error("expected invalid UDL");
    expect(calendar.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("fixed ISO-8601 duration"),
        path: expect.stringContaining("quote.charges[0].withinOffset"),
      }),
    );

    const unfundedDocument = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const unfundedEscrow = unfundedDocument.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    if (!unfundedEscrow?.actions.quote?.quote || !unfundedEscrow.actions.fund) {
      throw new Error("escrow_order funding fixture missing");
    }
    unfundedEscrow.actions.fund.moves = [];
    const unfunded = validateUdl(unfundedDocument);
    expect(unfunded.ok).toBe(false);
    if (unfunded.ok) throw new Error("expected invalid UDL");
    expect(unfunded.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "cannot refund fields.amount from refs.escrowAccountId",
        ),
        path: expect.stringContaining("actions.refund.moves[0]"),
      }),
    );

    const misplacedSourceDocument = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const misplacedSourceEscrow = misplacedSourceDocument.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const committing = Object.values(misplacedSourceEscrow?.actions ?? {}).find(
      (action) => action.commit,
    );
    if (!committing) {
      throw new Error("escrow_order quote-commit fixture missing");
    }
    const confirm = committing;
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
        message: expect.stringContaining(
          "source comes from the instrument instance",
        ),
        path: expect.stringContaining("actions.refund.moves"),
      }),
    );
  });

  test("rejects lifecycle states unreachable from create", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const claim = document.instruments.find(
      (instrument) => instrument.id === "claim",
    );
    if (!claim) throw new Error("claim fixture missing");
    claim.lifecycle.transitions.assess!.from = ["paid"];
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "lifecycle state assessed is unreachable from filed",
          path: "$.instruments[1].lifecycle.states[1]",
        }),
      ]),
    );
  });

  test("rejects a instrument-owned account debit reachable before funding", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const release = escrow?.actions.release?.moves[0];
    if (!escrow?.actions.cancel || !release) {
      throw new Error("escrow_order cancel or release fixture missing");
    }
    escrow.actions.cancel.moves = [
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
    const instrumentIndex = document.instruments.indexOf(escrow);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "UDL4001",
        message: "action cancel can debit unfunded refs.escrowAccountId",
        path: `$.instruments[${instrumentIndex}].actions.cancel.moves[0].bind.sourceAccountId`,
      }),
    );
  });

  test("rejects an escrow debit when one lifecycle path bypasses funding", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    if (!escrow) throw new Error("escrow_order fixture missing");
    escrow.lifecycle.transitions.skip_fund = {
      from: ["created"],
      to: "funded",
    };
    escrow.actions.skip_fund = {
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
          "action release can debit unfunded refs.escrowAccountId",
        ),
        path: expect.stringContaining(
          "actions.release.moves[0].bind.sourceAccountId",
        ),
      }),
    );
  });

  test("consumes escrow funding after a debit", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const release = escrow?.actions.release;
    if (!escrow || !release) throw new Error("escrow_order release missing");
    escrow.lifecycle.states.push("released_again");
    escrow.lifecycle.transitions.release_again = {
      from: ["released"],
      to: "released_again",
    };
    escrow.actions.release_again = structuredClone(release);

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "action release_again can debit unfunded refs.escrowAccountId",
        ),
        path: expect.stringContaining(
          "actions.release_again.moves[0].bind.sourceAccountId",
        ),
      }),
    );
  });

  test("rejects terminal paths that strand escrow value", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const release = escrow?.actions.release;
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
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    if (!escrow) throw new Error("escrow_order fixture missing");
    escrow.lifecycle.states.push("drained");
    escrow.lifecycle.transitions.drain = {
      from: ["penalty_collected"],
      to: "drained",
    };
    escrow.actions.drain = {
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
          "action drain can debit unfunded refs.escrowAccountId",
        ),
        path: expect.stringContaining(
          "actions.drain.moves[0].bind.sourceAccountId",
        ),
      }),
    );
  });

  test("accepts partitioned escrow funding drained piece by piece on every exit", () => {
    const issues = analyzeInstrumentFinance(partitionedEscrowInstrument());

    expect(issues).toEqual([]);
  });

  test("rejects a partitioned escrow exit that strands one funded piece", () => {
    const instrument = partitionedEscrowInstrument();
    const actions = { ...instrument.actions };
    delete (actions as Record<string, unknown>).keep_piece_b;
    const transitions = { ...instrument.lifecycle.transitions };
    delete (transitions as Record<string, unknown>).keep_piece_b;
    transitions.refund_piece_a = { from: ["cancel_started"], to: "canceled" };

    const issues = analyzeInstrumentFinance({
      ...instrument,
      lifecycle: { ...instrument.lifecycle, transitions },
      actions,
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
    const issues = analyzeInstrumentFinance(twoAccountBranchingInstrument(7));

    expect(issues).toContainEqual({
      message: "financial analysis exceeds 256 distinct path variants",
      path: ["lifecycle"],
    });
  });

  test("rejects financial graphs over the lifecycle-state budget", () => {
    const instrument = minimalFinancialInstrument();
    const issues = analyzeInstrumentFinance({
      ...instrument,
      lifecycle: {
        ...instrument.lifecycle,
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

  test("charges every financial effect to one instrument-wide work budget", () => {
    const issues = analyzeInstrumentFinance(twoAccountWorkBudgetInstrument());

    expect(issues).toContainEqual({
      message: "financial analysis exceeds 4096 deterministic work units",
      path: ["lifecycle"],
    });
  });

  test("pins every static finance graph budget at N and N+1", () => {
    const base = minimalFinancialInstrument();
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
                  `action_${index}`,
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
                  `action_${index}`,
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
          actions: Object.fromEntries(
            Array.from({ length: UDL_LIMITS.financeActions }, (_, index) => [
              `action_${index}`,
              { steps: [] },
            ]),
          ),
        },
        over: {
          ...base,
          actions: Object.fromEntries(
            Array.from(
              { length: UDL_LIMITS.financeActions + 1 },
              (_, index) => [`action_${index}`, { steps: [] }],
            ),
          ),
        },
        message: `financial analysis exceeds ${UDL_LIMITS.financeActions} actions`,
      },
      {
        exact: {
          ...base,
          actions: {
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
          actions: {
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
      analyzeInstrumentFinance(
        trackedAccountsInstrument(UDL_LIMITS.financeAccounts),
      ).some((issue) => issue.message.includes("tracked accounts")),
    ).toBe(false);
    expect(
      analyzeInstrumentFinance(
        trackedAccountsInstrument(UDL_LIMITS.financeAccounts + 1),
      ),
    ).toContainEqual({
      message: `financial analysis exceeds ${UDL_LIMITS.financeAccounts} tracked accounts`,
      path: ["actions"],
    });
  });

  test("analyzeInstrumentFinance validates retained quotes and prevents escaping through early return", () => {
    // The insurer holds exactly the premium before the refund, so the
    // conservation walk keeps proving the refund source even though the
    // charge is retained rather than paid out.
    const validRetained = {
      lifecycle: {
        initial: "bound",
        states: ["bound", "active", "refund_quoted", "canceled"],
        transitions: {
          activate: { from: ["bound"], to: "active" },
          quote_refund: { from: ["active"], to: "refund_quoted" },
          confirm_refund: { from: ["refund_quoted"], to: "canceled" },
        },
      },
      parties: {
        beneficiary: "insurerAccountId",
        payer: "policyholderAccountId",
      },
      actions: {
        activate: {
          moves: [
            {
              key: "premium",
              operation: "internal_transfer.create",
              bind: {
                amount: { from: "instance" as const, path: "fields.premium" },
                destinationAccountId: {
                  from: "instance" as const,
                  path: "fields.insurerAccountId",
                },
                sourceAccountId: {
                  from: "instance" as const,
                  path: "fields.policyholderAccountId",
                },
              },
            },
          ],
          steps: [],
        },
        quote_refund: {
          quote: {
            baseField: "premium",
            chargeRef: "penalty",
            chargeRetainedBy: "beneficiary" as const,
            charges: [{ bps: 1000 }],
            netRef: "refund",
          },
          steps: [],
        },
        confirm_refund: {
          commit: "quote_refund",
          moves: [
            {
              key: "refund",
              operation: "internal_transfer.create",
              bind: {
                amount: { from: "instance" as const, path: "refs.refund" },
                destinationAccountId: {
                  from: "instance" as const,
                  path: "fields.policyholderAccountId",
                },
                sourceAccountId: {
                  from: "instance" as const,
                  path: "fields.insurerAccountId",
                },
              },
            },
          ],
          steps: [],
        },
      },
    };

    const validIssues = analyzeInstrumentFinance(validRetained);
    expect(validIssues).toEqual([]);

    // A retained charge does not exempt the refund source from the walk:
    const { activate: _unfunded, ...unfundedActions } = validRetained.actions;
    expect(
      analyzeInstrumentFinance({
        ...validRetained,
        lifecycle: {
          ...validRetained.lifecycle,
          initial: "active",
          transitions: {
            quote_refund: validRetained.lifecycle.transitions.quote_refund,
            confirm_refund: validRetained.lifecycle.transitions.confirm_refund,
          },
        },
        actions: unfundedActions,
      }),
    ).toContainEqual(
      expect.objectContaining({
        message:
          "action confirm_refund cannot refund fields.premium from fields.insurerAccountId; that exact balance is not guaranteed",
      }),
    );

    // Removing chargeRetainedBy restores the old refusal:
    const withoutRetained = {
      ...validRetained,
      actions: {
        ...validRetained.actions,
        quote_refund: {
          ...validRetained.actions.quote_refund,
          quote: {
            ...validRetained.actions.quote_refund.quote,
            chargeRetainedBy: undefined,
          },
        },
      },
    };
    const missingPayoutIssues = analyzeInstrumentFinance(withoutRetained);
    expect(missingPayoutIssues).toContainEqual(
      expect.objectContaining({
        message:
          "refs.penalty is consumed 0 times; a nonzero charge schedule requires exactly one payout",
      }),
    );

    // Unresolved refund source cannot escape through early return when no escrow accounts exist:
    const unresolvedSource = {
      ...validRetained,
      actions: {
        ...validRetained.actions,
        confirm_refund: {
          ...validRetained.actions.confirm_refund,
          moves: [
            {
              ...validRetained.actions.confirm_refund.moves[0]!,
              bind: {
                ...validRetained.actions.confirm_refund.moves[0]!.bind,
                sourceAccountId: {
                  from: "const" as const,
                  value: "unknown",
                },
              },
            },
          ],
        },
      },
    };
    const unresolvedIssues = analyzeInstrumentFinance(unresolvedSource);
    expect(unresolvedIssues).toContainEqual(
      expect.objectContaining({
        message:
          "commit action confirm_refund refund source cannot be resolved to charge-retaining party field insurerAccountId",
      }),
    );
  });

  test("leaves caller-sized balance limits to runtime balance checks", () => {
    const issues = analyzeInstrumentFinance({
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
      actions: {
        create: {
          steps: [
            {
              operation: "account.escrow.provision",
              bind: { role: { from: "const", value: "product_escrow" } },
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
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const release = escrow?.actions.release;
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
          "actions.release.moves[0].bind.sourceAccountId",
        ),
      }),
    );
  });

  test("rejects a second refundable-base credit before a commit", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const fund = escrow?.actions.fund;
    if (!escrow || !fund) throw new Error("escrow_order fund missing");
    escrow.lifecycle.transitions.fund_again = {
      from: ["funded"],
      to: "funded",
    };
    escrow.actions.fund_again = structuredClone(fund);

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "quoted funding must establish exactly one refundable balance",
        ),
        path: expect.stringContaining(
          "actions.fund_again.moves[0].bind.destinationAccountId",
        ),
      }),
    );
  });

  test("checks subject policies, update fields, and aggregate references", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.instruments.find(
      (instrument) => instrument.id === "policy",
    );
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
        "$.instruments[0].subject.kinds[0]",
        "$.instruments[0].aggregateInvariants[0].childRefField",
      ]),
    );
  });

  test("checks aggregate money fields, consuming statuses, and immutability", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    const policy = document.instruments.find(
      (instrument) => instrument.id === "policy",
    );
    const claim = document.instruments.find(
      (instrument) => instrument.id === "claim",
    );
    if (!policy?.aggregateInvariants?.[0] || !claim) {
      throw new Error("protection fixture missing aggregate instruments");
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
        "$.instruments[0].aggregateInvariants[0].parentField",
        "$.instruments[0].aggregateInvariants[0].childField",
        "$.instruments[0].aggregateInvariants[0].childStatuses[1]",
        "$.instruments[0].aggregateInvariants[0].childStatuses[2]",
      ]),
    );
  });

  test("validates authored examples against create inputs", async () => {
    const document = structuredClone(
      await parsedFixture("commerce-escrow.udl"),
    );
    const listing = document.instruments.find(
      (instrument) => instrument.id === "listing",
    );
    if (!listing?.actions.create)
      throw new Error("listing create action missing");
    listing.actions.create.examples = [
      { input: { askingPrice: -1 }, name: "invalid_listing" },
    ];
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(
      result.issues.filter(
        (issue) =>
          issue.path === "$.instruments[0].actions.create.examples[0].input",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("rejects envelope fields, unknown required fields, and duplicate instrument ids", async () => {
    const document = structuredClone(await parsedFixture("protection.udl"));
    document.instruments[0]!.fields.status = { type: "string" };
    document.instruments[0]!.required.push("missing");
    document.instruments[1]!.id = document.instruments[0]!.id;
    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.instruments[0].fields.status",
        "$.instruments[0].required[8]",
        "$.instruments[1]",
      ]),
    );
  });
});

function partitionedEscrowInstrument(): Parameters<
  typeof analyzeInstrumentFinance
>[0] {
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
    actions: {
      create: {
        steps: [
          {
            operation: "account.escrow.provision",
            bind: { role: { from: "const", value: "product_escrow" } },
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

function minimalFinancialInstrument(): Parameters<
  typeof analyzeInstrumentFinance
>[0] {
  return {
    lifecycle: {
      initial: "state",
      states: ["state"],
      transitions: {},
    },
    actions: {
      create: { steps: [] },
    },
  };
}

function trackedAccountsInstrument(
  count: number,
): Parameters<typeof analyzeInstrumentFinance>[0] {
  return {
    lifecycle: {
      initial: "state",
      states: ["state"],
      transitions: {},
    },
    actions: {
      create: {
        steps: Array.from({ length: count }, (_, index) => ({
          operation: "account.escrow.provision",
          bind: { role: { from: "const" as const, value: "product_escrow" } },
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

function twoAccountBranchingInstrument(
  layers: number,
): Parameters<typeof analyzeInstrumentFinance>[0] {
  const states = Array.from(
    { length: layers + 1 },
    (_, index) => `state_${index}`,
  );
  const transitions: Record<
    string,
    { readonly from: readonly string[]; readonly to: string }
  > = {};
  const actions: Record<string, unknown> = {
    create: {
      steps: [
        {
          operation: "account.escrow.provision",
          bind: { role: { from: "const", value: "product_escrow" } },
          capture: { escrowA: "accountId" },
        },
        {
          operation: "account.escrow.provision",
          bind: { role: { from: "const", value: "product_escrow" } },
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
    actions[`skip_${index}`] = { steps: [], moves: [] };
    actions[`add_${index}`] = {
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
    actions,
  } as Parameters<typeof analyzeInstrumentFinance>[0];
}

function twoAccountWorkBudgetInstrument(): Parameters<
  typeof analyzeInstrumentFinance
>[0] {
  const base = twoAccountBranchingInstrument(5);
  const transitions = { ...base.lifecycle.transitions };
  const actions = { ...base.actions };
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
  actions.heavy = { steps: [], moves: heavyMoves };

  return {
    lifecycle: {
      initial: base.lifecycle.initial,
      states: [...base.lifecycle.states, "finished"],
      transitions,
    },
    actions,
  } as Parameters<typeof analyzeInstrumentFinance>[0];
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
    instruments: [
      {
        actionOrder: ["acknowledge", "create", "instruct", "reconcile"],
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
          settleBy: { format: "hyperscale-date-time", type: "string" },
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
          "settleBy",
          "sourceAccountId",
        ],
        summary: "One payout batch with evidence-backed settlement.",
        title: "Payout batch",
        actions: {
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
            due: { field: "settleBy" },
            moves: [],
            reconcile: [
              {
                amount: "fields.amount",
                capture: "settlementEvidenceId",
                counterpartyRef: "payoutId",
                currencyField: "currency",
                direction: "debit",
                evidence: "statement_line",
                exception: {
                  amountField: "amount",
                  childInstrumentId: "payout_break",
                  maxOpen: 1,
                  reasonField: "breakReason",
                  refField: "payoutBatchId",
                },
                match: { law: "exact" },
                within: { field: "settleBy" },
              },
            ],
            steps: [],
            summary: "Match durable evidence that the payout settled.",
          },
        },
      },
      {
        actionOrder: ["create"],
        fields: {
          amount: { pattern: "^[1-9][0-9]{0,17}$", type: "string" },
          breakReason: { type: "string" },
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
        id: "payout_break",
        idPrefix: "pbrk",
        lifecycle: { initial: "open", states: ["open"], transitions: {} },
        required: ["amount", "breakReason", "currency", "payoutBatchId"],
        summary: "One unmatched expectation carried off the batch.",
        title: "Payout break",
        actions: {
          create: {
            moves: [],
            steps: [],
            summary: "Carry an unmatched expectation off the batch.",
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
  test("admits a payout intent followed by a system-only reconcile", () => {
    const result = validateUdl(payoutSettlementDocument());
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  test("checks payout value shapes and the shared ref namespace", () => {
    const document = payoutSettlementDocument();
    const instrument = document.instruments[0]!;
    const instruct = instrument.actions.instruct!;
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
        "reconcile capture settlementEvidenceId collides with an existing instrument ref key",
      ]),
    );
  });

  test("binds a payout beneficiary to the declared destination party", () => {
    const withoutParty = payoutSettlementDocument();
    delete withoutParty.instruments[0]!.parties;

    const missingResult = validateUdl(withoutParty);
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) throw new Error("expected invalid UDL");
    expect(missingResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "payout requires parties.beneficiary to bind its destination party",
        path: "$.instruments[0].actions.instruct.payout.beneficiaryPartyField",
      }),
    );

    const mismatchedParty = payoutSettlementDocument();
    const instrument = mismatchedParty.instruments[0]!;
    const payout = instrument.actions.instruct!.payout;
    if (!payout) throw new Error("fixture payout missing");
    instrument.fields.otherPartyAccountId = {
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
        path: "$.instruments[0].actions.instruct.payout.beneficiaryPartyField",
      }),
    );
  });

  test("rejects a payout intent on create to match core admission", () => {
    const document = payoutSettlementDocument();
    const instrument = document.instruments[0]!;
    const payout = instrument.actions.instruct!.payout;
    if (!payout) throw new Error("fixture payout missing");
    instrument.actions.create!.payout = payout;
    delete instrument.actions.instruct!.payout;

    const result = validateUdl(document);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: "create cannot declare a payout intent",
        path: "$.instruments[0].actions.create.payout",
      }),
    );
  });

  test("rejects a payout intent combined with kernel steps or moves", () => {
    const document = payoutSettlementDocument();
    const instruct = document.instruments[0]!.actions.instruct!;
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
          "action instruct payout intent cannot combine with kernel steps or moves",
        path: "$.instruments[0].actions.instruct.payout",
      }),
    );
  });

  test("rejects a ref-backed payout before its signed-sum writer", () => {
    const document = payoutSettlementDocument();
    const instrument = document.instruments[0]!;
    const instruct = instrument.actions.instruct!;
    const acknowledge = instrument.actions.acknowledge!;
    if (!instruct.payout) throw new Error("fixture payout missing");
    instruct.payout.amount = "refs.payoutAmount";
    acknowledge.signedSum = {
      amountRef: "payoutAmount",
      onNegative: "refuse",
      onZero: "refuse",
      sources: [
        {
          amountField: "amount",
          instrumentId: "payout_item",
          refField: "payoutBatchId",
          sign: "add",
          statuses: ["ready"],
          subtotalRef: "readyAmount",
        },
      ],
    };
    document.instruments.push({
      actionOrder: ["create"],
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
      actions: {
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
        path: "$.instruments[0].actions.instruct.payout.amount",
      }),
    );
  });

  test("requires exactly one reconciling action for a payout-owning instrument", () => {
    const withoutGate = payoutSettlementDocument();
    delete withoutGate.instruments[0]!.actions.reconcile!.reconcile;

    const missingResult = validateUdl(withoutGate);
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) throw new Error("expected invalid UDL");
    expect(missingResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "payout-owning instrument must declare exactly one reconciling action; found 0",
        path: "$.instruments[0].actions",
      }),
    );

    const withTwoGates = payoutSettlementDocument();
    const acknowledge = withTwoGates.instruments[0]!.actions.acknowledge!;
    acknowledge.due = { field: "settleBy" };
    acknowledge.reconcile = [
      {
        ...withTwoGates.instruments[0]!.actions.reconcile!.reconcile![0]!,
        capture: "acknowledgementEvidenceId",
      },
    ];

    const duplicateResult = validateUdl(withTwoGates);
    expect(duplicateResult.ok).toBe(false);
    if (duplicateResult.ok) throw new Error("expected invalid UDL");
    expect(duplicateResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "payout-owning instrument must declare exactly one reconciling action; found 2",
        path: "$.instruments[0].actions",
      }),
    );

    const uncoveredPayout = payoutSettlementDocument();
    const secondPayout = structuredClone(
      uncoveredPayout.instruments[0]!.actions.instruct!.payout,
    );
    if (!secondPayout) throw new Error("fixture payout missing");
    secondPayout.capture = "secondPayoutId";
    uncoveredPayout.instruments[0]!.actions.acknowledge!.payout = secondPayout;

    const uncoveredResult = validateUdl(uncoveredPayout);
    expect(uncoveredResult.ok).toBe(false);
    if (uncoveredResult.ok) throw new Error("expected invalid UDL");
    expect(uncoveredResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "action acknowledge payout capture secondPayoutId is expected by no reconcile",
        path: "$.instruments[0].actions.acknowledge.payout.capture",
      }),
    );
  });

  test("refuses a reconcile without a dominating payout capture", () => {
    const document = payoutSettlementDocument();
    const instrument = document.instruments[0]!;
    const expectation = instrument.actions.reconcile!.reconcile?.[0];
    if (!expectation) throw new Error("fixture reconcile missing");
    expectation.counterpartyRef = "missingPayout";
    instrument.lifecycle.transitions.reconcile!.from = ["approved"];

    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues.map((issue) => issue.message)).toContain(
      "reconcile counterpartyRef missingPayout is not captured by a payout intent",
    );

    expectation.counterpartyRef = "payoutId";
    const early = validateUdl(document);
    expect(early.ok).toBe(false);
    if (early.ok) throw new Error("expected invalid UDL");
    expect(early.issues.map((issue) => issue.message)).toContain(
      "reconcile can read payoutId before payout writers instruct",
    );
  });

  test("refuses a payout reconcile that is not a debit statement line", () => {
    const confirmed = payoutSettlementDocument();
    confirmed.instruments[0]!.actions.reconcile!.reconcile![0]!.evidence =
      "provider_confirmation";

    const confirmedResult = validateUdl(confirmed);
    expect(confirmedResult.ok).toBe(false);
    if (confirmedResult.ok) throw new Error("expected invalid UDL");
    expect(confirmedResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "payout-owning instrument payout_batch action reconcile must reconcile against a debit statement_line; found debit provider_confirmation",
        path: "$.instruments[0].actions.reconcile.reconcile[0].evidence",
      }),
    );

    const credited = payoutSettlementDocument();
    credited.instruments[0]!.actions.reconcile!.reconcile![0]!.direction =
      "credit";

    const creditedResult = validateUdl(credited);
    expect(creditedResult.ok).toBe(false);
    if (creditedResult.ok) throw new Error("expected invalid UDL");
    expect(creditedResult.issues.map((issue) => issue.message)).toContain(
      "payout-owning instrument payout_batch action reconcile must reconcile against a debit statement_line; found credit statement_line",
    );

    // The match law stays the author's call: a tolerance on a debit statement
    // line is still a legal payout reconcile.
    const forgiving = payoutSettlementDocument();
    forgiving.instruments[0]!.actions.reconcile!.reconcile![0]!.match = {
      dial: "settlement_tolerance",
      law: "tolerance",
      minorUnits: 5,
    };
    forgiving.instruments[0]!.dials = [
      ...(forgiving.instruments[0]!.dials ?? []),
      {
        key: "settlement_tolerance",
        kind: "reconcile_tolerance",
        maxMinorUnits: 500,
        summary: "Minor units the settlement match may forgive.",
        title: "Settlement tolerance",
      },
    ];
    expect(validateUdl(forgiving).ok).toBe(true);
  });

  test("refuses a reconcile whose expectation the instrument cannot describe", () => {
    const unknownAmount = payoutSettlementDocument();
    unknownAmount.instruments[0]!.actions.reconcile!.reconcile![0]!.amount =
      "fields.settleBy";

    const amountResult = validateUdl(unknownAmount);
    expect(amountResult.ok).toBe(false);
    if (amountResult.ok) throw new Error("expected invalid UDL");
    expect(amountResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "reconcile amount fields.settleBy must name a declared money field or money ref",
        path: "$.instruments[0].actions.reconcile.reconcile[0].amount",
      }),
    );

    const unknownChild = payoutSettlementDocument();
    unknownChild.instruments[0]!.actions.reconcile!.reconcile![0]!.exception.childInstrumentId =
      "payout_ghost";

    const childResult = validateUdl(unknownChild);
    expect(childResult.ok).toBe(false);
    if (childResult.ok) throw new Error("expected invalid UDL");
    expect(childResult.issues).toContainEqual(
      expect.objectContaining({
        message: "reconcile raises unknown exception instrument payout_ghost",
        path: "$.instruments[0].actions.reconcile.reconcile[0].exception.childInstrumentId",
      }),
    );
  });

  test("refuses a reconcile window that no due condition closes", () => {
    const unswept = payoutSettlementDocument();
    delete unswept.instruments[0]!.actions.reconcile!.due;

    const unsweptResult = validateUdl(unswept);
    expect(unsweptResult.ok).toBe(false);
    if (unsweptResult.ok) throw new Error("expected invalid UDL");
    expect(unsweptResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "reconcile window settleBy is closed by no due condition on reconcile",
        path: "$.instruments[0].actions.reconcile.reconcile[0].within.field",
      }),
    );

    const drifting = payoutSettlementDocument();
    drifting.instruments[0]!.actions.reconcile!.reconcile![0]!.within = {
      offset: "P30D",
    };

    const driftResult = validateUdl(drifting);
    expect(driftResult.ok).toBe(false);
    if (driftResult.ok) throw new Error("expected invalid UDL");
    expect(driftResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "reconcile window P30D is closed by no due condition on reconcile",
        path: "$.instruments[0].actions.reconcile.reconcile[0].within.offset",
      }),
    );
  });

  test("refuses a tolerance above the ceiling its dial declares", () => {
    const document = payoutSettlementDocument();
    const instrument = document.instruments[0]!;
    instrument.dials = [
      {
        key: "settlement_tolerance",
        kind: "reconcile_tolerance",
        maxMinorUnits: 100,
        summary: "How far a settled amount may drift before it is a break.",
        title: "Settlement tolerance",
      },
    ];
    const expectation = instrument.actions.reconcile!.reconcile![0]!;
    expectation.match = {
      dial: "settlement_tolerance",
      law: "tolerance",
      minorUnits: 100,
    };
    expect(validateUdl(document)).toEqual(
      expect.objectContaining({ ok: true }),
    );

    expectation.match = {
      dial: "settlement_tolerance",
      law: "tolerance",
      minorUnits: 101,
    };
    const overResult = validateUdl(document);
    expect(overResult.ok).toBe(false);
    if (overResult.ok) throw new Error("expected invalid UDL");
    expect(overResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "reconcile tolerance 101 exceeds dial settlement_tolerance ceiling 100",
        path: "$.instruments[0].actions.reconcile.reconcile[0].match.minorUnits",
      }),
    );

    expectation.match = {
      dial: "no_such_dial",
      law: "tolerance",
      minorUnits: 1,
    };
    const unknownResult = validateUdl(document);
    expect(unknownResult.ok).toBe(false);
    if (unknownResult.ok) throw new Error("expected invalid UDL");
    expect(unknownResult.issues).toContainEqual(
      expect.objectContaining({
        message:
          "reconcile tolerance names no reconcile_tolerance dial no_such_dial",
        path: "$.instruments[0].actions.reconcile.reconcile[0].match.dial",
      }),
    );
  });

  test("refuses two expectations over the same counterparty row", () => {
    const document = payoutSettlementDocument();
    const expectations = document.instruments[0]!.actions.reconcile!.reconcile!;
    expectations.push({
      ...expectations[0]!,
      capture: "secondEvidenceId",
    });

    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message:
          "action reconcile expects payoutId twice; one counterparty row answers one reconcile",
        path: "$.instruments[0].actions.reconcile.reconcile[1].counterpartyRef",
      }),
    );
  });

  test("keeps reconciling transitions private and effect-free", () => {
    const document = payoutSettlementDocument();
    const reconcile = document.instruments[0]!.actions.reconcile!;
    reconcile.input = { properties: {}, type: "object" };
    reconcile.captureInput = { callerClaim: "claim" };
    reconcile.publicAction = "reconcilePayout";
    reconcile.port = { allowedParties: ["payer"] };
    reconcile.deadline = { field: "settleBy" };
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
      "publicAction",
      "port",
      "deadline",
    ]) {
      expect(result.issues.map((issue) => issue.message)).toContain(
        `a reconciling action is system-only and cannot declare ${facet}`,
      );
    }
    expect(result.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "a reconciling action cannot add kernel steps",
        "a reconciling action cannot move money",
      ]),
    );
  });

  test("freezes payout and settlement clauses in evolution snapshots", () => {
    const previous = snapshotUdlInstrument(
      payoutSettlementDocument().instruments[0]!,
    );
    const next = structuredClone(previous);
    const instruct = next.actions.instruct!;
    const reconcile = next.actions.reconcile!;
    (instruct as { payout?: unknown }).payout = {
      ...(instruct.payout as Record<string, unknown>),
      speed: "changed",
    };
    (reconcile as { reconcile?: unknown }).reconcile = [
      {
        ...((reconcile.reconcile as readonly Record<string, unknown>[])[0] ??
          {}),
        counterpartyRef: "changedPayout",
      },
    ];

    expect(diffInstrumentEvolution(previous, next)).toEqual(
      expect.arrayContaining([
        "payout_batch: action instruct changed its payout intent",
        "payout_batch: action reconcile changed its reconcile expectations",
      ]),
    );
  });

  test("classifies a payout on a newly added action as breaking", () => {
    const previous = snapshotUdlInstrument(
      payoutSettlementDocument().instruments[0]!,
    );
    const next = structuredClone(previous);
    (next.actions as Record<string, EvolutionActionSnapshot>).disburse = {
      ...structuredClone(next.actions.instruct!),
      eventName: "payout_batch.disbursed",
    };

    expect(diffInstrumentEvolution(previous, next)).toContain(
      "payout_batch: action disburse added a payout intent; external money movement is frozen once live",
    );

    const legacyPrevious = structuredClone(previous);
    delete (legacyPrevious.actions.instruct as { payout?: unknown }).payout;
    expect(diffInstrumentEvolution(legacyPrevious, next)).toContain(
      "payout_batch: action instruct changed its payout intent",
    );
  });

  test("treats a newly declared sandbox failure point as additive", () => {
    const previous = snapshotUdlInstrument(
      payoutSettlementDocument().instruments[0]!,
    );
    const next = structuredClone(previous);
    (
      next.actions.instruct as { sandboxFailurePoint?: string | null }
    ).sandboxFailurePoint = "release";

    expect(diffInstrumentEvolution(previous, next)).not.toContain(
      "payout_batch: action instruct changed its sandbox failure point",
    );
    expect(diffInstrumentEvolution(next, previous)).toContain(
      "payout_batch: action instruct changed its sandbox failure point",
    );
  });

  test("classifies a changed or removed cascade as breaking", () => {
    const previous = snapshotUdlInstrument(
      payoutSettlementDocument().instruments[0]!,
    );
    const withCascade = structuredClone(previous);
    (withCascade.actions as Record<string, EvolutionActionSnapshot>).instruct =
      {
        ...structuredClone(withCascade.actions.instruct!),
        cascade: [
          {
            action: "collect",
            inputField: "sliceIds",
            instrumentId: "slice",
          },
        ],
      };

    const changedCascade = structuredClone(withCascade);
    (
      changedCascade.actions as Record<string, EvolutionActionSnapshot>
    ).instruct = {
      ...structuredClone(changedCascade.actions.instruct!),
      cascade: [
        {
          action: "cancel",
          inputField: "sliceIds",
          instrumentId: "slice",
        },
      ],
    };
    expect(diffInstrumentEvolution(withCascade, changedCascade)).toContain(
      "payout_batch: action instruct changed its cascade rules",
    );

    expect(diffInstrumentEvolution(withCascade, previous)).toContain(
      "payout_batch: action instruct changed its cascade rules",
    );
  });
});

describe("signed sum validation", () => {
  test("rejects an amount ref that collides with captured input", async () => {
    const document = await signedSumDocument();
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const release = escrow?.actions.release;
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
          "signed sum ref releaseAmount collides with an existing instrument ref key",
        path: "$.instruments[2].actions.release.signedSum.amountRef",
      }),
    );
  });

  test("rejects overlapping status sets for the same signed source", async () => {
    const document = await signedSumDocument();
    const escrow = document.instruments.find(
      (instrument) => instrument.id === "escrow_order",
    );
    const release = escrow?.actions.release;
    if (!release?.signedSum) throw new Error("release signed sum missing");
    release.signedSum.sources.push({
      amountField: "askingPrice",
      instrumentId: "listing",
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
        path: "$.instruments[2].actions.release.signedSum.sources[1].statuses",
      }),
    );
  });
});

async function signedSumDocument(): Promise<UdlDocument> {
  const document = structuredClone(await parsedFixture("commerce-escrow.udl"));
  const escrow = document.instruments.find(
    (instrument) => instrument.id === "escrow_order",
  );
  const release = escrow?.actions.release;
  const payout = release?.moves[0];
  if (!release || !payout) throw new Error("escrow_order release missing");
  release.signedSum = {
    amountRef: "releaseAmount",
    onNegative: "refuse",
    onZero: "refuse",
    sources: [
      {
        amountField: "askingPrice",
        instrumentId: "listing",
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
    const transaction = document.instruments.find(
      (instrument) => instrument.id === "card_transaction",
    );
    const input = transaction?.actions.refund?.input;
    if (!input) throw new Error("cards refund input fixture missing");
    return input as ReturnType<typeof refundInput>;
  }

  async function policySnapshot(): Promise<InstrumentEvolutionSnapshot> {
    const document = await fixture();
    const policy = document.instruments.find(
      (instrument) => instrument.id === "policy",
    );
    if (!policy) throw new Error("policy fixture missing");
    return snapshotUdlInstrument(policy);
  }

  function changed(
    snapshot: InstrumentEvolutionSnapshot,
    patch: Partial<InstrumentEvolutionSnapshot>,
  ): InstrumentEvolutionSnapshot {
    return { ...snapshot, ...patch };
  }

  // The evolution exports take snapshots and documents the validator has
  // already admitted, and the diff walks them through stableStringify. A cycle
  // that reaches this far must still stop at a resource_limit issue rather than
  // a RangeError out of the call stack.
  describe("evolution admission", () => {
    /** The protection fixture with one instrument's field map pointing at itself. */
    async function cyclic(): Promise<UdlDocument> {
      const document = await fixture();
      const instrument = document.instruments[0];
      if (!instrument) throw new Error("protection fixture has no instruments");
      (instrument.fields as Record<string, unknown>).loop = instrument.fields;
      return document;
    }

    test("bounds stableStringify even when validation is skipped", async () => {
      const [live, broken] = [await fixture(), await cyclic()];
      const error = capturedError(() =>
        diffValidatedUdlEvolution(live, broken),
      );
      expect(error.issues[0]?.code).toBe("UDL1004");
      expect(error.issues[0]?.message).toContain("nesting exceeds");
    });

    test("bounds a snapshot handed straight to diffInstrumentEvolution", async () => {
      const instrument = (await cyclic()).instruments[0];
      if (!instrument) throw new Error("protection fixture has no instruments");
      const error = capturedError(() =>
        diffInstrumentEvolution(
          snapshotUdlInstrument(instrument),
          snapshotUdlInstrument(instrument),
        ),
      );
      expect(error.issues[0]?.code).toBe("UDL1004");
    });
  });

  describe("append-only UDL product evolution", () => {
    test("accepts unchanged and versioned additive product changes", async () => {
      const previous = await fixture();
      expect(
        diffValidatedUdlEvolution(previous, structuredClone(previous)),
      ).toEqual([]);

      const evolvedProduct = await evolved((document) => {
        const claim = document.instruments.find(
          (instrument) => instrument.id === "claim",
        );
        if (!claim) throw new Error("claim fixture missing");
        claim.fields.note = { type: "string" };
        claim.lifecycle.states.push("closed");
        claim.lifecycle.transitions.close = {
          from: ["paid", "denied"],
          to: "closed",
        };
        claim.actions.close = {
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
        document.instruments[1]!.fields.note = { type: "string" };
      }, 1);
      expect(diffValidatedUdlEvolution(previous, next)).toContain(
        "product definition changed without increasing version 1",
      );
    });

    test("reports an effect-only action change", async () => {
      const previous = await fixture();
      const action = previous.instruments[0]?.actions.create;
      if (!action) throw new Error("protection fixture has no create action");
      action.effects = {
        reads: [
          {
            signature: "reads.requires_refs",
            source: "requiresRefs",
          },
        ],
      };
      const next = structuredClone(previous);
      next.version += 1;
      next.instruments[0]!.actions.create!.effects!.reads![0]!.source =
        "forged";

      expect(diffValidatedUdlEvolution(previous, next)).toContain(
        `${next.instruments[0]!.id}: action create changed its derived effects`,
      );
    });

    test("freezes product identity, live instruments, and subject definitions", async () => {
      const { next, previous } = await evolved((document) => {
        document.product = "renamed_product";
        const policyRisk = document.subjects.find(
          (subject) => subject.kind === "policy_risk",
        );
        if (!policyRisk) throw new Error("policy_risk subject fixture missing");
        policyRisk.version += 1;
        document.instruments = document.instruments.filter(
          (instrument) => instrument.id !== "claim",
        );
      });
      // Dropping a instrument other instruments still reference leaves a document
      // `validateUdl` refuses outright; the evolution law is what is under
      // test here, not admission.
      expect(diffValidatedUdlEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "product id changed from protection to renamed_product",
          "subject kind policy_risk changed after becoming live",
          "claim: live instrument was removed from the product",
        ]),
      );
    });
  });

  describe("append-only action input evolution", () => {
    test("rejects removing a live action input field", async () => {
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
        "card_transaction: action refund input field reason was removed or renamed",
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
        "card_transaction: action refund changed its input schema beyond declared fields; a live action input is frozen",
      );
    });

    test("accepts an added optional input field and a action's first input", async () => {
      const { next, previous } = await evolved(
        (document) => {
          refundInput(document).properties.note = { type: "string" };
          const dispute = document.instruments.find(
            (instrument) => instrument.id === "card_dispute",
          );
          if (!dispute?.actions.review)
            throw new Error("dispute fixture missing");
          dispute.actions.review.input = {
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

  describe("append-only UDL instrument evolution", () => {
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
      expect(diffInstrumentEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "policy: instance id prefix changed from pol to cover",
          "policy: initial lifecycle state changed from quoted to bound",
          "policy: lifecycle state expired was removed or renamed",
          "policy: transition for action activate changed its target state from active to expired",
          "policy: transition for action activate no longer fires from state bound",
        ]),
      );
    });

    test("a reworded field description is prose, not a frozen schema", async () => {
      const document = await fixture();
      const policy = document.instruments.find(
        (instrument) => instrument.id === "policy",
      )!;
      const reworded = structuredClone(policy);
      (
        reworded.fields as Record<string, { description?: string }>
      ).premiumAmount!.description = "Premium, reworded for readers";
      expect(
        diffInstrumentEvolution(
          snapshotUdlInstrument(policy),
          snapshotUdlInstrument(reworded),
        ),
      ).toEqual([]);
    });

    test("allows only optional instrument fields to be added", async () => {
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
      expect(diffInstrumentEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "policy: field currency was removed or renamed",
          "policy: field termsSummary became required, tightening the schema",
          "policy: field premiumAmount schema changed; a live field schema is frozen",
          "policy: field requiredNew was added as required, which rejects existing instances (only optional fields are additive)",
        ]),
      );
    });

    test("freezes live actions, steps, inputs, gates, and execution facets", async () => {
      const previous = await policySnapshot();
      const bind = previous.actions.bind!;
      const activate = previous.actions.activate!;
      const next = changed(previous, {
        actions: {
          ...previous.actions,
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
      delete (next.actions as Record<string, unknown>).withdraw;
      expect(diffInstrumentEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "policy: action withdraw was removed or renamed",
          "policy: action bind changed move transfer at index 0; money movement is frozen once live",
          "policy: action bind input field approvalCode was added as required, tightening the action input",
          "policy: action bind changed its cross-instrument gates",
          "policy: action bind changed its event name",
          "policy: action bind changed its provider decision",
          "policy: action bind changed its computed timestamp",
          "policy: action activate changed its earnable flag",
          "policy: action activate changed its due condition",
          "policy: action activate changed its admission deadline",
        ]),
      );
    });

    test("a gate's optional marker is part of its frozen identity", async () => {
      const previous = await policySnapshot();
      const bind = previous.actions.bind!;
      const gated = (optional: boolean) =>
        changed(previous, {
          actions: {
            ...previous.actions,
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
      const violation =
        "policy: action bind changed its cross-instrument gates";
      expect(diffInstrumentEvolution(gated(false), gated(true))).toEqual(
        expect.arrayContaining([violation]),
      );
      expect(diffInstrumentEvolution(gated(true), gated(false))).toEqual(
        expect.arrayContaining([violation]),
      );
      expect(diffInstrumentEvolution(gated(true), gated(true))).toEqual([]);
    });

    test("freezes the complete admission-gate algebra", async () => {
      const previous = await policySnapshot();
      const bind = previous.actions.bind!;
      const gate = {
        bind: { policyholderAccountId: "fields.ownerAccountId" },
        field: "policyId",
        match: { "fields.currency": "fields.currency" },
        statuses: ["active"],
        unique: true as const,
      };
      const baseline = changed(previous, {
        actions: {
          ...previous.actions,
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
          actions: {
            ...baseline.actions,
            bind: { ...baseline.actions.bind!, requiresRefs },
          },
        });
      const crossInstrumentViolation =
        "policy: action bind changed its cross-instrument gates";
      expect(
        diffInstrumentEvolution(
          baseline,
          changeBind([{ ...gate, bind: { changed: "fields.ownerAccountId" } }]),
        ),
      ).toContain(crossInstrumentViolation);
      expect(
        diffInstrumentEvolution(
          baseline,
          changeBind([{ ...gate, match: { changed: "fields.currency" } }]),
        ),
      ).toContain(crossInstrumentViolation);
      expect(
        diffInstrumentEvolution(
          baseline,
          changeBind([{ ...gate, unique: undefined }]),
        ),
      ).toContain(crossInstrumentViolation);

      const relaxed = changed(baseline, {
        actions: {
          ...baseline.actions,
          bind: {
            ...baseline.actions.bind!,
            requiresAggregate: [],
            requiresDrainedAccount: null,
          },
        },
      });
      expect(diffInstrumentEvolution(baseline, relaxed)).toEqual(
        expect.arrayContaining([
          "policy: action bind changed its aggregate admission gates",
          "policy: action bind changed its drained-account gate",
        ]),
      );
    });

    test("freezes parties, aggregates, quotes, subjects, and update permissions", async () => {
      const previous = await policySnapshot();
      const next = changed(previous, {
        aggregateInvariants: [],
        parties: { payer: "insurerAccountId" },
        subjects: [],
        quotes: {
          preview: {
            ...record(record(previous.quotes).preview),
            netDestinationField: "insurerAccountId",
          },
        },
        updateFields: previous.updateFields.filter(
          (field) => field !== "termsSummary",
        ),
        updateStates: [],
      });
      expect(diffInstrumentEvolution(previous, next)).toEqual(
        expect.arrayContaining([
          "policy: party role payer moved from field policyholderAccountId to insurerAccountId",
          "policy: party role beneficiary was removed or renamed",
          expect.stringContaining("policy: aggregate invariant ["),
          "policy: quote policy changed; the charge schedule, the frozen fields, and the refund destination are frozen once live",
          "policy: subject kind policy_risk was removed, rejecting linked instances",
          "policy: update policy no longer permits field termsSummary",
          "policy: update policy no longer permits state quoted",
        ]),
      );
    });

    test("freezes a derived amount percentage after the instrument becomes live", async () => {
      const snapshot = await policySnapshot();
      const previous = changed(snapshot, {
        derivedAmounts: ["serviceAmount=floor(premiumAmount*250/10000)"],
      });
      const next = changed(previous, {
        derivedAmounts: ["serviceAmount=floor(premiumAmount*9900/10000)"],
      });

      expect(diffInstrumentEvolution(previous, next)).toContain(
        "policy: derived amount rules changed; derived money arithmetic is frozen once live",
      );
    });

    test("freezes fee basis points after the instrument becomes live", async () => {
      const snapshot = await policySnapshot();
      const previous = changed(snapshot, {
        feeRules: [
          {
            amountField: "serviceFee",
            baseField: "premiumAmount",
            bearerField: "policyholderAccountId",
            position: "on_top",
            rule: { bps: 250, kind: "bps" },
          },
        ],
      });
      const next = changed(snapshot, {
        feeRules: [
          {
            amountField: "serviceFee",
            baseField: "premiumAmount",
            bearerField: "policyholderAccountId",
            position: "on_top",
            rule: { bps: 300, kind: "bps" },
          },
        ],
      });

      expect(diffInstrumentEvolution(previous, next)).toContain(
        "policy: feeRules changed; fee calculation and settlement funding are frozen once live",
      );
    });

    test("freezes fee tier thresholds after the instrument becomes live", async () => {
      const snapshot = await policySnapshot();
      const feeRule = {
        amountField: "serviceFee",
        baseField: "premiumAmount",
        bearerField: "policyholderAccountId",
        position: "on_top",
        rule: {
          kind: "tiered",
          tiers: [
            {
              fromInclusive: "0",
              rule: { bps: 250, kind: "bps" },
              toExclusive: "10000",
            },
            {
              fromInclusive: "10000",
              rule: { bps: 150, kind: "bps" },
            },
          ],
        },
      };
      const previous = changed(snapshot, { feeRules: [feeRule] });
      const next = changed(snapshot, {
        feeRules: [
          {
            ...feeRule,
            rule: {
              ...feeRule.rule,
              tiers: feeRule.rule.tiers.map((tier, index) =>
                index === 0 ? { ...tier, toExclusive: "20000" } : tier,
              ),
            },
          },
        ],
      });

      expect(diffInstrumentEvolution(previous, next)).toContain(
        "policy: feeRules changed; fee calculation and settlement funding are frozen once live",
      );
    });

    test("freezes every weighted distribution selector after the action becomes live", async () => {
      const previous = await policySnapshot();
      const bind = previous.actions.bind!;
      const baseline = changed(previous, {
        actions: {
          ...previous.actions,
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
        "policy: action bind changed its distribution rule; money distribution is frozen once live";
      const changedDistributions = [
        {
          ...record(baseline.actions.bind!.distribute),
          pool: { from: "parent", path: "refs.replacementPool" },
        },
        {
          ...record(baseline.actions.bind!.distribute),
          weightField: "replacementWeight",
        },
        {
          ...record(baseline.actions.bind!.distribute),
          statuses: ["approved"],
        },
      ];

      for (const distribute of changedDistributions) {
        const next = changed(baseline, {
          actions: {
            ...baseline.actions,
            bind: { ...baseline.actions.bind!, distribute },
          },
        });
        expect(diffInstrumentEvolution(baseline, next)).toContain(violation);
      }
    });

    test("rejects an aggregate added to an already-live instrument", async () => {
      const previous = await policySnapshot();
      const key =
        "claim.claimAmount within coverageLimit via policyId while approved";
      const next = changed(previous, {
        aggregateInvariants: [...previous.aggregateInvariants, key],
      });
      expect(diffInstrumentEvolution(previous, next)).toContain(
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

describe("UDL action order", () => {
  function orderedDocument(): UdlDocument {
    return {
      instruments: [
        {
          actionOrder: ["create", "zebra", "alpha"],
          actions: {
            alpha: { moves: [], steps: [], summary: "Finish second" },
            create: { moves: [], steps: [], summary: "Create" },
            zebra: { moves: [], steps: [], summary: "Finish first" },
          },
          fields: {},
          id: "ordered_actions",
          idPrefix: "ord",
          lifecycle: {
            initial: "open",
            states: ["open", "first", "finished"],
            transitions: {
              alpha: { from: ["first"], to: "finished" },
              zebra: { from: ["open"], to: "first" },
            },
          },
          required: [],
          summary: "Action order fixture",
          title: "Ordered actions",
        },
      ],
      product: "action_order_test",
      subjects: [],
      title: "Action order test",
      udl: 1,
      version: 1,
    };
  }

  test("preserves the declared order across canonical serialization", () => {
    const parsed = parseUdl(serializeUdl(orderedDocument()));
    expect(parsed.instruments[0]?.actionOrder).toEqual([
      "create",
      "zebra",
      "alpha",
    ]);
    expect(Object.keys(parsed.instruments[0]?.actions ?? {})).toEqual([
      "alpha",
      "create",
      "zebra",
    ]);
  });

  test("requires exact action membership without duplicates", () => {
    const document = orderedDocument();
    document.instruments[0]!.actionOrder = ["create", "zebra", "zebra", "gone"];
    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "duplicate action id zebra; first declared at index 1",
          path: "$.instruments[0].actionOrder[2]",
        }),
        expect.objectContaining({
          message: "action order references unknown action gone",
          path: "$.instruments[0].actionOrder[3]",
        }),
        expect.objectContaining({
          message: "action alpha is missing from actionOrder",
          path: "$.instruments[0].actions.alpha",
        }),
      ]),
    );
  });

  test("freezes action order after publication", () => {
    const previous = snapshotUdlInstrument(orderedDocument().instruments[0]!);
    const next = {
      ...previous,
      actionOrder: ["create", "alpha", "zebra"],
    };
    expect(diffInstrumentEvolution(previous, next)).toContain(
      "ordered_actions: instrument action order changed after becoming live",
    );
  });
});

describe("UDL computed amount reference validation", () => {
  const moneyField = { pattern: "^[1-9][0-9]{0,17}$", type: "string" } as const;
  const currencyField = {
    maxLength: 3,
    minLength: 3,
    pattern: "^[A-Z]{3}$",
    type: "string",
  } as const;

  function distributionDocument(): UdlDocument {
    return {
      instruments: [
        {
          actionOrder: ["create"],
          fields: { currency: currencyField, poolAmount: moneyField },
          id: "source_pool",
          idPrefix: "spl",
          lifecycle: { initial: "open", states: ["open"], transitions: {} },
          required: ["poolAmount", "currency"],
          summary: "Stored distribution pool",
          title: "Source pool",
          actions: {
            create: { moves: [], steps: [], summary: "Create source pool" },
          },
        },
        {
          actionOrder: ["create", "payout"],
          fields: {
            currency: currencyField,
            parentId: {
              pattern: "^spl_(sandbox|live)_[a-z0-9]{8,64}$",
              type: "string",
            },
            weight: moneyField,
          },
          id: "entitlement",
          idPrefix: "ent",
          lifecycle: {
            initial: "recorded",
            states: ["recorded", "paid"],
            transitions: { payout: { from: ["recorded"], to: "paid" } },
          },
          required: ["parentId", "weight", "currency"],
          summary: "Stored weighted entitlement",
          title: "Entitlement",
          actions: {
            create: {
              moves: [],
              requiresRefs: [
                {
                  bind: { currency: "fields.currency" },
                  field: "parentId",
                  statuses: ["open"],
                },
              ],
              steps: [],
              summary: "Record entitlement",
            },
            payout: {
              distribute: {
                amountRef: "payoutShare",
                onZero: "skip_steps",
                pool: { from: "parent", path: "fields.poolAmount" },
                refField: "parentId",
                statuses: ["recorded", "paid"],
                weightField: "weight",
              },
              moves: [],
              steps: [],
              summary: "Pay entitlement",
            },
          },
        },
      ],
      product: "distribution_test",
      subjects: [],
      title: "Distribution test",
      udl: 1,
      version: 1,
    };
  }

  function getMessages(value: unknown): readonly string[] {
    const result = validateUdl(value);
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.issues.map((issue) => issue.message);
  }

  test("rejects nonexistent and wrong-typed distribute references", () => {
    expect(validateUdl(distributionDocument()).ok).toBe(true);

    const missingParent = distributionDocument();
    missingParent.instruments[1]!.actions.payout!.distribute!.refField =
      "missingParentId";
    expect(getMessages(missingParent)).toContain(
      "distribute refField missingParentId must identify exactly one parent instrument",
    );

    const missingPool = distributionDocument();
    missingPool.instruments[1]!.actions.payout!.distribute!.pool.path =
      "fields.missingAmount";
    expect(getMessages(missingPool)).toContain(
      "distribute pool fields.missingAmount must be a declared money field or ref of source_pool",
    );

    const wrongWeightType = distributionDocument();
    wrongWeightType.instruments[1]!.actions.payout!.distribute!.weightField =
      "currency";
    expect(getMessages(wrongWeightType)).toContain(
      "distribute weightField currency must be a declared money field",
    );
  });

  test("rejects nonexistent and wrong-typed derived amount references", () => {
    const valid = distributionDocument();
    valid.instruments[0]!.fields.derivedAmount = moneyField;
    valid.instruments[0]!.derivedAmounts = [
      {
        field: "derivedAmount",
        rounding: "floor",
        rule: { bps: 250, kind: "percentage_of" },
        sourceField: "poolAmount",
      },
    ];
    expect(validateUdl(valid).ok).toBe(true);

    const missingTarget = structuredClone(valid);
    missingTarget.instruments[0]!.derivedAmounts![0]!.field = "missingAmount";
    expect(getMessages(missingTarget)).toContain(
      "derived amount target missingAmount must be a declared money field",
    );

    const wrongSourceType = structuredClone(valid);
    wrongSourceType.instruments[0]!.derivedAmounts![0]!.sourceField =
      "currency";
    expect(getMessages(wrongSourceType)).toContain(
      "derived amount source currency must be a declared money field",
    );
  });
});

describe("UDL completeness clauses", () => {
  const money = { pattern: "^[1-9][0-9]{0,17}$", type: "string" } as const;
  const account = {
    pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
    type: "string",
  } as const;

  function completeDocument(): UdlDocument {
    return {
      instruments: [
        {
          actionOrder: ["create", "revise", "settle"],
          actions: {
            create: { moves: [], steps: [], summary: "Open the agreement" },
            revise: {
              examples: [
                {
                  input: {
                    agreementId: "agr_sandbox_agreement01",
                    note: "Updated terms",
                    tenantId: "ten_sandbox_example001",
                  },
                  name: "revise_terms",
                },
              ],
              input: {
                additionalProperties: false,
                properties: { note: { type: "string" } },
                required: ["note"],
                type: "object",
              },
              moves: [],
              principal: "user_session",
              steps: [],
              summary: "Revise the note",
              updates: ["note"],
            },
            settle: {
              deadline: { field: "closesAt" },
              moves: [
                {
                  bind: {
                    amount: { from: "instance", path: "refs.remainingAmount" },
                    currency: { from: "instance", path: "fields.currency" },
                    destinationAccountId: {
                      from: "instance",
                      path: "fields.destinationAccountId",
                    },
                    sourceAccountId: {
                      from: "instance",
                      path: "fields.sourceAccountId",
                    },
                  },
                  key: "settlement",
                  operation: "internal_transfer.create",
                },
              ],
              remainder: {
                amountRef: "remainingAmount",
                onZero: "refuse",
                totalPath: "fields.amount",
              },
              requiresChecks: [
                {
                  checkKind: "identity_verification",
                  family: "national_identity",
                  maxAge: "P30D",
                  statuses: ["completed"],
                  subjectField: "subjectId",
                },
              ],
              sandboxFailurePoint: "release",
              steps: [],
              summary: "Settle the agreement",
            },
          },
          callerParkedStates: {
            open: "The owner may revise or settle the agreement.",
          },
          dials: [
            {
              field: "closesAt",
              key: "settlement_window",
              kind: "window",
              maxOffset: "P30D",
              minOffset: "PT0S",
              summary: "The settlement deadline offset.",
              title: "Settlement window",
            },
          ],
          fields: {
            amount: money,
            closesAt: { format: "hyperscale-date-time", type: "string" },
            currency: { pattern: "^[A-Z]{3}$", type: "string" },
            destinationAccountId: account,
            note: { type: "string" },
            sourceAccountId: account,
            subjectId: { type: "string" },
          },
          id: "agreement",
          idPrefix: "agr",
          lifecycle: {
            initial: "open",
            states: ["open", "closed"],
            transitions: {
              revise: { from: ["open"], to: "open" },
              settle: { from: ["open"], to: "closed" },
            },
          },
          nav: ["Agreements"],
          required: [
            "amount",
            "closesAt",
            "currency",
            "destinationAccountId",
            "sourceAccountId",
            "subjectId",
          ],
          subject: { extensible: false, kinds: ["asset"] },
          summary: "One agreement with a computed final settlement.",
          surfaceVisibility: "public",
          templateId: "agreement",
          title: "Agreement",
          update: {
            examples: [
              {
                input: {
                  agreementId: "agr_sandbox_agreement01",
                  note: "Updated terms",
                  tenantId: "ten_sandbox_example001",
                },
                name: "revise_terms",
              },
            ],
            fields: ["note"],
            states: ["open"],
          },
        },
      ],
      product: "complete_contract",
      subjects: [
        {
          declaredValue: "none",
          kind: "asset",
          schema: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
          title: "Asset",
          version: 1,
        },
      ],
      title: "Complete contract",
      udl: 1,
      version: 1,
    };
  }

  function getMessages(document: UdlDocument): readonly string[] {
    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.issues.map((issue) => issue.message);
  }

  test("admits one document carrying every lifted clause family", () => {
    expect(validateUdl(completeDocument())).toEqual({
      ok: true,
      value: completeDocument(),
    });
  });

  test("refuses invalid remainder, check, update, dial, and parked-state clauses", () => {
    const remainder = completeDocument();
    remainder.instruments[0]!.actions.settle!.remainder!.inputKey = "partial";
    expect(getMessages(remainder)).toContain(
      "remainder inputKey partial is not declared by action input",
    );

    const check = completeDocument();
    check.instruments[0]!.actions.settle!.requiresChecks![0]!.maxAge = "P1M";
    expect(getMessages(check)).toContain(
      "check maxAge must be a fixed ISO-8601 duration",
    );

    const update = completeDocument();
    update.instruments[0]!.actions.revise!.updates = ["missing"];
    expect(getMessages(update)).toContain(
      "updated field missing is not declared by action input",
    );

    const dial = completeDocument();
    const windowDial = dial.instruments[0]!.dials![0];
    if (windowDial?.kind !== "window") throw new Error("window dial missing");
    windowDial.field = "missing";
    expect(getMessages(dial)).toContain(
      "window dial field missing anchors no action deadline or due condition",
    );

    const parked = completeDocument();
    parked.instruments[0]!.callerParkedStates = { missing: "Unknown state" };
    expect(getMessages(parked)).toContain(
      "callerParkedStates references unknown state missing",
    );
  });

  test("freezes parked state keys but not presentation text", () => {
    const previous = snapshotUdlInstrument(completeDocument().instruments[0]!);
    const reasonEdit = completeDocument().instruments[0]!;
    reasonEdit.callerParkedStates!.open = "A clearer operator reason.";
    expect(
      diffInstrumentEvolution(previous, snapshotUdlInstrument(reasonEdit)),
    ).toEqual([]);

    const removed = completeDocument().instruments[0]!;
    removed.callerParkedStates = {};
    expect(
      diffInstrumentEvolution(previous, snapshotUdlInstrument(removed)),
    ).toContain("agreement: caller-parked state annotations changed");
  });
});

describe("UDL decided amount validation", () => {
  const moneyField = {
    pattern: "^[1-9][0-9]{0,17}$",
    type: "string",
  } as const;

  const stringField = { type: "string" } as const;

  const currencyField = {
    pattern: "^[A-Z]{3}$",
    type: "string",
  } as const;

  function decidedAmountDocument(): UdlDocument {
    const drain = {
      bind: {
        transferId: { from: "instance" as const, path: "refs.reservationId" },
      },
      key: "cancel",
      operation: "internal_transfer.void" as const,
    };
    return {
      instruments: [
        {
          actionOrder: ["cancel", "create", "decide"],
          actions: {
            cancel: {
              moves: [drain],
              steps: [],
              summary: "Cancel and release the reserved remainder",
            },
            create: {
              moves: [
                {
                  bind: {
                    amount: {
                      from: "instance",
                      path: "fields.authorizedAmount",
                    },
                    destinationAccountId: {
                      from: "instance",
                      path: "fields.destinationAccountId",
                    },
                    sourceAccountId: {
                      from: "instance",
                      path: "fields.sourceAccountId",
                    },
                  },
                  capture: { reservationId: "transferId" },
                  key: "reserve",
                  operation: "internal_transfer.reserve",
                },
              ],
              steps: [],
              summary: "Reserve the authorized amount",
            },
            decide: {
              decidedAmount: {
                boundField: "authorizedAmount",
                field: "settledAmount",
                remainderAction: "cancel",
              },
              input: {
                additionalProperties: false,
                properties: { settledAmount: moneyField },
                required: ["settledAmount"],
                type: "object",
              },
              moves: [
                {
                  bind: {
                    amount: { from: "input", path: "settledAmount" },
                    currency: { from: "instance", path: "fields.currency" },
                    postMode: { from: "const", value: "partial_only" },
                    transferId: {
                      from: "instance",
                      path: "refs.reservationId",
                    },
                  },
                  key: "decided",
                  operation: "internal_transfer.post",
                },
                { ...structuredClone(drain), key: "remainder" },
              ],
              steps: [],
              summary: "Settle the decided amount and release the remainder",
            },
          },
          fields: {
            authorizedAmount: moneyField,
            currency: currencyField,
            destinationAccountId: stringField,
            sourceAccountId: stringField,
          },
          id: "decided_hold",
          idPrefix: "dch",
          lifecycle: {
            initial: "held",
            states: ["held", "settled", "cancelled"],
            transitions: {
              cancel: { from: ["held"], to: "cancelled" },
              decide: { from: ["held"], to: "settled" },
            },
          },
          required: [
            "authorizedAmount",
            "currency",
            "destinationAccountId",
            "sourceAccountId",
          ],
          summary: "A hold with a caller-decided settlement amount",
          title: "Decided hold",
        },
      ],
      product: "decided_amount_test",
      subjects: [],
      title: "Decided amount test",
      udl: 1,
      version: 1,
    };
  }

  function issues(value: unknown) {
    const result = validateUdl(value);
    expect(result.ok).toBe(false);
    return result.ok
      ? []
      : result.issues.map(({ code, message, path }) => ({
          code,
          message,
          path,
        }));
  }

  test("accepts one decided post followed by its cloned remainder drain", () => {
    expect(validateUdl(decidedAmountDocument())).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  test("rejects missing and non-money decided fields", () => {
    const missing = decidedAmountDocument();
    missing.instruments[0]!.actions.decide!.decidedAmount!.field =
      "missingAmount";
    expect(issues(missing)).toContainEqual({
      code: "UDL4001",
      message:
        "decided amount field missingAmount must be a declared action input money field",
      path: "$.instruments[0].actions.decide.decidedAmount.field",
    });

    const wrongType = decidedAmountDocument();
    const properties = wrongType.instruments[0]!.actions.decide!.input!
      .properties as Record<string, unknown>;
    properties.settledAmount = stringField;
    expect(issues(wrongType)).toContainEqual({
      code: "UDL4001",
      message:
        "decided amount field settledAmount must be a declared action input money field",
      path: "$.instruments[0].actions.decide.decidedAmount.field",
    });
  });

  test("rejects a non-partition post or mismatched currency binding", () => {
    const wrongPostMode = decidedAmountDocument();
    wrongPostMode.instruments[0]!.actions.decide!.moves[0]!.bind.postMode = {
      from: "const",
      value: "full",
    };
    expect(issues(wrongPostMode)).toContainEqual({
      code: "UDL5008",
      message:
        "decided amount post must use partial_only so the remainder stays reserved",
      path: "$.instruments[0].actions.decide.moves[0].bind.postMode",
    });

    const wrongCurrency = decidedAmountDocument();
    wrongCurrency.instruments[0]!.actions.decide!.moves[0]!.bind.currency = {
      from: "const",
      value: "USD",
    };
    expect(issues(wrongCurrency)).toContainEqual({
      code: "UDL5008",
      message: "decided amount post must bind the instrument currency",
      path: "$.instruments[0].actions.decide.moves[0].bind.currency",
    });
  });

  test("rejects a missing, wrong-typed, optional, or mutable bound", () => {
    const missing = decidedAmountDocument();
    missing.instruments[0]!.actions.decide!.decidedAmount!.boundField =
      "missingAmount";
    expect(issues(missing)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "decided amount bound missingAmount must be a declared instrument money field",
          path: "$.instruments[0].actions.decide.decidedAmount.boundField",
        }),
        expect.objectContaining({
          message: "decided amount bound missingAmount must be required",
          path: "$.instruments[0].actions.decide.decidedAmount.boundField",
        }),
      ]),
    );
  });

  test("rejects cancellation that strands or duplicates the remainder", () => {
    const missing = decidedAmountDocument();
    missing.instruments[0]!.actions.cancel!.moves = [];
    expect(issues(missing)).toContainEqual({
      code: "UDL4001",
      message:
        "decided amount remainder action cancel must declare exactly one reservation drain; found 0",
      path: "$.instruments[0].actions.cancel.moves",
    });
  });
});

describe("UDL action effects", () => {
  test("classifies collection funding from its endpoint roles", () => {
    expect(
      movementClass({
        bind: {
          destinationAccountId: {
            from: "instance",
            path: "refs.escrowAccountId",
          },
          sourceAccountId: {
            from: "instance",
            path: "fields.buyerAccountId",
          },
        },
        operation: "internal_transfer.create",
      }),
    ).toBe("collection.pay_in");
    expect(
      movementClass({
        bind: {
          destinationAccountId: {
            from: "instance",
            path: "fields.sellerAccountId",
          },
          sourceAccountId: {
            from: "instance",
            path: "fields.buyerAccountId",
          },
        },
        operation: "internal_transfer.create",
      }),
    ).toBe("transfer.internal");
  });

  test("refuses an operation with no movement class", () => {
    expect(() =>
      movementClass({
        bind: {
          destinationAccountId: { from: "instance", path: "fields.a" },
          sourceAccountId: { from: "instance", path: "fields.b" },
        },
        operation: "account.freeze" as any,
      }),
    ).toThrow();
  });

  test("derives quote, commit, and reconcile effect signatures", () => {
    expect(
      deriveUdlActionEffects(
        {
          commit: "quote_refund",
          quote: { expires: { offset: "PT15M" } },
          reconcile: [
            { evidence: "debit_statement_line" },
            { evidence: "debit_statement_line" },
          ],
        },
        udlClauseVocabulary,
      ),
    ).toEqual({
      holds: [{ signature: "holds.quote", source: "quote" }],
      reads: [
        { signature: "reads.reconcile", source: "reconcile[0]" },
        { signature: "reads.reconcile", source: "reconcile[1]" },
      ],
      schedules: [{ signature: "schedules.expiry", source: "quote" }],
    });
  });
});

describe("UDL unified fee rules", () => {
  const moneyField = {
    pattern: "^[1-9][0-9]{0,17}$",
    type: "string",
  } as const;
  const currencyField = {
    maxLength: 3,
    minLength: 3,
    pattern: "^[A-Z]{3}$",
    type: "string",
  } as const;
  const accountField = {
    pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
    type: "string",
  } as const;

  function feeDocument(): UdlDocument {
    return {
      instruments: [
        {
          actionOrder: ["create"],
          actions: {
            create: { moves: [], steps: [], summary: "Create the charge" },
          },
          feeRules: [
            {
              amountField: "feeAmount",
              baseField: "baseAmount",
              bearerField: "payerAccountId",
              position: "carved",
              rule: { bps: 250, kind: "bps" },
            },
          ],
          fields: {
            baseAmount: moneyField,
            currency: currencyField,
            feeAmount: moneyField,
            netAmount: moneyField,
            payerAccountId: accountField,
          },
          id: "fee_charge",
          idPrefix: "fch",
          lifecycle: {
            initial: "created",
            states: ["created"],
            transitions: {},
          },
          partitions: [
            {
              pieceFields: ["netAmount", "feeAmount"],
              totalField: "baseAmount",
            },
          ],
          required: ["baseAmount", "currency", "netAmount", "payerAccountId"],
          summary: "A charge with one fee",
          title: "Fee charge",
        },
      ],
      product: "fee_test",
      subjects: [],
      title: "Fee test",
      udl: 1,
      version: 1,
    };
  }

  function feeMessages(value: unknown): readonly string[] {
    const result = validateUdl(value);
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.issues.map((issue) => issue.message);
  }

  test("accepts carved bps, direct exact, and mixed tiered rules", () => {
    expect(validateUdl(feeDocument()).ok).toBe(true);

    const exact = feeDocument();
    exact.instruments[0]!.feeRules![0] = {
      amountField: "feeAmount",
      baseField: "baseAmount",
      bearerField: "payerAccountId",
      position: "carved",
      rule: { currencyField: "currency", field: "feeAmount", kind: "exact" },
    };
    exact.instruments[0]!.required.push("feeAmount");
    expect(validateUdl(exact).ok).toBe(true);

    const tiered = feeDocument();
    tiered.instruments[0]!.feeRules![0] = {
      amountField: "feeAmount",
      baseField: "baseAmount",
      bearerField: "payerAccountId",
      position: "on_top",
      rule: {
        kind: "tiered",
        tiers: [
          {
            fromInclusive: "0",
            rule: { bps: 125, kind: "bps" },
            toExclusive: "10000",
          },
          {
            fromInclusive: "10000",
            rule: {
              currencyField: "currency",
              field: "netAmount",
              kind: "exact",
            },
          },
        ],
      },
    };
    delete tiered.instruments[0]!.partitions;
    expect(validateUdl(tiered).ok).toBe(true);
  });

  test("refuses gaps, overlaps, and two open-ended tiers", () => {
    const tiered = feeDocument();
    tiered.instruments[0]!.feeRules![0]!.rule = {
      kind: "tiered",
      tiers: [
        {
          fromInclusive: "0",
          rule: { bps: 100, kind: "bps" },
          toExclusive: "100",
        },
        { fromInclusive: "101", rule: { bps: 200, kind: "bps" } },
      ],
    };
    expect(feeMessages(tiered)).toContain("fee tiers have a gap before 101");
  });

  test("refuses wrong currency and mutable exact money", () => {
    const exact = feeDocument();
    exact.instruments[0]!.feeRules![0]!.rule = {
      currencyField: "settlementCurrency",
      field: "feeAmount",
      kind: "exact",
    };
    exact.instruments[0]!.fields.settlementCurrency = currencyField;
    exact.instruments[0]!.required.push("feeAmount", "settlementCurrency");
    expect(feeMessages(exact)).toContain(
      "exact fee currency settlementCurrency must equal the fee base currency field",
    );
  });

  test("refuses a carved base-plus-fee exit", () => {
    const invalid = feeDocument();
    invalid.instruments[0]!.partitions = [
      {
        pieceFields: ["baseAmount", "feeAmount"],
        totalField: "netAmount",
      },
    ];
    expect(feeMessages(invalid)).toContain(
      "carved fee feeAmount must form part of a partition of baseAmount",
    );
  });
});

describe("UDL open-ended schedule validation", () => {
  const dateTimeField = {
    format: "hyperscale-date-time",
    type: "string",
  } as const;

  const accountField = {
    pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
    type: "string",
  } as const;

  function scheduleDocument(): UdlDocument {
    return {
      instruments: [
        {
          actionOrder: ["cancel", "collect_period", "create", "open_period"],
          actions: {
            cancel: {
              moves: [],
              port: { allowedParties: ["payer"] },
              requiresDrainedAccount: { path: "fields.payerAccountId" },
              steps: [],
              summary: "Cancel the collection and prove its account drained",
            },
            collect_period: {
              moves: [],
              steps: [],
              summary: "Collect through an authored period action",
            },
            create: {
              moves: [],
              steps: [],
              summary: "Create the recurring collection",
            },
            open_period: {
              due: {
                every: {
                  delinquency: "parent_policy",
                  drainAction: "cancel",
                  liability: "one_open",
                  period: {
                    calendar: "gregorian",
                    monthEnd: "clamp_to_last_day",
                    months: 1,
                  },
                  untilAction: "cancel",
                },
                field: "firstDueAt",
              },
              moves: [],
              steps: [],
              summary: "Open one collection period",
            },
          },
          fields: {
            firstDueAt: dateTimeField,
            payerAccountId: accountField,
            terminationAt: dateTimeField,
          },
          id: "recurring_charge",
          idPrefix: "rch",
          lifecycle: {
            initial: "active",
            states: ["active", "period_open", "cancelled"],
            transitions: {
              cancel: { from: ["active", "period_open"], to: "cancelled" },
              collect_period: { from: ["period_open"], to: "active" },
              open_period: { from: ["active"], to: "period_open" },
            },
          },
          parties: { payer: "payerAccountId" },
          required: ["firstDueAt", "payerAccountId", "terminationAt"],
          summary: "One open recurring collection period",
          title: "Recurring charge",
        },
      ],
      product: "schedule_test",
      subjects: [],
      title: "Schedule test",
      udl: 1,
      version: 1,
    };
  }

  function scheduleMessages(value: unknown): readonly string[] {
    const result = validateUdl(value);
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.issues.map((issue) => issue.message);
  }

  test("new compilations require decision party bindings without rejecting frozen UDL", () => {
    const document = scheduleDocument();
    const instrument = document.instruments[0]!;
    instrument.actions.cancel!.port = { allowedParties: ["inspector"] };
    expect(validateUdl(document).ok).toBe(true);
    const result = validateUdl(document, {
      requireDecisionPartyBindings: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "UDL5008",
          message:
            "decision port allows party role inspector, which the instrument does not declare",
        }),
      );
    }
    instrument.parties = { inspector: "payerAccountId" };
    expect(
      validateUdl(document, { requireDecisionPartyBindings: true }).ok,
    ).toBe(true);
  });

  test("accepts a monthly series with an explicit anchor rule and port termination", () => {
    expect(validateUdl(scheduleDocument()).ok).toBe(true);
  });

  test("refuses missing and ambiguous termination", () => {
    const missing = scheduleDocument();
    delete missing.instruments[0]!.actions.open_period!.due!.every!.untilAction;
    expect(scheduleMessages(missing)).toContain(
      "recurrence must declare a termination using countField, untilField, or untilAction",
    );

    const ambiguous = scheduleDocument();
    ambiguous.instruments[0]!.actions.open_period!.due!.every!.untilField =
      "terminationAt";
    expect(scheduleMessages(ambiguous)).toContain(
      "recurrence termination is ambiguous: untilField, untilAction",
    );
  });

  test("refuses a calendar-month series without its month-end rule", () => {
    const document = scheduleDocument() as unknown as {
      instruments: Array<{
        actions: Record<
          string,
          { due?: { every?: { period: Record<string, unknown> } } }
        >;
      }>;
    };
    delete document.instruments[0]!.actions.open_period!.due!.every!.period
      .monthEnd;

    const result = validateUdl(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid UDL");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "UDL1003",
        path: "$.instruments[0].actions.open_period.due.every.period",
      }),
    );
  });

  test("refuses overlapping recurring period liabilities", () => {
    const document = scheduleDocument();
    const instrument = document.instruments[0]!;
    instrument.actions.open_other = structuredClone(
      instrument.actions.open_period!,
    );
    instrument.lifecycle.states.push("other_open");
    instrument.lifecycle.transitions.open_other = {
      from: ["active"],
      to: "other_open",
    };

    expect(scheduleMessages(document)).toContain(
      "recurring due actions open_period and open_other overlap period liability in states active",
    );
  });

  test("requires the recurring collection parent delinquency policy", () => {
    const document = scheduleDocument();
    delete document.instruments[0]!.actions.open_period!.due!.every!
      .delinquency;

    expect(scheduleMessages(document)).toContain(
      "one-open recurrence must reuse delinquency parent_policy",
    );
  });

  test("refuses port and stored-date termination without a drain proof", () => {
    const port = scheduleDocument();
    delete port.instruments[0]!.actions.open_period!.due!.every!.drainAction;
    expect(scheduleMessages(port)).toContain(
      "open-ended recurrence must declare its drain action",
    );
  });
});
