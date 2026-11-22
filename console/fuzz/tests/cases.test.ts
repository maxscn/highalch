import { createHash } from "node:crypto";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { Fuzz } from "../src/index.ts";

const subject = { kind: "component", name: "test" } as const;

const Customer: Fuzz.JsonSchema<{ customer: { name: string; age?: number; tags: string[] } }> = {
  title: "Customer",
  type: "object",
  properties: {
    customer: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 80 },
        age: { type: "integer", minimum: -10 },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name", "tags"],
    },
  },
  required: ["customer"],
};
const options = {
  subject,
  seed: 20260922,
  count: 200,
  edges: ["long-string", "empty", "rtl", "negative", "huge-number"],
} as const;

const pointer = (value: unknown, path: string): unknown =>
  path
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | ReadonlyArray<unknown>)[key as never],
      value,
    );

describe("Fuzz.cases", () => {
  it("is deterministic: same seed gives byte-identical cases", () => {
    const a = JSON.stringify(Fuzz.cases(Customer, options));
    const b = JSON.stringify(Fuzz.cases(Customer, options));
    expect(a).toBe(b);
    expect(JSON.stringify(Fuzz.cases(Customer, { ...options, seed: 1 }))).not.toBe(a);
  });

  it("matches the pinned digest (guards cross-machine and fast-check drift)", () => {
    const digest = createHash("sha256")
      // the generated values only: subject and schemaHash are labels, not generation
      .update(
        JSON.stringify(
          Fuzz.cases(Customer, options).map(({ subject: _s, schemaHash: _h, ...c }) => c),
        ),
      )
      .digest("hex");
    expect(digest).toMatchInlineSnapshot(
      `"7a7fedce4eae3f1ba277e140523db54fddf7fa96a6a052a3c88ddc50cc1e59b8"`,
    );
  });

  it("labels cases with their subject and a stable schema hash", () => {
    const [first] = Fuzz.cases(Customer, options);
    expect(first?.subject).toEqual(subject);
    expect(first?.schemaHash).toMatch(/^s1:[0-9a-f]{16}$/);
    // key order does not change the hash; a changed schema does
    const reverse = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverse)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, reverse(v)]),
            )
          : value;
    const reordered = reverse(Customer) as typeof Customer;
    expect(Fuzz.cases(reordered, { ...options, count: 1 })[0]?.schemaHash).toBe(first?.schemaHash);
    expect(
      Fuzz.cases({ ...Customer, title: "Changed" }, { ...options, count: 1 })[0]?.schemaHash,
    ).not.toBe(first?.schemaHash);
    expect(
      Fuzz.cases(fc.integer(), { subject, seed: 1, count: 1, version: "2" })[0]?.schemaHash,
    ).toBe("v:2");
  });

  it("numbers cases with stable ids and fast-check paths", () => {
    const cases = Fuzz.cases(Customer, options);
    expect(cases).toHaveLength(200);
    expect(cases[17]).toMatchObject({
      name: "Customer",
      id: "20260922:17",
      index: 17,
      seed: 20260922,
      path: "17",
    });
  });

  it("replays a case from seed + path with plain fast-check", () => {
    const cases = Fuzz.cases(Customer, options);
    for (const target of [cases[0], cases[42], cases[199]]) {
      if (!target) throw new Error("missing case");
      let replayed: unknown;
      fc.assert(
        fc.property(Fuzz.arbitrary(Customer, { edges: options.edges }), (value) => {
          replayed = value;
        }),
        { seed: target.seed, path: target.path, numRuns: 1 },
      );
      expect(replayed).toEqual(target.value);
      expect(Fuzz.replay(Customer, { ...target, edges: options.edges })).toEqual(target.value);
    }
  });

  it("tags injected edges with JSON pointers to the awkward value", () => {
    const cases = Fuzz.cases(Customer, options);
    const edges = cases.flatMap((c) => c.edges.map((edge) => ({ edge, value: c.value })));
    const kinds = new Set(edges.map(({ edge }) => edge.kind));
    expect(kinds).toEqual(new Set(options.edges));
    for (const { edge, value } of edges) {
      const at = pointer(value, edge.path);
      if (edge.kind === "empty")
        expect(at === "" || (Array.isArray(at) && at.length === 0)).toBe(true);
      if (edge.kind === "long-string")
        expect(Array.from(at as string)).toHaveLength(edge.path === "/customer/name" ? 80 : 2000);
      if (edge.kind === "rtl") expect(at).toMatch(/[\u0590-\u08FF\u202E]/u);
      if (edge.kind === "negative") expect(at).toBeLessThan(0);
      if (edge.kind === "huge-number")
        expect(Math.abs(at as number)).toBeGreaterThanOrEqual(2 ** 31);
    }
    expect(edges.some(({ edge }) => edge.path === "/customer/name")).toBe(true);
    expect(edges.some(({ edge }) => /^\/customer\/tags\/\d+$/.test(edge.path))).toBe(true);
    expect(
      edges.every(({ edge }) => edge.kind !== "huge-number" || edge.path === "/customer/age"),
    ).toBe(true);
  });

  it("escapes pointer segments and allows disabling edges", () => {
    const cases = Fuzz.cases(
      { type: "object", properties: { "a/b~c": { type: "string" } }, required: ["a/b~c"] },
      { subject, seed: 3, count: 100, edges: ["empty"] },
    );
    expect(cases.some((c) => c.edges.some((edge) => edge.path === "/a~1b~0c"))).toBe(true);
    const none = Fuzz.cases(Customer, { subject, seed: 3, count: 100, edges: [] });
    expect(none.every((c) => c.edges.length === 0)).toBe(true);
  });

  it("accepts any fast-check arbitrary and classifies its edges", () => {
    const cases = Fuzz.cases(fc.record({ n: fc.integer(), s: fc.constantFrom("", "ok") }), {
      subject,
      version: "1",
      seed: 9,
      count: 50,
      edges: ["empty", "negative"],
      name: "record",
    });
    expect(cases[0]?.name).toBe("record");
    expect(cases.some((c) => c.edges.some((e) => e.kind === "empty" && e.path === "/s"))).toBe(
      true,
    );
    for (const c of cases)
      for (const edge of c.edges)
        if (edge.kind === "negative") expect(pointer(c.value, edge.path)).toBeLessThan(0);
    expect(JSON.stringify(Fuzz.cases(fc.integer(), { subject, seed: 9, count: 5 }))).toBe(
      JSON.stringify(Fuzz.cases(fc.integer(), { subject, seed: 9, count: 5 })),
    );
  });

  it("composes with fc.property, .map and .filter", () => {
    const names = Fuzz.arbitrary(Customer)
      .map((value) => value.customer.name)
      .filter((name) => name.length > 0);
    fc.assert(
      fc.property(names, (name) => typeof name === "string" && name.length > 0),
      { seed: 1, numRuns: 50 },
    );
  });
});
