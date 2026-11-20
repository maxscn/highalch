/**
 * TanStack DB steps for stories: what a client's sources show, the commands it runs and how they
 * settle, and the invariants of what it shows. They run on the story runner of
 * `@highalch/story`, beside machine and screen steps.
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
import {
  invariants,
  noFlickerBack,
  nothingPending,
  rejectedRestores,
  subsetsAgree,
} from "../invariants";
import { historyOf, open, rejected, reload, settled, then, when } from "../steps";
import { Live, Settled, view } from "../view";

/** The TanStack DB steps, invariants and view helpers. */
export const Db = {
  open,
  when,
  then,
  settled,
  rejected,
  reload,
  historyOf,
  view,
  Live,
  Settled,
  invariants,
  noFlickerBack,
  nothingPending,
  subsetsAgree,
  rejectedRestores,
} as const;

export type { Acting, Callable, Expected, ReadState, ShownRow, Then } from "../steps";

export type { ViewResult, ViewState } from "../view";
