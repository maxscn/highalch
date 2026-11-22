import type { DbClient } from "@tanstack/db";
import { DbProvider } from "@tanstack/react-db";
import { useSyncExternalStore, type ReactNode } from "react";
import { activate } from "./client";

const registrations = new WeakMap<DbClient, (notify: () => void) => () => void>();

/** The subscription that registers a client for commands while a provider of it is mounted. */
const registration = (client: DbClient) => {
  const known = registrations.get(client);

  if (known) return known;

  const created = () => activate(client);

  registrations.set(client, created);

  return created;
};

const snapshot = () => true;

/**
 * Provides one account's client: TanStack DB's `DbProvider` for stock `useLiveQuery`, and the
 * client commands use when they are given none. The registration lives exactly as long as the
 * provider is mounted (an external-store subscription, so never during server rendering).
 */
export function Provider({ client, children }: { client: DbClient; children?: ReactNode }) {
  useSyncExternalStore(registration(client), snapshot, snapshot);

  return <DbProvider client={client}>{children}</DbProvider>;
}
