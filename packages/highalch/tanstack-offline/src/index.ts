/**
 * Offline in stories, for apps on TanStack DB's `@tanstack/offline-transactions`: the browser's
 * storage, tabs and connectivity as things the story owns, so a story can take the network away,
 * bring it back, and reload a tab over the same stored queue.
 *
 * ```ts
 * import * as Story from "@highalch/story";
 * import { Db } from "@highalch/tanstack-db";
 * import { Offline } from "@highalch/tanstack-offline";
 *
 * const story = Story.make(hosting, { scope: "acc-1", adapters: [Offline.memory()] });
 *
 * await story(
 *   Db.open(list),
 *   Offline.down(),
 *   Db.when(notes.rename, { NoteId: "n1", title: "Abel" }),
 *   Db.restart(),
 *   Db.open(list),
 *   Offline.up(),
 * );
 * ```
 *
 * `Offline.memory()` provides `Devices`: each scope's device, whose three parts are the library's
 * own interfaces (`StorageAdapter`, `LeaderElection`, `OnlineDetector`). A connector that knows it
 * (`@highalch/alchemy-domain`'s LowAlch clients) gives them to the clients it makes; with a plain
 * `startOfflineExecutor`, pass a device's parts to its config yourself (`Offline.device()`).
 */
import type {
  LeaderElection,
  OnlineDetector,
  StorageAdapter,
} from "@tanstack/offline-transactions";
import { Context, Effect, Layer, Option } from "effect";
import {
  CurrentStage,
  Mismatch,
  reader,
  staged,
  type Reader,
  type Rule,
  type Stage,
} from "@highalch/story/internal";
import type { Scoped } from "@highalch/tanstack-db";

/** Storage that outlives a client, as IndexedDB outlives a tab; `stored` is what it holds. */
export type Storage = StorageAdapter & { readonly stored: Map<string, string> };

/** Connectivity a story sets; going online tells the executor, as the browser's event does. */
export type Network = OnlineDetector & { readonly set: (online: boolean) => void };

/**
 * What one account's tabs share on one machine: the stored queue, the network, and which tab
 * leads (`tab()` is one tab's leader election: the first to ask leads, and the next takes over
 * when it closes).
 */
export type Device = {
  readonly storage: Storage;
  readonly network: Network;
  readonly tab: () => LeaderElection;
};

const storage = (): Storage => {
  const stored = new Map<string, string>();

  return {
    stored,
    get: async (key) => stored.get(key) ?? null,
    set: async (key, value) => {
      stored.set(key, value);
    },
    delete: async (key) => {
      stored.delete(key);
    },
    keys: async () => [...stored.keys()],
    clear: async () => stored.clear(),
  };
};

const network = (): Network => {
  const listeners = new Set<() => void>();
  let online = true;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    set: (next) => {
      online = next;

      if (next) notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    notifyOnline: notify,
    isOnline: () => online,
    // The device owns it: a closing tab's executor must not silence the other tabs.
    dispose: () => {},
  };
};

type Tab = { leads: boolean; readonly told: Set<(leads: boolean) => void> };

const tabs = () => {
  const open: Array<Tab> = [];

  const elect = () => {
    const first = open[0];

    if (!first || first.leads) return;

    first.leads = true;

    for (const tell of first.told) tell(true);
  };

  return (): LeaderElection => {
    const self: Tab = { leads: false, told: new Set() };

    return {
      requestLeadership: async () => {
        if (!open.includes(self)) open.push(self);

        // Only the first tab leads now: the executor announces its own first result.
        if (open[0] === self) self.leads = true;

        return self.leads;
      },
      releaseLeadership: () => {
        const index = open.indexOf(self);

        if (index >= 0) open.splice(index, 1);

        self.leads = false;
        elect();
      },
      isLeader: () => self.leads,
      onLeadershipChange: (tell) => {
        self.told.add(tell);

        return () => self.told.delete(tell);
      },
    };
  };
};

/** A device of its own: for a plain `startOfflineExecutor`, or a test outside a story. */
const device = (): Device => ({ storage: storage(), network: network(), tab: tabs() });

/** The devices of one story run, by scope: made when first asked for. */
export class Devices extends Context.Service<Devices, { readonly of: (scope: string) => Device }>()(
  "@highalch/tanstack-offline/Devices",
) {}

/**
 * Storage, tabs and a network the story owns, one device per scope, for the story's `adapters`.
 * The clients a knowing connector makes queue their calls on them.
 */
const memory = (): Layer.Layer<Devices, never, CurrentStage> =>
  Layer.effect(
    Devices,
    Effect.gen(function* () {
      const stage = yield* CurrentStage;
      const known = new Map<string, Device>();

      // A stored call is a command that has not ended: the world is not at rest while one waits.
      Option.map(stage.world, (world) =>
        world.rests.push(() => [...known.values()].every((each) => each.storage.stored.size === 0)),
      );

      return {
        of: (scope) => {
          const made = known.get(scope) ?? device();

          known.set(scope, made);

          return made;
        },
      };
    }),
  );

/** The device of a step's scope; a story without `Offline.memory()` has none. */
const deviceOf = async (stage: Stage, label: string, scope: string | undefined) => {
  const world = stage.hosted(label);
  const devices = await stage.provided(Devices);

  return Option.getOrThrowWith(
    devices,
    () =>
      new Mismatch(
        `"${label}" needs the story's devices: add Offline.memory() to the story's adapters`,
      ),
  ).of(scope ?? world.scope);
};

/**
 * `down()`: the browser of the step's scope (or `as`'s) reports no network. The executor holds
 * its queue: calls are stored, not sent. What the app reads is the wire's business: compose the
 * host's own fault steps for an outage of reads too.
 */
const down = (options: Scoped = {}) =>
  staged("the network goes away", async (stage) => {
    (await deviceOf(stage, "the network goes away", options.as)).network.set(false);
    await stage.hosted("the network goes away").settle();
  });

/** `up()`: the network is back, and the executor is told: it sends what is queued, in order. */
const up = (options: Scoped = {}) =>
  staged("the network is back", async (stage) => {
    (await deviceOf(stage, "the network is back", options.as)).network.set(true);
    await stage.hosted("the network is back").settle();
  });

/** How many calls a scope's device stores now, as a rule reads it. */
const queued = (options: Scoped = {}): Reader<number> =>
  reader(
    ["queued calls", ...[options.as].filter((as) => as !== undefined).map((as) => `as ${as}`)].join(
      " ",
    ),
    async (stage) => (await deviceOf(stage, "queued calls", options.as)).storage.stored.size,
  );

/** Whether a scope's device reports a network, as a rule reads it. */
const online = (options: Scoped = {}): Reader<boolean> =>
  reader(
    ["online", ...[options.as].filter((as) => as !== undefined).map((as) => `as ${as}`)].join(" "),
    async (stage) => (await deviceOf(stage, "online", options.as)).network.isOnline(),
  );

/** With the network there and the world at rest, nothing is still queued: every call was sent. */
const drained: Rule = {
  name: "online at rest, nothing is queued",
  at: "rest",
  check: async (stage) => {
    const devices = await stage.provided(Devices);

    if (Option.isNone(devices) || Option.isNone(stage.world)) return [];

    const found = devices.value.of(stage.world.value.scope);

    if (!found.network.isOnline() || found.storage.stored.size === 0) return [];

    return [
      `${found.storage.stored.size} call(s) are still stored: ${[...found.storage.stored.keys()].join(", ")}`,
    ];
  },
};

/**
 * Offline steps, readers and rules. `memory()` goes in the story's `adapters`; `down()`/`up()`
 * take the network away and bring it back; `queued()` and `online()` read a device for rules;
 * `rules` hold of every story with a queue; `device()` is a device outside a story.
 */
export const Offline = {
  memory,
  device,
  down,
  up,
  queued,
  online,
  drained,
  rules: [drained],
} as const;
