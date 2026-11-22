import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { highalch } from "./packages/story/src/vite";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Tests and type checks run from source: these aliases (mirrored by `paths` in
 * `tsconfig.base.json`) point the workspace packages at their `src`, so no build is needed first.
 * Published packages resolve through their `exports`, which point at `dist`. The Console's
 * projects (each `vite.config.ts` under `console/`) use the same aliases.
 */
export const workspace = [
  { find: /^@lowalch\/tanstack-db$/, replacement: source("./packages/tanstack-db/src/index.ts") },
  {
    find: /^@lowalch\/tanstack-db\/server$/,
    replacement: source("./packages/tanstack-db/src/server.ts"),
  },
  {
    find: /^@lowalch\/tanstack-db\/react$/,
    replacement: source("./packages/tanstack-db/src/react.tsx"),
  },
  {
    find: /^@lowalch\/tanstack-db\/xstate$/,
    replacement: source("./packages/tanstack-db/src/xstate/index.ts"),
  },
  {
    find: /^@lowalch\/tanstack-db\/internal$/,
    replacement: source("./packages/tanstack-db/src/internal.ts"),
  },
  { find: /^@highalch\/examples$/, replacement: source("./packages/examples/src/index.ts") },
  { find: /^@highalch\/story$/, replacement: source("./packages/story/src/index.ts") },
  {
    find: /^@highalch\/story\/tanstack-db$/,
    replacement: source("./packages/story/src/tanstack-db/index.ts"),
  },
  {
    find: /^@highalch\/story\/lowalch$/,
    replacement: source("./packages/story/src/lowalch/index.ts"),
  },
  {
    find: /^@highalch\/story\/tanstack-form$/,
    replacement: source("./packages/story/src/tanstack-form/index.ts"),
  },
  {
    find: /^@highalch\/story\/react-form$/,
    replacement: source("./packages/story/src/tanstack-form/react-form.ts"),
  },
  {
    find: /^@highalch\/story\/takumi$/,
    replacement: source("./packages/story/src/takumi/index.ts"),
  },
  {
    find: /^@highalch\/story\/xstate$/,
    replacement: source("./packages/story/src/xstate/index.ts"),
  },
  {
    find: /^@highalch\/story\/screen$/,
    replacement: source("./packages/story/src/screen/index.ts"),
  },
  { find: /^@highalch\/explore$/, replacement: source("./packages/explore/src/index.ts") },
  {
    find: /^@highalch\/explore\/xstate$/,
    replacement: source("./packages/explore/src/xstate/index.ts"),
  },
  { find: /^@highalch\/stream$/, replacement: source("./packages/stream/src/index.ts") },
  { find: /^@highalch\/studio$/, replacement: source("./packages/studio/src/index.ts") },
];

export default defineConfig({
  // Stories find the forms the app mounts (see @highalch/story/vite).
  plugins: [highalch()],
  oxc: { jsx: { runtime: "automatic" } },
  fmt: {
    ignorePatterns: ["**/dist/**", "**/artifacts/**", "pnpm-lock.yaml", "**/routeTree.gen.ts"],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/artifacts/**", "**/routeTree.gen.ts"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  resolve: {
    alias: workspace,
    dedupe: ["effect", "react", "react-dom"],
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "highalch", include: ["packages/*/tests/**/*.test.{ts,tsx}"] },
      },
      // HighAlch Console (private): each package's own config. Their end-to-end tests
      // (`*.e2e.test.*`) run only with `vp run test:console-e2e`.
      "console/*/vite.config.ts",
    ],
  },
  run: {
    cache: true,
  },
});
