import * as Domain from "@alchemy.run/domain";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Pull,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { Defect, type TaggedFailure } from "./state";
import { cursorOf, failureOf, read, type Connection, type Frame } from "./client";
import * as Rows from "./rows";
import type { Subset } from "./subset";
import type { Answer, Row } from "./values";

/** One change the feed delivered, with its position in the feed and the command that caused it. */
export type Delivered = {
  readonly seq: number;
  readonly commandId: string;
  readonly change: Rows.Change<Row>;
};

type Waiter = Deferred.Deferred<boolean>;

const confirm = (waiter: Waiter, confirmed: boolean) =>
  Deferred.doneUnsafe(waiter, Effect.succeed(confirmed));

/** The command an entry delivers when its entity names one (`cause`), else the recorder's. */
const causeOf = (event: Answer): Option.Option<string> =>
  Option.liftPredicate(event, Predicate.hasProperty("cause")).pipe(
    Option.map((caused) => caused.cause),
    Option.filter(Predicate.isString),
  );

/** The entity an entry names. */
const entityOf = (event: Answer): Option.Option<string> =>
  Option.liftPredicate(event, Predicate.hasProperty("entity")).pipe(
    Option.map((named) => named.entity),
    Option.filter(Predicate.isString),
  );

/**
 * One feed's live subscription for one client: `peek(scope)` for the starting cursor (the latest
 * entry's `seq`), then `events(scope, { after })`, resumed from the last applied `seq` after a
 * failure. Every subset of every entity on the feed listens to it: it starts with the first and
 * stops with the last, and hands each subset the entries of its own entity.
 */
export class Subscription {
  /** The `seq` of the last applied entry. */
  seq = 0;
  private started = false;
  private live = false;
  private failed: Option.Option<TaggedFailure | Defect> = Option.none();
  private recoveries = 0;
  private readonly listeners = new Set<Subset>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly cursors = new Set<{ readonly cursor: number; readonly waiter: Waiter }>();
  private caughtUp = Deferred.makeUnsafe<void, TaggedFailure | Defect>();
  private fiber: Fiber.Fiber<void> | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly feed: Rows.AnyFeed,
  ) {}

  private get name() {
    return `${this.feed.streamName} feed`;
  }

  /** Adds a listener; the first one starts the subscription. */
  acquire = (subset: Subset) => {
    this.listeners.add(subset);

    if (!this.fiber) this.fiber = this.connection.fork(this.follow());
  };

  /** Removes a listener; the last one (of any entity) stops the subscription and forgets it. */
  release = (subset: Subset) => {
    this.listeners.delete(subset);

    if (this.listeners.size > 0) return;

    this.stop();
  };

  /** Whether any subset listens: the subscription then delivers every entry of its scope. */
  get active() {
    return this.listeners.size > 0 && Option.isNone(this.failed);
  }

  /**
   * Whether the feed is caught up now: it delivered its caught-up marker since it last connected
   * and has not failed since. Read-only; the story kit reads it to know the feed is current.
   */
  get current() {
    return this.live && Option.isNone(this.failed);
  }

  /** Completes when the feed is current, or fails if it gave up. */
  ready = Effect.suspend(() => Deferred.await(this.caughtUp));

  /** Registers before sending so a confirmation that beats the receipt is still observed. */
  settle = (commandId: string) => {
    const waiter = Deferred.makeUnsafe<boolean>();
    const known = this.waiters.get(commandId) ?? new Set<Waiter>();

    known.add(waiter);
    this.waiters.set(commandId, known);

    return {
      confirmed: Deferred.await(waiter),
      passed: (cursor: number) => {
        if (Deferred.isDoneUnsafe(waiter)) return;
        if (this.seq >= cursor) {
          confirm(waiter, true);

          return;
        }

        this.cursors.add({ cursor, waiter });
      },
      cancel: () => {
        known.delete(waiter);

        if (known.size === 0 && this.waiters.get(commandId) === known)
          this.waiters.delete(commandId);

        for (const entry of this.cursors) if (entry.waiter === waiter) this.cursors.delete(entry);

        confirm(waiter, false);
      },
    };
  };

  private stop() {
    if (this.connection.feeds.get(this.feed.streamName) === this) {
      this.connection.feeds.delete(this.feed.streamName);
    }

    const fiber = this.fiber;

    this.fiber = undefined;

    if (fiber) Effect.runFork(Fiber.interrupt(fiber));

    for (const waiter of this.waiters.values()) for (const each of waiter) confirm(each, false);

    this.waiters.clear();
    this.cursors.clear();
  }

  /** The entities listening now, by name: an entry of any other entity has no subset to reach. */
  private entities() {
    const entities = new Map<string, Rows.Any>();

    for (const subset of this.listeners) entities.set(subset.entity.entityName, subset.entity);

    return entities;
  }

  /**
   * Applies frames: each entity's changes go to its listeners in one sync transaction each, then
   * waiters. An entry at or before the last applied `seq` (a redelivery) is dropped.
   */
  private receive = (frames: ReadonlyArray<Frame>) => {
    const entities = this.entities();
    const delivered = new Map<string, Array<Delivered>>();
    const commands: Array<string> = [];
    let caughtUp = false;

    for (const frame of frames) {
      if (Domain.Read.isCaughtUp(frame)) {
        caughtUp = true;
        this.seq = Math.max(this.seq, frame.cursor);
      } else if (frame.envelope.seq > this.seq) {
        this.seq = frame.envelope.seq;

        const commandId = Option.getOrElse(causeOf(frame.event), () => frame.envelope.commandId);

        const entity = Option.flatMap(entityOf(frame.event), (name) =>
          Option.fromUndefinedOr(entities.get(name)),
        );

        commands.push(commandId);

        if (Option.isNone(entity)) continue;

        const name = entity.value.entityName;
        const list = delivered.get(name) ?? [];

        list.push({
          seq: frame.envelope.seq,
          commandId,
          change: this.changeOf(entity.value, frame.event),
        });
        delivered.set(name, list);
      }
    }

    if (delivered.size > 0)
      for (const subset of this.listeners) {
        const mine = delivered.get(subset.entity.entityName);

        if (mine) subset.receive(mine);
      }

    for (const commandId of commands)
      for (const waiter of this.waiters.get(commandId) ?? []) confirm(waiter, true);

    for (const entry of this.cursors)
      if (this.seq >= entry.cursor) {
        this.cursors.delete(entry);
        confirm(entry.waiter, true);
      }

    if (!caughtUp) return;

    if (this.live) return;

    this.live = true;
    this.recoveries += 1;
    Deferred.doneUnsafe(this.caughtUp, Effect.void);

    for (const subset of this.listeners) subset.healthy();
  };

  /** An entry as a change of its entity: an upsert's row is decoded by the entity's row schema. */
  private changeOf(entity: Rows.Any, event: Answer): Rows.Change<Row> {
    const meta = this.feed.feed;

    if (Predicate.isTagged(event, meta.Upserted.tag) && Predicate.hasProperty(event, "row")) {
      // SAFETY: a row schema is a plain codec: decoding it needs no services.
      const decoded = Schema.decodeUnknownExit(entity.rows.row as Schema.Codec<unknown, unknown>)(
        event.row,
      );

      if (Exit.isSuccess(decoded)) {
        // SAFETY: the entity's row schema decoded the row.
        const row = decoded.value as Row;

        return Rows.upserted(row);
      }

      throw new Defect({ name: this.name, cause: decoded.cause });
    }

    if (
      Predicate.isTagged(event, meta.Removed.tag) &&
      Predicate.hasProperty(event, "key") &&
      Predicate.isString(event.key)
    )
      return Rows.removed(event.key);

    throw new Defect({
      name: this.name,
      cause: Cause.die(new Error(`Unexpected feed entry ${JSON.stringify(event)}`)),
    });
  }

  /** One connection: the starting cursor once, then the entries after the last applied `seq`. */
  private session() {
    return Effect.gen({ self: this }, function* () {
      const stream = yield* this.connection.stream(this.feed.streamName);
      const scope = this.connection.scope;

      if (!this.started) {
        const latest = yield* stream.peek(scope);

        this.seq = cursorOf(latest);
        this.started = true;
      }

      yield* Stream.runForEachArray(stream.events(scope, { after: this.seq }), (frames) =>
        Effect.sync(() => this.receive(frames)),
      );
    });
  }

  /** Reconnects from the last applied cursor. A catch-up starts a fresh retry schedule. */
  private follow() {
    const name = this.name;
    const ended = new Defect({ name, cause: Cause.die(new Error("The feed ended")) });
    const session = read(name, this.session().pipe(Effect.andThen(Effect.fail(ended))));

    return Effect.gen({ self: this }, function* () {
      let step = yield* Schedule.toStep(this.connection.retry);

      while (true) {
        const before = this.recoveries;
        const error = yield* Effect.flip(session);

        if (this.recoveries !== before) step = yield* Schedule.toStep(this.connection.retry);

        // Report only failures the schedule will retry, before sleeping.
        const now = yield* Clock.currentTimeMillis;
        const [, duration] = yield* Pull.catchDone(step(now, error), () => Effect.fail(error));

        if (this.live) {
          this.live = false;
          this.caughtUp = Deferred.makeUnsafe();
        }

        for (const subset of this.listeners) subset.interrupted(error);

        yield* Effect.sleep(duration);
      }
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;

        return Effect.sync(() => this.fail(failureOf(name, cause)));
      }),
    );
  }

  /** The feed gave up: its listeners stop following it, and a new subset starts a new one. */
  fail(error: TaggedFailure | Defect) {
    this.failed = Option.some(error);

    if (this.connection.feeds.get(this.feed.streamName) === this)
      this.connection.feeds.delete(this.feed.streamName);

    Deferred.doneUnsafe(this.caughtUp, Effect.fail(error));

    for (const waiter of this.waiters.values()) for (const each of waiter) confirm(each, false);

    this.waiters.clear();

    for (const subset of this.listeners) subset.stopped(error);
  }
}

/** The subscription of a feed in a connection, created on first use. */
export const subscriptionOf = (connection: Connection, feed: Rows.AnyFeed) => {
  const known = connection.feeds.get(feed.streamName);

  if (known) return known;

  const created = new Subscription(connection, feed);

  connection.feeds.set(feed.streamName, created);

  return created;
};
