import type { Locator, LocatorScreenshotOptions, Page } from "@playwright/test";
import type { Adapter, Capture, CaseContext } from "./adapter.ts";

export interface ScreenshotOptions extends Omit<
  LocatorScreenshotOptions,
  "path" | "type" | "quality"
> {
  /** Page subjects only: capture the full scrollable page. Default false. */
  readonly fullPage?: boolean;
}

/** The PNG's width and height, from its header (none for a body too short to hold one). */
const size = (png: Uint8Array): Readonly<Record<string, number>> => {
  if (png.byteLength < 24) return {};
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

/**
 * Captures a Playwright `Page` or `Locator` as PNG. Animations are disabled by default so
 * repeated captures are stable. Does not navigate or touch the network itself.
 */
export const screenshot = (options: ScreenshotOptions = {}): Adapter<Page | Locator> => ({
  kind: "screenshot",
  async capture(subject: Page | Locator, ctx: CaseContext): Promise<Capture> {
    const { fullPage, ...common } = options;
    const settings = { animations: "disabled" as const, ...common, type: "png" as const };
    const buffer =
      "goto" in subject
        ? await subject.screenshot({ ...settings, ...(fullPage === undefined ? {} : { fullPage }) })
        : await subject.screenshot(settings);
    const body = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return {
      kind: "screenshot",
      mime: "image/png",
      body,
      meta: { ...size(body), case: ctx.id },
    };
  },
});
