import type * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import type * as Aggregate from "@alchemy.run/domain/Aggregate";
import * as Model from "@alchemy.run/domain/Model";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Option, Predicate } from "effect";
import type { TaggedFailure } from "@highalch/tanstack-db";

/** The Api client of an Api, as its `Client` service yields it. */
export type ClientOf<A extends Domain.Api.Any> =
  A["Client"] extends Context.Service<infer _Identifier, infer Client> ? Client : never;

/**
 * Where a story's Domain runs. `client(scope)` is the Api client a reader of `scope` uses (the
 * story wraps it for its own clients, and uses it unwrapped as "another client"). The rest is
 * optional: `idle` (the server has nothing queued), `seed` (history for `given`), `send` (a
 * command as another writer, for `remote(ref, command)`: its failure, if any) and `service` (a
 * service of the host, for `check`).
 */
export type Host<A extends Domain.Api.Any> = {
  readonly api: A;
  readonly client: (scope: string) => Promise<ClientOf<A>>;
  readonly idle?: () => Promise<boolean>;
  readonly seed?: (ref: Aggregate.Ref, events: ReadonlyArray<TaggedFailure>) => Promise<void>;
  readonly send?: (
    ref: Aggregate.Ref,
    command: TaggedFailure,
    commandId: string,
  ) => Promise<Option.Option<string>>;
  readonly service?: <I, S>(key: Context.Key<I, S>) => Promise<S>;
  readonly dispose: () => Promise<void>;
};

/** Builds a fresh host for each story. */
export type Hosting<A extends Domain.Api.Any> = () => Promise<Host<A>>;

/**
 * The services an Api's in-process client needs besides the model: its middleware (a reader's
 * session) and their clients.
 */
export type SessionOf<A extends Domain.Api.Any> = A extends {
  readonly layerClientInProcess: Layer.Layer<infer _Out, infer _E, infer In>;
}
  ? Exclude<In, Model.Internals>
  : never;

/** What the memory host reads of an Api class besides `Domain.Api.Any`: its in-process client. */
type InProcess = {
  readonly layerClientInProcess: Layer.Layer<never, never, Model.Internals>;
};

/** What the memory host reads of a model besides `Model.Any`: its `layer(handlers)`. */
type Hostable = {
  readonly layer: (handlers: never) => Layer.Layer<Model.Internals, never, never>;
};

const isHostable = (model: Model.Any): model is Model.Any & Hostable =>
  Predicate.hasProperty(model, "layer") && Predicate.isFunction(model.layer);

const servesInProcess = <A extends Domain.Api.Any>(api: A): api is A & InProcess =>
  Predicate.hasProperty(api, "layerClientInProcess");

/**
 * How to host an Api's model in memory: its handlers and projections (`layer`, as the model's
 * `layer` takes them), the services they share with the story (`services`: stores a `check` step
 * reads with `world.host.service(Tag)`), and the session a reader of a scope runs with when the
 * Api's reads are guarded. Both are functions: each story builds them afresh.
 */
export type Memory<A extends Domain.Api.Any, Out, E, R, S> = {
  readonly api: A;
  readonly layer: () => Layer.Layer<Out, E, R>;
  readonly services?: () => Layer.Layer<S>;
  readonly session?: (scope: string) => Layer.Layer<SessionOf<A>>;
};

/**
 * Hosts an Api's model on alchemy's in-memory platform, as the story runs it: projections and
 * policies run in the background (not alchemy's manual scheduling, since the client runs
 * concurrently), `given` seeds history through the model's stores exactly as alchemy's own `Story`
 * does, and `idle` is the platform's own quiescence.
 */
export const memory =
  <A extends Domain.Api.Any, Out, E, R, S>(options: Memory<A, Out, E, R, S>): Hosting<A> =>
  async () => {
    const platform = InMemory.make();
    const services = options.services?.() ?? Layer.empty;
    const api = options.api;

    if (!isHostable(api.model) || !servesInProcess(api))
      throw new Error(`${api.apiName} cannot be hosted in memory`);

    // SAFETY: the model takes its handlers' Layer (`Model.Any` erases which ones), and the services
    // are what those handlers need besides the model.
    const handlers = options.layer() as never;
    // SAFETY: as above: the services the handlers need, which the model's Layer type erases.
    const provided = services as Layer.Layer<never>;

    const model = api.model
      .layer(handlers)
      .pipe(Layer.provide(platform.layer), Layer.provideMerge(provided));

    const hosted = ManagedRuntime.make(model);
    const context = await hosted.runPromise(Effect.context<Model.Internals>());
    const internals = Context.get(context, Model.Internals);
    const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

    const shared = new Map<string, Promise<ClientOf<A>>>();

    const client = (scope: string): Promise<ClientOf<A>> => {
      // Without sessions, every scope reads through one client (as one browser connection would).
      const id = options.session ? scope : "";
      const known = shared.get(id);

      if (known) return known;

      const made = connect(scope);

      shared.set(id, made);

      return made;
    };

    const connect = async (scope: string): Promise<ClientOf<A>> => {
      const session = options.session?.(scope) ?? Layer.empty;

      const layer = api.layerClientInProcess.pipe(
        // SAFETY: the session provides what the in-process client needs besides the internals.
        Layer.provide(session as Layer.Layer<never>),
        Layer.provide(Layer.succeedContext(context)),
      );

      const runtime = ManagedRuntime.make(layer);

      runtimes.push(runtime);

      // SAFETY: the Layer builds the Api's `Client`, which yields its client.
      const client = Effect.service(api.Client) as Effect.Effect<ClientOf<A>>;

      return runtime.runPromise(client);
    };

    return {
      api,
      client,
      idle: () => Effect.runPromise(platform.control.idle),
      seed: async (ref, events) => {
        const store = internals.aggregates.get(ref.aggregate);

        if (!store?.seed) throw new Error(`The platform cannot seed ${ref.aggregate}`);

        const seed = store.seed;

        await hosted.runPromise(
          Effect.gen(function* () {
            const encoded = yield* Effect.forEach(events, internals.kernel.encodeEvent);

            yield* seed(String(ref.id), encoded);
          }),
        );
      },
      send: async (ref, command, commandId) => {
        const aggregate = internals.commands.get(command._tag);

        if (!aggregate) throw new Error(`No aggregate handles ${command._tag}`);

        const exit = await hosted.runPromiseExit(aggregate.send(ref, command, { commandId }));

        return Exit.match(exit, {
          onSuccess: () => Option.none(),
          onFailure: (cause) => Option.some(Cause.pretty(cause)),
        });
      },
      // SAFETY: the host's runtime holds the handlers' services; a key it lacks fails at run time.
      service: (key) => hosted.runPromise(Effect.service(key as Context.Key<never, never>)),
      dispose: async () => {
        for (const runtime of runtimes) await runtime.dispose();

        await hosted.dispose();
      },
    };
  };
