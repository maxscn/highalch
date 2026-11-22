import * as Domain from "@alchemy.run/domain";
import type * as Model from "@alchemy.run/domain/Model";
import { Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";
import * as LowAlch from "@lowalch/tanstack-db";

/**
 * Tasks people share: a task has an owner and a visibility (`private`, `everyone`, or `selected`
 * with the addresses it is shared with). Who may read a task is one function, `canRead`, which
 * the query's handler applies; the feed carries each task to its owner only.
 *
 * A reader learns that a task was shared with them, withdrawn or made public through two views
 * that hold ids only (`SharedTasks` by address, `EveryoneTasks`): the declaration of `visible`
 * follows them and asks `VisibleTasks` again, which reads every task from its aggregate and
 * judges it for the caller. So nothing a reader may not see is ever sent to them.
 */
export const Task = Schema.Struct({
  TaskId: Schema.String,
  owner: Schema.String,
  title: Schema.String,
  visibility: Schema.Literals(["private", "everyone", "selected"]),
  sharedWith: Schema.Array(Schema.String),
});

export type Task = typeof Task.Type;

/** Who is asking: a subject and its verified address. */
export type Person = { readonly subject: string; readonly email: string };

/** The person of a subject, as the fixtures name them. */
export const person = (subject: string): Person => ({ subject, email: `${subject}@example.test` });

/** The one read rule: the owner, anyone for an `everyone` task, the addresses of a `selected` one. */
export const canRead = (task: Task, who: Person) =>
  task.owner === who.subject ||
  task.visibility === "everyone" ||
  (task.visibility === "selected" && task.sharedWith.includes(who.email));

export class Who extends Context.Service<Who, Person>()("Test/Tasks/Who") {}

export class Session extends RpcMiddleware.Service<Session, { provides: Who }>()(
  "Test/Tasks/Session",
  {},
) {}

/** The session of a person, as an in-process client's server side runs it. */
export const session = (subject: string) =>
  Layer.succeed(Session, (effect) => Effect.provideService(effect, Who, person(subject)));

export class NotOwner extends Domain.Rejection("NotOwner") {}

export class NotYours extends Domain.Rejection("NotYours") {}

export class TaskMissing extends Domain.Rejection("TaskMissing") {}

/** What a change did to who the task is shared with: the addresses before it. */
const Before = { previous: Schema.Array(Schema.String) };

export class TaskCreated extends Domain.Event("TaskCreated", { task: Task }) {}

export class TaskChanged extends Domain.Event("TaskChanged", { task: Task, ...Before }) {}

export class TaskDeleted extends Domain.Event("TaskDeleted", {
  TaskId: Schema.String,
  owner: Schema.String,
  ...Before,
}) {}

export class CreateTask extends Domain.Command("CreateTask", {
  target: Schema.String,
  input: { owner: Schema.String, title: Schema.String },
  middleware: [Session],
  events: [TaskCreated],
  rejects: [NotOwner],
}) {}

export class RenameTask extends Domain.Command("RenameTask", {
  target: Schema.String,
  input: { TaskId: Schema.String, title: Schema.String },
  middleware: [Session],
  events: [TaskChanged],
  rejects: [NotOwner, TaskMissing],
}) {}

export class ShareTask extends Domain.Command("ShareTask", {
  target: Schema.String,
  input: {
    TaskId: Schema.String,
    visibility: Schema.Literals(["private", "everyone", "selected"]),
    sharedWith: Schema.Array(Schema.String),
  },
  middleware: [Session],
  events: [TaskChanged],
  rejects: [NotOwner, TaskMissing],
}) {}

export class DeleteTask extends Domain.Command("DeleteTask", {
  target: Schema.String,
  input: { TaskId: Schema.String },
  middleware: [Session],
  events: [TaskDeleted],
  rejects: [NotOwner, TaskMissing],
}) {}

const State = Schema.Struct({ task: Schema.NullOr(Task) });

const shared = (task: Task) => {
  if (task.visibility === "selected") return task.sharedWith;

  return [];
};

/** The owner's own task, or the rejection a command on it fails with. */
const owned = (state: typeof State.Type) =>
  Effect.gen(function* () {
    const who = yield* Who;

    if (state.task === null) return yield* new TaskMissing();

    // Only the owner writes: a reader the task is shared with reads it.
    if (state.task.owner !== who.subject) return yield* new NotOwner();

    return state.task;
  });

export class TaskAggregate extends Domain.Aggregate("Task", {
  id: Schema.String,
  state: State,
  initial: { task: null },
  commands: [CreateTask, RenameTask, ShareTask, DeleteTask],
  decide: {
    CreateTask: Effect.fn(function* (_state, command, context) {
      const who = yield* Who;

      if (command.owner !== who.subject) return yield* new NotOwner();

      return [
        new TaskCreated({
          task: {
            TaskId: context.id,
            owner: command.owner,
            title: command.title,
            visibility: "private",
            sharedWith: [],
          },
        }),
      ];
    }),
    RenameTask: Effect.fn(function* (state, command) {
      const task = yield* owned(state);

      return [new TaskChanged({ task: { ...task, title: command.title }, previous: shared(task) })];
    }),
    ShareTask: Effect.fn(function* (state, command) {
      const task = yield* owned(state);

      return [
        new TaskChanged({
          task: { ...task, visibility: command.visibility, sharedWith: command.sharedWith },
          previous: shared(task),
        }),
      ];
    }),
    DeleteTask: Effect.fn(function* (state) {
      const task = yield* owned(state);

      return [new TaskDeleted({ TaskId: task.TaskId, owner: task.owner, previous: shared(task) })];
    }),
  },
  evolve: {
    TaskCreated: (_state, event) => ({ task: event.task }),
    TaskChanged: (_state, event) => ({ task: event.task }),
    TaskDeleted: () => ({ task: null }),
  },
}) {}

// ---------------------------------------------------------------- the owner's feed

/** One feed per owner, readable by that owner only: it carries the owner's own tasks whole. */
export class OwnerTaskChanges extends LowAlch.Feed("OwnerTaskChanges", {
  scope: Schema.String,
  middleware: [Session],
  rejects: [NotYours],
}) {}

export const OwnerTaskChangesLive = OwnerTaskChanges.readers({
  scope: Effect.gen(function* () {
    const who = yield* Who;

    return who.subject;
  }),
  reject: () => new NotYours(),
});

export class TaskRows extends LowAlch.Rows("TaskRows", {
  feed: OwnerTaskChanges,
  row: Task,
  key: "TaskId",
  from: [TaskAggregate],
  scope: ({ event }) => {
    if (event._tag === "TaskDeleted") return event.owner;

    return event.task.owner;
  },
  on: {
    TaskCreated: (event) => LowAlch.upserted(event.task),
    TaskChanged: (event) => LowAlch.upserted(event.task),
    TaskDeleted: (event) => LowAlch.removed(event.TaskId),
  },
  // A client that knows who it is (`make({ context })`) decides its commands with `decide` first.
  state: (task) => ({ task }),
}) {}

export class OwnerTaskWriter extends LowAlch.Projection("OwnerTaskChanges", {
  feed: OwnerTaskChanges,
  entities: [TaskRows],
}) {}

// ---------------------------------------------------------------- who else may see a task

type Changed = { readonly event: TaskCreated | TaskChanged | TaskDeleted };

const Index = Schema.Struct({ ids: Schema.Record(Schema.String, Schema.Boolean) });

export class TaskIndexed extends Domain.Event("TaskIndexed", {
  TaskId: Schema.String,
  visible: Schema.Boolean,
}) {}

const idOf = (event: Changed["event"]) => {
  if (event._tag === "TaskDeleted") return event.TaskId;

  return event.task.TaskId;
};

/** Every address a change concerns: who the task is shared with now, and who it was before. */
const addresses = ({ event }: Changed) => {
  const now = Option.match(
    Option.liftPredicate(event, (each) => each._tag !== "TaskDeleted"),
    { onNone: () => [], onSome: (each) => shared(each.task) },
  );

  const before = Option.match(
    Option.liftPredicate(event, (each) => each._tag !== "TaskCreated"),
    { onNone: () => [], onSome: (each) => each.previous },
  );

  return [...new Set([...now, ...before])];
};

/** How many addresses one change may concern: a view's routes are fixed when it is declared. */
export const maxShared = 4;

// One named route per address a change can concern, so a withdrawn address is told too.
const routes = Object.fromEntries(
  Array.from({ length: maxShared * 2 }, (_, index) => [
    `address${index}`,
    (input: Changed) => addresses(input)[index],
  ]),
);

const update = (state: typeof Index.Type, id: string, include: boolean) => {
  const others = Object.entries(state.ids).filter(([key]) => key !== id);

  if (include) return { ids: Object.fromEntries([...others, [id, true]]) };

  return { ids: Object.fromEntries(others) };
};

const sharedWith = (event: Changed["event"], address: string) =>
  event._tag !== "TaskDeleted" && shared(event.task).includes(address);

/** The ids of the tasks shared with an address. Ids only: contents are read through the query. */
export class SharedTasks extends Domain.View("SharedTasks", {
  from: [TaskAggregate],
  key: Schema.String,
  state: Index,
  initial: { ids: {} },
  keyOf: { Task: routes },
  events: [TaskIndexed],
  evolve: {
    Task: (state, event, context) => update(state, idOf(event), sharedWith(event, context.key)),
  },
  emit: {
    Task: (event, context) =>
      new TaskIndexed({ TaskId: idOf(event), visible: sharedWith(event, context.key) }),
  },
  middleware: [Session],
  rejects: [NotYours],
}) {}

/** A person reads only their own address's index. */
export const SharedTasksLive = SharedTasks.toLayer(
  Effect.succeed(
    Effect.fn(function* (request) {
      const who = yield* Who;

      if (request.key !== who.email) return yield* new NotYours();
    }),
  ),
);

const open = (event: Changed["event"]) =>
  event._tag !== "TaskDeleted" && event.task.visibility === "everyone";

/** The ids of the tasks everyone may see, under the one key `everyone`. */
export class EveryoneTasks extends Domain.View("EveryoneTasks", {
  from: [TaskAggregate],
  key: Schema.String,
  state: Index,
  initial: { ids: {} },
  keyOf: { Task: () => "everyone" },
  events: [TaskIndexed],
  evolve: { Task: (state, event) => update(state, idOf(event), open(event)) },
  // A private task's id never enters the public log.
  emit: {
    Task: (event, context) => {
      const TaskId = idOf(event);

      if (open(event)) return new TaskIndexed({ TaskId, visible: true });

      if (context.before.ids[TaskId]) return new TaskIndexed({ TaskId, visible: false });

      return undefined;
    },
  },
  middleware: [Session],
  rejects: [NotYours],
}) {}

export const EveryoneTasksLive = EveryoneTasks.toLayer(
  Effect.succeed(
    Effect.fn(function* (request) {
      if (request.key !== "everyone") return yield* new NotYours();
    }),
  ),
);

/** The owner's own task ids, so the query finds them without a store of its own. */
export class OwnTasks extends Domain.View("OwnTasks", {
  from: [TaskAggregate],
  key: Schema.String,
  state: Index,
  initial: { ids: {} },
  keyOf: {
    Task: ({ event }: Changed) => {
      if (event._tag === "TaskDeleted") return event.owner;

      return event.task.owner;
    },
  },
  evolve: {
    Task: (state, event) => update(state, idOf(event), event._tag !== "TaskDeleted"),
  },
}) {}

const idsOf = (index: Option.Option<typeof Index.Type>) =>
  Object.keys(Option.match(index, { onNone: () => ({}), onSome: (found) => found.ids }));

/**
 * Every task the caller may read now: found through the three indexes, then read from its
 * aggregate and judged by `canRead`, so a stale index entry never shows a task.
 */
export class VisibleTasks extends Domain.Query("VisibleTasks", {
  input: { email: Schema.String },
  success: Schema.Array(Task),
  middleware: [Session],
  rejects: [NotYours],
}) {}

const VisibleTasksLive = VisibleTasks.toLayer(
  Effect.gen(function* () {
    const tasks = yield* TaskAggregate;
    const own = yield* OwnTasks;
    const mine = yield* SharedTasks;
    const everyone = yield* EveryoneTasks;

    return Effect.fn(function* (input) {
      const who = yield* Who;

      if (input.email !== who.email) return yield* new NotYours();

      const [owned, given, open] = yield* Effect.all(
        [own.get(who.subject), mine.get(who.email), everyone.get("everyone")],
        { concurrency: 3 },
      ).pipe(Effect.orDie);

      const ids = new Set([...idsOf(owned), ...idsOf(given), ...idsOf(open)]);
      const states = yield* Effect.forEach(ids, (id) => tasks.get(id), { concurrency: 8 });

      return states
        .flatMap((state) => Option.toArray(Option.fromNullOr(state.task)))
        .filter((task) => canRead(task, who))
        .sort((a, b) => a.TaskId.localeCompare(b.TaskId));
    });
  }),
);

export class Tasks extends Domain.Model("Tasks", {
  aggregates: [TaskAggregate],
  views: [SharedTasks, EveryoneTasks, OwnTasks],
  projections: [OwnerTaskWriter],
  streams: [OwnerTaskChanges],
  queries: [VisibleTasks],
}) {}

export class TasksApi extends Domain.Api("TasksApi", { model: Tasks }) {}

/**
 * The declarations under test. `visible` is decided by its query; it asks again when the feed
 * delivers one of the reader's own tasks, and when either index it follows changes: a task was
 * shared with the reader's address, withdrawn from it, or made public or private.
 */
export const tasks = LowAlch.collection(TaskRows, {
  queries: {
    visible: LowAlch.read(VisibleTasks)
      .follows(SharedTasks, (input) => input.email)
      .follows(EveryoneTasks, () => "everyone"),
  },
  commands: {
    create: LowAlch.inserts(CreateTask, {
      row: (input, key) => ({
        TaskId: key,
        owner: input.owner,
        title: input.title,
        visibility: "private" as const,
        sharedWith: [],
      }),
    }),
    rename: LowAlch.updates(RenameTask),
    share: LowAlch.updates(ShareTask),
    remove: LowAlch.deletes(DeleteTask),
  },
});

/** The model's handlers, its feed writer and the Layers that guard its reads. */
export const taskHandlers = () =>
  Layer.mergeAll(
    VisibleTasksLive,
    OwnerTaskWriter.layer,
    OwnerTaskChangesLive,
    SharedTasksLive,
    EveryoneTasksLive,
  );

/** Hosts the model in memory; `reader(subject)` is the Api client of that person. */
export const host = async () => {
  const model = Tasks.layer(taskHandlers()).pipe(Layer.provide(Domain.InMemory));
  const hosted = ManagedRuntime.make(model);
  const internals = await hosted.runPromise(Effect.context<Model.Internals>());
  const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];
  /** Every command a reader's client sent, as `<subject> <command>`. */
  const sent: Array<string> = [];

  const reader = async (subject: string) => {
    const runtime = ManagedRuntime.make(
      TasksApi.layerClientInProcess.pipe(
        Layer.provide(session(subject)),
        Layer.provide(Layer.succeedContext(internals)),
      ),
    );

    runtimes.push(runtime);

    const client = await runtime.runPromise(TasksApi.Client);

    const counted =
      <A extends ReadonlyArray<unknown>, R>(name: string, call: (...args: A) => R) =>
      (...args: A) => {
        sent.push(`${subject} ${name}`);

        return call(...args);
      };

    return {
      ...client,
      CreateTask: counted("CreateTask", client.CreateTask),
      RenameTask: counted("RenameTask", client.RenameTask),
      ShareTask: counted("ShareTask", client.ShareTask),
      DeleteTask: counted("DeleteTask", client.DeleteTask),
    };
  };

  return {
    reader,
    sent,
    dispose: async () => {
      for (const runtime of runtimes) await runtime.dispose();

      await hosted.dispose();
    },
  };
};
