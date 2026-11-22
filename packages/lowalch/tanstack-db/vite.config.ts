import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      server: "src/server.ts",
      react: "src/react.tsx",
      xstate: "src/xstate/index.ts",
      offline: "src/offline/index.ts",
      internal: "src/internal.ts",
    },
    format: "esm",
    fixedExtension: true,
    platform: "neutral",
    tsconfig: "tsconfig.build.json",
    dts: { generator: "tsgo" },
  },
});
