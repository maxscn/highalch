import { collectionOptions, localOnlyCollectionOptions } from "@tanstack/db";
import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Db } from "@highalch/story/tanstack-db";
import { NotesApi, notebook, store } from "../../../fixtures/notebook";

/**
 * `Db` steps on plain TanStack DB: no connector, so each scope's client is a bare `DbClient` and
 * the sources are ordinary collection options. The story still hosts a Domain (the world needs
 * one); these collections never reach it.
 */
const story = Story.make(Story.memory({ api: NotesApi, layer: notebook, services: store }), {
  scope: "acc-1",
});

type Todo = { readonly id: string; readonly title: string; readonly done: boolean };

/** A local-only collection, as a descriptor a `DbClient` materialises (`collectionOptions`). */
const todos = () =>
  collectionOptions(
    localOnlyCollectionOptions<Todo, string>({
      id: "todos",
      getKey: (todo) => todo.id,
      initialData: [
        { id: "t1", title: "Write the story", done: false },
        { id: "t2", title: "Review the frames", done: false },
      ],
    }),
  );

describe("f(plain TanStack DB, no connector) → the same Db steps", () => {
  it("f(local-only collection, toggle) → shown pending, settled, nothing pending at rest", async () => {
    const source = todos();

    await story.with({ rules: Db.rules })(
      Db.then(source, {
        rows: [{ title: "Write the story" }, { title: "Review the frames" }],
        state: "Ready",
      }),
      Db.when("toggle t1", ({ client }) =>
        client.collection(source).update("t1", (draft) => {
          draft.done = true;
        }),
      ),
      Db.then(source, [{ done: true }, { done: false }]),
      Db.settled(),
      Db.then(source, [
        { done: true, $hasPendingWrites: false },
        { done: false, $hasPendingWrites: false },
      ]),
    );
  });

  it("f(expected the old row) → a readable failure from the plain client", async () => {
    const source = todos();

    const failure = await story(
      Db.when("toggle t1", ({ client }) =>
        client.collection(source).update("t1", (draft) => {
          draft.done = true;
        }),
      ),
      Db.settled(),
      Db.then(source, [{ done: false }, { done: false }]),
    ).then(
      () => undefined,
      (error: Story.StoryFailure) => error,
    );

    expect(failure?.step).toBe(3);
    expect(failure?.message).toContain("todos does not show what was expected");
  });
});
