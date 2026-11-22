import { collectionOptions, localOnlyCollectionOptions } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { describe, expect, it } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Screen } from "@highalch/screen";
import { Db } from "@highalch/tanstack-db";

type Todo = { readonly id: string; readonly title: string };

/** A local-only collection: it syncs nothing, so a host with nothing behind it is enough. */
const todos = collectionOptions(
  localOnlyCollectionOptions<Todo, string>({
    id: "todos",
    getKey: (todo) => todo.id,
    initialData: [{ id: "t1", title: "Write the story" }],
  }),
);

const Todos = () => {
  const { data } = useLiveQuery((q) => q.from({ todo: todos }));

  return (
    <ul>
      {data.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
};

const View = Screen.make({ width: 360, height: 120 });

const shows = (text: string) =>
  View.check(`shows "${text}"`, (container) => {
    expect(container.textContent).toBe(text);
  });

describe("f(host's data layer, screen) → mounted under its client, or as is", () => {
  it("f(no data layer) → the element as is: a screen needs no data layer", () =>
    Story.make(Story.local(), { scope: "acc-1" })(View.render(<p>Hello</p>), shows("Hello")));

  it("f(Db.data) → under TanStack DB's provider: the view reads the story's client", () =>
    Story.make(Story.local({ adapters: [Db.data] }), { scope: "acc-1" })(
      View.render(<Todos />),
      shows("Write the story"),
    ));
});
