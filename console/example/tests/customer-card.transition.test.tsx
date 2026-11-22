/** @vitest-environment happy-dom */

import { Schema } from "effect";
import { afterAll, expect, it } from "vite-plus/test";
import { Console, Fuzz } from "@highalch/console-fuzz";
import { fromEffect } from "@highalch/console-fuzz/effect";
import { reactHtml } from "@highalch/console-fuzz/react";
import { Customer, CustomerCard } from "../src/index.ts";

const report = Console.reporter({ project: "crm-example" });
afterAll(async () => {
  await report.flush();
});

const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Customer));
const html = reactHtml();

it("f(customer from schema, render) renders every seeded customer", async () => {
  const cases = Fuzz.cases(fromEffect(Customer), {
    subject: { kind: "component", name: "customer/CustomerCard" },
    seed: 20260922,
    count: 100,
    edges: ["long-string", "empty", "rtl", "markup", "negative", "huge-number", "many-items"],
  });
  for (const c of cases) {
    const customer = decode(c.value);
    const capture = await html.capture(<CustomerCard customer={customer} />, c);
    // Generated markup must be escaped, never rendered as elements.
    expect(capture.body).not.toContain("<script>");
    report.add(c, capture, { state: customer });
  }
  // Edge tagging says where the awkward value came from, e.g. "/name" or "/tags/3".
  const paths = new Set(
    cases.flatMap((c) => c.edges.map((edge) => edge.path.replace(/\d+$/, "n"))),
  );
  expect(paths.has("/name")).toBe(true);
  expect(paths.has("/tags")).toBe(true);
});
