/**
 * LowAlch clients for stories: the TanStack DB clients of `Db` steps become LowAlch clients that
 * sync the story's hosted Domain through its wires, on its clock. `LowAlchDb.memory` hosts the
 * Domain in memory with them (or provide `LowAlchDb.connect(settings)` to another host's
 * `adapters`); then `Db.then` reads `match`'s states, `Db.settled` tells `Committed` from
 * `Unconfirmed`, `Db.invariants` judge rows against the feed, and screens mount under LowAlch's
 * `Provider`. This entry adds what only LowAlch has: `reload(Rows)`, the feed's `entries`, the
 * view helpers and the feed invariants by name.
 *
 * ```ts
 * import * as Story from "@highalch/story";
 * import { Db } from "@highalch/story/tanstack-db";
 * import { LowAlchDb } from "@highalch/story/lowalch";
 *
 * const story = Story.make(LowAlchDb.memory({ api, layer }), { scope: "acc-1" });
 * ```
 */
import type * as Domain from "@alchemy.run/domain";
import * as LowAlch from "@lowalch/tanstack-db";
import { memory as hosted, type Hosting, type Memory } from "../host";
import { dbStep, type Scoped } from "../tanstack-db/steps";
import { connect as connectWith, entries, retryTransport, type ClientSettings } from "./connector";
import { fed, noFlickerBack, rejectedRestores, subsetsAgree } from "./invariants";
import { Live, Settled, view } from "./view";

/** The connector of LowAlch clients, as a Layer for a host's `adapters`. */
const connect = (settings: ClientSettings = {}) => connectWith(settings, () => fed);

/**
 * Hosts an Api's model in memory (as `Story.memory` does) with LowAlch clients: each scope's
 * client syncs the Domain through the story's wire of that scope, with these settings.
 */
const memory =
  <A extends Domain.Api.Any, Out, E, R, S>(
    options: Memory<A, Out, E, R, S>,
    settings: ClientSettings = {},
  ): Hosting<A> =>
  async () => {
    const host = await hosted(options)();

    return { ...host, adapters: [...(host.adapters ?? []), connect(settings)] };
  };

/** An entity, as `LowAlch.reload(db, Rows)` takes it. */
type Entity = { readonly entityName: string };

/**
 * Reloads every loaded subset of an entity in the step's client, as `LowAlch.reload(db, Rows)`
 * does after a write the feed does not carry; its debounce (`reloadDelay`) passes, so the subsets
 * have reloaded when the step ends.
 */
const reload = (entity: Entity, options: Scoped = {}) =>
  dbStep(`reload ${entity.entityName}`, async (db, world) => {
    LowAlch.reload((await db.connect(options.as)).db, entity);

    while (world.clock.fireNext(Number.POSITIVE_INFINITY, ["reload"])) await world.settle();

    await world.settle();
  });

/** LowAlch clients for `Db` steps, and what only LowAlch has. */
export const LowAlchDb = {
  memory,
  connect,
  reload,
  entries,
  invariants: fed,
  noFlickerBack,
  subsetsAgree,
  rejectedRestores,
  view,
  Live,
  Settled,
  retryTransport,
} as const;

export type { ClientSettings, Entry } from "./connector";

export type { ViewResult, ViewState } from "./view";
