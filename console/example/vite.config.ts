import { defineConfig } from "vite-plus";
import { workspace } from "../../vite.config.ts";

export default defineConfig({
  resolve: { alias: workspace, dedupe: ["effect", "react", "react-dom"] },
  test: { name: "console-example", include: ["tests/**/*.test.{ts,tsx}"] },
});
