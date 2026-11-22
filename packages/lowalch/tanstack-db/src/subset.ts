import type * as Domain from "@alchemy.run/domain";
import type { Collection, SyncConfig } from "@tanstack/db";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  type Fiber,
  Option,
  Predicate,
  Pull,
  Schedule,
  Scope,
  Stream,
} from "effect";
import type { Defect, TaggedFailure } from "./state";
import { cursorOf, failureOf, read, waitKind, type Connection } from "./client";
import { subscriptionOf, type Delivered, type Subscription } from "./feed";
import type * as Rows from "./rows";
import { apply, rebase, settle } from "./sync-rows";
import { keyOf, type Answer, type Input, type Row } from "./values";

// Query-decided subsets patch every delivered entry and debounce a re-ask. Replay the changes
// since the last clean answer, keeping shown rows the answer omits. Discard at most two answers
// overtaken by the feed, then write a snapshot. Three progressively delayed corrections bound
// how long the feed can override a lagging answer. Explicit reloads start with a clean slate.
// A slower read model can still answer stale, and an omitted new row waits for another change
// or reload. One query runs at a time, with one waiting request that can preempt retry backoff
// after its debounce. Rule-based subsets keep cursor-based settlement and only re-ask on
// explicit reload. Subsets with live disabled never request a reload on their own.

type Params = Parameters<SyncConfig<Row, string>["sync"]>[0];

/** Which rows a subset holds: one Domain query's answer for one input, and its membership rule. */
export type Spec = {
  readonly entity: Rows.Any;
  readonly query: Domain.Query.Any;
  readonly input: Input;
  readonly page: { readonly after?: string; readonly take?: number };
  /** Whether a row belongs to this subset. Without a rule, the query decides. */
  readonly rule: Option.Option<(row: Row, input: Input) => boolean>;
  /** Reads the rows of one answer, when the declaration selects them with `.rows()`. */
  readonly select: Option.Option<(answer: Answer) => ReadonlyArray<Row>>;
  /** Served views or streams whose changes re-ask the query, each at its key (`.follows()`). */
  readonly follows: ReadonlyArray<{ readonly name: string; readonly key: string }>;
};

type Reason = "feed" | "reload" | "correction";

type Request = {
  reason: Reason;
  readonly elapsed: Deferred.Deferred<void>;
  timer?: Fiber.Fiber<void>;
};

/**
 * A query's answer as rows: what `select` reads, a page's entries, an array, or one row (none for
 * `null`).
 */
export const rowsOf = (
  query: Domain.Query.Any,
  result: Answer | null,
  select: Option.Option<(answer: Answer) => ReadonlyArray<Row>> = Option.none(),
): ReadonlyArray<Row> => {
  if (result === null) return [];

  if (Option.isSome(select)) return select.value(result);

  if (query.definition.paged && Predicate.hasProperty(result, "entries"))
    // SAFETY: a paged query answers `{ entries, cursor }` with one row per entry.
    return result.entries as ReadonlyArray<Row>;

  if (Array.isArray(result)) return result;

  return [result];
};

/** One collection's sync run, with one query worker for its entire lifetime. */
export class Subset {
  ready = false;
  private readonly scope: Scope.Closeable;
  private readonly reported: Array<TaggedFailure | Defect> = [];
  private synced = new Map<string, Row>();
  private triggers: Array<Delivered> = [];
  private deliveries = 0;
  private buffer: Array<Delivered> | undefined;
  private discarded = 0;
  private corrections = 0;
  private pending: Request | undefined;
  private queued = Deferred.makeUnsafe<Request>();
  private feed: Subscription | undefined;
  private readonly release: () => void;
  private stopping: Promise<void> | undefined;
  /** One per followed read: done once it showed its value, or failed, so the first ask is not older. */
  private readonly based: Array<Deferred.Deferred<void>> = [];

  constructor(
    private readonly connection: Connection,
    private readonly spec: Spec,
    private readonly params: Params,
  ) {
    this.scope = connection.openScope();
    this.release = connection.register(spec.entity.entityName, this);
  }

  get entity(): Rows.Any {
    return this.spec.entity;
  }

  get collection(): Collection<Row, string> {
    return this.params.collection;
  }

  keyOf = (row: Row): string => keyOf(this.spec.entity.rows.key, row);

  accepts = (row: Row) => Option.getOrElse(this.member(row), () => true);

  member = (row: Row) => Option.map(this.spec.rule, (rule) => rule(row, this.spec.input));

  private get byQuery() {
    return Option.isNone(this.spec.rule);
  }

  start = () => {
    if (this.connection.live) {
      this.feed = subscriptionOf(this.connection, this.spec.entity.feed);
      this.feed.acquire(this);
    }

    if (this.connection.live)
      for (const followed of this.spec.follows) {
        const based = Deferred.makeUnsafe<void>();

        this.based.push(based);
        this.connection.fork(this.follow(followed, based), this.scope);
      }

    this.connection.fork(this.work(), this.scope);

    return this.stop;
  };

  /**
   * Follows one served view or stream: its first value is the baseline, and every different value
   * after it (also the first one after a reconnect) asks the query again. A transport failure is
   * retried on the client's schedule; a failure for good is reported, and the rows stay.
   */
  private follow(
    followed: { readonly name: string; readonly key: string },
    based: Deferred.Deferred<void>,
  ) {
    const name = `${this.name} follows ${followed.name}`;
    const state = { ...followed, shown: Option.none<string>() };

    this.connection.followed.set(based, state);

    const seen = (value: unknown) =>
      Effect.sync(() => {
        const next = JSON.stringify(value) ?? "";

        if (Option.isSome(state.shown) && state.shown.value !== next) this.schedule();

        state.shown = Option.some(next);
        Deferred.doneUnsafe(based, Effect.void);
        this.healthy();
      });

    return Effect.gen({ self: this }, function* () {
      let step = yield* Schedule.toStep(this.connection.retry);

      while (true) {
        const result = yield* Effect.result(
          read(name, Stream.runForEach(this.connection.watch(followed.name, followed.key), seen)),
        );

        // The first ask must not wait on a read that cannot connect.
        Deferred.doneUnsafe(based, Effect.void);

        const now = yield* Clock.currentTimeMillis;

        if (result._tag === "Success") {
          step = yield* Schedule.toStep(this.connection.retry);
          yield* Effect.sleep(this.connection.reloadDelay).pipe(
            Effect.provideService(waitKind, "retry"),
          );

          continue;
        }

        const error = result.failure;

        this.interrupted(error);

        const waited = yield* Effect.exit(
          Pull.catchDone(step(now, error), () => Effect.fail(error)),
        );

        if (Exit.isFailure(waited)) return;

        yield* Effect.sleep(waited.value[1]).pipe(Effect.provideService(waitKind, "retry"));
      }
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;

        return Effect.sync(() => this.interrupted(failureOf(name, cause)));
      }),
      Effect.ensuring(Effect.sync(() => this.connection.followed.delete(based))),
    );
  }

  private stop = () => {
    if (this.stopping) return this.stopping;

    this.stopping = Promise.resolve()
      .then(() => Effect.runPromise(Scope.close(this.scope, Exit.void)))
      .finally(() => feedClosed);
    this.release();
    const feedClosed = this.feed?.release(this);

    return this.stopping;
  };

  /** Patch ready rows immediately and record the entries for the next answer. */
  receive = (delivered: ReadonlyArray<Delivered>) => {
    if (this.stopping || delivered.length === 0) return;

    if (this.byQuery) {
      this.triggers.push(...delivered);
      this.deliveries += delivered.length;
      this.corrections = 0;
      this.request("feed");
    } else this.buffer?.push(...delivered);

    if (!this.ready) return;

    const writes = apply(this.synced, delivered, this, (key) => this.collection.has(key));

    if (writes.length === 0) return;

    this.params.begin();
    for (const write of writes) this.params.write(write);
    void this.params.commit();
  };

  interrupted = (error: TaggedFailure | Defect) => {
    if (this.ready) this.params.reportError(error);
  };

  healthy = () => {
    if (this.ready) this.params.reportHealthy();
  };

  stopped = (error: TaggedFailure | Defect) => {
    if (this.stopping) return;

    void this.stop();
    this.params.fail(error);
  };

  schedule = () => {
    if (this.stopping) return;

    this.triggers = [];
    this.corrections = 0;
    this.request("reload");
  };

  private request(reason: Reason, delay = this.connection.reloadDelay) {
    if (this.pending) {
      if (this.pending.reason === "correction" && reason !== "correction") {
        const request = this.pending;

        request.reason = reason;
        request.timer?.interruptUnsafe();
        this.arm(request, delay);
      } else if (reason === "reload") this.pending.reason = reason;

      return;
    }

    const request: Request = { reason, elapsed: Deferred.makeUnsafe() };

    this.pending = request;
    this.arm(request, delay);
    Deferred.doneUnsafe(this.queued, Effect.succeed(request));
  }

  private arm(request: Request, delay: number) {
    request.timer = this.connection.fork(
      Effect.sleep(delay).pipe(
        Effect.andThen(Deferred.succeed(request.elapsed, undefined)),
        Effect.asVoid,
        Effect.provideService(waitKind, "reload"),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void;

          return Effect.sync(() => this.stopped(failureOf(this.name, cause)));
        }),
      ),
      this.scope,
    );
  }

  private clearRequest() {
    const request = this.pending;

    this.pending = undefined;
    this.queued = Deferred.makeUnsafe();

    request?.timer?.interruptUnsafe();

    return request?.reason;
  }

  private next = Effect.suspend(() =>
    Deferred.await(this.queued).pipe(Effect.flatMap(({ elapsed }) => Deferred.await(elapsed))),
  );

  private get name() {
    return `${this.entity.entityName}/${this.spec.query.queryName}`;
  }

  private work() {
    const name = this.name;

    return Effect.gen({ self: this }, function* () {
      yield* Effect.yieldNow;
      // Followed reads show their value first: an answer is then never older than its baseline.
      yield* Effect.forEach(this.based, (based) => Deferred.await(based), { discard: true });

      let reason: Reason | undefined;
      while (true) {
        yield* this.load(name, reason);
        yield* this.next;
        reason = this.clearRequest();
        yield* Effect.yieldNow;
      }
    }).pipe(
      Effect.catchCause((cause) => {
        if (this.stopping && Cause.hasInterruptsOnly(cause)) return Effect.void;

        return Effect.sync(() => this.stopped(failureOf(name, cause)));
      }),
    );
  }

  private load(name: string, reason: Reason | undefined) {
    return Effect.gen({ self: this }, function* () {
      let step = yield* Schedule.toStep(this.connection.retry);

      while (true) {
        const changes: Array<Delivered> = [];

        if (!this.byQuery) this.buffer = changes;

        const result = yield* Effect.result(
          read(name, this.fetch(reason)).pipe(
            Effect.tap((answer) => Effect.sync(() => this.accept(answer, changes))),
            Effect.ensuring(
              Effect.sync(() => {
                this.buffer = undefined;
              }),
            ),
          ),
        );

        if (result._tag === "Success") return;

        reason = undefined;
        const error = result.failure;
        const now = yield* Clock.currentTimeMillis;
        const [, duration] = yield* Pull.catchDone(step(now, error), () => Effect.fail(error));

        if (this.ready) {
          this.reported.push(error);
          this.params.reportError(error);
        }

        const requested = yield* Effect.raceFirst(
          Effect.as(this.next, true),
          Effect.as(Effect.sleep(duration), false),
        );

        if (requested) {
          reason = this.clearRequest();
          step = yield* Schedule.toStep(this.connection.retry);
        }
      }
    });
  }

  private fetch(reason: Reason | undefined) {
    return Effect.gen({ self: this }, function* () {
      const { entity, query, input, page } = this.spec;
      let cursor = 0;

      if (this.feed) cursor = cursorOf(yield* this.connection.peek(entity.feed.streamName));

      // A request whose debounce expired during the cursor read can use this query.
      if (this.byQuery) {
        if (this.pending && Deferred.isDoneUnsafe(this.pending.elapsed)) {
          const queued = this.clearRequest();

          if (queued === "reload" || reason !== "reload") reason = queued;
        }

        if (reason === "reload") this.triggers = [];
      }

      const deliveries = this.deliveries;
      const result = yield* this.connection.query(query.queryName, input, page);

      if (this.feed) yield* this.feed.ready;

      return { cursor, result, deliveries };
    });
  }

  private accept(
    {
      cursor,
      result,
      deliveries,
    }: {
      readonly cursor: number;
      readonly result: Answer | null;
      readonly deliveries: number;
    },
    changes: ReadonlyArray<Delivered>,
  ) {
    if (this.stopping) return;

    const overtaken = deliveries !== this.deliveries;

    if (this.byQuery && this.ready && overtaken && this.discarded < 2) {
      this.discarded += 1;

      return;
    }

    this.discarded = 0;
    const rows = new Map(
      rowsOf(this.spec.query, result, this.spec.select).map((row) => [this.keyOf(row), row]),
    );

    if (!this.byQuery) {
      settle(
        rows,
        changes.filter(({ seq }) => seq > cursor),
        this,
      );
      this.write(rows);
      return;
    }

    const patched = rebase(rows, this.triggers, this, (key) => this.collection.has(key));
    if (patched && this.corrections < 3 && !this.pending) {
      this.corrections += 1;
      this.request("correction", Math.max(1, this.connection.reloadDelay) * 2 ** this.corrections);
    } else if (this.corrections === 3 || (!patched && !overtaken)) {
      this.triggers = [];
      this.corrections = 0;
      this.write(rows);
      return;
    }

    this.write(patched ?? rows);
  }

  /** Replaces the synced rows with a fresh answer in one sync transaction. */
  private write(rows: Map<string, Row>) {
    const { begin, write, commit, markReady, reportHealthy } = this.params;

    begin({ snapshot: true });

    for (const value of rows.values()) write({ type: "insert", value });

    void commit();
    this.synced = rows;

    if (!this.ready) {
      this.ready = true;
      markReady();

      // Calls restored from a durable queue show on the rows that just loaded.
      Option.map(this.connection.queue, (queue) => queue.arrived(this));

      return;
    }

    for (const error of this.reported.splice(0)) reportHealthy(error);
  }
}
