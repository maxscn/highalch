import * as HighAlch from "@lowalch/tanstack-db/server";
import * as Story from "@highalch/story";
import { describe, expect, it } from "vite-plus/test";

/** HighAlch is linked from source (the workspace's `packages/`): its `src` entries load and type check. */
describe("HighAlch linked from source", () => {
  it("loads @lowalch/tanstack-db/server", () => {
    expect([typeof HighAlch.Feed, typeof HighAlch.Rows, typeof HighAlch.Projection]).toEqual([
      "function",
      "function",
      "function",
    ]);
  });

  it("runs an empty hostless @highalch/story", async () => {
    const story: Story.Runner = Story.make();
    await expect(story()).resolves.toBeUndefined();
  });
});
