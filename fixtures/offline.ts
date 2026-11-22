/**
 * The Notebook with a durable offline queue: what an app sets up, with the browser's storage,
 * leadership and connectivity replaced by ones a test holds, so it can reload a tab (a new client
 * over the same `storage`), open a second tab (another `tab` of the same `browser`) and take the
 * network away (`network.set(false)`).
 *
 * ```ts
 * const db = LowAlch.make({ api, layer, scope, offline: offline() }); // an app: the defaults
 * ```
 */
import type {
  LeaderElection,
  OnlineDetector,
  StorageAdapter,
} from "@tanstack/offline-transactions";
import type * as LowAlch from "@lowalch/tanstack-db";
import { offline } from "@lowalch/tanstack-db/offline";
import { account, type Host } from "./harness";
import type { NotesApi } from "./notebook";

/** Storage that outlives a client, as IndexedDB outlives a tab. */
export const memoryStorage = (): StorageAdapter & { readonly stored: Map<string, string> } => {
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

/** Connectivity a test sets; going online tells the executor, as the browser's event does. */
export const network = (): OnlineDetector & { readonly set: (online: boolean) => void } => {
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

/** One browser's tabs: the first to ask leads, and the next one takes over when it closes. */
export const browser = () => {
  const tabs: Array<{ leads: boolean; readonly told: Set<(leads: boolean) => void> }> = [];

  const elect = () => {
    const first = tabs[0];

    if (!first || first.leads) return;

    first.leads = true;

    for (const tell of first.told) tell(true);
  };

  /** A tab's leader election. */
  const tab = (): LeaderElection => {
    const self = { leads: false, told: new Set<(leads: boolean) => void>() };

    return {
      requestLeadership: async () => {
        if (!tabs.includes(self)) tabs.push(self);

        // Only the first tab is told now: the executor announces its own first result.
        if (tabs[0] === self) self.leads = true;

        return self.leads;
      },
      releaseLeadership: () => {
        const index = tabs.indexOf(self);

        if (index >= 0) tabs.splice(index, 1);

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

  return { tab };
};

/** What one account's tabs share: its stored queue, its browser and its network. */
export const device = () => ({ storage: memoryStorage(), browser: browser(), network: network() });

export type Device = ReturnType<typeof device>;

/** Opens a tab of the account on a device: a client with a durable queue. */
export const offlineAccount = (
  server: Host,
  scope: string,
  on: Device,
  cleanup: Array<() => Promise<void>>,
  options: Partial<LowAlch.Config<typeof NotesApi>> = {},
) =>
  account(server, scope, cleanup, {
    offline: offline({
      storage: on.storage,
      leaderElection: on.browser.tab(),
      onlineDetector: on.network,
    }),
    ...options,
  });
