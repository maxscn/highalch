// Node strips types but cannot run TypeScript parameter properties (used in the workspace
// packages), so the seed runs through Vite's module runner, with the workspace's aliases (the
// root `vite.config.ts`): HighAlch's packages are linked from source.
import { runnerImport } from "vite-plus";

const root = new URL("../../../../vite.config.ts", import.meta.url).pathname;
const { module } = await runnerImport(root, { configFile: false, logLevel: "error" });

await runnerImport(new URL("./generate.ts", import.meta.url).pathname, {
  configFile: false,
  logLevel: "error",
  resolve: { alias: module.workspace },
});
