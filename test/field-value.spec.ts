import { expect, test } from "bun:test";
import { udlFieldValueSchema } from "../src/index.js";

test("a date field names the date-time shape it takes", () => {
  const schema = udlFieldValueSchema({ name: "departure", type: "date" });
  expect(schema.safeParse("2026-12-01T00:00:00Z").success).toBe(true);
  const refused = schema.safeParse("2026-12-01");
  expect(refused.success).toBe(false);
  expect(refused.error?.issues[0]?.message).toContain("2026-12-01T00:00:00Z");
});
