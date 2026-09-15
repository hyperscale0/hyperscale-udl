/** Read the sealed ID grammar without executing document-authored patterns. */
export function referencePatternPrefix(
  schema: Readonly<Record<string, unknown>>,
): string | undefined {
  if (schema.type !== "string" || typeof schema.pattern !== "string")
    return undefined;
  const match = /^\^([a-z]{2,8})_\(sandbox\|live\)_\[a-z0-9\]\{8,64\}\$$/.exec(
    schema.pattern,
  );
  const prefix = match?.[1];
  if (!prefix) return undefined;
  const min = typeof schema.minLength === "number" ? schema.minLength : 0;
  const max =
    typeof schema.maxLength === "number" ? schema.maxLength : Infinity;
  if (min > prefix.length + 73 || max < prefix.length + 14 || min > max)
    return undefined;
  const validId = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    const id = /^([a-z]{2,8})_(sandbox|live)_([a-z0-9]{8,64})$/.exec(value);
    return id?.[1] === prefix && value.length >= min && value.length <= max;
  };
  if (schema.const !== undefined && !validId(schema.const)) return undefined;
  if (
    Array.isArray(schema.enum) &&
    (!schema.enum.length ||
      !schema.enum.every(validId) ||
      (schema.const !== undefined && !schema.enum.includes(schema.const)))
  )
    return undefined;
  return prefix;
}
