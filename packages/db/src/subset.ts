import type * as Domain from "@alchemy.run/domain";
import type { Collection, SyncConfig } from "@tanstack/db";
import { Exit, Option, Predicate } from "effect";
import type { Defect, TaggedFailure } from "./state";
import { cursorOf, failureOf, type Connection } from "./client";
import { subscriptionOf, type Delivered, type Subscription } from "./feed";
import * as Rows from "./rows";
import { keyOf, type Answer, type Input, type Row } from "./values";

type Params = Parameters<SyncConfig<Row, string>["sync"]>[0];

/** Which rows a subset holds: one Domain query's answer for one input, and its membership rule. */
export type Spec = {
  readonly entity: Rows.Any;
  readonly query: Domain.Query.Any;
  readonly input: Input;
  readonly page: { readonly after?: string; readonly take?: number };
  /** Whether a row belongs to this subset; without one, a row it cannot place reloads it. */
  readonly rule: Option.Option<(row: Row, input: Input) => boolean>;
  /** Reads the rows of one answer, when the declaration says where they are (`entries`). */
  readonly select: Option.Option<(answer: Answer) => ReadonlyArray<Row>>;
  /** Whether the query alone decides which rows are in the window. */
  readonly windowed: boolean;
};

type Buffered = {
  readonly entries: Array<Delivered>;
  /** Optimistic inserts confirmed while this query was in flight. */
  readonly inserted: Set<number>;
  /** The reload's debounce elapsed while the query was still in flight. */
  reload: boolean;
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

/** A failure's retry delay, if the connection's policy retries it. */
const delayOf = (connection: Connection, error: TaggedFailure | Defect, attempt: number) =>
  connection.retry(error, attempt);

/**
 * The sync run of one subset collection. It loads with the cursor-then-events protocol, keeps
 * its rows in step with its entity's entries on the shared feed, and holds the rows it synced so a
 * change it cannot place reloads it instead of guessing.
 */
export class Subset {
  ready = false;
  /** The run ended: cleaned up, or failed for good (a reload starts a new run). */
  private closed = false;
  /** Errors this run's own reloads reported; a successful reload clears exactly these. */
  private reported: Array<TaggedFailure | Defect> = [];
  /** The rows this subset synced, by key. */
  private synced = new Map<string, Row>();
  /** Changes the feed delivered while a load or reload runs; applied on top of its answer. */
  private buffer: Buffered | undefined;
  /** The cancel of a scheduled reload, while one is scheduled. */
  private reloading: (() => void) | undefined;
  private feed: Subscription | undefined;
  private readonly release: () => void;

  constructor(
    private readonly connection: Connection,
    private readonly spec: Spec,
    private readonly params: Params,
  ) {
    this.release = connection.register(spec.entity.entityName, this);
  }

  /** The entity whose rows this subset holds. */
  get entity(): Rows.Any {
    return this.spec.entity;
  }

  /** The collection this run syncs; commands edit it optimistically. */
  get collection(): Collection<Row, string> {
    return this.params.collection;
  }

  /** The key of a row. */
  keyOf = (row: Row): string => keyOf(this.spec.entity.rows.key, row);

  /** Whether an optimistic insert shows here: its rule holds, or there is no rule. */
  accepts = (row: Row) => Option.getOrElse(this.member(row), () => true);

  /** Whether a row belongs here by the membership rule; `None` without a rule. */
  private member = (row: Row) => Option.map(this.spec.rule, (rule) => rule(row, this.spec.input));

  start = () => {
    if (this.connection.live) {
      this.feed = subscriptionOf(this.connection, this.spec.entity.feed);
      this.feed.acquire(this);
    }

    void this.load(1);

    return () => this.stop();
  };

  private stop() {
    this.closed = true;
    this.reloading?.();
    this.feed?.release(this);
    this.release();
  }

  /** Changes from the feed: applied now when ready, buffered while a load or reload runs. */
  receive = (delivered: ReadonlyArray<Delivered>) => {
    if (this.closed) return;

    this.buffer?.entries.push(...delivered);

    if (!this.ready) return;

    const reload = this.apply(delivered);

    if (reload) this.schedule();
  };

  /** The feed failed and is trying again. */
  interrupted = (error: TaggedFailure | Defect) => {
    if (this.ready && !this.closed) this.params.reportError(error);
  };

  /** The feed caught up again. */
  healthy = () => {
    if (this.ready && !this.closed) this.params.reportHealthy();
  };

  /** The feed gave up: a ready subset keeps its rows and shows the error; a loading one fails. */
  stopped = (error: TaggedFailure | Defect) => this.fail(error);

  private fail(error: TaggedFailure | Defect) {
    if (this.closed) return;

    this.closed = true;
    this.buffer = undefined;
    this.reloading?.();
    this.params.fail(error);
  }

  /** Reloads soon; several reasons within the delay reload once. */
  schedule = () => {
    if (this.closed || this.reloading !== undefined) return;

    this.reloading = this.connection.after(this.connection.reloadDelay, "reload", () => {
      this.reloading = undefined;

      if (this.spec.windowed && this.buffer) {
        this.buffer.reload = true;

        return;
      }

      void this.load(1);
    });
  };

  /**
   * Applies feed changes to the synced rows in one sync transaction. Returns whether the query
   * needs to confirm membership.
   */
  private apply(delivered: ReadonlyArray<Delivered>) {
    const { begin, write, commit } = this.params;
    let open = false;
    let reload = false;

    const start = () => {
      if (!open) begin();

      open = true;
    };

    for (const { seq, change } of delivered)
      if (Rows.isRemoved(change)) {
        if (this.synced.delete(change.key)) {
          start();
          write({ type: "delete", key: change.key });
          reload ||= this.spec.windowed;
        }
      } else {
        const key = this.keyOf(change.row);
        const belongs = this.member(change.row);

        if (this.synced.has(key)) {
          start();

          if (Option.getOrElse(belongs, () => true)) {
            this.synced.set(key, change.row);
            write({ type: "update", value: change.row });
            reload ||= this.spec.windowed;
          } else {
            this.synced.delete(key);
            write({ type: "delete", key });
          }
        } else if (Option.getOrElse(belongs, () => this.collection.has(key))) {
          // A rule placed it, or this client shows it already (its own optimistic insert).
          start();
          this.synced.set(key, change.row);
          write({ type: "insert", value: change.row });
          reload ||= Option.isNone(belongs);

          if (this.spec.windowed) this.buffer?.inserted.add(seq);
        } else reload ||= Option.isNone(belongs);
      }

    if (open) void commit();

    return reload;
  }

  /** Applies buffered changes after `cursor` to a fresh answer, without writing. */
  private settle(rows: Map<string, Row>, buffered: Buffered, cursor: number) {
    let reload = false;

    for (const { seq, change } of buffered.entries) {
      if (seq <= cursor) continue;

      if (Rows.isRemoved(change)) {
        const removed = rows.delete(change.key);
        reload ||= this.spec.windowed && removed;
        continue;
      }

      const key = this.keyOf(change.row);
      const belongs = this.member(change.row);

      reload ||= this.spec.windowed;

      if (rows.has(key) && !Option.getOrElse(belongs, () => true)) rows.delete(key);
      else if (rows.has(key) || Option.getOrElse(belongs, () => false)) rows.set(key, change.row);
      // The in-flight answer can predate the change. Keep a row this window shows (a confirmed
      // insert, or a held row the older answer no longer places) until the next answer.
      else if (buffered.inserted.has(seq) || (this.spec.windowed && this.synced.has(key)))
        rows.set(key, change.row);
      else reload ||= Option.isNone(belongs);
    }

    return reload;
  }

  /**
   * Loads (or reloads) the subset: the feed's cursor (its latest entry's `seq`), the query, the
   * changes after the cursor,
   * one snapshot sync transaction, then ready. A failure retries per the connection's policy;
   * before the first readiness it then fails the collection, after it reports the error.
   */
  private load = async (attempt: number): Promise<void> => {
    if (this.closed) return;

    const buffered: Buffered = { entries: [], inserted: new Set(), reload: false };
    const { entity, query } = this.spec;
    const name = `${entity.entityName}/${query.queryName}`;

    this.buffer = buffered;

    const failure = await this.fetch(name).then(
      ({ cursor, result }) => {
        if (this.closed) return Option.none();

        const rows = new Map(
          rowsOf(query, result, this.spec.select).map((row) => [this.keyOf(row), row]),
        );

        const reload = this.settle(rows, buffered, cursor);

        this.buffer = undefined;
        this.write(rows);

        if (buffered.reload) {
          // This query answers every change so far, so a reload still scheduled is not needed.
          this.reloading?.();
          this.reloading = undefined;
          void this.load(1);
        } else if (reload) this.schedule();

        return Option.none();
      },
      (error: TaggedFailure | Defect) => Option.some(error),
    );

    if (Option.isNone(failure) || this.closed) return;

    // For a window, a retry also covers any reloads requested while this attempt was in flight.
    if (!this.spec.windowed) this.buffer = undefined;

    const error = failure.value;
    const delay = delayOf(this.connection, error, attempt);

    if (Option.isNone(delay)) return this.fail(error);

    if (this.ready) {
      this.reported.push(error);
      this.params.reportError(error);
    }

    await this.connection.sleep(delay.value, "retry");

    return this.load(attempt + 1);
  };

  /** The cursor, the query's answer, and the feed caught up; rejects with a typed failure. */
  private async fetch(name: string) {
    const { entity, query, input, page } = this.spec;
    const scope = this.connection.scope;
    let cursor = 0;

    if (this.connection.live) {
      const stream = await this.connection.stream(entity.feed.streamName);
      const latest = await this.connection.run(stream.peek(scope));

      if (Exit.isFailure(latest)) throw failureOf(name, latest.cause);

      cursor = cursorOf(latest.value);
    }

    const ask = await this.connection.query(query.queryName);
    const answer = await this.connection.run(ask(input, page));

    if (Exit.isFailure(answer)) throw failureOf(name, answer.cause);

    if (this.feed) await this.feed.ready();

    return { cursor, result: answer.value };
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
