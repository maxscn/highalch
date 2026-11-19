import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      xstate: "src/xstate/index.ts",
      screen: "src/screen/index.ts",
    },
    format: "esm",
    fixedExtension: true,
    platform: "node",
    tsconfig: "tsconfig.build.json",
    dts: { generator: "tsgo" },
  },
});
