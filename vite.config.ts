import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Tests and type checks run from source: these aliases (mirrored by `paths` in
 * `tsconfig.base.json`) point the workspace packages at their `src`, so no build is needed first.
 * Published packages resolve through their `exports`, which point at `dist`.
 */
const workspace = [
  { find: /^@highalch\/tanstack-db$/, replacement: source("./packages/tanstack-db/src/index.ts") },
  {
    find: /^@highalch\/tanstack-db\/server$/,
    replacement: source("./packages/tanstack-db/src/server.ts"),
  },
  {
    find: /^@highalch\/tanstack-db\/react$/,
    replacement: source("./packages/tanstack-db/src/react.tsx"),
  },
  {
    find: /^@highalch\/tanstack-db\/xstate$/,
    replacement: source("./packages/tanstack-db/src/xstate/index.ts"),
  },
  {
    find: /^@highalch\/tanstack-db\/internal$/,
    replacement: source("./packages/tanstack-db/src/internal.ts"),
  },
  { find: /^@highalch\/story$/, replacement: source("./packages/story/src/index.ts") },
  {
    find: /^@highalch\/story\/xstate$/,
    replacement: source("./packages/story/src/xstate/index.ts"),
  },
  {
    find: /^@highalch\/story\/screen$/,
    replacement: source("./packages/story/src/screen/index.ts"),
  },
];

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  fmt: {
    ignorePatterns: ["**/dist/**", "**/artifacts/**", "pnpm-lock.yaml"],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/artifacts/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  resolve: {
    alias: workspace,
    dedupe: ["effect", "react", "react-dom"],
  },
  test: {
    include: ["packages/*/tests/**/*.test.{ts,tsx}"],
  },
  run: {
    cache: true,
  },
});
