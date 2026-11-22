import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { highalch } from "./packages/highalch/tanstack-form/src/vite";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Tests and type checks run from source: these aliases (mirrored by `paths` in
 * `tsconfig.base.json`) point the workspace packages at their `src`, so no build is needed first.
 * Published packages resolve through their `exports`, which point at `dist`.
 */
const workspace = [
  {
    find: /^@lowalch\/tanstack-db$/,
    replacement: source("./packages/lowalch/tanstack-db/src/index.ts"),
  },
  {
    find: /^@lowalch\/tanstack-db\/server$/,
    replacement: source("./packages/lowalch/tanstack-db/src/server.ts"),
  },
  {
    find: /^@lowalch\/tanstack-db\/react$/,
    replacement: source("./packages/lowalch/tanstack-db/src/react.tsx"),
  },
  {
    find: /^@lowalch\/tanstack-db\/xstate$/,
    replacement: source("./packages/lowalch/tanstack-db/src/xstate/index.ts"),
  },
  {
    find: /^@lowalch\/tanstack-db\/internal$/,
    replacement: source("./packages/lowalch/tanstack-db/src/internal.ts"),
  },
  {
    find: /^@highalch\/examples$/,
    replacement: source("./packages/highalch/examples/src/index.ts"),
  },
  { find: /^@highalch\/story$/, replacement: source("./packages/highalch/story/src/index.ts") },
  {
    find: /^@highalch\/story\/internal$/,
    replacement: source("./packages/highalch/story/src/internal.ts"),
  },
  {
    find: /^@highalch\/tanstack-db$/,
    replacement: source("./packages/highalch/tanstack-db/src/index.ts"),
  },
  {
    find: /^@highalch\/tanstack-db\/internal$/,
    replacement: source("./packages/highalch/tanstack-db/src/internal.ts"),
  },
  { find: /^@highalch\/xstate$/, replacement: source("./packages/highalch/xstate/src/index.ts") },
  { find: /^@highalch\/screen$/, replacement: source("./packages/highalch/screen/src/index.ts") },
  {
    find: /^@highalch\/screen\/internal$/,
    replacement: source("./packages/highalch/screen/src/internal.ts"),
  },
  { find: /^@highalch\/takumi$/, replacement: source("./packages/highalch/takumi/src/index.ts") },
  {
    find: /^@highalch\/tanstack-form$/,
    replacement: source("./packages/highalch/tanstack-form/src/index.ts"),
  },
  {
    find: /^@highalch\/tanstack-form\/vite$/,
    replacement: source("./packages/highalch/tanstack-form/src/vite.ts"),
  },
  {
    find: /^@highalch\/tanstack-form\/react-form$/,
    replacement: source("./packages/highalch/tanstack-form/src/react-form.ts"),
  },
  {
    find: /^@highalch\/alchemy-domain$/,
    replacement: source("./packages/highalch/alchemy-domain/src/index.ts"),
  },
  { find: /^@highalch\/explore$/, replacement: source("./packages/highalch/explore/src/index.ts") },
  {
    find: /^@highalch\/explore\/xstate$/,
    replacement: source("./packages/highalch/explore/src/xstate/index.ts"),
  },
  { find: /^@highalch\/stream$/, replacement: source("./packages/highalch/stream/src/index.ts") },
  { find: /^@highalch\/studio$/, replacement: source("./packages/highalch/studio/src/index.ts") },
];

export default defineConfig({
  // Stories find the forms the app mounts (see @highalch/story/vite).
  plugins: [highalch()],
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
    include: ["packages/*/*/tests/**/*.test.{ts,tsx}"],
  },
  run: {
    cache: true,
  },
});
