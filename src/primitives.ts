import * as z from "zod";

const minorUnits = /^(0|[1-9][0-9]{0,17})$/;

export const name = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]*$/)
  .max(80);
export const text = z.string().min(1).max(2048);
export const amount = z.string().regex(minorUnits);
export const integer = z.number().int().safe();
export const path = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*$/)
  .max(240);

/** True for a money amount in minor units. Guard every BigInt() of an unchecked amount with it. */
export const isMinorUnits = (value: string): boolean => minorUnits.test(value);

/** Reads only the record's own keys, so names like `constructor` never reach the prototype. */
export function own<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

export const targetIds = (target: string | string[]): string[] =>
  typeof target === "string" ? [target] : target;
