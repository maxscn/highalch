# HighAlch

This repository holds two npm scopes:

- **LowAlch** (`@lowalch/*`) converts [alchemy Domain](https://alchemy.run/domain) primitives
  for other infrastructure. `@lowalch/tanstack-db` syncs a Domain into TanStack DB 1.0
  collections. Typed errors come from the Domain definitions. Reads use stock `useLiveQuery`,
  writes are native TanStack DB transactions, and `match` renders each state.
- **HighAlch** (`@highalch/*`) verifies apps built on those primitives. `@highalch/story` tests
  what a client shows and how its commands settle. It can also screenshot a mounted component
  after every step without a browser.

| Package                                                                  | What                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@lowalch/tanstack-db`](packages/lowalch/tanstack-db/README.md)         | Feeds, rows and projections on the server; collections, queries, commands and `match` in the client; `./react` (`Provider`), `./xstate` (`invoke`), `./server` and the unstable `./internal` |
| [`@highalch/story`](packages/highalch/story/README.md)                   | The story runner, the world (transport faults, held replies, time), rules; the guide to stories                                                                                              |
| [`@highalch/tanstack-db`](packages/highalch/tanstack-db/README.md)       | `Db`: what a client's sources show and how its commands settle, on plain TanStack DB                                                                                                         |
| [`@highalch/alchemy-domain`](packages/highalch/alchemy-domain/README.md) | `Alchemy`: an alchemy Domain hosted in memory with LowAlch clients, `given`, `remote`, the feed rules                                                                                        |
| [`@highalch/xstate`](packages/highalch/xstate/README.md)                 | `Machine`: XState machines stepped purely or running, in the same story                                                                                                                      |
| [`@highalch/screen`](packages/highalch/screen/README.md)                 | `Screen`: a mounted component, its frames vs reviewed baselines, its layout for rules                                                                                                        |
| [`@highalch/takumi`](packages/highalch/takumi/README.md)                 | `Takumi`: takumi's WASM renderer as a screen's frames and layout, without a browser                                                                                                          |
| [`@highalch/tanstack-form`](packages/highalch/tanstack-form/README.md)   | `Form`: the app's own TanStack Form forms, found by the `highalch()` Vite plugin                                                                                                             |
| [`@highalch/explore`](packages/highalch/explore/README.md)               | Explorations: every sequence of what can happen, deterministically, shrunk and replayed, sharded across processes; `./xstate` (`explore`: stories generated from a model)                    |
| [`@highalch/stream`](packages/highalch/stream/README.md)                 | The stream explorations send to an app while they run: the protocol's schemas and the client that sends it, with its auth                                                                    |
| [`@highalch/studio`](packages/highalch/studio/README.md)                 | `highalch studio`: watch explorations live at studio.highalch.dev, through a relay on your machine                                                                                           |

The packages are ESM-only and built on Effect v4 (`effect` 4.1.4), `@alchemy.run/domain`
2.0.0-beta.87 and `@tanstack/db` 1.0.0-rc.1.5. XState, react-dom, happy-dom, takumi and
`@effect/atom-react` are optional peers, needed only by the entries that use them.

## End to end

The example below follows a note list from the server to a screen story.

### Server: a feed, an entity and the feed's projection

```ts
import * as LowAlch from "@lowalch/tanstack-db/server"; // alchemy Domain and Effect only

export class NotebookChanges extends LowAlch.Feed("NotebookChanges", { scope: Schema.String }) {}

export class NoteRows extends LowAlch.Rows("NoteRows", {
  feed: NotebookChanges,
  row: Note,
  key: "NoteId",
  from: [NoteAggregate],
  scope: ({ event }) =>
    Predicate.isTagged(event, "NoteDeleted") ? event.account : event.note.account,
  target: (key, scope) => JSON.stringify([scope, key]), // the aggregate a row's commands address
  on: {
    NoteCreated: (event) => LowAlch.upserted(event.note),
    NoteChanged: (event) => LowAlch.upserted(event.note),
    NoteDeleted: (event) => LowAlch.removed(event.NoteId),
  },
}) {}

export class NotebookWriter extends LowAlch.Projection("NotebookChanges", {
  feed: NotebookChanges,
  entities: [NoteRows],
}) {}
// List `NotebookChanges` in the model's `streams`, `NotebookWriter` in its `projections`, and
// serve the stream in the Api like any stream.
```

### Client: a collection, a provider, a read and a command

```tsx
import * as LowAlch from "@lowalch/tanstack-db";
import { Provider } from "@lowalch/tanstack-db/react";
import { useLiveQuery } from "@tanstack/react-db";

export const notes = LowAlch.collection(NoteRows, {
  queries: { list: LowAlch.read(Notes).all() },
  commands: { rename: LowAlch.updates(RenameNote) },
});

const db = LowAlch.make({
  api: NotesApi,
  layer: NotesApi.layerClientWebSocket(url),
  scope: account,
});

export const App = () => (
  <Provider client={db}>
    <NoteList account={account} />
  </Provider>
);

export function NoteList({ account }: { readonly account: string }) {
  const res = useLiveQuery((q) => q.from({ note: notes.list({ account }) }));

  return LowAlch.match(res).on({
    [LowAlch.anyOf("Loading", "Retrying")]: () => <p>Loading notes…</p>,
    Ready: ({ data }) => (
      <ul>
        {data.map((note) => (
          <li key={note.NoteId}>{note.title}</li>
        ))}
      </ul>
    ),
    orElse: (error, { retry }) => <button onClick={retry}>Retry after {error._tag}</button>,
  });
}

// A command takes its input only and returns TanStack DB's transaction. It settles when the
// feed delivers its change.
await notes.rename({ NoteId: "n1", title: "Ada Lovelace" }).when("settled");
```

Effect applications can use `LowAlch.layer(config)` to provide the client as
`LowAlch.Client` and close it with the scope. For a client created with `LowAlch.make`,
run `yield* LowAlch.close(db)` when its owner shuts down.

### A story with a screen

```tsx
import * as Story from "@highalch/story";
import { Db } from "@highalch/tanstack-db";
import { Alchemy } from "@highalch/alchemy-domain";
import { Screen } from "@highalch/screen";
import { Takumi } from "@highalch/takumi";

const story = Story.make(Alchemy.memory({ api: NotesApi, layer: handlers, services: stores }), {
  scope: "acc-1",
});

const List = Screen.make({ css, width: 360, height: 200 }).pipe(
  Takumi.frames({
    baselines: new URL("./baselines/", import.meta.url),
    output: new URL("../artifacts/stories/", import.meta.url),
    update: process.env.UPDATE_SCREENS === "1",
  }),
);

it("renames optimistically, then settles through the feed", () =>
  story.with({ name: "rename settles", rules: Db.rules })(
    Alchemy.given(NoteAggregate.ref(id), new NoteCreated({ note: ada })),
    List.render(<NoteList account="acc-1" />), // a frame after this step and every later one
    Db.when(notes.rename, { NoteId: "n1", title: "Ada Lovelace" }),
    Db.then(notes.list({ account: "acc-1" }), [{ title: "Ada Lovelace", $hasPendingWrites: true }]),
    Db.settled("Committed"),
  ));
```

Complete, running versions of these snippets are in `fixtures/` (a Notebook and a Ledger Domain)
and in the packages' `tests/`.

## This is opinionated

LowAlch works only if a frontend is built one way. A story can show, assert and screenshot a
state only when that state lives where the story can reach it. The rules:

1. **Server state lives in collections.** Read it with stock `useLiveQuery` and render it with
   `match`. Write it with declared commands.
2. **State you want a frame of lives in an XState machine.** That is anything that changes what a
   reviewer would look at, or decides which command is sent: a draft, a step, an open dialog, the
   last error. A machine sends commands through `invoke(command)` from `@lowalch/tanstack-db/xstate`.
3. **`useState` is for what nobody reviews.** Focus, hover, scroll position, a headless library's
   popover. A story cannot seed, read or enumerate it, so it has no frame. If you want a frame of
   it, move it into the machine.
4. **A component reads its machine through atoms.** The machines are Effect-backed, so XState's
   `useMachine`, `useActor` and `useActorRef` cannot start them. Use `createActorAtoms` from
   `@xstate/effect/atom` and the hooks of `@effect/atom-react`:

   ```tsx
   const runtime = Atom.runtime(Layer.empty);

   const editing = Atom.family((NoteId: string) =>
     createActorAtoms(runtime, editor, { input: { NoteId } }),
   );

   function NoteEditor({ NoteId }: { NoteId: string }) {
     const atoms = editing(NoteId);
     const result = useAtomValue(atoms.snapshot);
     const send = useAtomSet(atoms.send);
     // render from result; call send from handlers
   }
   ```

   The actor starts when the first component reads one of its atoms and stops when the last one
   unmounts. Make the runtime with `Atom.runtime`, so a story can run its commands. Do not write
   a hook or a store of your own for this, and do not create an actor inside a component. A
   story reaches the same actor with `Machine.mounted(editing("n1"))`.

5. **Stories do not drive the DOM.** There are no click or type steps, and there will be none: a
   story sends events to machines and commands to clients, then paints what is mounted. Nothing
   checks that a button sends the event you meant, so keep handlers to one `send`.
6. **Time and randomness enter a view as data.** A view that reads the wall clock or animates
   paints frames that differ between runs.

A story then drives all of it: data steps for collections, machine steps for machines
(`Machine.mounted` for the one a mounted component reads), and a frame of the component after
each step. See [Machines in a screen](packages/highalch/story/README.md#machines-in-a-screen). One thing
is not covered yet: a frame of a state seeded without reaching it. A story has to send the events
that lead there.

## Examples

[`packages/highalch/examples`](packages/highalch/examples/README.md) shows bugs a story catches (a list that claims to be
empty while it loads, a rejected rename that stays on screen, a rejected save that says "Saved",
a form that forgets your draft), each with the broken variant next to the approved one.

## Repository

A Vite+ (`vp`) pnpm workspace:

```
packages/tanstack-db   @lowalch/tanstack-db
packages/story         @highalch/story
packages/highalch/examples      @highalch/examples (private): bugs a story catches, broken vs approved
fixtures/              example Domains and views shared by both packages' tests (not published)
scripts/               check-patterns.ts: the packages' import boundaries
```

| Command                  | What                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `vp install`             | Install                                                                   |
| `vp run build`           | `vp pack` each package to `dist` (ESM, `.mjs` and `.d.mts`)               |
| `vp run typecheck`       | `tsc` over both packages (sources and tests) and the fixtures and scripts |
| `vp run check:patterns`  | Import boundaries: XState, screen and story confinement, no React effects |
| `vp check`               | Format, lint and type-aware lint                                          |
| `vp test --maxWorkers=2` | All tests, run from source (no build needed)                              |

Tests and type checks resolve `@lowalch/*` and `@highalch/*` to the packages' `src`: the aliases are in
`vite.config.ts` and the matching `paths` are in `tsconfig.base.json`. Published packages resolve
through their `exports`, which point at `dist`. `@highalch/story` builds against `@lowalch/tanstack-db`'s
`dist`, so `vp run build` builds `db` first.

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets). `@lowalch/tanstack-db`,
and every `@highalch/*` package always share a version.

1. With a change that should reach npm, run `vp run changeset`, choose the bump and write one
   line for the changelog. Commit the file it adds under `.changeset/`.
2. Merging to `main` opens or updates a "Version Packages" pull request with the new versions and
   changelogs.
3. Merging that pull request packs the new versions and stops: the `publish` job waits in the
   `npm` environment until its reviewer approves it in the Actions tab. Approval publishes the
   packages through npm trusted publishing and tags the release.

For a prerelease line, run `vp exec changeset pre enter next` before step 1 and
`vp exec changeset pre exit` to leave it.

### Supply-chain rules

No npm token exists: only `.github/workflows/publish.yml`, in the `npm` environment, can
publish. To keep that worth something:

- The job that holds the publish credential installs nothing and checks out nothing. It receives
  tarballs from a job that has read access only. Do not give `id-token: write` to a job that
  installs dependencies.
- Actions are pinned to commit SHAs (the repository refuses unpinned ones), and no dependency
  cache is restored in this workflow.
- Never add a `pull_request_target` workflow, and never run pull request code in a job with
  write access or secrets.
- `pnpm-workspace.yaml` refuses versions younger than three days (`minimumReleaseAge`),
  install scripts of dependencies that are not allowed explicitly (`strictDepBuilds`), and
  transitive dependencies from git or tarball URLs (`blockExoticSubdeps`). If an install is
  refused, wait or pin an older version; do not relax the policy for one package without reading
  what changed in it.
- Do not publish from a laptop or keep an npm token on one.

## License

[MIT](./LICENSE)

Provenance: extracted from an application's internal Domain data package.
