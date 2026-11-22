/** @vitest-environment happy-dom */
import {
  act,
  Component,
  StrictMode,
  Suspense,
  useDeferredValue,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useLiveQuery } from "@tanstack/react-db";
import { Deferred, Effect } from "effect";
import * as LowAlch from "@lowalch/tanstack-db";
import { Provider } from "@lowalch/tanstack-db/react";
import { account, seed, tick, type Host } from "../../../../fixtures/harness";
import { host } from "../../../../fixtures/notebook";
import { notes } from "../../../../fixtures/notes";

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

/** Holds every query answer until the returned release. */
const hold = (server: Host) => {
  const gate = Effect.runSync(Deferred.make<void>());

  server.store.gate = Deferred.await(gate);

  return () => {
    server.store.gate = Effect.void;
    Effect.runSync(Deferred.succeed(gate, undefined));
  };
};

/** What one reader did: renders, suspensions and the distinct promises it threw. */
type Probe = { renders: number; suspensions: number; readonly thrown: Set<unknown> };

const probe = (): Probe => ({ renders: 0, suspensions: 0, thrown: new Set() });

/** Counts a render that suspends with what it throws, then rethrows it. */
const counted = (seen: Probe, render: () => ReactNode): ReactNode => {
  seen.renders += 1;

  try {
    return render();
  } catch (thrown) {
    if (thrown instanceof Promise) {
      seen.suspensions += 1;
      seen.thrown.add(thrown);
    }

    throw thrown;
  }
};

const counts = (seen: Probe) => ({
  renders: seen.renders,
  suspensions: seen.suspensions,
  promises: seen.thrown.size,
});

function List({ seen }: { seen: Probe }) {
  const result = useLiveQuery((q) =>
    q.from({ note: notes.list({ account: "acc-1" }) }).orderBy(({ note }) => note.NoteId),
  );

  return counted(seen, () => (
    <p>
      {LowAlch.match(result).on({
        Loading: LowAlch.Suspend,
        Retrying: ({ data }) => `retrying:${data.length}`,
        Ready: ({ data }) => `list:${data.map((note) => note.title).join(",")}`,
        QueryRefused: () => "refused",
        RpcClientError: () => "transport",
      })}
    </p>
  ));
}

function Book({ book, seen }: { book: string; seen: Probe }) {
  const result = useLiveQuery((q) =>
    q.from({ note: notes.byBook({ BookId: book }) }).orderBy(({ note }) => note.NoteId),
  );

  return counted(seen, () => (
    <p>
      {LowAlch.match(result).on({
        Loading: LowAlch.Suspend,
        Ready: ({ data }) => `${book}:${data.map((note) => note.title).join(",")}`,
        orElse: (state) => `other:${state._tag}`,
      })}
    </p>
  ));
}

/** Counts the fallback's renders. */
function Fallback({ seen }: { seen: { renders: number } }) {
  seen.renders += 1;

  return <p>fallback</p>;
}

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

/** The text a user sees: React hides suspended content with `display: none` and keeps it. */
const visible = (node: Node): string => {
  if (node instanceof HTMLElement && node.style.display === "none") return "";

  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";

  return [...node.childNodes].map(visible).join("");
};

const render = async (node: ReactNode) => {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.append(container);
  cleanup.push(async () => act(() => root.unmount()));
  await act(async () => root.render(node));

  return {
    text: () => visible(container),
    rerender: (next: ReactNode) => act(async () => root.render(next)),
    unmount: () => act(async () => root.unmount()),
    root,
  };
};

/** Lets React retry pinged renders until `expected` shows (act flushes only when it returns). */
const settle = async (read: () => string, expected: RegExp) => {
  for (let tries = 0; tries < 100 && !expected.test(read()); tries += 1)
    await act(async () => tick(10));

  expect(read()).toMatch(expected);
};

/** Fails the test on any unhandled rejection while it runs. */
const rejections = () => {
  const seen: Array<unknown> = [];
  const listen = (reason: unknown) => seen.push(reason);

  process.on("unhandledRejection", listen);
  cleanup.push(async () => {
    process.off("unhandledRejection", listen);
  });

  return seen;
};

describe("f(stock useLiveQuery result, match with Loading: Suspend)", () => {
  it("f(first mount, query held) → fallback; f(release) → the list, retried once", async () => {
    const server = await open();
    const unhandled = rejections();

    await seed(server, ada, bob);

    const release = hold(server);
    const db = account(server, "acc-1", cleanup);
    const seen = probe();
    const fallback = { renders: 0 };

    const view = await render(
      <Provider client={db}>
        <Suspense fallback={<Fallback seen={fallback} />}>
          <List seen={seen} />
        </Suspense>
      </Provider>,
    );

    await act(async () => tick(50));

    expect(view.text()).toBe("fallback");
    // The render and React's pre-warm of the suspended tree; both throw the one promise.
    expect(counts(seen)).toEqual({ renders: 2, suspensions: 2, promises: 1 });

    release();
    await settle(view.text, /^list:Ada,Bob$/);

    // The retry builds a new live query collection over the loaded source: Ready at once.
    expect(counts(seen)).toEqual({ renders: 3, suspensions: 2, promises: 1 });
    expect(fallback.renders).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it("f(ready, input → unloaded subset) → fallback replaces the list, then the new list", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);
    const seen = probe();
    const fallback = { renders: 0 };
    const page = (book: string) => (
      <Provider client={db}>
        <Suspense fallback={<Fallback seen={fallback} />}>
          <Book book={book} seen={seen} />
        </Suspense>
      </Provider>
    );

    const view = await render(page("b1"));

    await settle(view.text, /^b1:Ada$/);

    const before = counts(seen);
    const release = hold(server);

    await view.rerender(page("b2"));

    expect(view.text()).toBe("fallback");

    release();
    await settle(view.text, /^b2:Bob$/);

    expect({
      renders: seen.renders - before.renders,
      suspensions: seen.suspensions - before.suspensions,
    }).toEqual({ renders: 3, suspensions: 2 });
  });

  it("f(ready, input → unloaded subset in a transition) → the old list stays until the new one", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);
    const seen = probe();
    const shown: Array<string> = [];
    let choose: (book: string) => void = () => {};

    function Picker() {
      const [pending, start] = useTransition();
      const [book, setBook] = useState("b1");

      choose = (next) => start(() => setBook(next));

      return (
        <>
          <span>{pending ? "pending|" : ""}</span>
          <Suspense fallback={<p>fallback</p>}>
            <Book book={book} seen={seen} />
          </Suspense>
        </>
      );
    }

    const view = await render(
      <Provider client={db}>
        <Picker />
      </Provider>,
    );

    await settle(view.text, /^b1:Ada$/);

    const before = counts(seen);
    const release = hold(server);

    await act(async () => choose("b2"));
    await act(async () => tick(50));
    shown.push(view.text());

    release();
    await settle(view.text, /^b2:Bob$/);

    expect(shown).toEqual(["pending|b1:Ada"]);
    expect({
      renders: seen.renders - before.renders,
      suspensions: seen.suspensions - before.suspensions,
    }).toEqual({ renders: 3, suspensions: 1 });
  });

  it("f(ready, deferred input → unloaded subset) → the old list stays until the new one", async () => {
    const server = await open();

    await seed(server, ada, bob);

    const db = account(server, "acc-1", cleanup);
    const seen = probe();

    function Deferring({ book }: { book: string }) {
      const deferred = useDeferredValue(book);

      return (
        <Suspense fallback={<p>fallback</p>}>
          <span>{deferred === book ? "" : "stale|"}</span>
          <Book book={deferred} seen={seen} />
        </Suspense>
      );
    }

    const view = await render(
      <Provider client={db}>
        <Deferring book="b1" />
      </Provider>,
    );

    await settle(view.text, /^b1:Ada$/);

    const release = hold(server);

    const before = counts(seen);
    const shown: Array<string> = [];

    // The urgent render keeps b1 and the deferred one suspends on b2; released after 50 ms.
    await act(async () => {
      view.root.render(
        <Provider client={db}>
          <Deferring book="b2" />
        </Provider>,
      );
      setTimeout(() => {
        shown.push(view.text());
        release();
      }, 50);
    });
    await settle(view.text, /^b2:Bob$/);

    expect(shown).toEqual(["stale|b1:Ada"]);
    expect({
      renders: seen.renders - before.renders,
      suspensions: seen.suspensions - before.suspensions,
    }).toEqual({ renders: 3, suspensions: 1 });
  });

  it("f(two readers of one subset under one Suspense) → one promise; both shown together", async () => {
    const server = await open();

    await seed(server, ada);

    const release = hold(server);
    const db = account(server, "acc-1", cleanup);
    const first = probe();
    const second = probe();

    const view = await render(
      <Provider client={db}>
        <Suspense fallback={<p>fallback</p>}>
          <List seen={first} />
          <List seen={second} />
        </Suspense>
      </Provider>,
    );

    await act(async () => tick(50));

    expect(view.text()).toBe("fallback");

    release();
    await settle(view.text, /^list:Adalist:Ada$/);

    expect([...first.thrown]).toEqual([...second.thrown]);
    expect(counts(first)).toEqual({ renders: 3, suspensions: 2, promises: 1 });
    expect(counts(second)).toEqual({ renders: 2, suspensions: 1, promises: 1 });
  });

  it("f(two clients suspend on one subset input, A held, B answered) → B's list while A waits; then A's", async () => {
    // Two hosts, so one client's query can be held while the other's answers.
    const held = await open();
    const answered = await open();

    await seed(held, ada);
    await seed(answered, ada, bob);

    const release = hold(held);
    const first = account(held, "acc-1", cleanup);
    const second = account(answered, "acc-1", cleanup);
    const a = probe();
    const b = probe();

    const view = await render(
      <>
        <Provider client={first}>
          <Suspense fallback={<p>waiting|</p>}>
            <List seen={a} />
          </Suspense>
        </Provider>
        <Provider client={second}>
          <Suspense fallback={<p>waiting</p>}>
            <List seen={b} />
          </Suspense>
        </Provider>
      </>,
    );

    // The same subset id in both clients: B's read starts and ends on its own.
    await settle(view.text, /^waiting\|list:Ada,Bob$/);

    release();
    await settle(view.text, /^list:Adalist:Ada,Bob$/);

    expect([...a.thrown].some((promise) => b.thrown.has(promise))).toBe(false);
    expect(counts(a)).toEqual({ renders: 3, suspensions: 2, promises: 1 });
    expect(counts(b)).toEqual({ renders: 3, suspensions: 2, promises: 1 });
  });

  it("f(first load refused) → the typed branch, not the boundary; no loop", async () => {
    const server = await open();
    const unhandled = rejections();

    await seed(server, ada);
    server.store.refuse.add("Notes");

    const release = hold(server);
    const db = account(server, "acc-1", cleanup);
    const seen = probe();

    const view = await render(
      <Provider client={db}>
        <Boundary>
          <Suspense fallback={<p>fallback</p>}>
            <List seen={seen} />
          </Suspense>
        </Boundary>
      </Provider>,
    );

    expect(view.text()).toBe("fallback");

    release();
    await settle(view.text, /^refused$/);
    await act(async () => tick(50));

    expect(view.text()).toBe("refused");
    expect(counts(seen)).toEqual({ renders: 3, suspensions: 2, promises: 1 });
    expect(unhandled).toEqual([]);
  });

  it("f(first load dies) → a defect at the error boundary, as without Suspend", async () => {
    const server = await open();

    await seed(server, ada);
    server.store.crash.add("Notes");

    const errors = console.error;

    console.error = () => {};
    cleanup.push(async () => {
      console.error = errors;
    });

    const release = hold(server);
    const db = account(server, "acc-1", cleanup);
    const seen = probe();

    const view = await render(
      <Provider client={db}>
        <Boundary>
          <Suspense fallback={<p>fallback</p>}>
            <List seen={seen} />
          </Suspense>
        </Boundary>
      </Provider>,
    );

    expect(view.text()).toBe("fallback");

    release();
    await settle(view.text, /^boundary:/);

    expect(view.text()).toBe("boundary:Defect NoteRows/Notes");
    expect(seen.suspensions).toBe(2);
    expect(seen.thrown.size).toBe(1);
  });

  it("f(StrictMode, first mount held) → fallback; f(release) → the list, one promise", async () => {
    const server = await open();

    await seed(server, ada);

    const release = hold(server);
    const db = account(server, "acc-1", cleanup);
    const seen = probe();

    const view = await render(
      <StrictMode>
        <Provider client={db}>
          <Suspense fallback={<p>fallback</p>}>
            <List seen={seen} />
          </Suspense>
        </Provider>
      </StrictMode>,
    );

    expect(view.text()).toBe("fallback");

    release();
    await settle(view.text, /^list:Ada$/);

    expect(counts(seen)).toEqual({ renders: 4, suspensions: 2, promises: 1 });
  });

  it("f(suspended, unmount) → f(release) → the source is no longer observed; nothing rejects", async () => {
    const server = await open();
    const unhandled = rejections();

    await seed(server, ada);

    const release = hold(server);
    const db = account(server, "acc-1", cleanup);
    const seen = probe();

    const view = await render(
      <Provider client={db}>
        <Suspense fallback={<p>fallback</p>}>
          <List seen={seen} />
        </Suspense>
      </Provider>,
    );

    expect(view.text()).toBe("fallback");

    await view.unmount();

    const source = db.collection(notes.list({ account: "acc-1" }));

    // The pending read still observes the load it waits for.
    expect(source.subscriberCount).toBe(1);

    release();
    await act(async () => tick(50));

    // Loaded: the promise resolved, and its observer lingers for a retry that never comes.
    expect(source.status).toBe("ready");
    expect(source.subscriberCount).toBe(1);
    expect(counts(seen)).toEqual({ renders: 2, suspensions: 2, promises: 1 });

    // After TanStack DB's suspense gcTime (5 s) nothing observes the source.
    for (let waited = 0; waited < 7_000 && source.subscriberCount > 0; waited += 100)
      await tick(100);

    expect(source.subscriberCount).toBe(0);

    expect(unhandled).toEqual([]);
  }, 10_000);

  it("f(a Loading that is no live query's, Suspend) → a clear error, not a promise", () => {
    const tagged: { readonly _tag: "Loading" } = { _tag: "Loading" };

    expect(() => LowAlch.match(tagged).on({ Loading: LowAlch.Suspend })).toThrow(
      "LowAlch.Suspend handles only the Loading state of match(res) over a stock useLiveQuery result",
    );
  });
});
