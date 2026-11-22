# @highalch/tanstack-db

## 0.0.7

### Patch Changes

- 2984313: Screens and machines reach the data layer through `Data`, an interface of `@highalch/story` (`connect`, `mount`, `run`, `runs`) a host provides through its `adapters`, instead of importing `@highalch/tanstack-db`. `Db.data` is TanStack DB's (`Story.local({ adapters: [Db.data] })`), and `Alchemy.memory` includes it. Without one, a screen mounts its element as is and a running machine fails naming its step. A host's adapters may now read the story's stage. **Breaking:** a machine step's `(read) => …` takes a reader, as a rule yields it: `read(Db.rows(source))` instead of `read(source)`.
- 9490c37: A read can follow a served view or stream: `LowAlch.read(Query).follows(View, (input) => key)` asks the query again whenever that view changes at the key, so a subset can hold rows its entity's feed cannot place (shared with the reader, visible to a group) while the query's handler stays the one place that decides who may read. The story kit waits for a followed read to connect and to catch up (a wire counts a served `watch` until its first value), and a step now settles the world the first time it reads a source a rule's reader had opened.
- 2e88285: Each integration is its own package, and the story runner no longer knows alchemy. `@highalch/story` is the runner, world and rules, depending on effect only; its host interface has no Domain types (`Story.local()` hosts nothing, for clients that sync nothing). `Db` moves to `@highalch/tanstack-db`, `Machine` to `@highalch/xstate`, `Screen` to `@highalch/screen`, `Takumi` to `@highalch/takumi`, and `Form` with the `highalch()` Vite plugin to `@highalch/tanstack-form` (`./vite`). `@highalch/alchemy-domain` holds what knows alchemy: `Alchemy.memory` (the Domain in memory with LowAlch clients, formerly `LowAlchDb.memory`), `Alchemy.given`, `Alchemy.remote(ref, command)`, `Alchemy.from` (formerly `Story.alchemy`), and LowAlch's `reload`, feed entries, feed rules and view helpers. **Breaking:** the `@highalch/story/*` entries are gone; `Story.given`, `Story.memory`, `Story.alchemy` and `LowAlchDb` move to `Alchemy`; `Story.remote` keeps only its `(label, (api) => …)` form.
- 3f90ad8: Offline in stories. The new `@highalch/tanstack-offline` (`Offline`) gives a story the stored queue, tabs and network of apps on TanStack DB's offline transactions: `Offline.memory()` in the story's `adapters`, `Offline.down()` and `Offline.up()`, the readers `Offline.queued()` and `Offline.online()`, and `Offline.rules`. `@highalch/story` takes `adapters` in a story's options, added to its host's. `Db.restart()` closes the scope's client as a reloading tab does; the next step opens a new one. `@highalch/alchemy-domain` makes its LowAlch clients with a durable queue on the story's devices when `Offline.memory()` is provided.
- Updated dependencies [2984313]
- Updated dependencies [64b1e69]
- Updated dependencies [d717c4e]
- Updated dependencies [52b54c1]
- Updated dependencies [9490c37]
- Updated dependencies [2e88285]
- Updated dependencies [6fd88c3]
- Updated dependencies [be0fdd5]
- Updated dependencies [621faf5]
- Updated dependencies [912e879]
- Updated dependencies [3f90ad8]
  - @highalch/story@0.0.7
