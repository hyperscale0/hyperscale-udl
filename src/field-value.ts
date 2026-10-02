import * as z from "zod";
import { udlObjectIdSchema, type UdlField } from "./schema.js";
import { amount, integer, isMinorUnits, text } from "./primitives.js";

// HSX dates are instants; say so when a caller sends a calendar date.
const dateTime = z.iso.datetime({
  offset: true,
  error:
    "A date field takes an ISO 8601 date-time with an offset, such as 2026-12-01T00:00:00Z",
});

/** Values, rather than declarations. The same validator feeds forms and admission. */
export function udlFieldValueSchema(field: UdlField): z.ZodType {
  let schema: z.ZodType;
  switch (field.type) {
    case "money":
      schema = amount
        .refine(
          (value) =>
            isMinorUnits(value) &&
            (field.minimum === undefined ||
              BigInt(value) >= BigInt(field.minimum)) &&
            (field.maximum === undefined ||
              BigInt(value) <= BigInt(field.maximum)),
          "Money is outside its declared bounds",
        )
        .meta({
          ...(field.minimum !== undefined
            ? { "x-udl-minimum": field.minimum }
            : {}),
          ...(field.maximum !== undefined
            ? { "x-udl-maximum": field.maximum }
            : {}),
        });
      break;
    case "account":
      schema = text;
      break;
    case "ref":
      schema = field.targetKind === "object" ? udlObjectIdSchema : text;
      break;
    case "date":
      schema = dateTime;
      break;
    case "duration":
      schema = integer.positive();
      break;
    case "text": {
      let value = z
        .string()
        .min(field.minLength ?? 1)
        .max(field.maxLength ?? 2048);
      if (field.pattern) value = value.regex(new RegExp(field.pattern));
      schema = value;
      break;
    }
    case "integer": {
      let value = integer;
      if (field.minimum !== undefined) value = value.min(field.minimum);
      if (field.maximum !== undefined) value = value.max(field.maximum);
      schema = value;
      break;
    }
    case "percent":
      schema = z.number().int().min(0).max(10000);
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "enum":
      schema = z.enum(field.values);
      break;
    case "list": {
      const item =
        field.item === "money"
          ? amount
          : field.item === "date"
            ? dateTime
            : field.item === "integer"
              ? integer
              : field.item === "ref" && field.targetKind === "object"
                ? udlObjectIdSchema
                : text;
      schema = z.array(item).max(field.maxItems);
      break;
    }
  }
  if ("value" in field && field.value !== undefined)
    schema = z.literal(field.value);
  if (field.description) schema = schema.describe(field.description);
  return schema;
}
