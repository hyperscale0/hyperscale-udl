import * as z from "zod";
import {
  udlDocumentSchema,
  type UdlDocument,
  type UdlInstrument,
} from "./schema.js";

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);
let documentSchema: Schema | undefined;

/** Visit identities through schema annotations, never through user JSON keys. */
export function mapUdlInstrumentReferences(
  document: UdlDocument,
  map: (id: string) => string,
): UdlDocument {
  const root = (documentSchema ??= z.toJSONSchema(udlDocumentSchema));
  const result = structuredClone(document);
  const locations = new Map<
    string,
    { parent: Schema | unknown[]; key: string | number; kind: string }
  >();
  function visit(
    schema: unknown,
    value: unknown,
    parent: Schema | unknown[],
    key: string | number,
    path: readonly (string | number)[],
  ): void {
    if (!object(schema)) return;
    if (typeof schema.$ref === "string") {
      if (!schema.$ref.startsWith("#/"))
        throw new Error("UDL reference schema must be local");
      let target: unknown = root;
      for (const part of schema.$ref.slice(2).split("/")) {
        target = object(target)
          ? target[part.replaceAll("~1", "/").replaceAll("~0", "~")]
          : undefined;
      }
      visit(target, value, parent, key, path);
    }
    const kind = schema["x-udl-reference"];
    if (typeof kind === "string" && typeof value === "string")
      locations.set(JSON.stringify(path), { parent, key, kind });
    for (const union of [schema.anyOf, schema.oneOf, schema.allOf])
      if (Array.isArray(union))
        for (const branch of union) visit(branch, value, parent, key, path);
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visit(schema.items, entry, value, index, [...path, index]),
      );
    } else if (object(value)) {
      const properties = object(schema.properties) ? schema.properties : {};
      const discriminator = object(properties.type)
        ? properties.type.const
        : undefined;
      if (
        (discriminator === "ref" || discriminator === "list") &&
        value.type === discriminator &&
        value.targetKind === "instrument"
      ) {
        if (typeof value.target === "string")
          locations.set(JSON.stringify([...path, "target"]), {
            parent: value,
            key: "target",
            kind: "instrument",
          });
        else if (Array.isArray(value.target))
          value.target.forEach((_, index) =>
            locations.set(JSON.stringify([...path, "target", index]), {
              parent: value.target as unknown[],
              key: index,
              kind: "instrument",
            }),
          );
      }
      for (const [name, entry] of Object.entries(value))
        visit(
          properties[name] ?? schema.additionalProperties,
          entry,
          value,
          name,
          [...path, name],
        );
    }
  }
  visit(root, result, [result], 0, []);
  for (const { parent, key, kind } of locations.values()) {
    const holder = parent as Record<string | number, unknown>;
    const value = holder[key] as string;
    if (kind === "instrument") holder[key] = map(value);
    else if (kind === "instrument_event") {
      const separator = value.indexOf(".");
      holder[key] = map(value.slice(0, separator)) + value.slice(separator);
    }
  }
  return result;
}

export function referencedUdlInstrumentIds(
  instrument: UdlInstrument,
): readonly string[] {
  const found = new Set<string>();
  mapUdlInstrumentReferences(
    {
      udl: 4,
      version: 1,
      product: "references",
      title: "References",
      currency: "SAR",
      parties: {},
      objects: [],
      instruments: [instrument],
    },
    (id) => {
      found.add(id);
      return id;
    },
  );
  found.delete(instrument.id);
  return [...found];
}
