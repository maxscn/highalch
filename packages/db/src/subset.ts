import type * as Domain from "@alchemy.run/domain";
import type { Collection, SyncConfig } from "@tanstack/db";
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
  Scope,
} from "effect";
import type { Defect, TaggedFailure } from "./state";
import { cursorOf, failureOf, read, waitKind, type Connection } from "./client";
import { subscriptionOf, type Delivered, type Subscription } from "./feed";
import type * as Rows from "./rows";
import { apply, reconcile, remember, settle } from "./sync-rows";
import { keyOf, type Answer, type Input, type Row } from "./values";

type Params = Parameters<SyncConfig<Row, string>["sync"]>[0];

/** Which rows a subset holds: one Domain query's answer for one input, and its membership rule. */
export type Spec = {
  readonly entity: Rows.Any;
  readonly query: Domain.Query.Any;
  readonly input: Input;
  readonly page: { readonly after?: string; readonly take?: number };
  /** Whether a row belongs to this subset. Without a rule, the query decides. */
  readonly rule: Option.Option<(row: Row, input: Input) => boolean>;
  /** Reads the rows of one answer, when the declaration says where they are (`entries`). */
  readonly select: Option.Option<(answer: Answer) => ReadonlyArray<Row>>;
};

type Request = {
  after: number;
  readonly elapsed: Deferred.Deferred<void>;
  correction: boolean;
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
  private readonly applied = new Map<string, Delivered>();
  private buffer: Array<Delivered> | undefined;
  private cursor = 0;
  private discarded = 0;
  private corrections = 0;
  private pending: Request | undefined;
  private queued = Deferred.makeUnsafe<Request>();
  private feed: Subscription | undefined;
  private readonly release: () => void;

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

    this.connection.fork(this.work(), this.scope);

    return this.stop;
  };

  private stop = () => {
    this.feed?.release(this);
    this.release();

    return Effect.runPromise(Scope.close(this.scope, Exit.void));
  };

  /** Patch ready rows immediately and retain changes received during a query for its answer. */
  receive = (delivered: ReadonlyArray<Delivered>) => {
    let changes = delivered;

    if (this.byQuery) changes = delivered.filter(({ seq }) => seq > this.cursor);

    this.buffer?.push(...changes);

    if (!this.ready || changes.length === 0) return;

    const writes = apply(this.synced, changes, this, (key) => this.collection.has(key));

    if (this.byQuery) remember(changes, this.applied, this.synced, this);

    if (writes.length > 0) {
      this.params.begin();
      for (const write of writes) this.params.write(write);
      void this.params.commit();
    }

    const last = changes.at(-1);

    if (this.byQuery && last) {
      this.corrections = 0;
      this.request(last.seq);
    }
  };

  interrupted = (error: TaggedFailure | Defect) => {
    if (this.ready) this.params.reportError(error);
  };

  healthy = () => {
    if (this.ready) this.params.reportHealthy();
  };

  stopped = (error: TaggedFailure | Defect) => {
    void this.stop();
    this.params.fail(error);
  };

  schedule = () => {
    this.corrections = 0;
    this.request(Infinity);
  };

  private request(after: number, correction = false, delay = this.connection.reloadDelay) {
    if (this.pending) {
      if (this.pending.correction && !correction) {
        const request = this.pending;

        request.correction = false;
        request.after = after;
        if (request.timer) Effect.runFork(Fiber.interrupt(request.timer));
        this.arm(request, delay);
      } else this.pending.after = Math.max(this.pending.after, after);

      return;
    }

    const request: Request = { after, correction, elapsed: Deferred.makeUnsafe() };

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
      ),
      this.scope,
    );
  }

  private clearRequest() {
    const timer = this.pending?.timer;

    this.pending = undefined;
    this.queued = Deferred.makeUnsafe();

    if (timer) Effect.runFork(Fiber.interrupt(timer));
  }

  private next = Effect.suspend(() =>
    Deferred.await(this.queued).pipe(Effect.flatMap(({ elapsed }) => Deferred.await(elapsed))),
  );

  private work() {
    const name = `${this.entity.entityName}/${this.spec.query.queryName}`;

    return Effect.gen({ self: this }, function* () {
      yield* Effect.yieldNow;

      while (true) {
        yield* this.load(name);
        yield* this.next;
        this.clearRequest();
        yield* Effect.yieldNow;
      }
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;

        return Effect.sync(() => this.stopped(failureOf(name, cause)));
      }),
    );
  }

  private load(name: string) {
    return Effect.gen({ self: this }, function* () {
      let step = yield* Schedule.toStep(this.connection.retry);

      while (true) {
        const changes: Array<Delivered> = [];

        this.buffer = changes;
        const result = yield* Effect.result(
          read(name, this.fetch()).pipe(
            Effect.tap((answer) => Effect.sync(() => this.accept(answer, changes))),
            Effect.ensuring(
              Effect.sync(() => {
                this.buffer = undefined;
              }),
            ),
          ),
        );

        if (result._tag === "Success") return;

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
          this.clearRequest();
          step = yield* Schedule.toStep(this.connection.retry);
        }
      }
    });
  }

  private fetch() {
    return Effect.gen({ self: this }, function* () {
      const { entity, query, input, page } = this.spec;
      let cursor = 0;

      if (this.feed) {
        const stream = yield* this.connection.stream(entity.feed.streamName);

        cursor = cursorOf(yield* stream.peek(this.connection.scope));
      }

      const ask = yield* this.connection.query(query.queryName);
      const result = yield* ask(input, page);

      if (this.feed) yield* this.feed.ready;

      return { cursor, result };
    });
  }

  private accept(
    { cursor, result }: { readonly cursor: number; readonly result: Answer | null },
    changes: ReadonlyArray<Delivered>,
  ) {
    const later = changes.filter(({ seq }) => seq > cursor);
    const latest = later.at(-1);

    if (this.byQuery && this.ready && latest && this.discarded < 2) {
      this.discarded += 1;
      this.request(latest.seq);

      return;
    }

    this.discarded = 0;
    const rows = new Map(
      rowsOf(this.spec.query, result, this.spec.select).map((row) => [this.keyOf(row), row]),
    );

    if (this.byQuery && this.pending && this.pending.after <= cursor) this.clearRequest();

    const contradicted = this.byQuery && reconcile(rows, this.applied, cursor);

    settle(rows, later, this);

    if (this.byQuery) {
      this.cursor = cursor;
      remember(later, this.applied, rows, this);
    }

    this.write(rows);

    if (this.byQuery && latest) this.request(latest.seq);

    if (contradicted && this.corrections < 3) {
      this.corrections += 1;
      this.request(
        Infinity,
        true,
        Math.max(1, this.connection.reloadDelay) * 2 ** this.corrections,
      );
    } else if (!contradicted) this.corrections = 0;
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

      return markReady();
    }

    for (const error of this.reported.splice(0)) reportHealthy(error);
  }
}
