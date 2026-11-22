import * as fc from "fast-check";
import { Schema } from "effect";
import * as Edge from "./edge.ts";

/**
 * A JSON Schema (draft 2020-12, with draft-07 `definitions`/array `items` and OpenAPI
 * `nullable` accepted). `T` is a phantom type for the generated (JSON) value.
 */
export interface JsonSchema<out T = unknown> {
  readonly [keyword: string]: unknown;
  /** Phantom marker carrying the value type; never present at runtime. */
  readonly "~value"?: T;
}

/** The schema uses a keyword this generator does not implement. */
export class UnsupportedKeyword extends Schema.TaggedError<UnsupportedKeyword>()(
  "UnsupportedKeyword",
  {
    keyword: Schema.String,
    /** JSON pointer to the schema object containing the keyword. */
    pointer: Schema.String,
    message: Schema.String,
  },
) {}

/** The schema is malformed or unsatisfiable (e.g. `minimum > maximum`, a bad `$ref`). */
export class InvalidSchema extends Schema.TaggedError<InvalidSchema>()("InvalidSchema", {
  pointer: Schema.String,
  message: Schema.String,
}) {}

/** Keywords that shape generation. */
export const supported: ReadonlyArray<string> = [
  "type",
  "nullable",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "$ref",
  "$defs",
  "definitions",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
];

/** Keywords that never affect generation (plus any `x-*` vendor extension). */
export const annotations: ReadonlyArray<string> = [
  "$schema",
  "$id",
  "$comment",
  "$anchor",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
  "contentEncoding",
  "contentMediaType",
];

/** Supported `format` values. */
export const formats: ReadonlyArray<string> = [
  "date-time",
  "date",
  "time",
  "email",
  "uuid",
  "uri",
  "url",
  "uri-reference",
  "iri",
  "hostname",
  "ipv4",
  "ipv6",
];

/** A generated value with the edges it contains (pointers relative to the value). */
export interface Tagged {
  readonly value: unknown;
  readonly edges: ReadonlyArray<Edge.Edge>;
}

type Node = { readonly [keyword: string]: unknown };
type Arb = fc.Arbitrary<Tagged>;

interface Ctx {
  readonly root: Node;
  readonly edges: ReadonlySet<Edge.Kind>;
  readonly tie: (ref: string) => Arb;
  readonly need: (ref: string, pointer: string) => void;
  readonly depth: fc.DepthIdentifier;
  readonly recursive: boolean;
  readonly cyclic: ReadonlySet<string>;
  readonly nest: Nesting;
}

/** Shared recursion depth of one compiled schema, counted through recursive `$ref`s. */
interface Nesting {
  depth: number;
}

/** Deepest recursive `$ref` nesting before arrays, optionals and unions take their smallest form. */
export const maxDepth = 4;

/** Counts recursion depth while generating through a recursive `$ref`. */
class Nest extends fc.Arbitrary<Tagged> {
  constructor(
    private readonly inner: Arb,
    private readonly state: Nesting,
  ) {
    super();
  }
  generate(mrng: fc.Random, bias: number | undefined): fc.Value<Tagged> {
    this.state.depth++;
    try {
      return this.inner.generate(mrng, bias);
    } finally {
      this.state.depth--;
    }
  }
  canShrinkWithoutContext(value: unknown): value is Tagged {
    return this.inner.canShrinkWithoutContext(value);
  }
  shrink(value: Tagged, context: unknown): fc.Stream<fc.Value<Tagged>> {
    return this.inner.shrink(value, context);
  }
}

/** Generates from `shallow` once the recursion depth limit is reached, else from `normal`. */
class Guard<T> extends fc.Arbitrary<T> {
  constructor(
    private readonly normal: fc.Arbitrary<T>,
    private readonly shallow: fc.Arbitrary<T>,
    private readonly state: Nesting,
  ) {
    super();
  }
  generate(mrng: fc.Random, bias: number | undefined): fc.Value<T> {
    const deep = this.state.depth >= maxDepth;
    const value = (deep ? this.shallow : this.normal).generate(mrng, bias);
    return new fc.Value(value.value_, { deep, inner: value.context });
  }
  canShrinkWithoutContext(_value: unknown): _value is T {
    return false;
  }
  shrink(value: T, context: unknown): fc.Stream<fc.Value<T>> {
    if (typeof context !== "object" || context === null || !("deep" in context))
      return fc.Stream.nil();
    const { deep, inner } = context as { deep: boolean; inner: unknown };
    return (deep ? this.shallow : this.normal)
      .shrink(value, inner)
      .map((next) => new fc.Value(next.value_, { deep, inner: next.context }));
  }
}

const guard = <T>(ctx: Ctx, normal: fc.Arbitrary<T>, shallow: fc.Arbitrary<T>): fc.Arbitrary<T> =>
  ctx.recursive ? new Guard(normal, shallow, ctx.nest) : normal;

const known = new Set([...supported, ...annotations]);
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const plain = <A>(arb: fc.Arbitrary<A>): Arb => arb.map((value) => ({ value, edges: [] }));
const json = (): Arb => plain(fc.jsonValue({ maxDepth: 2 }));
const tagged = (kind: Edge.Kind, value: unknown): Tagged => ({
  value,
  edges: [{ kind, path: "" }],
});

const num = (node: Node, key: string, pointer: string): number | undefined => {
  const value = node[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new InvalidSchema({ pointer, message: `${key} must be a finite number` });
  return value;
};
const count = (node: Node, key: string, pointer: string): number | undefined => {
  const value = num(node, key, pointer);
  if (value !== undefined && (!Number.isInteger(value) || value < 0))
    throw new InvalidSchema({ pointer, message: `${key} must be a non-negative integer` });
  return value;
};

/** Injects edge arbitraries next to the normal one (about 1 in 5 values is an edge). */
const inject = (normal: Arb, edges: ReadonlyArray<Arb>): Arb =>
  edges.length === 0
    ? normal
    : fc.oneof({ arbitrary: normal, weight: 4 }, { arbitrary: fc.oneof(...edges), weight: 1 });

const unique = <A>(values: ReadonlyArray<A>) =>
  values.filter((value, index) => values.findIndex((other) => Object.is(other, value)) === index);

const resolve = (root: Node, ref: string, pointer: string): Node | boolean => {
  if (ref === "#") return root;
  const found = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!found)
    throw new UnsupportedKeyword({
      keyword: "$ref",
      pointer,
      message: `$ref "${ref}" is not supported; only "#", "#/$defs/<name>" and "#/definitions/<name>" are`,
    });
  const defs = root[found[1] ?? ""];
  const name = (found[2] ?? "").replace(/~1/g, "/").replace(/~0/g, "~");
  const target = isNode(defs) ? defs[name] : undefined;
  if (!isNode(target) && typeof target !== "boolean")
    throw new InvalidSchema({ pointer, message: `$ref "${ref}" does not resolve` });
  return target;
};

const refs = (value: unknown, out: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(value)) for (const item of value) refs(item, out);
  else if (isNode(value))
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") out.add(item);
      else if (key !== "$defs" && key !== "definitions") refs(item, out);
    }
  return out;
};

/** Refs that can reach themselves through other refs. */
const cycles = (root: Node): ReadonlySet<string> => {
  const edges = new Map<string, ReadonlySet<string>>();
  const walk = (ref: string) => {
    if (edges.has(ref)) return;
    let target: Node | boolean;
    try {
      target = resolve(root, ref, "");
    } catch {
      edges.set(ref, new Set());
      return;
    }
    const next = refs(target);
    edges.set(ref, next);
    for (const item of next) walk(item);
  };
  walk("#");
  const out = new Set<string>();
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    const stack = [...(edges.get(start) ?? [])];
    while (stack.length > 0) {
      const ref = stack.pop() ?? "";
      if (ref === start) {
        out.add(start);
        break;
      }
      if (seen.has(ref)) continue;
      seen.add(ref);
      stack.push(...(edges.get(ref) ?? []));
    }
  }
  return out;
};

const check = (node: Node, pointer: string) => {
  for (const key of Object.keys(node))
    if (!known.has(key) && !key.startsWith("x-"))
      throw new UnsupportedKeyword({
        keyword: key,
        pointer,
        message: `JSON Schema keyword "${key}" at "${pointer || "/"}" is not supported`,
      });
};

const strings = (node: Node, pointer: string, ctx: Ctx): Arb => {
  const min = count(node, "minLength", pointer) ?? 0;
  const max = count(node, "maxLength", pointer);
  if (max !== undefined && max < min)
    throw new InvalidSchema({ pointer, message: "maxLength is less than minLength" });
  const sized = (arb: fc.Arbitrary<string>) =>
    node.minLength === undefined && node.maxLength === undefined
      ? arb
      : arb.filter((value) => {
          const n = Edge.length(value);
          return n >= min && (max === undefined || n <= max);
        });
  const format = node.format;
  if (format !== undefined) {
    if (typeof format !== "string" || !formats.includes(format))
      throw new UnsupportedKeyword({
        keyword: "format",
        pointer,
        message: `format ${JSON.stringify(format)} at "${pointer || "/"}" is not supported`,
      });
    const date = fc
      .date({
        min: new Date("1970-01-01T00:00:00.000Z"),
        max: new Date("2099-12-31T23:59:59.999Z"),
        noInvalidDate: true,
      })
      .map((value) => value.toISOString());
    const generators: Readonly<Record<string, () => fc.Arbitrary<string>>> = {
      "date-time": () => date,
      date: () => date.map((value) => value.slice(0, 10)),
      time: () => date.map((value) => value.slice(11)),
      email: () => fc.emailAddress(),
      uuid: () => fc.uuid(),
      uri: () => fc.webUrl(),
      url: () => fc.webUrl(),
      "uri-reference": () => fc.webUrl(),
      iri: () => fc.webUrl(),
      hostname: () => fc.domain(),
      ipv4: () => fc.ipV4(),
      ipv6: () => fc.ipV6(),
    };
    return plain(sized((generators[format] ?? (() => fc.string()))()));
  }
  if (node.pattern !== undefined) {
    if (typeof node.pattern !== "string")
      throw new InvalidSchema({ pointer, message: "pattern must be a string" });
    let regex: RegExp;
    try {
      regex = new RegExp(node.pattern);
    } catch (cause) {
      throw new InvalidSchema({ pointer, message: `invalid pattern: ${String(cause)}` });
    }
    return plain(sized(fc.stringMatching(regex)));
  }
  const normal = plain(
    fc.string(max === undefined ? { minLength: min } : { minLength: min, maxLength: max }),
  );
  const upper = max ?? Number.POSITIVE_INFINITY;
  const edges: Array<Arb> = [];
  if (ctx.edges.has("empty") && min === 0) edges.push(fc.constant(tagged("empty", "")));
  if (ctx.edges.has("long-string")) {
    const target = Math.max(min, max ?? Edge.longLength);
    const value =
      target > 0 ? Edge.fit(Edge.strings["long-string"]?.[0] ?? "x", target, target) : undefined;
    if (value !== undefined) edges.push(fc.constant(tagged("long-string", value)));
  }
  for (const kind of ["rtl", "whitespace", "emoji", "markup"] as const) {
    if (!ctx.edges.has(kind)) continue;
    const values = unique(
      (Edge.strings[kind] ?? []).flatMap((base) => {
        const value = Edge.fit(base, min, upper);
        return value === undefined ? [] : [value];
      }),
    );
    if (values.length > 0)
      edges.push(fc.constantFrom(...values).map((value) => tagged(kind, value)));
  }
  return inject(normal, edges);
};

const numbers = (node: Node, pointer: string, ctx: Ctx, integer: boolean): Arb => {
  const exMinRaw = node.exclusiveMinimum;
  const exMaxRaw = node.exclusiveMaximum;
  const minimum = num(node, "minimum", pointer);
  const maximum = num(node, "maximum", pointer);
  // Draft-04 boolean exclusivity modifies minimum/maximum.
  const exMin = exMinRaw === true ? minimum : typeof exMinRaw === "number" ? exMinRaw : undefined;
  const exMax = exMaxRaw === true ? maximum : typeof exMaxRaw === "number" ? exMaxRaw : undefined;
  if (exMinRaw !== undefined && typeof exMinRaw !== "number" && typeof exMinRaw !== "boolean")
    throw new InvalidSchema({ pointer, message: "exclusiveMinimum must be a number" });
  if (exMaxRaw !== undefined && typeof exMaxRaw !== "number" && typeof exMaxRaw !== "boolean")
    throw new InvalidSchema({ pointer, message: "exclusiveMaximum must be a number" });
  const lowInclusive = exMinRaw === true ? undefined : minimum;
  const highInclusive = exMaxRaw === true ? undefined : maximum;
  const step = num(node, "multipleOf", pointer);
  if (step !== undefined && step <= 0)
    throw new InvalidSchema({ pointer, message: "multipleOf must be positive" });
  const inRange = (value: number) =>
    (lowInclusive === undefined || value >= lowInclusive) &&
    (highInclusive === undefined || value <= highInclusive) &&
    (exMin === undefined || value > exMin) &&
    (exMax === undefined || value < exMax) &&
    (!integer || Number.isSafeInteger(value)) &&
    (step === undefined || Math.abs(value / step - Math.round(value / step)) < 1e-9);

  let normal: fc.Arbitrary<number>;
  if (integer || step !== undefined) {
    const unit = step ?? 1;
    const lowBound = Math.max(
      lowInclusive ?? Number.NEGATIVE_INFINITY,
      exMin === undefined
        ? Number.NEGATIVE_INFINITY
        : integer && step === undefined
          ? Math.floor(exMin) + 1
          : exMin,
    );
    const highBound = Math.min(
      highInclusive ?? Number.POSITIVE_INFINITY,
      exMax === undefined
        ? Number.POSITIVE_INFINITY
        : integer && step === undefined
          ? Math.ceil(exMax) - 1
          : exMax,
    );
    const k0 = Math.max(Math.ceil(lowBound / unit), -(2 ** 31));
    const k1 = Math.min(Math.floor(highBound / unit), 2 ** 31 - 1);
    if (k0 > k1) throw new InvalidSchema({ pointer, message: "numeric range is empty" });
    normal = fc
      .integer({ min: k0, max: k1 })
      .map((k) => k * unit)
      .filter(inRange);
  } else {
    const low = lowInclusive ?? exMin;
    const high = highInclusive ?? exMax;
    if (low !== undefined && high !== undefined && low > high)
      throw new InvalidSchema({ pointer, message: "numeric range is empty" });
    normal = fc.double({
      noNaN: true,
      noDefaultInfinity: true,
      ...(low === undefined
        ? {}
        : { min: low, minExcluded: exMin !== undefined && lowInclusive === undefined }),
      ...(high === undefined
        ? {}
        : { max: high, maxExcluded: exMax !== undefined && highInclusive === undefined }),
    });
  }
  normal = normal.map((value) => (Object.is(value, -0) ? 0 : value));
  const bounds = [lowInclusive, highInclusive].filter((value) => value !== undefined);
  const candidates: Readonly<Record<"negative" | "zero" | "huge-number", ReadonlyArray<number>>> = {
    negative: integer ? [-1, ...bounds] : [-1, -0.5, ...bounds],
    zero: [0],
    "huge-number": integer
      ? [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, ...bounds]
      : [1e21, -1e21, Number.MAX_VALUE, -Number.MAX_VALUE, ...bounds],
  };
  const edges: Array<Arb> = [];
  for (const kind of ["negative", "zero", "huge-number"] as const) {
    if (!ctx.edges.has(kind)) continue;
    const values = unique(
      candidates[kind].filter(
        (value) =>
          inRange(value) &&
          (kind === "negative"
            ? value < 0
            : kind === "zero"
              ? value === 0
              : Math.abs(value) >= 2 ** 31),
      ),
    );
    if (values.length > 0)
      edges.push(fc.constantFrom(...values).map((value) => tagged(kind, value)));
  }
  return inject(plain(normal), edges);
};

const combineArray = (items: ReadonlyArray<Tagged>): Tagged => ({
  value: items.map((item) => item.value),
  edges: items.flatMap((item, index) => Edge.prefix(item.edges, index)),
});

const arrays = (node: Node, pointer: string, ctx: Ctx): Arb => {
  const min = count(node, "minItems", pointer) ?? 0;
  const max = count(node, "maxItems", pointer);
  if (max !== undefined && max < min)
    throw new InvalidSchema({ pointer, message: "maxItems is less than minItems" });
  const tuple = Array.isArray(node.prefixItems)
    ? { key: "prefixItems", list: node.prefixItems as ReadonlyArray<unknown> }
    : Array.isArray(node.items)
      ? { key: "items", list: node.items as ReadonlyArray<unknown> }
      : { key: "prefixItems", list: [] as ReadonlyArray<unknown> };
  const prefix = tuple.list
    .slice(0, max ?? tuple.list.length)
    .map((item, index) => compile(item, `${pointer}/${tuple.key}/${index}`, ctx));
  const restSchema = Array.isArray(node.items) ? false : node.items;
  const rest: Arb | undefined =
    restSchema === false
      ? undefined
      : restSchema === undefined
        ? json()
        : compile(restSchema, `${pointer}/items`, ctx);
  const restMin = Math.max(0, min - prefix.length);
  const restMax = max === undefined ? undefined : Math.max(0, max - prefix.length);
  if (rest === undefined && restMin > 0)
    throw new InvalidSchema({ pointer, message: "minItems exceeds the tuple length" });
  const uniqueItems = node.uniqueItems === true;
  const list = (item: Arb, minLength: number, maxLength: number | undefined) => {
    const constraints = {
      minLength,
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(ctx.recursive ? { depthIdentifier: ctx.depth } : {}),
    };
    return uniqueItems
      ? fc.uniqueArray(item, { ...constraints, selector: (t) => JSON.stringify(t.value) })
      : fc.array(item, constraints);
  };
  const restArb =
    rest === undefined || restMax === 0
      ? fc.constant([])
      : guard(ctx, list(rest, restMin, restMax), list(rest, restMin, restMin));
  const normal = fc
    .tuple(fc.tuple(...prefix), restArb)
    .map(([head, tail]) => combineArray([...head, ...tail]));
  const edges: Array<Arb> = [];
  if (ctx.edges.has("empty") && min === 0 && prefix.length === 0)
    edges.push(fc.constant(tagged("empty", [])));
  if (ctx.edges.has("many-items") && rest !== undefined && !uniqueItems && !ctx.recursive) {
    const n = Math.min(Math.max(Edge.manyLength, restMin), restMax ?? Edge.manyLength);
    if (n >= 2 && n > restMin)
      edges.push(
        fc
          .tuple(fc.tuple(...prefix), fc.array(rest, { minLength: n, maxLength: n }))
          .map(([head, tail]) => {
            const combined = combineArray([...head, ...tail]);
            return {
              value: combined.value,
              edges: [{ kind: "many-items" as const, path: "" }, ...combined.edges],
            };
          }),
      );
  }
  return inject(normal, edges);
};

const objects = (node: Node, pointer: string, ctx: Ctx): Arb => {
  const properties = node.properties ?? {};
  if (!isNode(properties))
    throw new InvalidSchema({ pointer, message: "properties must be an object" });
  const required = node.required ?? [];
  if (!Array.isArray(required) || !required.every((key) => typeof key === "string"))
    throw new InvalidSchema({ pointer, message: "required must be an array of strings" });
  const declared = new Set(Object.keys(properties));
  const fields: Array<fc.Arbitrary<readonly [string, Tagged] | undefined>> = [];
  for (const [key, schema] of Object.entries(properties)) {
    const child = compile(schema, `${pointer}/properties/${Edge.escape(key)}`, ctx).map(
      (value) => [key, value] as const,
    );
    fields.push(
      required.includes(key)
        ? child
        : guard(
            ctx,
            fc.option(child, {
              nil: undefined,
              ...(ctx.recursive ? { depthIdentifier: ctx.depth } : {}),
            }),
            fc.constant(undefined),
          ),
    );
  }
  for (const key of required as ReadonlyArray<string>)
    if (!declared.has(key)) fields.push(json().map((value) => [key, value] as const));
  const extras: Array<fc.Arbitrary<ReadonlyArray<readonly [string, Tagged]>>> = [];
  const free = (key: string) => !declared.has(key) && key !== "__proto__";
  const dictionary = (keys: fc.Arbitrary<string>, value: Arb) =>
    guard(
      ctx,
      fc.uniqueArray(fc.tuple(keys.filter(free), value), {
        maxLength: 3,
        selector: ([key]) => key,
        ...(ctx.recursive ? { depthIdentifier: ctx.depth } : {}),
      }),
      fc.constant<Array<[string, Tagged]>>([]),
    ).map((entries) => entries as ReadonlyArray<readonly [string, Tagged]>);
  if (node.patternProperties !== undefined) {
    if (!isNode(node.patternProperties))
      throw new InvalidSchema({ pointer, message: "patternProperties must be an object" });
    for (const [pattern, schema] of Object.entries(node.patternProperties)) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (cause) {
        throw new InvalidSchema({ pointer, message: `invalid pattern: ${String(cause)}` });
      }
      extras.push(
        dictionary(
          fc.stringMatching(regex),
          compile(schema, `${pointer}/patternProperties/${Edge.escape(pattern)}`, ctx),
        ),
      );
    }
  }
  if (isNode(node.additionalProperties) || node.additionalProperties === true) {
    if (isNode(node.additionalProperties) && Object.keys(node.additionalProperties).length > 0)
      extras.push(
        dictionary(
          fc.string({ minLength: 1, maxLength: 12 }),
          compile(node.additionalProperties, `${pointer}/additionalProperties`, ctx),
        ),
      );
  } else if (node.additionalProperties !== undefined && node.additionalProperties !== false)
    throw new InvalidSchema({
      pointer,
      message: "additionalProperties must be a boolean or schema",
    });
  return fc.tuple(fc.tuple(...fields), ...extras).map(([fixed, ...rest]) => {
    const entries = [...fixed.filter((entry) => entry !== undefined), ...rest.flat()];
    const seen = new Set<string>();
    const kept = entries.filter(([key]) => !seen.has(key) && seen.add(key) !== undefined);
    return {
      value: Object.fromEntries(kept.map(([key, item]) => [key, item.value])),
      edges: kept.flatMap(([key, item]) => Edge.prefix(item.edges, key)),
    };
  });
};

const types = ["null", "boolean", "integer", "number", "string", "array", "object"] as const;
type Type = (typeof types)[number];

const infer = (node: Node): ReadonlyArray<Type> => {
  const has = (...keys: ReadonlyArray<string>) => keys.some((key) => node[key] !== undefined);
  if (has("properties", "required", "additionalProperties", "patternProperties")) return ["object"];
  if (has("items", "prefixItems", "minItems", "maxItems", "uniqueItems")) return ["array"];
  if (has("minLength", "maxLength", "pattern", "format")) return ["string"];
  if (has("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"))
    return ["number"];
  return [];
};

const generators: Readonly<Record<Type, (node: Node, pointer: string, ctx: Ctx) => Arb>> = {
  null: () => fc.constant({ value: null, edges: [] }),
  boolean: () => plain(fc.boolean()),
  integer: (node, pointer, ctx) => numbers(node, pointer, ctx, true),
  number: (node, pointer, ctx) => numbers(node, pointer, ctx, false),
  string: strings,
  array: arrays,
  object: objects,
};

const structural = new Set(supported.filter((key) => key !== "$defs" && key !== "definitions"));

/** Compiles a (sub)schema into an arbitrary of tagged values. */
const compile = (schema: unknown, pointer: string, ctx: Ctx): Arb => {
  if (schema === true) return json();
  if (schema === false)
    throw new InvalidSchema({ pointer, message: "false schema accepts no value" });
  if (!isNode(schema))
    throw new InvalidSchema({ pointer, message: "schema must be an object or boolean" });
  check(schema, pointer);

  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string")
      throw new InvalidSchema({ pointer, message: "$ref must be a string" });
    const sibling = Object.keys(schema).find((key) => key !== "$ref" && structural.has(key));
    if (sibling !== undefined)
      throw new UnsupportedKeyword({
        keyword: sibling,
        pointer,
        message: `"${sibling}" next to "$ref" at "${pointer || "/"}" is not supported`,
      });
    ctx.need(schema.$ref, pointer);
    return ctx.cyclic.has(schema.$ref)
      ? new Nest(ctx.tie(schema.$ref), ctx.nest)
      : ctx.tie(schema.$ref);
  }

  const nullable = schema.nullable === true;
  const wrap = (arb: Arb) =>
    nullable ? fc.oneof(arb, fc.constant<Tagged>({ value: null, edges: [] })) : arb;

  if (schema.const !== undefined) return wrap(fc.constant({ value: schema.const, edges: [] }));
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0)
      throw new InvalidSchema({ pointer, message: "enum must be a non-empty array" });
    return wrap(plain(fc.constantFrom(...(schema.enum as ReadonlyArray<unknown>))));
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0)
      throw new InvalidSchema({ pointer, message: `${key} must be a non-empty array` });
    const sibling = Object.keys(schema).find(
      (other) => other !== key && other !== "nullable" && structural.has(other),
    );
    if (sibling !== undefined)
      throw new UnsupportedKeyword({
        keyword: sibling,
        pointer,
        message: `"${sibling}" next to "${key}" at "${pointer || "/"}" is not supported`,
      });
    const arbs = (branches as ReadonlyArray<unknown>).map((branch, index) =>
      compile(branch, `${pointer}/${key}/${index}`, ctx),
    );
    return wrap(
      ctx.recursive
        ? guard(
            ctx,
            fc.oneof({ depthIdentifier: ctx.depth, maxDepth: 8 }, ...arbs),
            arbs[0] ?? json(),
          )
        : fc.oneof(...arbs),
    );
  }

  const declared = schema.type;
  const list: ReadonlyArray<unknown> =
    declared === undefined ? infer(schema) : Array.isArray(declared) ? declared : [declared];
  for (const type of list)
    if (typeof type !== "string" || !(types as ReadonlyArray<string>).includes(type))
      throw new InvalidSchema({ pointer, message: `unknown type ${JSON.stringify(type)}` });
  const typed = list as ReadonlyArray<Type>;
  if (typed.length === 0) return wrap(json());
  const arbs = typed.map((type) => generators[type](schema, pointer, ctx));
  return wrap(arbs.length === 1 ? (arbs[0] ?? json()) : fc.oneof(...arbs));
};

/**
 * Compiles a JSON Schema into an arbitrary of values tagged with their edges.
 * Throws {@link UnsupportedKeyword} or {@link InvalidSchema} eagerly.
 */
export const build = (schema: JsonSchema, edges: ReadonlySet<Edge.Kind>): Arb => {
  if (!isNode(schema))
    throw new InvalidSchema({ pointer: "", message: "schema must be an object" });
  const recursive = cycles(schema);
  const depth = fc.createDepthIdentifier();
  const nest: Nesting = { depth: 0 };
  const built = fc.letrec((tie) => {
    const out: Record<string, Arb> = {};
    const queue: Array<string> = [];
    const ctx = (rec: boolean): Ctx => ({
      root: schema,
      edges,
      tie: (ref) => tie(ref) as Arb,
      need: (ref, pointer) => {
        resolve(schema, ref, pointer);
        if (!(ref in out) && !queue.includes(ref)) queue.push(ref);
      },
      depth,
      recursive: rec,
      cyclic: recursive,
      nest,
    });
    out["#"] = compile(schema, "", ctx(recursive.has("#")));
    while (queue.length > 0) {
      const ref = queue.shift() ?? "#";
      if (ref in out) continue;
      const pointer = ref.slice(1);
      out[ref] = compile(resolve(schema, ref, ""), pointer, ctx(recursive.has(ref)));
    }
    return out;
  });
  const root = built["#"];
  if (root === undefined)
    throw new InvalidSchema({ pointer: "", message: "schema did not compile" });
  return root;
};
