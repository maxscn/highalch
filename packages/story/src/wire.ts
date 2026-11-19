import * as Domain from "@alchemy.run/domain";
import { Deferred, Effect, Predicate, Stream } from "effect";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import type { TaggedFailure } from "@highalch/db";
import type { Answer, Input } from "@highalch/db/internal";

/** A fresh transport failure, as the websocket protocol reports giving up. */
export const transport = (message = "socket closed") =>
  new RpcClientError({ reason: new RpcClientDefect({ message, cause: new Error(message) }) });

/** A command one of the story's clients sent: its name, target and input. */
export type Sent = { readonly name: string; readonly target: string; readonly input: Input };

/** A command or query of an Api client. */
type Call = (...args: ReadonlyArray<never>) => Effect.Effect<Answer | null, TaggedFailure>;

/** A stream's latest entry, as `peek` answers it. */
type Latest = { readonly envelope: { readonly seq: number } };

/** A served stream of an Api client: its latest entry, and its entries after a cursor. */
export type Feed = {
  readonly peek: (
    key: string,
    ...rest: ReadonlyArray<never>
  ) => Effect.Effect<Latest | null, TaggedFailure>;
  readonly events: (
    key: string,
    options: { readonly after: number },
  ) => Stream.Stream<Answer, TaggedFailure>;
};

/** An Api client's endpoints by name: methods (commands, queries) and served streams. */
export type Endpoints = Readonly<Record<string, Call | Feed>>;

/** An Api client as its endpoints by name. */
export const endpointsOf = <C>(client: C): Endpoints =>
  // SAFETY: an Api client holds its endpoints by name: methods and served streams.
  client as Endpoints;

export const isFeed = (endpoint: Call | Feed | undefined): endpoint is Feed =>
  Predicate.hasProperty(endpoint, "events") && Predicate.hasProperty(endpoint, "peek");

/**
 * The faults and counts of one client's connection. The story's client of a scope talks to the
 * Domain through it: it counts requests in flight (so the story knows when the network is quiet),
 * records sent commands, and injects the world's events: a dropped feed (`drop`/`resume`), a
 * feed that delivers nothing (`mute`), a failing query or command (`fail`/`recover`) and held
 * answers (`hold`/`release`, a query answers with what it saw when asked, later).
 */
export class Wire {
  /** Requests running and not held. */
  inflight = 0;
  /** Feed connections open now. */
  open = 0;
  /** Feed connections made. */
  connections = 0;
  /** Commands sent, in order. */
  readonly sent: Array<Sent> = [];
  /** Queries asked, by name, in order. */
  readonly asked: Array<string> = [];
  private down: RpcClientError | undefined;
  /** Whether the feed delivers nothing now (`mute`). */
  muted = false;
  /** Whether the feed was ever muted: the entries it dropped are lost to this connection. */
  lossy = false;
  /** Closed while the story is not letting time pass: command replies wait at it. */
  private network: Deferred.Deferred<void> | undefined = Effect.runSync(Deferred.make<void>());
  private readonly cuts = new Set<Deferred.Deferred<never, RpcClientError>>();
  private readonly failing = new Map<string, { error: TaggedFailure; times: number }>();
  private gate: Deferred.Deferred<void> | undefined;

  /** Whether the feed is held down (`drop` without `resume`). */
  get dropped() {
    return this.down !== undefined;
  }

  /** Fails every open feed with `error`; reconnections fail too until `resume`. */
  drop = (error: RpcClientError = transport()) => {
    this.down = error;
    Effect.runSync(Effect.forEach([...this.cuts], (cut) => Deferred.fail(cut, error)));
  };

  /** Lets feeds connect again. */
  resume = () => {
    this.down = undefined;
  };

  /** Drops feed entries (a feed that stays connected and delivers nothing) while on. */
  mute = (on: boolean) => {
    this.muted = on;
    this.lossy ||= on;
  };

  /** The endpoint `name` fails with `error`, `times` times (or until `recover`). */
  fail = (name: string, error: TaggedFailure, times = Number.POSITIVE_INFINITY) => {
    this.failing.set(name, { error, times });
  };

  recover = (name: string) => {
    this.failing.delete(name);
  };

  /**
   * Lets replies through (the story is settling) or holds them again (`flow(false)`): a command's
   * reply reaches the client only while the story lets time pass, so the steps between `when`
   * and the next settling step see the optimistic rows whatever the server already did.
   */
  flow = (on: boolean) => {
    if (!on) {
      this.network ??= Effect.runSync(Deferred.make<void>());

      return;
    }

    const network = this.network;

    this.network = undefined;

    if (network) Effect.runSync(Deferred.succeed(network, undefined));
  };

  /** Holds every query's answer until `release`. */
  hold = () => {
    this.gate ??= Effect.runSync(Deferred.make<void>());
  };

  release = () => {
    const gate = this.gate;

    this.gate = undefined;

    if (gate) Effect.runSync(Deferred.succeed(gate, undefined));
  };

  /** Waits, uncounted, at a gate (if it is closed now). */
  private waitAt = (gate: () => Deferred.Deferred<void> | undefined) =>
    Effect.suspend(() => {
      const closed = gate();

      if (!closed) return Effect.void;

      return Effect.sync(() => (this.inflight -= 1)).pipe(
        Effect.andThen(Deferred.await(closed)),
        Effect.ensuring(Effect.sync(() => (this.inflight += 1))),
      );
    });

  /**
   * Counts a request while it runs; a held query's answer (read when asked) waits for `release`,
   * a command's reply waits until the story lets time pass. Fails it when the story says so.
   */
  private counted = <A>(
    name: string,
    effect: Effect.Effect<A, TaggedFailure>,
    held: boolean,
    reply: boolean,
  ) =>
    Effect.suspend(() => {
      const failing = this.failing.get(name);

      if (failing && failing.times > 0) {
        failing.times -= 1;

        return Effect.fail(failing.error);
      }

      this.inflight += 1;

      return Effect.exit(effect).pipe(
        Effect.tap(() => this.waitAt(() => (held ? this.gate : undefined))),
        Effect.tap(() => this.waitAt(() => (reply ? this.network : undefined))),
        Effect.ensuring(Effect.sync(() => (this.inflight -= 1))),
        Effect.flatMap((exit) => exit),
      );
    });

  private feed = (name: string, endpoint: Feed): Feed => ({
    peek: (...args) => this.counted(`${name}.peek`, endpoint.peek(...args), false, false),
    events: (key, options) =>
      Stream.unwrap(
        Effect.gen({ self: this }, function* () {
          this.connections += 1;

          if (this.down) return Stream.fail(this.down);

          const cut = yield* Deferred.make<never, RpcClientError>();

          this.cuts.add(cut);
          this.open += 1;

          const frames = endpoint
            .events(key, options)
            .pipe(Stream.filter((frame) => !this.muted || Domain.Read.isCaughtUp(frame)));

          return Stream.merge(frames, Stream.fromEffect(Deferred.await(cut)), {
            haltStrategy: "either",
          }).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                this.cuts.delete(cut);
                this.open -= 1;
              }),
            ),
          );
        }),
      ),
  });

  /** Wraps an Api client's endpoints: every endpoint goes through this wire. */
  wrap = (endpoints: Endpoints, queries: ReadonlySet<string>): Endpoints =>
    Object.fromEntries(
      Object.entries(endpoints).map(([name, endpoint]) => {
        if (isFeed(endpoint)) return [name, this.feed(name, endpoint)];

        if (!Predicate.isFunction(endpoint)) return [name, endpoint];

        const call: Call = (...args) => {
          if (queries.has(name)) this.asked.push(name);
          else
            this.sent.push({
              name,
              target: String(args[0]),
              // SAFETY: a command's second argument is its input.
              input: (args[1] ?? {}) as Input,
            });

          return this.counted(name, endpoint(...args), queries.has(name), !queries.has(name));
        };

        return [name, call];
      }),
    );
}
