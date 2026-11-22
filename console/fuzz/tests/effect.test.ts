import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Fuzz } from "../src/index.ts";
import { fromEffect } from "../src/effect.ts";

const subject = { kind: "component", name: "test" } as const;

const Address = Schema.Struct({ street: Schema.String, city: Schema.String }).annotate({
  identifier: "Address",
});
interface Category {
  readonly name: string;
  readonly children: ReadonlyArray<Category>;
}
const Category = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Category> => Category)),
}).annotate({ identifier: "Category" });
const Customer = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  age: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 130 }))),
  email: Schema.NullOr(Schema.String),
  status: Schema.Literals(["lead", "active", "churned"]),
  joined: Schema.DateTimeUtcFromString,
  score: Schema.Finite,
  address: Address,
  category: Category,
  tags: Schema.Array(Schema.String),
  pair: Schema.Tuple([Schema.String, Schema.Boolean]),
  extra: Schema.Record(Schema.String, Schema.Number),
  event: Schema.Union([
    Schema.TaggedStruct("Called", { at: Schema.Number }),
    Schema.TaggedStruct("Emailed", { subject: Schema.String }),
  ]),
}).annotate({ identifier: "Customer" });

describe("fromEffect", () => {
  it("produces a JSON Schema whose cases decode with the schema's JSON codec", () => {
    const json = fromEffect(Customer);
    expect(json.$defs).toBeDefined();
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Customer));
    const cases = Fuzz.cases(json, { subject, seed: 20260922, count: 150 });
    let decoded = 0;
    for (const c of cases) {
      try {
        decode(c.value);
        decoded++;
      } catch (cause) {
        // Only DateTime strings may be rejected: JSON Schema carries no format for them.
        expect(String(cause)).toMatch(/DateTime|joined/);
      }
    }
    expect(decoded).toBeGreaterThan(0);
  });

  it("decodes every case when every field is expressible in JSON Schema", () => {
    const Simple = Customer.mapFields(({ joined: _joined, ...rest }) => rest);
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Simple));
    for (const c of Fuzz.cases(fromEffect(Simple), { subject, seed: 5, count: 200 }))
      decode(c.value);
  });

  it("tags edges at the encoded field paths", () => {
    const cases = Fuzz.cases(fromEffect(Customer), {
      subject,
      seed: 1,
      count: 200,
      edges: ["empty", "rtl"],
    });
    const paths = new Set(cases.flatMap((c) => c.edges.map((edge) => edge.path)));
    expect([...paths].some((path) => path === "/tags" || path.startsWith("/tags/"))).toBe(true);
    expect([...paths].some((path) => path.startsWith("/address/"))).toBe(true);
  });

  it("uses the identifier as the case-set name", () => {
    expect(Fuzz.cases(fromEffect(Customer), { subject, seed: 1, count: 1 })[0]?.name).toBe(
      "Customer",
    );
  });
});
