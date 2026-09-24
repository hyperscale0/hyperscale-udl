import { expect, test } from "bun:test";
import witness from "../spec/cars.udl.json";
import { validateUdl } from "../src/index.js";

test("money destinations must resolve to typed accounts", () => {
  expect(validateUdl(witness).ok).toBe(true);
  const document = structuredClone(witness);
  document.instruments[0]!.actions.fund.moves[0]!.to = "self.price";
  expect(validateUdl(document).ok).toBe(false);
});
