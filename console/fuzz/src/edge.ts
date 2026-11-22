/**
 * Deliberately awkward values injected into generated data, and the JSON pointer where each
 * one landed.
 */
export const kinds = [
  "long-string",
  "empty",
  "rtl",
  "whitespace",
  "emoji",
  "markup",
  "negative",
  "zero",
  "huge-number",
  "many-items",
] as const;
export type Kind = (typeof kinds)[number];

/** `path` is an RFC 6901 JSON pointer into the case value (`""` = the value itself). */
export interface Edge {
  readonly kind: Kind;
  readonly path: string;
}

/** Escapes one JSON pointer segment (RFC 6901). */
export const escape = (segment: string | number) =>
  String(segment).replace(/~/g, "~0").replace(/\//g, "~1");

export const prefix = (edges: ReadonlyArray<Edge>, segment: string | number): ReadonlyArray<Edge> =>
  edges.map((edge) => ({ kind: edge.kind, path: `/${escape(segment)}${edge.path}` }));

/** Length in Unicode code points (the unit JSON Schema uses for min/maxLength). */
export const length = (value: string) => Array.from(value).length;

/** Repeats `base` up to `min` code points and truncates to `max`. */
export const fit = (base: string, min: number, max: number): string | undefined => {
  if (base === "" || max < min) return undefined;
  let points = Array.from(base);
  while (points.length < min) points = points.concat(Array.from(base));
  return points.slice(0, Math.max(min, Math.min(max, points.length))).join("");
};

const lorem =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";

/** Candidate strings per kind; the compiler fits each to the schema's length bounds. */
export const strings: Readonly<Partial<Record<Kind, ReadonlyArray<string>>>> = {
  "long-string": [lorem],
  rtl: ["مرحبا بالعالم", "שלום עולם", "سلام 123 עברית", "\u202Eabc\u202C"],
  whitespace: [" ", "\t", "  leading and trailing  ", "\u00A0\u2003", "line\nbreak"],
  emoji: [
    "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
    "\u{1F3F3}\uFE0F\u200D\u{1F308}",
    "e\u0301\u0301",
    "\u{1F642}\u{1F642}\u{1F642}",
  ],
  markup: [
    "<b>bold</b>",
    "<script>alert(1)</script>",
    '"><img src=x onerror=alert(1)>',
    "&amp;&lt;",
  ],
};

/** Default length of an unbounded `long-string`. */
export const longLength = 2000;
/** Default length of an unbounded `many-items` array. */
export const manyLength = 50;

const rtl = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u202E]/u;
const emoji = /\p{Extended_Pictographic}|\p{M}/u;
const markup = /<[a-z!/]|&[a-z]+;/i;

/**
 * Finds awkward values of the given kinds anywhere in `value`. Used for sources given as a
 * plain fast-check arbitrary, where injected values cannot be tracked.
 */
export const classify = (value: unknown, wanted: ReadonlySet<Kind>, path = ""): Array<Edge> => {
  const found: Array<Edge> = [];
  const add = (kind: Kind) => {
    if (wanted.has(kind)) found.push({ kind, path });
  };
  if (typeof value === "string") {
    if (value === "") add("empty");
    if (length(value) >= 256) add("long-string");
    if (rtl.test(value)) add("rtl");
    if (value !== "" && value.trim() !== value) add("whitespace");
    if (emoji.test(value)) add("emoji");
    if (markup.test(value)) add("markup");
  } else if (typeof value === "number") {
    if (value < 0) add("negative");
    if (value === 0) add("zero");
    if (!Number.isFinite(value) || Math.abs(value) >= 2 ** 31) add("huge-number");
  } else if (Array.isArray(value)) {
    if (value.length === 0) add("empty");
    if (value.length >= manyLength) add("many-items");
    value.forEach((item: unknown, index) => {
      found.push(...classify(item, wanted, `${path}/${index}`));
    });
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value))
      found.push(...classify(item, wanted, `${path}/${escape(key)}`));
  }
  return found;
};
