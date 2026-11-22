/** @vitest-environment happy-dom */

import { useEffect, useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { Fuzz } from "../src/index.ts";
import { reactHtml } from "../src/react.ts";

const subject = { kind: "component", name: "test" } as const;

function Card(props: { readonly name: string; readonly tags: ReadonlyArray<string> }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <article data-mounted={mounted}>
      <h1>{props.name}</h1>
      <ul>
        {props.tags.map((tag, index) => (
          <li key={index}>{tag}</li>
        ))}
      </ul>
    </article>
  );
}

const schema: Fuzz.JsonSchema<{ name: string; tags: string[] }> = {
  title: "Card",
  type: "object",
  properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
  required: ["name", "tags"],
};

describe("reactHtml", () => {
  it("renders with react-dom inside happy-dom, after effects, as a standalone document", async () => {
    const [c] = Fuzz.cases(schema, { subject, seed: 4, count: 1 });
    if (!c) throw new Error("no case");
    const capture = await reactHtml({ head: '<link rel="stylesheet" href="app.css">' }).capture(
      <Card {...c.value} />,
      c,
    );
    expect(capture.kind).toBe("html");
    expect(capture.mime).toBe("text/html");
    expect(capture.meta).toMatchObject({ mode: "dom", case: c.id });
    expect(capture.body).toMatch(/^<!doctype html><html><head><meta charset="utf-8"><link/);
    expect(capture.body).toContain('data-mounted="true"');
    expect(document.body.children).toHaveLength(0);
  });

  it("escapes awkward generated values instead of executing them", async () => {
    const adapter = reactHtml();
    const capture = await adapter.capture(<Card name="<script>alert(1)</script>" tags={[]} />, {
      name: "Card",
      id: "1:0",
      index: 0,
      seed: 1,
      path: "0",
      edges: [{ kind: "markup", path: "/name" }],
    });
    expect(capture.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("supports server rendering without mounting", async () => {
    const capture = await reactHtml({ mode: "server" }).capture(<Card name="a" tags={["x"]} />, {
      name: "Card",
      id: "1:0",
      index: 0,
      seed: 1,
      path: "0",
      edges: [],
    });
    expect(capture.meta.mode).toBe("server");
    expect(capture.body).toContain(
      '<article data-mounted="false"><h1>a</h1><ul><li>x</li></ul></article>',
    );
  });
});
