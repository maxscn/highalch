import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      vite: "src/vite.ts",
      "react-form": "src/react-form.ts",
    },
    format: "esm",
    fixedExtension: true,
    platform: "node",
    tsconfig: "tsconfig.build.json",
    dts: { generator: "tsgo" },
  },
});
