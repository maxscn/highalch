import { describe, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Alchemy } from "@highalch/alchemy-domain";
import { Db } from "@highalch/tanstack-db";
import { Offline } from "@highalch/tanstack-offline";
import {
  canRead,
  NotOwner,
  person,
  session,
  TaskAggregate,
  TaskCreated,
  taskHandlers,
  tasks,
  TasksApi,
} from "../../../../fixtures/tasks";

/**
 * Tasks people share, as stories: one LowAlch client per person, each reading `visible`, which
 * follows the indexes that say a task was shared, withdrawn or made public. Only steps the kit
 * already has: a story's scope is the person, and the host's session decides what they may read.
 */
const mine = (subject: string) => tasks.visible({ email: person(subject).email });

/** No reader ever shows a task the app's own rule would not let them read. */
const visible = Story.rule("a reader sees only tasks they may read", function* () {
  for (const subject of ["ada", "bob", "cyd"]) {
    const rows = yield* Db.rows(mine(subject), { as: subject });

    if (![...rows.values()].every((task) => canRead(task, person(subject)))) return false;
  }

  return true;
});

const story = Story.make(Alchemy.memory({ api: TasksApi, layer: taskHandlers, session }), {
  scope: "ada",
  rules: [...Db.rules, visible],
});

/** Each person's read is open, then Ada's private task comes to exist. */
const created = [
  Db.open(mine("ada")),
  Story.as("bob", Db.open(mine("bob"))),
  Story.as("cyd", Db.open(mine("cyd"))),
  Alchemy.given(
    TaskAggregate.ref("t1"),
    new TaskCreated({
      task: { TaskId: "t1", owner: "ada", title: "Plan", visibility: "private", sharedWith: [] },
    }),
  ),
  Story.advance(10),
  Db.then(mine("ada"), [{ title: "Plan" }]),
  Story.as("bob", Db.then(mine("bob"), [])),
];

describe("f(shared tasks, audience) as stories", () => {
  it("f(shared with Bob, then made private) → Bob sees it, then does not; Cyd never does", async () => {
    await story(
      created,
      Db.when(tasks.share, {
        TaskId: "t1",
        visibility: "selected",
        sharedWith: [person("bob").email],
      }),
      Db.settled("Committed"),
      Story.advance(10),
      Story.as("bob", Db.then(mine("bob"), [{ title: "Plan", visibility: "selected" }])),
      Story.as("cyd", Db.then(mine("cyd"), [])),
      Db.when(tasks.share, { TaskId: "t1", visibility: "private", sharedWith: [] }),
      Db.settled("Committed"),
      Story.advance(10),
      Story.as("bob", Db.then(mine("bob"), [])),
      Db.then(mine("ada"), [{ title: "Plan", visibility: "private" }]),
    );
  });

  it("f(public, then shared with Bob only) → Bob keeps the one row; Cyd loses it", async () => {
    await story(
      created,
      Db.when(tasks.share, { TaskId: "t1", visibility: "everyone", sharedWith: [] }),
      Db.settled("Committed"),
      Story.advance(10),
      Story.as("bob", Db.then(mine("bob"), [{ title: "Plan" }])),
      Story.as("cyd", Db.then(mine("cyd"), [{ title: "Plan" }])),
      Db.when(tasks.share, {
        TaskId: "t1",
        visibility: "selected",
        sharedWith: [person("bob").email],
      }),
      Db.settled("Committed"),
      Story.advance(10),
      Story.as("bob", Db.then(mine("bob"), [{ title: "Plan", visibility: "selected" }])),
      Story.as("cyd", Db.then(mine("cyd"), [])),
    );
  });

  it("f(Bob renames a task shared with him) → rejected with NotOwner; his row is the owner's again", async () => {
    await story(
      created,
      Db.when(tasks.share, {
        TaskId: "t1",
        visibility: "selected",
        sharedWith: [person("bob").email],
      }),
      Db.settled("Committed"),
      Story.advance(10),
      Story.as(
        "bob",
        Db.then(mine("bob"), [{ title: "Plan" }]),
        Db.when(tasks.rename, { TaskId: "t1", title: "Mine" }),
        Db.rejected(new NotOwner()),
        Db.then(mine("bob"), [{ title: "Plan", $hasPendingWrites: false }]),
      ),
    );
  });

  it("f(owner offline renames, restarts, back online) → replayed; the reader sees it", async () => {
    await story.with({
      adapters: [Offline.memory()],
      rules: [...Db.rules, ...Offline.rules, visible],
    })(
      created,
      Db.when(tasks.share, {
        TaskId: "t1",
        visibility: "selected",
        sharedWith: [person("bob").email],
      }),
      Db.settled("Committed"),
      Story.advance(10),
      Story.as("bob", Db.then(mine("bob"), [{ title: "Plan" }])),
      Offline.down(),
      Db.when(tasks.rename, { TaskId: "t1", title: "Plan B" }),
      Db.restart(),
      Db.then(mine("ada"), [{ title: "Plan B", $hasPendingWrites: true }]),
      Offline.up(),
      Story.advance(10),
      Db.then(mine("ada"), [{ title: "Plan B", $hasPendingWrites: false }]),
      Story.as("bob", Db.then(mine("bob"), [{ title: "Plan B" }])),
    );
  });
});
