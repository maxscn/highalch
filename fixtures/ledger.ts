import * as Domain from "@alchemy.run/domain";
import type { DecideContext } from "@alchemy.run/domain/Aggregate";
import type * as Model from "@alchemy.run/domain/Model";
import { Context, Deferred, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";
import * as HighAlch from "@highalch/tanstack-db";

/**
 * A Domain whose writes settle later, as writes through a policy do: a command records a decision
 * (`EntryRecorded`, before anything is stored), a policy persists it to the store and settles the
 * entry under its own command id (`settle:<command id>`). Only the settled fact reaches the row
 * feed, with the original command as its `cause`. Command inputs nest the row fields in `value`,
 * and the list query wraps its rows in `{ Items, Count }`. The feed is guarded: a reader (the
 * `ReadSession` middleware provides who) reads only its own account's feed.
 */
export const Entry = Schema.Struct({
  EntryId: Schema.String,
  account: Schema.String,
  text: Schema.String,
});

export type Entry = typeof Entry.Type;

const Address = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));

/** An entry aggregate's id: the account and the entry's key, as JSON. */
export const address = (account: string, EntryId: string) =>
  Schema.encodeSync(Address)([account, EntryId]);

export class EntryRecorded extends Domain.Event("EntryRecorded", {
  requestId: Schema.String,
  entry: Entry,
  remove: Schema.Boolean,
}) {}

const Settlement = {
  requestId: Schema.String,
  entry: Entry,
  remove: Schema.Boolean,
  stored: Schema.Boolean,
};

export class EntrySettled extends Domain.Event("EntrySettled", Settlement) {}

export class EntryEmpty extends Domain.Rejection("EntryEmpty") {}

export class SaveEntry extends Domain.Command("SaveEntry", {
  target: Schema.String,
  input: {
    value: Schema.Struct({ EntryId: Schema.optionalKey(Schema.String), text: Schema.String }),
  },
  events: [EntryRecorded],
  rejects: [EntryEmpty],
}) {}

export class DropEntry extends Domain.Command("DropEntry", {
  target: Schema.String,
  input: { value: Schema.Struct({ EntryId: Schema.String }) },
  events: [EntryRecorded],
}) {}

export class SettleEntry extends Domain.Command("SettleEntry", {
  target: Schema.String,
  input: Settlement,
  events: [EntrySettled],
}) {}

const recorded = (id: string, context: DecideContext<string>, text: string, remove: boolean) => {
  const [account, EntryId] = Schema.decodeUnknownSync(Address)(id);

  return [
    new EntryRecorded({
      requestId: context.commandId,
      entry: { EntryId, account, text },
      remove,
    }),
  ];
};

export class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ text: Schema.NullOr(Schema.String) }),
  initial: { text: null },
  commands: [SaveEntry, DropEntry, SettleEntry],
  decide: {
    SaveEntry: (_state, command, context) =>
      Option.match(
        Option.liftPredicate(command.value.text, (text) => text.length > 0),
        {
          onNone: () => new EntryEmpty(),
          onSome: (text) => recorded(context.id, context, text, false),
        },
      ),
    DropEntry: (state, _command, context) => recorded(context.id, context, state.text ?? "", true),
    SettleEntry: (_state, command) => [
      new EntrySettled({
        requestId: command.requestId,
        entry: command.entry,
        remove: command.remove,
        stored: command.stored,
      }),
    ],
  },
  evolve: {
    EntryRecorded: (_state, event) => ({ text: event.entry.text }),
    EntrySettled: (state) => state,
  },
}) {}

/** Who reads: the account the `ReadSession` middleware found for the request. */
export class Reader extends Context.Service<Reader, { readonly account: string }>()(
  "Test/Reader",
) {}

export class ReadSession extends RpcMiddleware.Service<ReadSession, { provides: Reader }>()(
  "Test/ReadSession",
  {},
) {}

/** The session of a reader of `account`, as an in-process client's server side runs it. */
export const session = (account: string) =>
  Layer.succeed(ReadSession, (effect) => Effect.provideService(effect, Reader, { account }));

export class NotYours extends Domain.Rejection("NotYours") {}

/** The guarded feed: one stream per account, readable by that account only. */
export class LedgerChanges extends HighAlch.Feed("LedgerChanges", {
  scope: Schema.String,
  middleware: [ReadSession],
  rejects: [NotYours],
}) {}

export const LedgerChangesLive = LedgerChanges.readers({
  scope: Effect.gen(function* () {
    const reader = yield* Reader;

    return reader.account;
  }),
  reject: () => new NotYours(),
});

/** The entity: only stored changes, each delivering the command that recorded it. */
export class EntryRows extends HighAlch.Rows("EntryRows", {
  feed: LedgerChanges,
  row: Entry,
  key: "EntryId",
  from: [Ledger],
  scope: ({ event }) => event.entry.account,
  target: (key, scope) => address(scope, key),
  cause: (event) => event.requestId,
  on: {
    EntrySettled: (event) => {
      if (!event.stored) return undefined;

      if (event.remove) return HighAlch.removed(event.entry.EntryId);

      return HighAlch.upserted(event.entry);
    },
  },
}) {}

export class LedgerWriter extends HighAlch.Projection("LedgerChanges", {
  feed: LedgerChanges,
  entities: [EntryRows],
}) {}

/** The store the policy writes and the query reads. */
export class EntryStore extends Context.Service<
  EntryStore,
  {
    readonly entries: Map<string, Entry>;
    /** Entry keys whose writes the store refuses (settled, but nothing stored). */
    readonly refuse: Set<string>;
    /** Held before each write is stored. */
    gate: Effect.Effect<void>;
  }
>()("Test/EntryStore") {}

export class Persist extends Domain.Policy("Persist", {
  from: [Ledger],
  key: Ledger,
  on: [EntryRecorded],
}) {}

const PersistLive = Persist.toLayer(
  Effect.gen(function* () {
    const store = yield* EntryStore;
    const ledger = yield* Ledger;

    return ({ event, source }) =>
      Effect.gen(function* () {
        yield* store.gate;

        const stored = !store.refuse.has(event.entry.EntryId);

        if (stored && event.remove) store.entries.delete(event.entry.EntryId);
        else if (stored) store.entries.set(event.entry.EntryId, event.entry);

        yield* ledger
          .send(
            source.id,
            new SettleEntry({
              requestId: event.requestId,
              entry: event.entry,
              remove: event.remove,
              stored,
            }),
            {
              commandId: `settle:${event.requestId}`,
            },
          )
          .pipe(Effect.orDie);
      });
  }),
);

export class Entries extends Domain.Query("Entries", {
  input: { account: Schema.String },
  success: Schema.Struct({ Items: Schema.Array(Entry), Count: Schema.Number }),
}) {}

const EntriesLive = Entries.toLayer(
  Effect.gen(function* () {
    const store = yield* EntryStore;

    return ({ account }) =>
      Effect.sync(() => {
        const Items = [...store.entries.values()]
          .filter((entry) => entry.account === account)
          .sort((a, b) => a.EntryId.localeCompare(b.EntryId));

        return { Items, Count: Items.length };
      });
  }),
);

export class Ledgers extends Domain.Model("Ledgers", {
  aggregates: [Ledger],
  policies: [Persist],
  projections: [LedgerWriter],
  streams: [LedgerChanges],
  queries: [Entries],
}) {}

export class LedgerApi extends Domain.Api("LedgerApi", { model: Ledgers }) {}

/** The declarations under test: wrapped list rows, nested command inputs, deferred settlement. */
export const entries = HighAlch.collection(EntryRows, {
  queries: { list: HighAlch.entries(Entries, (answer) => answer.Items) },
  commands: {
    save: HighAlch.updates(SaveEntry, {
      key: (input) => input.value.EntryId ?? "",
      fields: (input) => input.value,
      input: (row: Partial<Entry>) => ({ value: { EntryId: row.EntryId, text: row.text ?? "" } }),
    }),
    drop: HighAlch.deletes(DropEntry, { key: (input) => input.value.EntryId }),
  },
});

/** A fresh, empty store, as a Layer (a story reads it with `world.host.service(EntryStore)`). */
export const entryStore = () =>
  Layer.sync(EntryStore, () =>
    EntryStore.of({ entries: new Map(), refuse: new Set(), gate: Effect.void }),
  );

/** The model's handlers, its feed writer and its feed's readers, over the `EntryStore` service. */
export const ledger = () =>
  Layer.mergeAll(PersistLive, EntriesLive, LedgerWriter.layer, LedgerChangesLive);

/**
 * Hosts the model in memory; `hold` holds every write until its release is called. `api` reads as
 * a reader of `acc-1`; `reader(account)` is an Api client of another account's reader.
 */
export const host = async () => {
  const store = EntryStore.of({ entries: new Map(), refuse: new Set(), gate: Effect.void });

  const model = Ledgers.layer(
    Layer.mergeAll(PersistLive, EntriesLive, LedgerWriter.layer, LedgerChangesLive),
  ).pipe(Layer.provide(Layer.succeed(EntryStore, store)), Layer.provide(Domain.InMemory));

  const hosted = ManagedRuntime.make(model);
  const internals = await hosted.runPromise(Effect.context<Model.Internals>());

  /** The in-process client of a reader of `account`, over the one hosted model. */
  const reader = (account: string) =>
    ManagedRuntime.make(
      LedgerApi.layerClientInProcess.pipe(
        Layer.provide(session(account)),
        Layer.provide(Layer.succeedContext(internals)),
      ),
    );

  const runtime = reader("acc-1");
  const api = await runtime.runPromise(LedgerApi.Client);

  const hold = () => {
    const gate = Effect.runSync(Deferred.make<void>());

    store.gate = Deferred.await(gate);

    return () => {
      store.gate = Effect.void;
      Effect.runSync(Deferred.succeed(gate, undefined));
    };
  };

  /** Writes entries as another client would and waits until they are stored. */
  const seed = async (...rows: ReadonlyArray<Entry>) => {
    for (const row of rows)
      await runtime.runPromise(
        api.SaveEntry(address(row.account, row.EntryId), { value: { text: row.text } }),
      );

    for (
      let tries = 0;
      tries < 200 && !rows.every((row) => store.entries.has(row.EntryId));
      tries++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
  };

  return {
    api,
    store,
    hold,
    seed,
    reader,
    dispose: async () => {
      await runtime.dispose();
      await hosted.dispose();
    },
  };
};
