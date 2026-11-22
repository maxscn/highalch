import { afterEach, describe, expect, it } from "vite-plus/test";
import type { DbClient } from "@tanstack/db";
import { Effect } from "effect";
import * as LowAlch from "@lowalch/tanstack-db";
import { calls, rejected, status, type Status } from "@lowalch/tanstack-db/offline";
import { account, observe, seed, titles, until, type Host } from "../../../../fixtures/harness";
import { host, NoteLocked, type Note } from "../../../../fixtures/notebook";
import { notes, touch } from "../../../../fixtures/notes";
import { device, offlineAccount } from "../../../../fixtures/offline";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

const open = async (): Promise<Host> => {
  const server = await host();

  cleanup.push(() => server.dispose());

  return server;
};

const ada = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada" };

const ready = (...collections: ReadonlyArray<{ isReady: () => boolean }>) =>
  until(() => collections.every((collection) => collection.isReady()), "ready");

const statusOf = (db: DbClient) => observe<Status>(db, status, cleanup);

/** The one status row, once the queue has started. */
const started = async (db: DbClient) => {
  const shown = statusOf(db);

  await until(() => shown.get("status")?.durable === true, "queue started");

  return shown;
};

/** Closes a client now, as a tab that reloads does. */
const reload = (db: DbClient) => Effect.runPromise(LowAlch.close(db));

const sent = (server: Host, name: string) =>
  server.wire.counts.commands.filter((command) => command === name).length;

const renamesSent = (server: Host) => sent(server, "RenameNote");

describe("f(client without offline, command)", () => {
  it("f(transport down, rename) → fails with the transport and rolls back, as before", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);

    await ready(one);
    server.wire.down(true);

    const outcome = await notes.rename.with({ client: db }).result({ NoteId: "n1", title: "Abel" });

    expect(outcome).toMatchObject({ _tag: "RpcClientError" });
    expect(titles(one)).toEqual(["n1:Ada"]);
    expect(() => db.collection(status)).toThrow(/no offline queue/);
  });
});

describe("f(offline client, command)", () => {
  it("f(online, rename) → the same transaction: optimistic at once, Committed once the feed delivered", async () => {
    const server = await open();

    await seed(server, ada);

    const db = offlineAccount(server, "acc-1", device(), cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);
    const shown = await started(db);

    await ready(one);

    const seen: Array<string> = [];
    const tx = notes.rename.with({ client: db })(
      { NoteId: "n1", title: "Abel" },
      { onCommitted: (value) => seen.push(value._tag) },
    );

    expect(titles(one)).toEqual(["n1:Abel"]);

    await tx.when("settled");

    expect(seen).toEqual(["Committed"]);
    expect(titles(one)).toEqual(["n1:Abel"]);
    // The call was sent with the transaction's id as its commandId.
    expect((await server.entries("acc-1")).at(-1)?.envelope.commandId).toBe(tx.id);
    await until(() => shown.get("status")?.queued === 0, "queue empty");
    expect(shown.get("status")).toMatchObject({
      online: true,
      queued: 0,
      leader: true,
      durable: true,
    });
  });

  it("f(network away, rename) → queued as data and shown pending; back online it is sent once and settles", async () => {
    const server = await open();

    await seed(server, ada);

    const on = device();
    const db = offlineAccount(server, "acc-1", on, cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);
    const queue = observe(db, calls, cleanup);
    const shown = await started(db);

    await ready(one);
    on.network.set(false);

    const tx = notes.rename.with({ client: db })({ NoteId: "n1", title: "Abel" });

    await until(() => queue.size === 1, "queued");

    expect([...queue.values()]).toMatchObject([
      {
        commandId: tx.id,
        name: "NoteRows/rename",
        command: "RenameNote",
        target: JSON.stringify(["acc-1", "n1"]),
        key: "n1",
        input: { NoteId: "n1", title: "Abel" },
        at: expect.any(Number),
      },
    ]);
    expect(shown.get("status")).toMatchObject({ online: false, queued: 1 });
    expect(titles(one)).toEqual(["n1:Abel"]);
    expect(one.get("n1")).toMatchObject({ $hasPendingWrites: true });
    expect(tx.state).toBe("persisting");
    expect(renamesSent(server)).toBe(0);
    expect(on.storage.stored.size).toBe(1);

    on.network.set(true);
    await tx.when("settled");

    expect(renamesSent(server)).toBe(1);
    expect(titles(one)).toEqual(["n1:Abel"]);
    await until(() => on.storage.stored.size === 0, "outbox emptied");
    await until(() => shown.get("status")?.queued === 0, "status caught up");
    expect(shown.get("status")).toMatchObject({ online: true, queued: 0 });
  });

  it("f(transport failing, rename) → retried by the executor until it is sent; never rejected", async () => {
    const server = await open();

    await seed(server, ada);

    const on = device();
    const db = offlineAccount(server, "acc-1", on, cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);
    const shown = await started(db);

    await ready(one);
    server.wire.down(true);

    const tx = notes.rename.with({ client: db })({ NoteId: "n1", title: "Abel" });

    await until(() => shown.get("status")?.online === false, "transport failure seen");
    expect(tx.state).toBe("persisting");
    expect(titles(one)).toEqual(["n1:Abel"]);

    server.wire.down(false);
    // The browser's "online" event: the executor retries now instead of after its backoff.
    on.network.set(true);
    await tx.when("settled");

    expect(titles(one)).toEqual(["n1:Abel"]);
    expect(shown.get("status")).toMatchObject({ online: true });
  });

  it("f(queued rename, typed rejection) → rolls back; when('settled') rejects with the original error", async () => {
    const server = await open();

    await seed(server, ada);

    const on = device();
    const db = offlineAccount(server, "acc-1", on, cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);

    await started(db);
    await ready(one);
    on.network.set(false);

    const tx = notes.rename.with({ client: db })({ NoteId: "n1", title: "locked" });

    expect(titles(one)).toEqual(["n1:locked"]);

    on.network.set(true);

    const error = await tx.when("settled").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(NoteLocked);
    expect(error).toMatchObject({ title: "locked" });
    expect(titles(one)).toEqual(["n1:Ada"]);
    await until(() => on.storage.stored.size === 0, "outbox emptied");
    // It was sent once: a rejection is never retried.
    expect(renamesSent(server)).toBe(1);
  });

  it("f(queued create and rename of it) → sent in the order called", async () => {
    const server = await open();
    const on = device();
    const db = offlineAccount(server, "acc-1", on, cleanup);
    const list = observe<Note>(db, notes.list({ account: "acc-1" }), cleanup);

    await started(db);
    await ready(list);
    on.network.set(false);

    const made = notes.create.with({ client: db })({
      account: "acc-1",
      BookId: "b1",
      title: "Ada",
    });
    const NoteId = LowAlch.created(made);
    const renamed = notes.rename.with({ client: db })({ NoteId, title: "Abel" });

    expect(titles(list)).toEqual([`${NoteId}:Abel`]);

    on.network.set(true);
    await Promise.all([made.when("settled"), renamed.when("settled")]);

    expect(titles(list)).toEqual([`${NoteId}:Abel`]);
    await server.indexed((stored) => stored.get(NoteId)?.title === "Abel");
  });

  it("f(command with no rows, network away) → queued too, and sent once back online", async () => {
    const server = await open();

    await seed(server, ada);

    const on = device();
    const db = offlineAccount(server, "acc-1", on, cleanup);
    const queue = observe(db, calls, cleanup);

    await started(db);
    on.network.set(false);

    const tx = touch.with({ client: db })({ NoteId: "n1" });

    await until(() => queue.size === 1, "queued");
    expect([...queue.values()][0]).toMatchObject({ name: "/TouchNote", key: "" });

    on.network.set(true);
    await tx.when("settled");

    expect(sent(server, "TouchNote")).toBe(1);
  });
});

describe("f(offline client, reload)", () => {
  it("f(queued rename, reload) → the queue is restored, shown on the rows again and sent with the same commandId", async () => {
    const server = await open();

    await seed(server, ada);

    const on = device();
    const first = offlineAccount(server, "acc-1", on, []);
    const before = observe<Note>(first, notes.get({ NoteId: "n1" }), cleanup);

    await started(first);
    await ready(before);
    on.network.set(false);

    const tx = notes.rename.with({ client: first })({ NoteId: "n1", title: "Abel" });
    const closed = tx.when("settled").then(
      () => "settled",
      (cause: Error) => cause.message,
    );

    await until(() => on.storage.stored.size === 1, "stored");
    await reload(first);

    // The tab is gone: its transaction rolled back, and the call is still stored.
    expect(await closed).toMatch(/closed/);
    expect(on.storage.stored.size).toBe(1);
    expect(renamesSent(server)).toBe(0);

    const second = offlineAccount(server, "acc-1", on, cleanup);
    const queue = observe(second, calls, cleanup);
    const shown = await started(second);
    const after = observe<Note>(second, notes.get({ NoteId: "n1" }), cleanup);

    await ready(after);

    expect([...queue.values()]).toMatchObject([{ commandId: tx.id, name: "NoteRows/rename" }]);
    expect(shown.get("status")).toMatchObject({ online: false, queued: 1 });
    // The server still says Ada: the restored call shows on the row that just loaded.
    expect(titles(after)).toEqual(["n1:Abel"]);
    expect(after.get("n1")).toMatchObject({ $hasPendingWrites: true });

    on.network.set(true);
    await until(() => queue.size === 0, "replayed");

    expect(renamesSent(server)).toBe(1);
    expect((await server.entries("acc-1")).at(-1)?.envelope.commandId).toBe(tx.id);
    expect(titles(after)).toEqual(["n1:Abel"]);
    await until(() => after.get("n1")?.$hasPendingWrites === false, "settled");
    await until(() => on.storage.stored.size === 0, "outbox emptied");
  });

  it("f(queued create, reload) → restored with the key it was given; the row is the same row", async () => {
    const server = await open();
    const on = device();
    const first = offlineAccount(server, "acc-1", on, []);

    await started(first);
    on.network.set(false);

    const made = notes.create.with({ client: first })({
      account: "acc-1",
      BookId: "b1",
      title: "Ada",
    });
    const NoteId = LowAlch.created(made);

    made.when("settled").catch(() => {});
    await until(() => on.storage.stored.size === 1, "stored");
    await reload(first);

    const second = offlineAccount(server, "acc-1", on, cleanup);
    const list = observe<Note>(second, notes.list({ account: "acc-1" }), cleanup);

    await started(second);
    await ready(list);

    expect(titles(list)).toEqual([`${NoteId}:Ada`]);

    on.network.set(true);
    await server.indexed((stored) => stored.get(NoteId)?.title === "Ada");
    await until(() => list.get(NoteId)?.$hasPendingWrites === false, "settled");
    expect(titles(list)).toEqual([`${NoteId}:Ada`]);
  });

  it("f(queued rename, reload, typed rejection on replay) → rolled back, and kept as data with its error", async () => {
    const server = await open();

    await seed(server, ada);

    const on = device();
    const first = offlineAccount(server, "acc-1", on, []);
    const before = observe<Note>(first, notes.get({ NoteId: "n1" }), cleanup);

    await started(first);
    await ready(before);
    on.network.set(false);

    const tx = notes.rename.with({ client: first })({ NoteId: "n1", title: "locked" });

    tx.when("settled").catch(() => {});
    await until(() => on.storage.stored.size === 1, "stored");
    await reload(first);

    const second = offlineAccount(server, "acc-1", on, cleanup);
    const after = observe<Note>(second, notes.get({ NoteId: "n1" }), cleanup);
    const failures = observe(second, rejected, cleanup);

    await started(second);
    await ready(after);
    expect(titles(after)).toEqual(["n1:locked"]);

    on.network.set(true);
    await until(() => failures.size === 1, "rejection recorded");

    const [failure] = [...failures.values()];

    expect(failure).toMatchObject({ commandId: tx.id, command: "RenameNote", key: "n1" });
    expect(failure?.error).toBeInstanceOf(NoteLocked);
    await until(() => titles(after)[0] === "n1:Ada", "rolled back");
    await until(() => on.storage.stored.size === 0, "outbox emptied");
  });
});

describe("f(two accounts, one device)", () => {
  it("f(queued rename of one account) → the other account's queue is its own", async () => {
    const server = await open();

    await seed(server, ada);

    const mine = device();
    const theirs = device();
    const db = offlineAccount(server, "acc-1", mine, cleanup);
    const other = offlineAccount(server, "acc-2", theirs, cleanup);
    const queue = observe(other, calls, cleanup);
    const one = observe<Note>(db, notes.get({ NoteId: "n1" }), cleanup);

    await started(db);
    await started(other);
    await ready(one);
    mine.network.set(false);

    notes.rename
      .with({ client: db })({ NoteId: "n1", title: "Abel" })
      .when("settled")
      .catch(() => {});
    await until(() => mine.storage.stored.size === 1, "stored");

    expect(queue.size).toBe(0);
    expect(theirs.storage.stored.size).toBe(0);
  });
});

describe("f(two tabs, one device)", () => {
  it("f(second tab) → not the leader: its calls are sent by itself and not stored", async () => {
    const server = await open();

    await seed(server, ada);

    const on = device();
    const leader = offlineAccount(server, "acc-1", on, cleanup);
    const follower = offlineAccount(server, "acc-1", on, cleanup);
    const leading = await started(leader);
    const following = statusOf(follower);
    const one = observe<Note>(follower, notes.get({ NoteId: "n1" }), cleanup);

    await ready(one);
    await until(() => following.get("status") !== undefined, "follower status");

    expect(leading.get("status")).toMatchObject({ leader: true, durable: true });
    expect(following.get("status")).toMatchObject({ leader: false, durable: false });

    const tx = notes.rename.with({ client: follower })({ NoteId: "n1", title: "Abel" });

    await tx.when("settled");

    expect(on.storage.stored.size).toBe(0);
    expect(renamesSent(server)).toBe(1);
  });

  it("f(leader with a queued rename closes) → the other tab takes over and sends it; nothing is lost", async () => {
    const server = await open();

    await seed(server, ada);

    const on = device();
    const leader = offlineAccount(server, "acc-1", on, []);
    const follower = offlineAccount(server, "acc-1", on, cleanup);
    const before = observe<Note>(leader, notes.get({ NoteId: "n1" }), cleanup);
    const one = observe<Note>(follower, notes.get({ NoteId: "n1" }), cleanup);
    const following = statusOf(follower);

    await started(leader);
    await ready(before, one);
    on.network.set(false);

    const tx = notes.rename.with({ client: leader })({ NoteId: "n1", title: "Abel" });

    tx.when("settled").catch(() => {});
    await until(() => on.storage.stored.size === 1, "stored");
    await reload(leader);

    await until(() => following.get("status")?.leader === true, "took over");
    // The restored call shows in the tab that now leads.
    await until(() => titles(one)[0] === "n1:Abel", "restored in the new leader");

    on.network.set(true);
    await until(() => on.storage.stored.size === 0, "sent");

    expect(renamesSent(server)).toBe(1);
    expect((await server.entries("acc-1")).at(-1)?.envelope.commandId).toBe(tx.id);
    expect(titles(one)).toEqual(["n1:Abel"]);
  });
});
