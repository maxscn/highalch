# @highalch/story

## 0.0.7

### Patch Changes

- 2984313: Screens and machines reach the data layer through `Data`, an interface of `@highalch/story` (`connect`, `mount`, `run`, `runs`) a host provides through its `adapters`, instead of importing `@highalch/tanstack-db`. `Db.data` is TanStack DB's (`Story.local({ adapters: [Db.data] })`), and `Alchemy.memory` includes it. Without one, a screen mounts its element as is and a running machine fails naming its step. A host's adapters may now read the story's stage. **Breaking:** a machine step's `(read) => …` takes a reader, as a rule yields it: `read(Db.rows(source))` instead of `read(source)`.
- 64b1e69: Explorations are deterministic tests, with discovery as an explicit option. `Explore.run` replays a committed corpus first, then every sequence up to `depth` (checked) and fixed-seed walks (`sample`, renamed from `walks`); `discover` adds walks from a fresh seed and keeps what they find in the corpus. A failure is confirmed on two replays (else `ExploreFlaky`), a run that checked less than it says throws `ExploreIncomplete` unless `allow` names it, the real clock is refused, and the run returns its coverage and a report. Sampled form values are seeded by name.
- d717c4e: Explorations make stories. `Explore.stories(runner, { setup, sources, depth, … })` makes a story of every sequence of what can happen, on a named runner with its rules (`story.with({ name, rules })`); each is callable on its own and has a `name` from its moves, its `code` and a `prompt()` for a coding agent. `Explore.run(stories, { artifacts, shard, stream, allow })` runs them. An `ExploreFailure` carries the shortest failing story (`story`, runnable), its `code` and a `prompt` that asks a coding agent to pin it as a test and fix the app, also written beside the replay's trace and streamed. A source may `label` its values for stories' names (`Form.typing`: `title "Ada 2"`). **Breaking:** `Explore.run(exploration)` takes the stories `Explore.stories` made; `rules` come from the runner.
- 52b54c1: Explorations shard and stream. `shard: { index, total }` (or `HIGHALCH_SHARD=2/4`) runs every `total`-th sequence, numbered the same in every shard, so CI jobs split one exploration. With `HIGHALCH_STREAM_URL`, each exploration streams its attempts, steps, frames and outcome to an app, authenticated by a project's ingest token (exchanged for a session token) or GitHub OIDC; every shard streams to the same run. `@highalch/stream` holds the protocol's schemas for the receiving app and the client that sends it.
- 9490c37: A read can follow a served view or stream: `LowAlch.read(Query).follows(View, (input) => key)` asks the query again whenever that view changes at the key, so a subset can hold rows its entity's feed cannot place (shared with the reader, visible to a group) while the query's handler stays the one place that decides who may read. The story kit waits for a followed read to connect and to catch up (a wire counts a served `watch` until its first value), and a step now settles the world the first time it reads a source a rule's reader had opened.
- 2e88285: Each integration is its own package, and the story runner no longer knows alchemy. `@highalch/story` is the runner, world and rules, depending on effect only; its host interface has no Domain types (`Story.local()` hosts nothing, for clients that sync nothing). `Db` moves to `@highalch/tanstack-db`, `Machine` to `@highalch/xstate`, `Screen` to `@highalch/screen`, `Takumi` to `@highalch/takumi`, and `Form` with the `highalch()` Vite plugin to `@highalch/tanstack-form` (`./vite`). `@highalch/alchemy-domain` holds what knows alchemy: `Alchemy.memory` (the Domain in memory with LowAlch clients, formerly `LowAlchDb.memory`), `Alchemy.given`, `Alchemy.remote(ref, command)`, `Alchemy.from` (formerly `Story.alchemy`), and LowAlch's `reload`, feed entries, feed rules and view helpers. **Breaking:** the `@highalch/story/*` entries are gone; `Story.given`, `Story.memory`, `Story.alchemy` and `LowAlchDb` move to `Alchemy`; `Story.remote` keeps only its `(label, (api) => …)` form.
- 6fd88c3: Explorations and the stream leave the story kit. `@highalch/explore` holds `Explore.run`, `Explore.source`, shards and the failures (`ExploreFailure`, `ExploreFlaky`, `ExploreIncomplete`), and `./xstate` the model-based `explore`; `@highalch/stream` holds the protocol and its client and imports only effect. Rules stay with stories: `Explore.rule` and `Explore.before` are now `Story.rule` and `Story.before`, and a source's type is `Story.Source`. **Breaking:** import `Explore` from `@highalch/explore`, `explore` from `@highalch/explore/xstate`, and the stream from `@highalch/stream`.
- be0fdd5: Screens take their engines as pipe steps, and can be laid out for rules. Breaking: `Screen.make({ css, width, height })` mounts and checks a component only; `.pipe(Takumi.frames({ baselines, output, update }))` gives it frames (replacing the `painter`, `baselines`, `output` and `update` options and `Takumi.layer()`), and `.pipe(Takumi.layout())` gives it a layout engine (the `LayoutOf` service, beside `PainterOf`). A screen has only the steps and readers its engines give: `shot` and `render(element, { every })` with frames, `Card.layout()` with a layout engine. `Card.layout()` is a rule reader of every element's box, and `Screen.overflowing(layout)` lists what spills out of its box, named by element (`section.card > h1.title: text "WWWW…" runs 788px past its right edge`), honouring `overflow` from the computed style. `Form.typing` now tries a string field's longest accepted value (`Schema.isMaxLength(n)`) before its seeded samples, so an exploration reaches a field's declared edge.
- 621faf5: Stories get one namespace per adapter and a runner that knows none of them. `@highalch/story` keeps the runner and the Domain's steps (`given`, `remote`, transport faults, time). Data steps move to `Db` (`@highalch/tanstack-db`), with `Db.then` replacing `shows` and `state`, and work on plain TanStack DB clients; `Alchemy` (`@highalch/alchemy-domain`) makes them LowAlch clients (`Alchemy.memory(...)`) and adds `reload(Rows)`, feed entries, the feed invariants and the view helpers. Adapters are Effect Layers built once per story run (`stage.use`). Screens take a painter Layer (`Takumi.layer()` from `@highalch/takumi`) and keep baselines per painter; the screen helpers are a `Screen` object.
- 912e879: Rules, explorations and forms. `Story.rule("a sentence", function* ({ step }) { … }, { at })` replaces invariants (`story.with({ rules })`, `Db.rules`, `Alchemy.rules`), checked after every step, at rest or at the end. A rule yields what it reads, when it gets there (`yield* Db.rows(list)`, `Db.commands`, `Machine.snapshot`, `Form.state`, `Form.all`; `yield* Story.before(reader)` for its value at the previous check), and a failure lists each read by name. `Explore.run` (`@highalch/explore`) tries every sequence of up to `depth` moves of its sources (then seeded walks), captures nothing while exploring, and on a failure shrinks the sequence and replays it once with a trace and frames, as a story to paste. `story.with({ trace: true })` keeps a reviewed text snapshot of a story. `@highalch/tanstack-form` (`Form`) types into and submits the app's own `formOptions` forms, found through the `highalch()` Vite plugin (`@highalch/tanstack-form/vite`) with no wiring in the app, and `Form.typing` makes typing an exploration's source. Commands the app sends itself are recorded like a story's own.
- 3f90ad8: Offline in stories. The new `@highalch/tanstack-offline` (`Offline`) gives a story the stored queue, tabs and network of apps on TanStack DB's offline transactions: `Offline.memory()` in the story's `adapters`, `Offline.down()` and `Offline.up()`, the readers `Offline.queued()` and `Offline.online()`, and `Offline.rules`. `@highalch/story` takes `adapters` in a story's options, added to its host's. `Db.restart()` closes the scope's client as a reloading tab does; the next step opens a new one. `@highalch/alchemy-domain` makes its LowAlch clients with a durable queue on the story's devices when `Offline.memory()` is provided.

## 0.0.6

### Patch Changes

- c4c693e: `command.result(input)` is a promise again: await it for `Committed | Unconfirmed | E` where there is no Effect, such as a React transition or a form's submit. It never rejects for a typed error; a defect rejects, as does a call on a closing or closed client. Breaking: it is no longer an Effect, so drop the `Effect.runPromise` around it; Effect code uses `command.effect(input)`, with the typed error in the error channel.
- 0fafb1b: A `.where` or `.one` rule may read only what the entity's rows have. The feed gives a rule the entity's own rows, so a rule over rows that `.rows(...)` widened with extra fields compiled and then read `undefined`; it is now a type error on that declaration. A query whose answer is an array or `null` is accepted as a bare query.
- c683be6: Move the core to the LowAlch scope: `@highalch/db` is now `@lowalch/tanstack-db` (with the same `/server`, `/react`, `/xstate` and `/internal` entries), and its namespace and error messages say `LowAlch` instead of `HighAlch`. `@highalch/story` keeps its name. The API is otherwise unchanged.
- Updated dependencies [c4c693e]
- Updated dependencies [0fafb1b]
- Updated dependencies [c683be6]
  - @lowalch/tanstack-db@0.0.6

## 0.0.5

### Patch Changes

- 4f06048: Declare entity reads with the typed `read(Query)` builder. A bare Domain query remains valid.

  Breaking: Replace the standalone declaration helpers with these chains:

  - `all(Q)` → `read(Q).all()`
  - `where(Q, rule)` → `read(Q).where(rule)`
  - `one(Q, rule)` → `read(Q).one(rule)`
  - `entries(Q, select)` → `read(Q).rows(select)`
  - `where(entries(Q, select), rule)` → `read(Q).rows(select).where(rule)`

  The exported `Membership` and `Entries` classes are removed. Use the builder to create
  declarations and `QuerySpec` to type a declaration value.

- Updated dependencies [4f06048]
- Updated dependencies [c5fd50a]
  - @highalch/db@0.0.5

## 0.0.4

### Patch Changes

- 46a873d: Let bare and `entries` queries decide subset membership and re-ask after a burst of feed changes.
  Use `all(Query)` for a whole list that follows the feed directly. Use `where(entries(Query, select), rule)`
  in place of `entries(Query, select, rule)`. Give each query one declaration per entity and use a
  bare query or `entries` for a cursor page. Conflicting declarations and `all` on a paged query
  now fail at declaration. The exported `Entries` class no longer takes or holds a rule.

  Subset loads, feed reconnects and command settlement run on Effect. Replace retry callbacks
  with Effect schedules filtered by typed errors. Replace custom timers with an Effect `Clock`.
  Run `HighAlch.close(db)` and `command.result(input)` as Effects. `HighAlch.layer(config)` provides
  a scoped client under `HighAlch.Client`, and `HighAlch.make(config)` still returns the client
  synchronously. The story kit's `retryTransport` is now a schedule.

  Closing a client rejects new commands immediately. Commands with a server reply settle as usual.
  If a reply is still outstanding after `settleTimeout` from the start of close, HighAlch interrupts
  the call and rolls back the transaction with a HighAlch error.

- Updated dependencies [46a873d]
  - @highalch/db@0.0.4

## 0.0.3

### Patch Changes

- 960b8fd: Stories reach the machine a mounted component reads through atoms: `Machine.mounted(atoms)` enters the actor of `createActorAtoms` as a running machine, `Screen.render` mounts under the story's atom registry, and the commands of machines there run on the story's client, recorded. `Screen.check(label, (container) => …)` asserts on the mounted DOM. Breaking: the XState peers are now `xstate` 6.0.0-beta.3 and `@xstate/effect` 1.0.0-beta.2, where an invoked command's `onError` receives an `EffectFailure`; read the typed rejection with the new `rejection(event.error)` from `@highalch/db/xstate`. `@highalch/story/screen` needs the new optional peer `@effect/atom-react`.
- Updated dependencies [960b8fd]
  - @highalch/db@0.0.3

## 0.0.2

### Patch Changes

- 49d16de: Add `HighAlch.Suspend`, a `match` `Loading` handler that suspends a stock `useLiveQuery` read to the nearest `<Suspense>` while typed errors stay branches.
- Updated dependencies [9831869]
- Updated dependencies [49d16de]
  - @highalch/db@0.0.2

## 0.0.1

### Patch Changes

- First release published from CI: MIT licence, public access, and peer ranges for effect, React, happy-dom and takumi.
- Updated dependencies
  - @highalch/db@0.0.1
