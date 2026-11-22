/**
 * What adapters built on `Db` (`@highalch/alchemy-domain`, `@highalch/xstate`, `@highalch/screen`)
 * reach: its clients, connector and steps as they are inside. Unstable and outside semver.
 */
export { Connect, plain as plainConnector } from "./connector";
export type { Change, Connector, Watched } from "./connector";
export * from "./rules";
export * from "./state";
export * from "./steps";
