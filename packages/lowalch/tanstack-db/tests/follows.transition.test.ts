import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Collection, DbClient } from "@tanstack/db";
import { Context, Effect, Layer, Stream } from "effect";
import * as LowAlch from "@lowalch/tanstack-db";
import { calls } from "@lowalch/tanstack-db/offline";
import { observe, until } from "../../../../fixtures/harness";
import { device, type Device } from "../../../../fixtures/offline";
import { offline } from "@lowalch/tanstack-db/offline";
import {
  host,
  NotOwner,
  NotYours,
  person,
  tasks,
  TasksApi,
  Who,
  type Task,
} from "../../../../fixtures/tasks";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

type Host = Awaited<ReturnType<typeof host>>;

const open = async (): Promise<Host> => {
  const server = await host();

  cleanup.push(() => server.dispose());

  return server;
};

/** A person's client; with a device, one with a durable queue on it. */
const client = async (
  server: Host,
  subject: string,
  on?: Device,
  release: Array<() => Promise<void>> = cleanup,
  context?: Context.Context<never>,
) => {
  const db = LowAlch.make({
    api: TasksApi,
    layer: Layer.succeed(TasksApi.Client, await server.reader(subject)),
    scope: subject,
    reloadDelay: 5,
    settleTimeout: 2_000,
    ...(context !== undefined && { context }),
    ...(on !== undefined && {
      offline: offline({
        storage: on.storage,
        leaderElection: on.browser.tab(),
        onlineDetector: on.network,
      }),
    }),
  });

  release.push(() => Effect.runPromise(LowAlch.close(db)));

  return db;
};

/** What a person sees: the tasks their `visible` read shows. */
const visible = (db: DbClient, subject: string) =>
  observe<Task>(db, tasks.visible({ email: person(subject).email }), cleanup);

const titles = (shown: Collection<Task, string>) =>
  [...shown.values()].map((task) => task.title).sort();

const ready = (...collections: ReadonlyArray<{ isReady: () => boolean }>) =>
  until(() => collections.every((collection) => collection.isReady()), "ready");

const shows = (shown: Collection<Task, string>, expected: ReadonlyArray<string>, label: string) =>
  until(() => JSON.stringify(titles(shown)) === JSON.stringify(expected), label);

/** Ada, Bob and Cyd, each with their `visible` read loaded. */
const three = async () => {
  const server = await open();
  const ada = await client(server, "ada");
  const bob = await client(server, "bob");
  const cyd = await client(server, "cyd");
  const seen = { ada: visible(ada, "ada"), bob: visible(bob, "bob"), cyd: visible(cyd, "cyd") };

  await ready(seen.ada, seen.bob, seen.cyd);

  return { server, ada, bob, cyd, seen };
};

/** Ada creates a task and waits until it settled; answers its key. */
const created = async (ada: DbClient, title: string) => {
  const tx = tasks.create.with({ client: ada })({ owner: "ada", title });

  await tx.when("settled");

  return LowAlch.created(tx);
};

const share = (
  db: DbClient,
  TaskId: string,
  visibility: Task["visibility"],
  sharedWith: ReadonlyArray<string> = [],
) => tasks.share.with({ client: db })({ TaskId, visibility, sharedWith }).when("settled");

describe("f(read following served views, a task's audience)", () => {
  it("f(private task) → only its owner sees it", async () => {
    const { ada, seen } = await three();

    await created(ada, "Plan");

    await shows(seen.ada, ["Plan"], "the owner sees it");
    expect(titles(seen.bob)).toEqual([]);
    expect(titles(seen.cyd)).toEqual([]);
  });

  it("f(shared with Bob) → Bob sees it once his index says so; Cyd does not", async () => {
    const { ada, seen } = await three();
    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "selected", [person("bob").email]);

    await shows(seen.bob, ["Plan"], "shared with Bob");
    expect(seen.bob.get(TaskId)).toMatchObject({ owner: "ada", visibility: "selected" });
    expect(titles(seen.ada)).toEqual(["Plan"]);
    expect(titles(seen.cyd)).toEqual([]);
  });

  it("f(made visible to everyone) → every reader sees the one row, once", async () => {
    const { ada, seen } = await three();
    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "everyone");

    await shows(seen.bob, ["Plan"], "Bob sees it");
    await shows(seen.cyd, ["Plan"], "Cyd sees it");
    expect(seen.ada.size).toBe(1);
    expect(seen.bob.size).toBe(1);
    expect(seen.cyd.size).toBe(1);
  });

  it("f(shared with Bob and Cyd, Cyd withdrawn) → it leaves Cyd only", async () => {
    const { ada, seen } = await three();
    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "selected", [person("bob").email, person("cyd").email]);
    await shows(seen.bob, ["Plan"], "Bob sees it");
    await shows(seen.cyd, ["Plan"], "Cyd sees it");

    await share(ada, TaskId, "selected", [person("bob").email]);

    await shows(seen.cyd, [], "withdrawn from Cyd");
    expect(titles(seen.bob)).toEqual(["Plan"]);
    expect(titles(seen.ada)).toEqual(["Plan"]);
  });

  it("f(visible to everyone, then shared with Bob only) → Bob keeps it while Cyd loses it", async () => {
    const { ada, seen } = await three();
    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "everyone");
    await shows(seen.bob, ["Plan"], "Bob sees it");
    await shows(seen.cyd, ["Plan"], "Cyd sees it");

    // Bob loses one reason to see it and gains another in the same change.
    await share(ada, TaskId, "selected", [person("bob").email]);

    await shows(seen.cyd, [], "no longer public");
    expect(titles(seen.bob)).toEqual(["Plan"]);
    expect(seen.bob.get(TaskId)).toMatchObject({ visibility: "selected" });
  });

  it("f(shared task renamed by its owner) → the reader it is shared with sees the new title", async () => {
    const { ada, seen } = await three();
    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "selected", [person("bob").email]);
    await shows(seen.bob, ["Plan"], "Bob sees it");

    await tasks.rename.with({ client: ada })({ TaskId, title: "Plan B" }).when("settled");

    await shows(seen.bob, ["Plan B"], "renamed for Bob");
  });

  it("f(made private) → it leaves everyone but its owner", async () => {
    const { ada, seen } = await three();
    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "selected", [person("bob").email]);
    await shows(seen.bob, ["Plan"], "Bob sees it");

    await share(ada, TaskId, "private");

    await shows(seen.bob, [], "private again");
    expect(titles(seen.ada)).toEqual(["Plan"]);
  });

  it("f(shared task deleted) → gone for its owner and for the reader", async () => {
    const { ada, seen } = await three();
    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "everyone");
    await shows(seen.cyd, ["Plan"], "Cyd sees it");

    await tasks.remove.with({ client: ada })({ TaskId }).when("settled");

    await shows(seen.cyd, [], "deleted for Cyd");
    await shows(seen.ada, [], "deleted for Ada");
  });
});

describe("f(reader, what is not theirs)", () => {
  it("f(another person's index) → the read is rejected with the typed rejection", async () => {
    const server = await open();
    const bob = await server.reader("bob");

    const refused = await Effect.runPromise(
      Effect.flip(Stream.runHead(bob.SharedTasks.watch(person("ada").email))),
    );

    expect(refused).toBeInstanceOf(NotYours);
  });

  it("f(a read declared for another person's address) → fails with NotYours; nothing is shown", async () => {
    const server = await open();
    const ada = await client(server, "ada");
    const bob = await client(server, "bob");

    await created(ada, "Plan");

    const stolen = observe<Task>(bob, tasks.visible({ email: person("ada").email }), cleanup);

    await until(() => stolen.status === "error", "the read failed");

    expect(stolen.size).toBe(0);
    expect(stolen.health.error?.cause).toBeInstanceOf(NotYours);
  });

  it("f(the reader renames a task shared with them) → rejected by its owner's aggregate; rolled back", async () => {
    const { ada, bob, seen } = await three();
    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "selected", [person("bob").email]);
    await shows(seen.bob, ["Plan"], "Bob sees it");

    const tx = tasks.rename.with({ client: bob })({ TaskId, title: "Mine" });

    expect(titles(seen.bob)).toEqual(["Mine"]);

    const error = await tx.when("settled").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(NotOwner);
    expect(titles(seen.bob)).toEqual(["Plan"]);
    expect(titles(seen.ada)).toEqual(["Plan"]);
  });
});

describe("f(client that knows who it is, command)", () => {
  it("f(the reader renames a task shared with them) → refused at once by decide; nothing shown, nothing sent", async () => {
    const server = await open();
    const ada = await client(server, "ada");
    // SAFETY: the context a command's middleware provides: who is asking.
    const who = Context.make(Who, person("bob")) as Context.Context<never>;
    const bob = await client(server, "bob", undefined, cleanup, who);
    const mine = visible(ada, "ada");
    const theirs = visible(bob, "bob");

    await ready(mine, theirs);

    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "selected", [person("bob").email]);
    await shows(theirs, ["Plan"], "Bob sees it");

    const before = server.sent.length;
    const tx = tasks.rename.with({ client: bob })({ TaskId, title: "Mine" });

    // The aggregate's own decide ran here: no optimistic edit shows.
    expect(titles(theirs)).toEqual(["Plan"]);

    const error = await tx.when("settled").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(NotOwner);
    expect(server.sent.slice(before)).toEqual([]);
  });

  it("f(the owner renames their task) → accepted by decide; the row is the one its event carries", async () => {
    const server = await open();
    // SAFETY: as above.
    const who = Context.make(Who, person("ada")) as Context.Context<never>;
    const ada = await client(server, "ada", undefined, cleanup, who);
    const mine = visible(ada, "ada");

    await ready(mine);

    const TaskId = await created(ada, "Plan");
    const tx = tasks.rename.with({ client: ada })({ TaskId, title: "Plan B" });

    expect(mine.get(TaskId)).toMatchObject({ title: "Plan B", $hasPendingWrites: true });

    await tx.when("settled");

    expect(titles(mine)).toEqual(["Plan B"]);
  });
});

describe("f(offline client following views, restart)", () => {
  it("f(owner's queued rename, restart, back online) → replayed once; the reader sees it", async () => {
    const server = await open();
    const on = device();
    const first: Array<() => Promise<void>> = [];
    const ada = await client(server, "ada", on, first);
    const bob = await client(server, "bob");
    const mine = visible(ada, "ada");
    const theirs = visible(bob, "bob");

    await ready(mine, theirs);

    const TaskId = await created(ada, "Plan");

    await share(ada, TaskId, "selected", [person("bob").email]);
    await shows(theirs, ["Plan"], "Bob sees it");

    on.network.set(false);

    const tx = tasks.rename.with({ client: ada })({ TaskId, title: "Plan B" });

    tx.when("settled").catch(() => {});
    await until(() => on.storage.stored.size === 1, "stored");
    for (const release of first.splice(0)) await release();

    const again = await client(server, "ada", on);
    const queue = observe(again, calls, cleanup);
    const restored = visible(again, "ada");

    await ready(restored);
    await shows(restored, ["Plan B"], "restored on the owner's rows");
    expect(titles(theirs)).toEqual(["Plan"]);

    on.network.set(true);

    await until(() => queue.size === 0 && on.storage.stored.size === 0, "replayed");
    await shows(theirs, ["Plan B"], "the reader sees the replayed rename");
    await shows(restored, ["Plan B"], "the owner keeps it");
  });
});
