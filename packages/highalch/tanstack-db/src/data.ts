import type { Transaction } from "@tanstack/db";
import { DbProvider } from "@tanstack/react-db";
import { Effect, Layer, Option } from "effect";
import { createElement, type ReactElement } from "react";
import { CurrentStage, Data, type DataLayer } from "@highalch/story/internal";
import { clients, type Clients, type Declared, type Settled } from "./state";

/**
 * The story's data layer on TanStack DB clients (plain, or a connector's): screens mount under the
 * client's provider (TanStack DB's `DbProvider`, or the connector's: LowAlch's `Provider`), a
 * running machine's commands run on the client and are recorded as `Db.commands` reads them.
 * Give it to a host's `adapters`:
 * `Story.local({ adapters: [Db.data] })`; `Alchemy.memory` includes it.
 */
export const data: Layer.Layer<Data, never, CurrentStage> = Layer.effect(
  Data,
  Effect.gen(function* () {
    const stage = yield* CurrentStage;
    let built = Option.none<Clients>();

    const db = async () => {
      const made = await stage.use(clients);

      built = Option.some(made);

      return made;
    };

    const layer: DataLayer = {
      connect: async (scope) => {
        await (await db()).connect(scope);
      },
      mount: async (element, scope) => {
        const made = await db();
        const client = await made.connect(scope);
        // SAFETY: screens mount React elements.
        const mounted = element as ReactElement;

        return Option.match(Option.fromUndefinedOr(made.connector.provide), {
          onNone: () => createElement(DbProvider, { client: client.db }, mounted),
          onSome: (provide) => provide(client.db, mounted),
        });
      },
      run: async (request) =>
        (await db()).start(
          request.label,
          request.scope,
          request.by,
          request.input,
          // SAFETY: a command called on a TanStack DB client answers its transaction.
          (client, onCommitted) =>
            request.call(client, (value) => onCommitted(value as Settled)) as Transaction,
          // SAFETY: the commands a data layer runs are the app's declared commands.
          request.command as Option.Option<Declared>,
        ),
      runs: () => Option.match(built, { onNone: () => [], onSome: (made) => made.runs }),
    };

    return layer;
  }),
);
