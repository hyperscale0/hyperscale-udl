import * as z from "zod";
import { udlObjectIdSchema, type UdlField } from "./schema.js";

const amount = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const text = z.string().min(1).max(2048);

/** Values, rather than declarations. The same validator feeds forms and admission. */
export function udlFieldValueSchema(field: UdlField): z.ZodType {
  let schema: z.ZodType;
  switch (field.type) {
    case "money":
      schema = amount
        .refine(
          (value) =>
            /^(0|[1-9][0-9]{0,17})$/.test(value) &&
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
      schema = z.iso.datetime({ offset: true });
      break;
    case "duration":
      schema = z.number().int().safe().positive();
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
      let value = z.number().int().safe();
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
            ? z.iso.datetime({ offset: true })
            : field.item === "integer"
              ? z.number().int().safe()
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
