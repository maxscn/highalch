import * as DomainRead from "@alchemy.run/domain/Read";
import { getLiveQueryStatusFlags, type DbClient } from "@tanstack/db";
import { createElement } from "react";
import { Effect, Exit, Layer, Option, Predicate, Schedule, Schema, Stream } from "effect";
import * as LowAlch from "@lowalch/tanstack-db";
import { activate, createdKey, type Retry, type Settings } from "@lowalch/tanstack-db";
import {
  connectionOf,
  fromLive,
  keyOf,
  waitKind,
  type Connection,
  type Rows,
} from "@lowalch/tanstack-db/internal";
import { Provider } from "@lowalch/tanstack-db/react";
import type { Rule } from "../rules";
import { Connect, type Connector } from "../tanstack-db/connector";
import { plain, type Clients, type Observed } from "../tanstack-db/state";
import { isFeed } from "../wire";
import { macrotask, type Plain, type World } from "../world";

/** What a story's LowAlch clients are, besides how they reach the Api and their clock. */
export type ClientSettings = Partial<Omit<Settings, "api" | "layer" | "scope" | "clock">>;

/** Retries transport failures (every 100 ms on the story's clock); stops for anything else. */
export const retryTransport: Retry = Schedule.spaced(100).pipe(
  Schedule.while(({ input }: { input: LowAlch.TaggedFailure | LowAlch.Defect }) =>
    Predicate.isTagged(input, "RpcClientError"),
  ),
);

/** One entry of a feed, as a story reads the feed to judge what its clients showed. */
export type Entry = {
  readonly seq: number;
  readonly commandId: string;
  readonly entity: string;
  readonly key: string;
  /** The row after it, decoded by its entity's schema (`None`: removed). */
  readonly row: Option.Option<Plain>;
};

const Frame = Schema.Struct({
  envelope: Schema.Struct({ seq: Schema.Number, commandId: Schema.String }),
  event: Schema.Struct({
    _tag: Schema.String,
    entity: Schema.String,
    key: Schema.optionalKey(Schema.String),
    row: Schema.optionalKey(Schema.Unknown),
    cause: Schema.optionalKey(Schema.String),
  }),
});

/** The entity whose subset an observed source is, when it is one (a `LowAlch.query` is not). */
export const entityOf = (observed: Observed): Option.Option<Rows.Any> => {
  for (const subsets of connectionOf(observed.clients.client(observed.scope).db).subsets.values())
    for (const subset of subsets)
      if (subset.collection.id === observed.collection.id) return Option.some(subset.entity);

  return Option.none();
};

/**
 * The feed entries of every entity the client of `scope` reads, in order, with rows decoded by
 * their entity's schema. Read from the Domain itself (not through the story's wire).
 */
export const entries = async (
  db: Clients,
  scope = db.world.scope,
): Promise<ReadonlyArray<Entry>> => {
  const client = db.all().find((each) => each.scope === scope);

  if (!client) return [];

  const entities = new Map<string, Rows.Any>();

  for (const subsets of connectionOf(client.db).subsets.values())
    for (const subset of subsets) entities.set(subset.entity.entityName, subset.entity);

  const streams = new Set([...entities.values()].map((entity) => entity.feed.streamName));

  const raw = await db.world.raw(scope);
  const read: Array<Entry> = [];

  for (const stream of streams) {
    const feed = raw[stream];

    if (!isFeed(feed)) continue;

    const frames = await Effect.runPromise(
      feed.events(scope, { after: 0 }).pipe(
        Stream.takeUntil(DomainRead.isCaughtUp),
        Stream.filter((frame) => !DomainRead.isCaughtUp(frame)),
        Stream.runCollect,
      ),
    );

    for (const frame of frames) {
      const { envelope, event } = Schema.decodeUnknownSync(Frame)(frame);
      const entity = entities.get(event.entity);

      if (!entity) continue;

      const row = Option.map(Option.fromUndefinedOr(event.row), (encoded) =>
        // SAFETY: an entity's row schema is a plain codec; decoding needs no services.
        plain(Schema.decodeUnknownSync(entity.rows.row as Schema.Codec<object, unknown>)(encoded)),
      );

      const key = Option.match(row, {
        onNone: () => event.key ?? "",
        onSome: (decoded) => keyOf(entity.rows.key, decoded),
      });

      read.push({
        seq: envelope.seq,
        commandId: event.cause ?? envelope.commandId,
        entity: entity.entityName,
        key,
        row,
      });
    }
  }

  return read.sort((a, b) => a.seq - b.seq);
};

/** The server's latest `seq` of a stream for a scope, read from the Domain itself. */
const cursor = async (world: World, scope: string, stream: string) => {
  const feed = (await world.raw(scope))[stream];

  if (!isFeed(feed)) return 0;

  const latest = await Effect.runPromiseExit(feed.peek(scope));

  return Exit.match(latest, {
    onFailure: () => 0,
    onSuccess: (entry) => entry?.envelope.seq ?? 0,
  });
};

/**
 * LowAlch clients over the story's hosted Domain: each scope's client reaches the Api through the
 * world's wire of that scope and waits on the story's clock. The world waits for every live feed
 * to deliver the server's latest entry; read states are `match`'s; closing lets the commands in
 * flight through.
 */
export const lowalch =
  (settings: ClientSettings, rules: () => ReadonlyArray<Rule>) =>
  (world: World): Connector => ({
    connect: async (scope) => {
      const wire = world.wire(scope);
      const raw = await world.raw(scope);
      const api = world.host.api;

      // SAFETY: the wrapped client has the Api client's endpoints, as its `Client` key yields them.
      const layer = Layer.succeed(api.Client, wire.wrap(raw, world.queries) as never);

      return LowAlch.make({
        api,
        layer,
        scope,
        live: settings.live,
        gcTime: settings.gcTime,
        reloadDelay: settings.reloadDelay ?? 10,
        settleTimeout: settings.settleTimeout ?? 2_000,
        retry: settings.retry ?? retryTransport,
        clock: world.clock.effect(waitKind),
      });
    },

    busy: async (db: DbClient, scope: string) => {
      if (world.clock.mode === "real" && world.clock.waiting("retry", "reload"))
        return Option.some("a retry or reload is about to run");

      const wire = world.wire(scope);
      const connection: Connection = connectionOf(db);

      for (const [stream, feed] of connection.feeds) {
        if (!feed.active) continue;

        if (wire.lossy) continue;

        if (!feed.current) {
          if (wire.dropped || world.clock.waiting("retry")) continue;

          return Option.some(`${scope}: the ${stream} feed is connecting`);
        }

        const latest = await cursor(world, scope, stream);

        if (feed.seq < latest)
          return Option.some(`${scope}: the ${stream} feed is at ${feed.seq} of ${latest}`);
      }

      return Option.none();
    },

    /**
     * `LowAlch.close` waits until the commands it sent have settled, and a story holds them
     * (replies wait at the wire, settle timeouts on the manual clock): a story that ended or
     * failed with a command in flight lets its replies through and runs the clock's waits until
     * the close returns, so disposing never hangs. Gives up after three seconds.
     */
    close: async (db, scope) => {
      const wire = world.wire(scope);
      const deadline = Date.now() + 3_000;
      let closed = false;

      const closing = Effect.runPromise(LowAlch.close(db)).finally(() => {
        closed = true;
      });

      while (!closed && Date.now() < deadline) {
        wire.flow(true);
        wire.release();
        world.clock.fireNext(Number.POSITIVE_INFINITY);
        await macrotask();
      }

      if (closed) await closing;
    },

    state: (collection, single) => {
      const rows = [...collection.values()];

      const data = Option.match(
        Option.liftPredicate(rows, () => single),
        {
          onNone: () => rows,
          onSome: (found) => found[0],
        },
      );

      const flags = getLiveQueryStatusFlags(collection.status, collection.health);

      // `match`'s `retry` reloads the collection, when it can.
      const reload = async () => {
        if (collection.reload !== undefined) await collection.reload();
      };

      return fromLive({
        ...flags,
        data,
        status: collection.status,
        isEnabled: true,
        collection: { reload },
      }).state;
    },

    keyOf: (transaction) => {
      const key = transaction.metadata[createdKey];

      if (Predicate.isString(key)) return key;

      return "";
    },

    activate,

    provide: (db, element) => createElement(Provider, { client: db }, element),

    rules: rules(),
  });

/** The connector as a Layer: what a host's `adapters` (or `story.with`) provide. */
export const connect = (settings: ClientSettings, rules: () => ReadonlyArray<Rule>) =>
  Layer.succeed(Connect, lowalch(settings, rules));
