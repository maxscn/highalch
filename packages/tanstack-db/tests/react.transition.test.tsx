/** @vitest-environment happy-dom */
import { act, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { Option } from "effect";
import * as LowAlch from "@lowalch/tanstack-db";
import { Provider } from "@lowalch/tanstack-db/react";
import { account, retryTransport, seed, tick, until, type Host } from "../../../fixtures/harness";
import { host, QueryRefused } from "../../../fixtures/notebook";
import { notes, stats } from "../../../fixtures/notes";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  document.body.replaceChildren();
});

const open = async (): Promise<Host> => {
  const server = await host();

  cleanup.push(() => server.dispose());

  return server;
};

const ada = { NoteId: "n1", account: "acc-1", BookId: "b1", title: "Ada" };

const bob = { NoteId: "n2", account: "acc-1", BookId: "b2", title: "Bob" };

/** Renders into a fresh root; returns the root's text. */
const render = async (node: ReactNode) => {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.append(container);
  cleanup.push(async () => act(() => root.unmount()));
  await act(async () => root.render(node));

  return {
    text: () => container.textContent ?? "",
    rerender: (next: ReactNode) => act(async () => root.render(next)),
  };
};

const settle = (read: () => string, expected: RegExp) =>
  act(() => until(() => expected.test(read()), `text ${expected}`));

/** The retry the last error branch received. */
const retries: Array<() => void> = [];

function Page() {
  const result = useLiveQuery((q) =>
    q.from({ note: notes.list({ account: "acc-1" }) }).orderBy(({ note }) => note.NoteId),
  );

  return (
    <p>
      {LowAlch.match(result).on({
        Loading: () => "loading",
        Retrying: ({ error, attempt, data }) => `retrying:${error._tag}:${attempt}:${data.length}`,
        Ready: ({ data, feed, retry }) => {
          retries.push(retry);

          return `ready:${data.map((note) => note.title).join(",")}:${Option.match(feed, {
            onNone: () => "live",
            onSome: (error) => error._tag,
          })}`;
        },
        QueryRefused: (error, { retry }) => {
          retries.push(retry);

          return `refused:${error instanceof QueryRefused}`;
        },
        RpcClientError: () => "transport",
      })}
    </p>
  );
}

function One({ id }: { id: string }) {
  const result = useLiveQuery((q) =>
    q
      .from({ note: notes.get({ NoteId: id }) })
      .where(({ note }) => eq(note.NoteId, id))
      .findOne(),
  );

  return (
    <p>
      {LowAlch.match(result).on({
        [LowAlch.anyOf("Loading", "Retrying")]: () => "loading",
        Ready: ({ data }) => `note:${data.title}`,
        Missing: () => "missing",
        orElse: (error) => `error:${error._tag}`,
      })}
    </p>
  );
}

function Maybe({ on }: { on: boolean }) {
  const result = useLiveQuery((q) =>
    on ? q.from({ note: notes.byBook({ BookId: "b1" }) }) : undefined,
  );

  return (
    <p>
      {LowAlch.match(result).on({
        Disabled: () => "off",
        Ready: ({ data }) => `on:${data.length}`,
        orElse: () => "pending",
      })}
    </p>
  );
}

function Summary() {
  const result = useLiveQuery((q) => q.from({ summary: stats({ account: "acc-1" }) }).findOne());

  return (
    <p>
      {LowAlch.match(result).on({
        Ready: ({ data }) => `count:${data.count}`,
        orElse: () => "pending",
      })}
    </p>
  );
}

/** Renders what the nearest error boundary would: a defect thrown during render. */
type Caught = { readonly failed?: string };

class Boundary extends Component<{ readonly children: ReactNode }, Caught> {
  override state: Caught = {};

  static getDerivedStateFromError(cause: Error) {
    return { failed: cause instanceof LowAlch.Defect ? `Defect ${cause.name}` : cause.message };
  }

  override render() {
    return this.state.failed ? `boundary:${this.state.failed}` : this.props.children;
  }
}

describe("f(stock useLiveQuery result, match)", () => {
  it("f(loading → ready) and a write from a component through the provider's client", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);

    const release = server.hold();

    const view = await render(
      <Provider client={db}>
        <Page />
      </Provider>,
    );

    expect(view.text()).toBe("loading");
    release();

    await settle(view.text, /^ready:Ada,Bob:live$/);

    // No client argument: the provider registered this one.
    await act(async () => {
      await notes.rename({ NoteId: "n2", title: "Bobby" }).when("settled");
    });

    expect(view.text()).toBe("ready:Ada,Bobby:live");
  });

  it("f(first load refused) → the original rejection as its own state; retry recovers", async () => {
    const server = await open();

    await seed(server, ada);
    server.store.refuse.add("Notes");

    const db = account(server, "acc-1", cleanup);

    const view = await render(
      <Provider client={db}>
        <Page />
      </Provider>,
    );

    await settle(view.text, /^refused:true$/);

    server.store.refuse.delete("Notes");
    await act(async () => retries.at(-1)?.());
    await settle(view.text, /^ready:Ada:live$/);
  });

  it("f(ready, feed interrupted) → Retrying with the data, then Ready; f(feed gives up) → Ready with feed", async () => {
    const server = await open();

    await seed(server, ada);

    const retry = retryTransport(150, 2);

    const db = account(server, "acc-1", cleanup, { retry });

    const view = await render(
      <Provider client={db}>
        <Page />
      </Provider>,
    );

    await settle(view.text, /^ready:Ada:live$/);

    server.wire.cut();
    await settle(view.text, /^retrying:RpcClientError:2:1$/);
    await settle(view.text, /^ready:Ada:live$/);

    server.wire.refuse(3);
    server.wire.cut();
    await settle(view.text, /^ready:Ada:RpcClientError$/);

    // Ready's retry reloads the live query and its stopped source: a new feed, live again.
    await act(async () => retries.at(-1)?.());
    await settle(view.text, /^ready:Ada:live$/);
  });

  it("f(first load dies) → a defect, not a state: thrown to the error boundary", async () => {
    const server = await open();

    await seed(server, ada);
    server.store.crash.add("Notes");

    const db = account(server, "acc-1", cleanup);
    const errors = console.error;

    console.error = () => {};

    cleanup.push(async () => {
      console.error = errors;
    });

    const view = await render(
      <Provider client={db}>
        <Boundary>
          <Page />
        </Boundary>
      </Provider>,
    );

    await settle(view.text, /^boundary:/);

    expect(view.text()).toBe("boundary:Defect NoteRows/Notes");
  });

  it("f(findOne, no row) → Missing; f(findOne, row) → Ready", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);

    const view = await render(
      <Provider client={db}>
        <One id="b1:Nine" />
      </Provider>,
    );

    await settle(view.text, /^missing$/);

    await act(async () => {
      // `file` declares the key from the input, so the caller knows it before creating.
      await notes.file({ account: "acc-1", BookId: "b1", title: "Nine" }).when("settled");
    });

    await settle(view.text, /^note:Nine$/);
  });

  it("f(query function returns nothing) → Disabled; f(enabled) → Ready", async () => {
    const server = await open();

    await seed(server, ada);

    const db = account(server, "acc-1", cleanup);

    const view = await render(
      <Provider client={db}>
        <Maybe on={false} />
      </Provider>,
    );

    expect(view.text()).toBe("off");

    await view.rerender(
      <Provider client={db}>
        <Maybe on />
      </Provider>,
    );
    await settle(view.text, /^on:1$/);
  });

  it("f(non-entity query) → Ready with its one row", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);

    const view = await render(
      <Provider client={db}>
        <Summary />
      </Provider>,
    );

    await settle(view.text, /^count:2$/);
    await tick();
  });
});
