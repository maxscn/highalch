import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { workspace } from "../../vite.config.ts";
import { consoleDevBackend } from "./dev/plugin.ts";

const require = createRequire(import.meta.url);
/** `@tanstack/router-core`'s browser `isServer` (false), for the screen stories. */
const routerClient = join(
  dirname(
    require.resolve("@tanstack/router-core/package.json", {
      paths: [dirname(require.resolve("@tanstack/react-router"))],
    }),
  ),
  "dist/esm/isServer/client.js",
);

/**
 * The screen stories and the seed's own test (`*.e2e.test.tsx`) read the generated seed (`.seed`,
 * from real Playwright and fuzz runs), so they run only with `vp run test:console-e2e`.
 */
const e2e = process.env.HIGHALCH_CONSOLE_E2E === "1";

export default defineConfig({
  plugins: [
    tanstackStart(),
    react(),
    tailwindcss(),
    consoleDevBackend(join(import.meta.dirname, ".seed")),
  ],
  resolve: {
    alias: workspace,
    dedupe: ["react", "react-dom", "@tanstack/db", "@tanstack/react-db", "effect"],
  },
  server: { port: 5201, strictPort: true },
  test: {
    name: "console-web",
    include: [e2e ? "tests/**/*.e2e.test.tsx" : "tests/**/*.test.tsx"],
    exclude: e2e ? [] : ["tests/**/*.e2e.test.tsx"],
    passWithNoTests: true,
    // The app renders in the browser only. Screen stories run in Node with the DOM HighAlch's
    // Screen installs per story, so the router is given its browser build of `isServer` (it
    // otherwise decides it runs on a server, once, at import) instead of a global test DOM.
    alias: [{ find: /^@tanstack\/router-core\/isServer$/, replacement: routerClient }],
    server: { deps: { inline: [/@tanstack\/(react-)?router/, /@tanstack\/router-core/] } },
    // The screen stories paint the compiled stylesheet (`?inline`).
    css: { include: [/.+/] },
    // Screen stories wait for the page by condition; under a loaded machine that can take minutes.
    testTimeout: 300_000,
  },
});
