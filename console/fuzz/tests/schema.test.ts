import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { Fuzz } from "../src/index.ts";

const sample = <T>(schema: Fuzz.JsonSchema<T>, options: Fuzz.ArbitraryOptions = {}, n = 300) =>
  fc.sample(Fuzz.arbitrary(schema, options), { seed: 1, numRuns: n });
const length = (value: string) => Array.from(value).length;

describe("JSON Schema keywords", () => {
  it("type: null, boolean, integer, number, string, array, object", () => {
    expect(sample({ type: "null" }).every((v) => v === null)).toBe(true);
    expect(sample({ type: "boolean" }).every((v) => typeof v === "boolean")).toBe(true);
    expect(sample({ type: "integer" }).every((v) => Number.isSafeInteger(v))).toBe(true);
    expect(
      sample({ type: "number" }).every((v) => typeof v === "number" && Number.isFinite(v)),
    ).toBe(true);
    expect(sample({ type: "string" }).every((v) => typeof v === "string")).toBe(true);
    expect(sample({ type: "array" }).every((v) => Array.isArray(v))).toBe(true);
    expect(sample({ type: "object" }).every((v) => typeof v === "object" && v !== null)).toBe(true);
  });

  it("type arrays and nullable", () => {
    const values = sample({ type: ["string", "null"] });
    expect(values.every((v) => v === null || typeof v === "string")).toBe(true);
    expect(values.some((v) => v === null)).toBe(true);
    const nullable = sample({ type: "integer", nullable: true });
    expect(nullable.some((v) => v === null)).toBe(true);
    expect(nullable.every((v) => v === null || Number.isInteger(v))).toBe(true);
  });

  it("properties and required", () => {
    const values = sample({
      type: "object",
      properties: { id: { type: "string" }, age: { type: "integer" } },
      required: ["id"],
    }) as ReadonlyArray<Record<string, unknown>>;
    expect(values.every((v) => typeof v.id === "string")).toBe(true);
    expect(values.some((v) => !("age" in v))).toBe(true);
    expect(values.some((v) => typeof v.age === "number")).toBe(true);
    expect(values.every((v) => Object.keys(v).every((k) => k === "id" || k === "age"))).toBe(true);
  });

  it("additionalProperties and patternProperties", () => {
    const record = sample({
      type: "object",
      additionalProperties: { type: "integer" },
    }) as ReadonlyArray<Record<string, unknown>>;
    expect(record.some((v) => Object.keys(v).length > 0)).toBe(true);
    expect(record.every((v) => Object.values(v).every((x) => Number.isInteger(x)))).toBe(true);
    const patterned = sample({
      type: "object",
      patternProperties: { "^x-[a-z]+$": { type: "boolean" } },
    }) as ReadonlyArray<Record<string, unknown>>;
    expect(patterned.some((v) => Object.keys(v).length > 0)).toBe(true);
    expect(
      patterned.every((v) =>
        Object.entries(v).every(([k, x]) => /^x-[a-z]+$/.test(k) && typeof x === "boolean"),
      ),
    ).toBe(true);
  });

  it("items, prefixItems, minItems, maxItems, uniqueItems", () => {
    const bounded = sample({ type: "array", items: { type: "integer" }, minItems: 2, maxItems: 4 });
    expect(
      bounded.every(
        (v) => Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every(Number.isInteger),
      ),
    ).toBe(true);
    const tuple = sample({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      minItems: 2,
      maxItems: 2,
    }) as ReadonlyArray<ReadonlyArray<unknown>>;
    expect(
      tuple.every((v) => v.length === 2 && typeof v[0] === "string" && Number.isInteger(v[1])),
    ).toBe(true);
    const draft07 = sample({ type: "array", items: [{ const: 1 }, { const: 2 }] }) as ReadonlyArray<
      ReadonlyArray<unknown>
    >;
    expect(draft07.every((v) => v[0] === 1 && v[1] === 2)).toBe(true);
    const uniq = sample({
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 1000 },
      uniqueItems: true,
    }) as ReadonlyArray<ReadonlyArray<number>>;
    expect(uniq.every((v) => new Set(v).size === v.length)).toBe(true);
  });

  it("enum and const", () => {
    expect(new Set(sample({ enum: ["a", "b", 3] }))).toEqual(new Set(["a", "b", 3]));
    expect(sample({ const: { x: 1 } }).every((v) => JSON.stringify(v) === '{"x":1}')).toBe(true);
  });

  it("minLength, maxLength (code points) including injected edges", () => {
    const values = sample(
      { type: "string", minLength: 2, maxLength: 5 },
      {},
      500,
    ) as ReadonlyArray<string>;
    expect(values.every((v) => length(v) >= 2 && length(v) <= 5)).toBe(true);
  });

  it("pattern", () => {
    const values = sample({
      type: "string",
      pattern: "^[A-Z]{2}-\\d{3}$",
    }) as ReadonlyArray<string>;
    expect(values.every((v) => /^[A-Z]{2}-\d{3}$/.test(v))).toBe(true);
    const sized = sample({
      type: "string",
      pattern: "^a+$",
      maxLength: 3,
    }) as ReadonlyArray<string>;
    expect(sized.every((v) => /^a{1,3}$/.test(v))).toBe(true);
  });

  it("formats", () => {
    const check = (format: string, test: (v: string) => boolean) =>
      expect(
        (sample({ type: "string", format }, {}, 100) as ReadonlyArray<string>).every(test),
      ).toBe(true);
    check("date-time", (v) => !Number.isNaN(Date.parse(v)) && v.endsWith("Z"));
    check("date", (v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
    check("time", (v) => /^\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v));
    check("email", (v) => v.includes("@"));
    check("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v));
    check("uri", (v) => /^https?:\/\//.test(v));
    check("hostname", (v) => v.length > 0 && !v.includes("/"));
    check("ipv4", (v) => /^\d+\.\d+\.\d+\.\d+$/.test(v));
    check("ipv6", (v) => v.includes(":"));
  });

  it("minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf", () => {
    const ints = sample(
      { type: "integer", minimum: -5, maximum: 5 },
      {},
      500,
    ) as ReadonlyArray<number>;
    expect(ints.every((v) => v >= -5 && v <= 5)).toBe(true);
    expect(new Set(ints).size).toBe(11);
    const exclusive = sample({
      type: "integer",
      exclusiveMinimum: 0,
      exclusiveMaximum: 3,
    }) as ReadonlyArray<number>;
    expect(new Set(exclusive)).toEqual(new Set([1, 2]));
    const doubles = sample(
      { type: "number", exclusiveMinimum: 0, maximum: 1 },
      {},
      500,
    ) as ReadonlyArray<number>;
    expect(doubles.every((v) => v > 0 && v <= 1)).toBe(true);
    const steps = sample({
      type: "integer",
      multipleOf: 5,
      minimum: 0,
      maximum: 100,
    }) as ReadonlyArray<number>;
    expect(steps.every((v) => v % 5 === 0 && v >= 0 && v <= 100)).toBe(true);
  });

  it("anyOf and oneOf", () => {
    const values = sample({ anyOf: [{ type: "string" }, { type: "integer" }] });
    expect(values.some((v) => typeof v === "string")).toBe(true);
    expect(values.some((v) => typeof v === "number")).toBe(true);
    const tagged = sample({
      oneOf: [
        { type: "object", properties: { _tag: { const: "A" } }, required: ["_tag"] },
        { type: "object", properties: { _tag: { const: "B" } }, required: ["_tag"] },
      ],
    }) as ReadonlyArray<{ _tag: string }>;
    expect(new Set(tagged.map((v) => v._tag))).toEqual(new Set(["A", "B"]));
  });

  it("$ref with $defs and definitions, including recursion", () => {
    const values = sample({
      type: "object",
      properties: { home: { $ref: "#/$defs/Address" }, work: { $ref: "#/definitions/Address" } },
      required: ["home", "work"],
      $defs: {
        Address: { type: "object", properties: { zip: { type: "string" } }, required: ["zip"] },
      },
      definitions: {
        Address: { type: "object", properties: { zip: { type: "string" } }, required: ["zip"] },
      },
    }) as ReadonlyArray<{ home: { zip: unknown }; work: { zip: unknown } }>;
    expect(
      values.every((v) => typeof v.home.zip === "string" && typeof v.work.zip === "string"),
    ).toBe(true);
    type Tree = { value: number; children: ReadonlyArray<Tree> };
    const trees = sample({
      $ref: "#/$defs/Tree",
      $defs: {
        Tree: {
          type: "object",
          properties: {
            value: { type: "integer" },
            children: { type: "array", items: { $ref: "#/$defs/Tree" } },
          },
          required: ["value", "children"],
        },
      },
    }) as ReadonlyArray<Tree>;
    const depth = (tree: Tree): number => 1 + Math.max(0, ...tree.children.map(depth));
    expect(trees.every((tree) => Number.isInteger(tree.value))).toBe(true);
    expect(trees.some((tree) => depth(tree) > 1)).toBe(true);
  });

  it("annotations and x-* extensions are ignored; no type means any JSON", () => {
    const values = sample({ title: "Anything", description: "d", "x-ui": { hidden: true } });
    expect(values.every((v) => JSON.parse(JSON.stringify(v)) !== undefined)).toBe(true);
  });
});

describe("rejections", () => {
  it.each([
    ["not", { not: { type: "string" } }, ""],
    ["allOf", { allOf: [{ type: "string" }] }, ""],
    ["if", { if: {}, else: {} }, ""],
    [
      "propertyNames",
      { type: "object", properties: { a: { type: "object", propertyNames: { maxLength: 2 } } } },
      "/properties/a",
    ],
    ["contains", { type: "array", contains: { type: "string" } }, ""],
    ["minProperties", { type: "object", minProperties: 1 }, ""],
    ["unevaluatedProperties", { type: "object", unevaluatedProperties: false }, ""],
    ["dependentRequired", { type: "object", dependentRequired: { a: ["b"] } }, ""],
  ])("throws UnsupportedKeyword for %s with its pointer", (keyword, schema, pointer) => {
    let error: unknown;
    try {
      Fuzz.arbitrary(schema);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Fuzz.UnsupportedKeyword);
    expect(error).toMatchObject({ _tag: "UnsupportedKeyword", keyword, pointer });
  });

  it("rejects unknown formats and external refs", () => {
    expect(() => Fuzz.arbitrary({ type: "string", format: "credit-card" })).toThrow(
      Fuzz.UnsupportedKeyword,
    );
    expect(() => Fuzz.arbitrary({ $ref: "https://example.test/schema.json" })).toThrow(
      Fuzz.UnsupportedKeyword,
    );
    expect(() =>
      Fuzz.arbitrary({
        type: "object",
        properties: { a: { $ref: "#/$defs/A", minLength: 1 } },
        $defs: { A: {} },
      }),
    ).toThrow(Fuzz.UnsupportedKeyword);
  });

  it("throws InvalidSchema for unsatisfiable or malformed schemas", () => {
    for (const schema of [
      { type: "integer", minimum: 5, maximum: 1 },
      { type: "string", minLength: 3, maxLength: 1 },
      { type: "array", minItems: 3, maxItems: 1 },
      { $ref: "#/$defs/Missing" },
      { type: "nope" },
      { type: "string", pattern: "(" },
      { enum: [] },
      { type: "object", properties: { a: false }, required: ["a"] },
    ])
      expect(() => Fuzz.arbitrary(schema)).toThrow(Fuzz.InvalidSchema);
  });
});
