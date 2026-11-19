# HighAlch

HighAlch syncs an [alchemy Domain](https://alchemy.run/domain) into TanStack DB 1.0 collections.
Typed errors come from the Domain definitions. Reads use stock `useLiveQuery`, writes are native
TanStack DB transactions, and `match` renders each state. A story kit tests what a client shows
and how its commands settle. It can also screenshot a mounted component after every step without
a browser.

| Package                                       | What                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@highalch/db`](packages/db/README.md)       | Feeds, rows and projections on the server; collections, queries, commands and `match` in the client; `./react` (`Provider`), `./xstate` (`invoke`), `./server` and the unstable `./internal` |
| [`@highalch/story`](packages/story/README.md) | Stories: the runner, data steps, invariants and view helpers; `./xstate` (machine steps, `explore`) and `./screen` (takumi screenshots)                                                      |

Both packages are ESM-only and built on Effect v4 (`effect` 4.1.4), `@alchemy.run/domain`
2.0.0-beta.87 and `@tanstack/db` 1.0.0-rc.1.5. XState, react-dom, happy-dom and takumi are
optional peers, needed only by the entries that use them.

## End to end

The example below follows a note list from the server to a screen story.

### Server: a feed, an entity and the feed's projection

```ts
import * as HighAlch from "@highalch/db/server"; // alchemy Domain and Effect only

export class NotebookChanges extends HighAlch.Feed("NotebookChanges", { scope: Schema.String }) {}

export class NoteRows extends HighAlch.Rows("NoteRows", {
  feed: NotebookChanges,
  row: Note,
  key: "NoteId",
  from: [NoteAggregate],
  scope: ({ event }) =>
    Predicate.isTagged(event, "NoteDeleted") ? event.account : event.note.account,
  target: (key, scope) => JSON.stringify([scope, key]), // the aggregate a row's commands address
  on: {
    NoteCreated: (event) => HighAlch.upserted(event.note),
    NoteChanged: (event) => HighAlch.upserted(event.note),
    NoteDeleted: (event) => HighAlch.removed(event.NoteId),
  },
}) {}

export class NotebookWriter extends HighAlch.Projection("NotebookChanges", {
  feed: NotebookChanges,
  entities: [NoteRows],
}) {}
// List `NotebookChanges` in the model's `streams`, `NotebookWriter` in its `projections`, and
// serve the stream in the Api like any stream.
```

### Client: a collection, a provider, a read and a command

```tsx
import * as HighAlch from "@highalch/db";
import { Provider } from "@highalch/db/react";
import { useLiveQuery } from "@tanstack/react-db";

export const notes = HighAlch.collection(NoteRows, {
  queries: { list: Notes },
  commands: { rename: HighAlch.updates(RenameNote) },
});

const db = HighAlch.make({
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

  return HighAlch.match(res).on({
    [HighAlch.anyOf("Loading", "Retrying")]: () => <p>Loading notes…</p>,
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

### A story with a screen

```tsx
import * as Story from "@highalch/story";
import * as Screen from "@highalch/story/screen";

const story = Story.make(Story.memory({ api: NotesApi, layer: handlers, services: stores }), {
  scope: "acc-1",
});

const screen = Screen.make({
  css,
  width: 360,
  height: 200,
  baselines: new URL("./baselines/", import.meta.url),
  output: new URL("../artifacts/stories/", import.meta.url),
  update: process.env.UPDATE_SCREENS === "1",
});

it("renames optimistically, then settles through the feed", () =>
  story.with({ name: "rename settles", invariants: Story.invariants })(
    Story.given(NoteAggregate.ref(id), new NoteCreated({ note: ada })),
    screen.render(<NoteList account="acc-1" />), // a frame after this step and every later one
    Story.when(notes.rename, { NoteId: "n1", title: "Ada Lovelace" }),
    Story.shows(notes.list({ account: "acc-1" }), [
      { title: "Ada Lovelace", $hasPendingWrites: true },
    ]),
    Story.settled("Committed"),
  ));
```

Complete, running versions of these snippets are in `fixtures/` (a Notebook and a Ledger Domain)
and in the packages' `tests/`.

## Repository

A Vite+ (`vp`) pnpm workspace:

```
packages/db       @highalch/db
packages/story    @highalch/story
fixtures/         example Domains and views shared by both packages' tests (not published)
scripts/          check-patterns.ts: the packages' import boundaries
```

| Command                  | What                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `vp install`             | Install                                                                   |
| `vp run build`           | `vp pack` each package to `dist` (ESM, `.mjs` and `.d.mts`)               |
| `vp run typecheck`       | `tsc` over both packages (sources and tests) and the fixtures and scripts |
| `vp run check:patterns`  | Import boundaries: XState, screen and story confinement, no React effects |
| `vp check`               | Format, lint and type-aware lint                                          |
| `vp test --maxWorkers=2` | All tests, run from source (no build needed)                              |

Tests and type checks resolve `@highalch/*` to the packages' `src`: the aliases are in
`vite.config.ts` and the matching `paths` are in `tsconfig.base.json`. Published packages resolve
through their `exports`, which point at `dist`. `@highalch/story` builds against `@highalch/db`'s
`dist`, so `vp run build` builds `db` first.

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets). `@highalch/db` and
`@highalch/story` always share a version.

1. With a change that should reach npm, run `vp run changeset`, choose the bump and write one
   line for the changelog. Commit the file it adds under `.changeset/`.
2. Merging to `main` opens or updates a "Version Packages" pull request with the new versions and
   changelogs.
3. Merging that pull request packs the new versions and stops: the `publish` job waits in the
   `npm` environment until its reviewer approves it in the Actions tab. Approval publishes both
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
