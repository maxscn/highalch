import type { Locator, Page } from "@playwright/test";
import { describe, expect, it } from "vite-plus/test";
import { screenshot } from "../src/playwright.ts";

// 1x1 PNG header is enough for the size probe; IHDR width/height at bytes 16..23.
const png = (width: number, height: number) => {
  const bytes = Buffer.alloc(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};
const ctx = { name: "s", id: "1:0", index: 0, seed: 1, path: "0", edges: [] };

describe("screenshot", () => {
  it("captures a page as PNG with animations disabled and full-page passthrough", async () => {
    const calls: Array<unknown> = [];
    const page = {
      goto: async () => null,
      screenshot: async (options: unknown) => {
        calls.push(options);
        return png(1280, 720);
      },
    } as unknown as Page;
    const capture = await screenshot({ fullPage: true }).capture(page, ctx);
    expect(calls).toEqual([{ animations: "disabled", type: "png", fullPage: true }]);
    expect(capture).toMatchObject({
      kind: "screenshot",
      mime: "image/png",
      meta: { width: 1280, height: 720, case: "1:0" },
    });
    expect(capture.body).toBeInstanceOf(Uint8Array);
  });

  it("captures a locator without page-only options", async () => {
    const calls: Array<unknown> = [];
    const locator = {
      screenshot: async (options: unknown) => {
        calls.push(options);
        return png(10, 20);
      },
    } as unknown as Locator;
    await screenshot({ fullPage: true, omitBackground: true }).capture(locator, ctx);
    expect(calls).toEqual([{ animations: "disabled", omitBackground: true, type: "png" }]);
  });
});
