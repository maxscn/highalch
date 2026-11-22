/** JSON with object keys sorted, so equal schemas hash equal whatever their key order. */
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

/** 64-bit FNV-1a of a string's UTF-16 code units, as 16 hex digits (sync, no dependencies). */
export const fnv64 = (text: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
};

/**
 * The generator identity behind snapshot comparison: `s1:<hash>` of the canonical JSON Schema,
 * or `v:<version>` for an explicit version. A raw arbitrary without a version is `unversioned`.
 */
export const schemaHash = (source: unknown, isArbitrary: boolean, version: string | undefined) =>
  version !== undefined
    ? `v:${version}`
    : isArbitrary
      ? "unversioned"
      : `s1:${fnv64(canonical(source))}`;
