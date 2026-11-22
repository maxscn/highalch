import { Schema } from "effect";
import type { JsonSchema } from "./schema.ts";

/**
 * Effect Schema to a JSON Schema accepted by `Fuzz.*`. The result describes the schema's
 * canonical JSON encoding (`Schema.toCodecJson(schema)`), so generated values are encoded
 * JSON: decode them with `Schema.decodeUnknownSync(Schema.toCodecJson(schema))`.
 * Identified schemas become `$defs` entries referenced with `$ref`.
 */
export const fromEffect = <S extends Schema.Constraint>(schema: S): JsonSchema<S["Encoded"]> => {
  const document = Schema.toJsonSchemaDocument(schema);
  const identifier = Schema.resolveAnnotations(schema)?.identifier;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(typeof identifier === "string" && document.schema.title === undefined
      ? { title: identifier }
      : {}),
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
};
