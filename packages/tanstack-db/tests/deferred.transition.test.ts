import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPacedMutations, debounceStrategy } from "@tanstack/db";
import { Effect, Layer, Stream } from "effect";
import * as Domain from "@alchemy.run/domain";
import * as HighAlch from "@highalch/tanstack-db";
import { observe, quick, tick, until } from "../../../fixtures/harness";
import {
  entries,
  EntryEmpty,
  host,
  LedgerApi,
  NotYours,
  type Entry,
} from "../../../fixtures/ledger";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

type Ledger = Awaited<ReturnType<typeof host>>;

const open = async () => {
  const server = await host();

  cleanup.push(() => server.dispose());

  return server;
};

const client = (server: Ledger, settleTimeout = 2_000, api = server.api) => {
  const db = HighAlch.make({
    api: LedgerApi,
    layer: Layer.succeed(LedgerApi.Client, api),
    scope: "acc-1",
    reloadDelay: 10,
    settleTimeout,
    retry: quick,
  });

  cleanup.push(() => HighAlch.close(db));

  return db;
};

const ada: Entry = { EntryId: "e1", account: "acc-1", text: "Ada" };

const bob: Entry = { EntryId: "e2", account: "acc-1", text: "Bob" };

const texts = (rows: Iterable<Entry>) =>
  [...rows].sort((a, b) => a.EntryId.localeCompare(b.EntryId)).map((row) => row.text);

describe("f(wrapped answer, load)", () => {
  it("f(nothing loaded, entries(query, answer => answer.Items)) → ready with the answer's rows", async () => {
    const server = await open();

    await server.seed(ada, bob);

    const list = observe<Entry>(client(server), entries.list({ account: "acc-1" }), cleanup);

    await until(() => list.isReady(), "ready");

    expect(texts(list.values())).toEqual(["Ada", "Bob"]);
  });
});

describe("f(deferred settlement, command)", () => {
  it("f(stored later, update) → optimistic until the settled row arrives under the command's id, then that row", async () => {
    const server = await open();

    await server.seed(ada);

    const db = client(server);
    const list = observe<Entry>(db, entries.list({ account: "acc-1" }), cleanup);

    await until(() => list.isReady(), "ready");

    const release = server.hold();
    const settled: Array<string> = [];

    const transaction = entries.save.with({ client: db })(
      { value: { EntryId: "e1", text: "Ada 2" } },
      { id: "edit-1", onCommitted: (value) => settled.push(value._tag) },
    );

    // `fields` reads the nested input: the optimistic row has the new text.
    expect(list.get("e1")?.text).toBe("Ada 2");

    // The command's receipt is in, the write is not stored: the transaction stays pending.
    await tick(100);

    expect(transaction.state).toBe("persisting");
    expect(server.store.entries.get("e1")?.text).toBe("Ada");

    release();
    await transaction.when("settled");

    // Settled by the feed's row: it was stored before it was emitted.
    expect(server.store.entries.get("e1")?.text).toBe("Ada 2");
    expect(list.get("e1")?.text).toBe("Ada 2");
    // Committed, not Unconfirmed: the feed delivered the row under `edit-1`, its `cause`.
    await until(() => settled.length === 1, "onCommitted");
    expect(settled).toEqual(["Committed"]);
  });

  it("f(stored later, delete with a declared key) → the row leaves, settled by its Removed", async () => {
    const server = await open();

    await server.seed(ada, bob);

    const db = client(server);
    const list = observe<Entry>(db, entries.list({ account: "acc-1" }), cleanup);

    await until(() => list.isReady(), "ready");

    const outcome = await entries.drop.with({ client: db }).result({ value: { EntryId: "e2" } });

    expect(outcome).toMatchObject({ _tag: "Committed" });
    expect(texts(list.values())).toEqual(["Ada"]);
    expect(server.store.entries.has("e2")).toBe(false);
  });

  it("f(store refuses, update) → nothing emitted: Unconfirmed after the timeout, the subset reloads the stored row", async () => {
    const server = await open();

    await server.seed(ada);
    server.store.refuse.add("e1");

    const db = client(server, 300);
    const list = observe<Entry>(db, entries.list({ account: "acc-1" }), cleanup);

    await until(() => list.isReady(), "ready");

    const outcome = await entries.save
      .with({ client: db })
      .result({ value: { EntryId: "e1", text: "Ada 2" } });

    expect(outcome).toMatchObject({ _tag: "Unconfirmed" });
    await until(() => list.get("e1")?.text === "Ada", "reloaded");
  });

  it("f(rejected decision, update) → rolls back with the typed rejection", async () => {
    const server = await open();

    await server.seed(ada);

    const db = client(server);
    const list = observe<Entry>(db, entries.list({ account: "acc-1" }), cleanup);

    await until(() => list.isReady(), "ready");

    const outcome = await entries.save
      .with({ client: db })
      .result({ value: { EntryId: "e1", text: "" } });

    expect(outcome).toBeInstanceOf(EntryEmpty);
    expect(list.get("e1")?.text).toBe("Ada");
  });

  it("f(paced update, nested input) → one command whose input `input(row)` built from the merged row", async () => {
    const server = await open();

    await server.seed(ada);

    const db = client(server);
    const list = observe<Entry>(db, entries.list({ account: "acc-1" }), cleanup);
    const release = HighAlch.activate(db);

    cleanup.push(async () => release());
    await until(() => list.isReady(), "ready");

    const mutate = createPacedMutations({
      ...entries.save.paced,
      strategy: debounceStrategy({ wait: 20 }),
    });

    const calls = ["A", "Ad", "Ada 3"].map((text) => mutate({ value: { EntryId: "e1", text } }));

    expect(list.get("e1")?.text).toBe("Ada 3");

    await calls[0]?.when("settled");

    expect(server.store.entries.get("e1")?.text).toBe("Ada 3");
    expect(list.get("e1")?.text).toBe("Ada 3");
  });
});

describe("f(guarded feed, reader of another scope)", () => {
  it("f(acc-2 reader, peek | events of acc-1's feed) → NotYours; its own feed reads", async () => {
    const server = await open();

    await server.seed(ada);

    const other = server.reader("acc-2");

    cleanup.push(() => other.dispose());

    const peeked = await other.runPromise(
      Effect.flatMap(LedgerApi.Client, (api) => api.LedgerChanges.peek("acc-1").pipe(Effect.flip)),
    );

    expect(peeked).toBeInstanceOf(NotYours);

    // Each delivered entry is judged too: the first entry ends the read.
    const followed = await other.runPromise(
      Effect.flatMap(LedgerApi.Client, (api) =>
        api.LedgerChanges.events("acc-1", { after: 0 }).pipe(
          Stream.filter(Domain.Read.isEvent),
          Stream.runHead,
          Effect.flip,
        ),
      ),
    );

    expect(followed).toBeInstanceOf(NotYours);

    const own = await other.runPromise(
      Effect.flatMap(LedgerApi.Client, (api) => api.LedgerChanges.peek("acc-2")),
    );

    expect(own).toBeNull();
  });

  it("f(client scoped to acc-1 over an acc-2 reader, load) → the subset fails with the feed's typed NotYours", async () => {
    const server = await open();

    await server.seed(ada);

    const other = server.reader("acc-2");

    cleanup.push(() => other.dispose());

    const api = await other.runPromise(LedgerApi.Client);

    const list = observe<Entry>(
      client(server, 2_000, api),
      entries.list({ account: "acc-1" }),
      cleanup,
    );

    await until(() => list.health.error !== null, "failed");

    expect(list.isReady()).toBe(false);
    expect(list.health.error?.cause).toBeInstanceOf(NotYours);
  });
});
