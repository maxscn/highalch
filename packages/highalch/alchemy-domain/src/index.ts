/**
 * Stories of apps on an alchemy Domain: the Domain hosted in memory with LowAlch clients that
 * sync it through the story's wires, on its clock (`Alchemy.memory`), its steps (`given`,
 * `remote`, alchemy's own `from`), and what only LowAlch has. `Db` steps (`@highalch/tanstack-db`)
 * then read `match`'s states, `Db.settled` tells `Committed` from `Unconfirmed`, `Db.rules` judge
 * rows against the feed, and screens mount under LowAlch's `Provider`.
 *
 * ```ts
 * import * as Story from "@highalch/story";
 * import { Alchemy } from "@highalch/alchemy-domain";
 *
 * const story = Story.make(Alchemy.memory({ api, layer, services }), { scope: "acc-1" });
 * await story(Alchemy.given(n1, new NoteCreated({ note })), Db.open(list));
 * ```
 */
import type * as Domain from "@alchemy.run/domain";
import * as LowAlch from "@lowalch/tanstack-db";
import { dbStep, type Scoped } from "@highalch/tanstack-db/internal";
import { connect as connectWith, entries, retryTransport, type ClientSettings } from "./connector";
import { domain, type DomainHost, type Memory } from "./host";
import { fed, noFlickerBack, rejectedRestores, subsetsAgree } from "./rules";
import { from, given, remote } from "./steps";
import { Live, Settled, view } from "./view";

/** The connector of LowAlch clients, as a Layer for a host's `adapters`. */
const connect = (settings: ClientSettings = {}) => connectWith(settings, () => fed);

/**
 * Hosts an Api's model in memory, with LowAlch clients: each scope's client syncs the Domain
 * through the story's wire of that scope, on its clock, with these settings. `Alchemy.given` and
 * `Alchemy.remote` act on it; `Db` steps read its clients.
 */
const memory =
  <A extends Domain.Api.Any, Out, E, R, S>(
    options: Memory<A, Out, E, R, S>,
    settings: ClientSettings = {},
  ): (() => Promise<DomainHost<A>>) =>
  async () => {
    const host = await domain(options)();

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

/**
 * An alchemy Domain in stories: `memory` hosts it with LowAlch clients; `given` seeds history,
 * `remote` is another writer, `from` runs alchemy's own `Given`/`When`; and what only LowAlch has:
 * `reload(Rows)`, the feed's `entries`, the feed rules (`rules`, also in `Db.rules`) and the view
 * helpers. `connect(settings)` is the LowAlch connector, for another host's `adapters`.
 */
export const Alchemy = {
  memory,
  given,
  remote,
  from,
  connect,
  reload,
  entries,
  rules: fed,
  noFlickerBack,
  subsetsAgree,
  rejectedRestores,
  view,
  Live,
  Settled,
  retryTransport,
} as const;

export { isDomainHost } from "./host";

export type { ClientOf, DomainHost, Memory, SessionOf } from "./host";

export type { ClientSettings, Entry } from "./connector";

export type { ViewResult, ViewState } from "./view";
