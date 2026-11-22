import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts", bin: "src/bin.ts", browser: "src/browser.ts" },
    format: "esm",
    fixedExtension: true,
    platform: "node",
    tsconfig: "tsconfig.build.json",
    dts: { generator: "tsgo" },
  },
});
