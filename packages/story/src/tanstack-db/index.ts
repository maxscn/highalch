/**
 * TanStack DB steps for stories: what a client's sources show, the commands it runs and how they
 * settle, and the rules of what it shows. They run on the story runner of
 * `@highalch/story`, beside machine and screen steps, on plain TanStack DB clients or on the
 * clients a connector makes (`@highalch/story/lowalch`).
 *
 * ```ts
 * import * as Story from "@highalch/story";
 * import { Db } from "@highalch/story/tanstack-db";
 *
 * await story(
 *   Story.given(n1, new NoteCreated({ note: ada })),
 *   Db.then(list, [{ title: "Ada" }]),
 *   Db.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
 *   Db.then(list, [{ title: "Ada 2", $hasPendingWrites: true }]),
 *   Db.settled("Committed"),
 * );
 * ```
 */
import { connected, nothingPending, rules } from "./rules";
import { clients } from "./state";
import { check, historyOf, open, rejected, reload, rows, settled, thenShows, when } from "./steps";

/**
 * The TanStack DB steps, readers and rules. They work on plain TanStack DB clients; a connector
 * (`LowAlchDb` from `@highalch/story/lowalch`) makes them LowAlch clients that sync the story's
 * Domain, and its own rules join `Db.rules`.
 */
export const Db = {
  open,
  when,
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is the given/when/then vocabulary
  then: thenShows,
  settled,
  rejected,
  reload,
  historyOf,
  check,
  rows,
  rules,
  nothingPending,
  connected,
  clients,
} as const;

export { Connect, plain as plainConnector } from "./connector";

export type { Change, Connector, Watched } from "./connector";

export { Clients, DbClients, Observed, Outcome, plain } from "./state";

export type { Client, Observation, Run, Settled, Shown, Source } from "./state";

export type { Acting, Callable, Expected, ReadState, Scoped, ShownRow, Then } from "./steps";
