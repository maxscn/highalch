import * as Domain from "@alchemy.run/domain";
import type * as Model from "@alchemy.run/domain/Model";
import * as LowAlch from "@lowalch/tanstack-db";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";

export class Session extends Context.Service<Session, string>()("Prediction/Session") {}

class Authorize extends RpcMiddleware.Service<Authorize, { provides: Session }>()(
  "Prediction/Authorize",
  {},
) {}

const Row = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  title: Schema.String,
});
export type Row = typeof Row.Type;

export const original = { id: "note", owner: "owner", title: "Original" };
export const scope = "notes";

class Saved extends Domain.Event("PredictionSaved", { row: Row }) {}
export class Forbidden extends Domain.Rejection("PredictionForbidden") {}
const forbidden = new Forbidden();

class Create extends Domain.Command("PredictionCreate", {
  target: Schema.String,
  input: { title: Schema.String },
  events: [Saved],
}) {}

class Rename extends Domain.Command("PredictionRename", {
  target: Schema.String,
  input: { id: Schema.String, title: Schema.String },
  events: [Saved],
  rejects: [Forbidden],
  middleware: [Authorize],
}) {}

const State = Schema.Struct({ owner: Schema.String });

class Note extends Domain.Aggregate("PredictionNote", {
  id: Schema.String,
  state: State,
  initial: { owner: "owner" },
  commands: [Create, Rename],
  decide: {
    PredictionCreate: (state, command, { id }) => [
      new Saved({ row: { id, owner: state.owner, title: command.title.toUpperCase() } }),
    ],
    PredictionRename: (state, command, { id }) =>
      Effect.gen(function* () {
        const session = yield* Session;
        if (session !== state.owner) return yield* Effect.fail(forbidden);

        return [new Saved({ row: { id, owner: state.owner, title: command.title.toUpperCase() } })];
      }),
  },
  evolve: { PredictionSaved: (_state, event) => ({ owner: event.row.owner }) },
}) {}

class Feed extends LowAlch.Feed("PredictionFeed", { scope: Schema.String }) {}

const definition = {
  feed: Feed,
  row: Row,
  key: "id",
  from: [Note],
  scope: () => scope,
  on: { PredictionSaved: (event: Saved) => LowAlch.upserted(event.row) },
} as const;

export class Rows extends LowAlch.Rows("PredictedRows", {
  ...definition,
  state: (row) => ({ owner: row.owner }),
}) {}

class ManualRows extends LowAlch.Rows("ManualRows", definition) {}

class Writer extends LowAlch.Projection("PredictionFeed", {
  feed: Feed,
  entities: [Rows, ManualRows],
}) {}

class List extends Domain.Query("PredictionList", {
  input: {},
  success: Schema.Array(Row),
}) {}

class Notebook extends Domain.Model("PredictionNotebook", {
  aggregates: [Note],
  streams: [Feed],
  projections: [Writer],
  queries: [List],
}) {}

export class Api extends Domain.Api("PredictionApi", { model: Notebook }) {}

const declarations = {
  queries: { list: List },
  commands: {
    create: LowAlch.inserts(Create, { row: (input, id) => ({ ...original, ...input, id }) }),
    rename: LowAlch.updates(Rename),
  },
};

export const predicted = LowAlch.collection(Rows, declarations);
export const manual = LowAlch.collection(ManualRows, declarations);

export const host = async (user: string) => {
  const model = Notebook.layer(
    Layer.merge(Writer.layer, List.toLayer(Effect.succeed(() => Effect.succeed([original])))),
  ).pipe(Layer.provide(Domain.InMemory));
  const runtime = ManagedRuntime.make(model);
  const internals = await runtime.runPromise(Effect.context<Model.Internals>());
  const sent: Array<string> = [];

  const layer = Api.layerClientInProcess.pipe(
    Layer.provide(
      Layer.succeed(Authorize, (effect) =>
        Effect.sync(() => sent.push("rename")).pipe(
          Effect.andThen(Effect.provideService(effect, Session, user)),
        ),
      ),
    ),
    Layer.provide(Layer.succeedContext(internals)),
  );

  return { layer, sent, dispose: () => runtime.dispose() };
};
