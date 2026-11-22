import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Alchemy } from "@highalch/alchemy-domain";
import { Db } from "@highalch/tanstack-db";
import { Offline } from "@highalch/tanstack-offline";
import {
  address,
  NoteAggregate,
  NoteCreated,
  NoteLocked,
  NotesApi,
  notebook,
  store,
  type Note,
} from "../../../../fixtures/notebook";
import { notes } from "../../../../fixtures/notes";

/**
 * Offline as stories: the Notebook hosted in memory, LowAlch clients with a durable queue on the
 * story's devices (its storage, tabs and network), on the story's clock. No DOM events.
 */
const story = Story.make(Alchemy.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
  adapters: [Offline.memory()],
  rules: [...Db.rules, ...Offline.rules],
});

const ada: Note = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada", pinned: false };

const exists = Alchemy.given(
  NoteAggregate.ref(address(ada.account, ada.NoteId)),
  new NoteCreated({ note: ada }),
);

const one = notes.get({ NoteId: "n1" });

describe("f(client with a durable queue, network) as stories", () => {
  it("f(online, rename) → the same story as without a queue: pending, then Committed", async () => {
    await story(
      exists,
      Db.then(one, [{ title: "Ada" }]),
      Db.when(notes.rename, { NoteId: "n1", title: "Abel" }),
      Db.then(one, [{ title: "Abel", $hasPendingWrites: true }]),
      Db.settled("Committed"),
      Db.then(one, [{ title: "Abel", $hasPendingWrites: false }]),
    );
  });

  it("f(network away, rename) → queued and shown pending; back online it settles Committed", async () => {
    await story(
      exists,
      Db.then(one, [{ title: "Ada" }]),
      Offline.down(),
      Db.when(notes.rename, { NoteId: "n1", title: "Abel" }),
      Db.then(one, [{ title: "Abel", $hasPendingWrites: true }]),
      Offline.up(),
      Db.settled("Committed"),
      Db.then(one, [{ title: "Abel", $hasPendingWrites: false }]),
    );
  });

  it("f(queued rename, typed rejection once online) → rolled back with the original NoteLocked", async () => {
    await story(
      exists,
      Db.then(one, [{ title: "Ada" }]),
      Offline.down(),
      Db.when(notes.rename, { NoteId: "n1", title: "locked" }),
      Db.then(one, [{ title: "locked", $hasPendingWrites: true }]),
      Offline.up(),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Db.then(one, [{ title: "Ada", $hasPendingWrites: false }]),
    );
  });

  it("f(queued rename, restart) → the queue is restored and shown again; back online it is replayed", async () => {
    await story(
      exists,
      Db.then(one, [{ title: "Ada" }]),
      Offline.down(),
      Db.when(notes.rename, { NoteId: "n1", title: "Abel" }),
      Db.restart(),
      // The reloaded app reads the server's Ada, and the restored call shows on it.
      Db.then(one, [{ title: "Abel", $hasPendingWrites: true }]),
      Offline.up(),
      Db.then(one, [{ title: "Abel", $hasPendingWrites: false }]),
      Db.check("the rename was sent once, by the app's queue", (db) => {
        expect(db.runs.map((run) => [run.by, run.outcome._tag])).toEqual([["app", "Committed"]]);
      }),
    );
  });

  it("f(queued rename, restart, typed rejection on replay) → the row is the server's again", async () => {
    await story(
      exists,
      Db.then(one, [{ title: "Ada" }]),
      Offline.down(),
      Db.when(notes.rename, { NoteId: "n1", title: "locked" }),
      Db.restart(),
      Db.then(one, [{ title: "locked", $hasPendingWrites: true }]),
      Offline.up(),
      Db.rejected(new NoteLocked({ title: "locked" })),
      Db.then(one, [{ title: "Ada", $hasPendingWrites: false }]),
    );
  });

  it("f(rule over the device) → one call is queued exactly while the rename waits offline", async () => {
    const seen: Array<readonly [boolean, number]> = [];

    const watched = Story.rule("the queue is read at every step", function* () {
      seen.push([yield* Offline.online(), yield* Offline.queued()]);

      return true;
    });

    await story.with({ rules: [...Db.rules, ...Offline.rules, watched] })(
      exists,
      Db.open(one),
      Offline.down(),
      Db.when(notes.rename, { NoteId: "n1", title: "Abel" }),
      Offline.up(),
      Db.settled("Committed"),
    );

    // Stored only while the network was away, and sent by the end.
    expect(seen).toContainEqual([false, 1]);
    expect(seen.filter(([online, queued]) => online && queued > 0)).toEqual([]);
    expect(seen.at(-1)).toEqual([true, 0]);
  });

  it("f(story without Offline.memory(), down) → fails, naming what is missing", async () => {
    const bare = Story.make(Alchemy.memory({ api: NotesApi, layer: notebook, services: store }), {
      scope: "acc-1",
    });

    const failure = await bare(Offline.down()).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("add Offline.memory() to the story's adapters");
  });
});
