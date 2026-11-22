import { defineConfig } from "vite-plus";
import { workspace } from "../../vite.config.ts";

/** End-to-end tests (`*.e2e.test.ts`) run only with `vp run test:console-e2e`. */
const e2e = process.env.HIGHALCH_CONSOLE_E2E === "1";

export default defineConfig({
  resolve: { alias: workspace, dedupe: ["effect", "react", "react-dom"] },
  test: {
    name: "console-server",
    include: [e2e ? "tests/**/*.e2e.test.ts" : "tests/**/*.test.ts"],
    exclude: e2e ? [] : ["tests/**/*.e2e.test.ts"],
  },
});
