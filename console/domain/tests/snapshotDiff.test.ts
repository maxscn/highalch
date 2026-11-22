import { describe, expect, it } from "vite-plus/test";
import { caseKey, diff, parse } from "../src/Run/SnapshotDiff.ts";

const subject = { kind: "component", name: "Card" } as const;
const item = (index: number, artifactId: string, schemaHash = "s1:a", outcome = "ok") => ({
  name: "Card",
  subject,
  schemaHash,
  case: {
    id: `1:${index}`,
    index,
    seed: 1,
    path: String(index),
    value: null,
    edges: [],
    outcome,
    capture: { artifactId, kind: "html" },
  },
});
const side = (items: ReadonlyArray<unknown>, sha: Record<string, string>) => ({
  loaded: parse([{ part: "cases", items }]),
  sha: new Map(Object.entries(sha)),
});

describe("snapshot diff", () => {
  it("classifies every capture against the baseline", () => {
    const baseline = {
      run: "r0",
      ...side([item(0, "r0.1"), item(1, "r0.2"), item(2, "r0.3")], {
        "r0.1": "x",
        "r0.2": "y",
        "r0.3": "z",
      }),
    };
    const current = side([item(0, "r1.1"), item(1, "r1.2", "s1:a", "crash"), item(3, "r1.3")], {
      "r1.1": "x",
      "r1.2": "Y",
      "r1.3": "w",
    });
    const result = diff(current, baseline);
    expect(result.snapshots[caseKey(item(0, ""))]).toEqual({
      status: "unchanged",
      baselineRunId: "r0",
      baselineArtifactId: "r0.1",
    });
    expect(result.snapshots[caseKey(item(1, ""))]?.status).toBe("changed");
    expect(result.snapshots[caseKey(item(3, ""))]).toEqual({ status: "new", baselineRunId: "r0" });
    expect(result.counts).toEqual({
      unchanged: 1,
      changed: 1,
      new: 1,
      removed: 1,
      "schema-changed": 0,
    });
    expect(result.removed.cases).toEqual([
      {
        ...item(2, "r0.3"),
        snapshot: { status: "removed", baselineRunId: "r0", baselineArtifactId: "r0.3" },
      },
    ]);
    expect(result.subjects).toEqual([
      {
        kind: "component",
        name: "Card",
        items: 3,
        failures: 1,
        schemaHash: "s1:a",
        snapshots: { unchanged: 1, changed: 1, new: 1, removed: 1, "schema-changed": 0 },
      },
    ]);
  });

  it("reports a changed generator as schema-changed, and everything as new without a baseline", () => {
    const baseline = { run: "r0", ...side([item(0, "r0.1")], { "r0.1": "x" }) };
    const changed = diff(side([item(0, "r1.1", "s1:b")], { "r1.1": "q" }), baseline);
    expect(changed.counts["schema-changed"]).toBe(1);
    const first = diff(side([item(0, "r1.1")], { "r1.1": "x" }), null);
    expect(first.counts).toMatchObject({ new: 1, removed: 0 });
  });
});
