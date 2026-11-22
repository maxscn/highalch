import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      "tanstack-db": "src/tanstack-db/index.ts",
      lowalch: "src/lowalch/index.ts",
      "tanstack-form": "src/tanstack-form/index.ts",
      "react-form": "src/tanstack-form/react-form.ts",
      vite: "src/vite.ts",
      xstate: "src/xstate/index.ts",
      screen: "src/screen/index.ts",
      takumi: "src/takumi/index.ts",
      stream: "src/stream/index.ts",
    },
    format: "esm",
    fixedExtension: true,
    platform: "node",
    tsconfig: "tsconfig.build.json",
    dts: { generator: "tsgo" },
  },
});
