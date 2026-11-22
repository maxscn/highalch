import { Context, Effect } from "effect";
import { afterEach, expect, it } from "vite-plus/test";
import * as LowAlch from "@lowalch/tanstack-db";
import { calls, offline, status } from "@lowalch/tanstack-db/offline";
import { observe, until } from "../../../../fixtures/harness";
import { device, type Device } from "../../../../fixtures/offline";
import {
  Api,
  Forbidden,
  Session,
  host,
  manual,
  original,
  predicted,
  scope,
} from "../../../../fixtures/predicted";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

const open = async (user: string, on?: Device) => {
  const server = await host(user);
  cleanup.push(server.dispose);
  const db = LowAlch.make({
    api: Api,
    layer: server.layer,
    scope,
    context: Context.make(Session, user),
    offline:
      on &&
      offline({
        storage: on.storage,
        leaderElection: on.browser.tab(),
        onlineDetector: on.network,
      }),
  });
  cleanup.push(() => Effect.runPromise(LowAlch.close(db)));
  return { db, sent: server.sent };
};

const load = async (db: Awaited<ReturnType<typeof open>>["db"], entity = predicted) => {
  const list = observe(db, entity.list({}), cleanup);
  await until(() => list.isReady(), "notes ready");
  return list;
};

const rename = { id: original.id, title: "Revised" };

it("f(loaded note, forbidden rename) → rolls back immediately with the original rejection and never sends", async () => {
  const { db, sent } = await open("guest");
  const list = await load(db);
  const seen: Array<unknown> = [];
  const changes = list.subscribeChanges((batch) => expect(batch).toEqual([]));
  cleanup.push(async () => changes.unsubscribe());

  const command = predicted.rename.with({ client: db });
  const tx = command(rename, { onRejected: { orElse: (error) => seen.push(error) } });
  expect(tx.state).toBe("failed");
  expect(tx.mutations).toEqual([]);
  expect(list.get(original.id)).toMatchObject(original);

  const rejection = await tx.when("settled").catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(Forbidden);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBe(rejection);
  expect(await Effect.runPromise(Effect.flip(command.effect(rename)))).toBe(rejection);
  expect(await command.result(rename)).toBe(rejection);
  expect(sent).toEqual([]);
});

it("f(loaded note, accepted rename) → shows the event's row and commits after one send", async () => {
  const { db, sent } = await open("owner");
  const list = await load(db);
  const seen: Array<string> = [];
  const tx = predicted.rename.with({ client: db })(rename, {
    onCommitted: (value) => seen.push(value._tag),
  });

  expect(list.get(original.id)?.title).toBe("REVISED");
  await tx.when("settled");
  expect(seen).toEqual(["Committed"]);
  expect(sent).toEqual(["rename"]);
  expect(list.get(original.id)?.title).toBe("REVISED");
});

it("f(empty aggregate, insert) → uses the initial state and the declared created key", async () => {
  const { db } = await open("owner");
  const list = await load(db);
  const tx = predicted.create.with({ client: db })({ title: "New" });
  const id = LowAlch.created(tx);

  expect(list.get(id)).toMatchObject({ id, owner: "owner", title: "NEW" });
  await tx.when("settled");
  expect(list.get(id)?.title).toBe("NEW");
});

it("f(unloaded note, forbidden rename) → sends without an optimistic edit and rejects from the server", async () => {
  const { db, sent } = await open("guest");
  const tx = predicted.rename.with({ client: db })(rename);

  expect(tx.mutations).toEqual([]);
  await expect(tx.when("settled")).rejects.toBeInstanceOf(Forbidden);
  expect(sent).toEqual(["rename"]);
});

it("f(entity without state, forbidden rename) → shows the declared edit until the server rejects", async () => {
  const { db, sent } = await open("guest");
  const list = await load(db, manual);
  const tx = manual.rename.with({ client: db })(rename);

  expect(list.get(original.id)?.title).toBe("Revised");
  await expect(tx.when("settled")).rejects.toBeInstanceOf(Forbidden);
  expect(list.get(original.id)?.title).toBe(original.title);
  expect(sent).toEqual(["rename"]);
});

it("f(offline client, accepted rename) → shows the event's row, queues the call, then sends it once online", async () => {
  const on = device();
  const { db, sent } = await open("owner", on);
  const list = await load(db);
  const queue = observe(db, calls, cleanup);
  const shown = db.collection(status);
  const subscription = shown.subscribeChanges(() => {}, { includeInitialState: true });
  cleanup.push(async () => subscription.unsubscribe());
  await until(() => shown.get("status")?.durable === true, "queue ready");
  on.network.set(false);

  const tx = predicted.rename.with({ client: db })(rename);
  expect(list.get(original.id)?.title).toBe("REVISED");
  await until(() => queue.size === 1, "rename queued");
  expect(sent).toEqual([]);

  on.network.set(true);
  await tx.when("settled");
  expect(sent).toEqual(["rename"]);
  expect(list.get(original.id)?.title).toBe("REVISED");
});
