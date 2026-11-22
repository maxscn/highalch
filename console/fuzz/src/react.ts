import type { ReactElement } from "react";
import type { Adapter, Capture, CaseContext } from "./adapter.ts";

export interface ReactHtmlOptions {
  /** Markup placed in `<head>` (stylesheets, `<base>`), so the capture renders standalone. */
  readonly head?: string;
  /**
   * `dom` mounts with `react-dom/client` inside `act` (effects and layout run; needs a DOM such
   * as happy-dom). `server` uses `react-dom/server` static markup (no DOM needed).
   * Default: `dom` when `document` exists, else `server`.
   */
  readonly mode?: "dom" | "server";
}

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const dom = async (element: ReactElement): Promise<string> => {
  const [{ act }, { createRoot }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
  ]);
  const scope = globalThis as ActGlobal;
  const previous = scope.IS_REACT_ACT_ENVIRONMENT;
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(element));
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (previous === undefined) delete scope.IS_REACT_ACT_ENVIRONMENT;
    else scope.IS_REACT_ACT_ENVIRONMENT = previous;
  }
};

const server = async (element: ReactElement): Promise<string> => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(element);
};

/**
 * Captures a React element as a standalone HTML document. Works under happy-dom; no browser
 * and no network.
 */
export const reactHtml = (options: ReactHtmlOptions = {}): Adapter<ReactElement> => ({
  kind: "html",
  async capture(element: ReactElement, ctx: CaseContext): Promise<Capture> {
    const mode = options.mode ?? (typeof document === "undefined" ? "server" : "dom");
    const html = mode === "dom" ? await dom(element) : await server(element);
    return {
      kind: "html",
      mime: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8">${options.head ?? ""}</head><body>${html}</body></html>`,
      meta: { renderer: "react-dom", mode, case: ctx.id },
    };
  },
});
