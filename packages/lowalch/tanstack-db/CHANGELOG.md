# @highalch/tanstack-db

Versions up to 0.0.5 were named `@highalch/db`.

## 0.0.7

### Patch Changes

- 64b1e69: Explorations are deterministic tests, with discovery as an explicit option. `Explore.run` replays a committed corpus first, then every sequence up to `depth` (checked) and fixed-seed walks (`sample`, renamed from `walks`); `discover` adds walks from a fresh seed and keeps what they find in the corpus. A failure is confirmed on two replays (else `ExploreFlaky`), a run that checked less than it says throws `ExploreIncomplete` unless `allow` names it, the real clock is refused, and the run returns its coverage and a report. Sampled form values are seeded by name.
- 9490c37: A read can follow a served view or stream: `LowAlch.read(Query).follows(View, (input) => key)` asks the query again whenever that view changes at the key, so a subset can hold rows its entity's feed cannot place (shared with the reader, visible to a group) while the query's handler stays the one place that decides who may read. The story kit waits for a followed read to connect and to catch up (a wire counts a served `watch` until its first value), and a step now settles the world the first time it reads a source a rule's reader had opened.
- 0708bfd: Durable offline command calls: `LowAlch.make({ ..., offline: offline() })` with `offline` from the new `@lowalch/tanstack-db/offline` entry, built on TanStack DB's `@tanstack/offline-transactions` 1.2.0 (an optional peer). A call is stored as data (declaration, target, encoded input, `commandId`) before it is sent, sent in order by the leader tab, retried while the transport fails and replayed with the same `commandId` after a reload, where its optimistic edit shows again on the subsets that load. A typed rejection is permanent and reaches `when("settled")` as the original instance. The entry also exports three collections of the client for stock `useLiveQuery`: `calls` (the queue), `status` (`online`, `queued`, `leader`, `durable`) and `rejected` (calls rejected while replayed after a reload). Without the option nothing changes.
- 2e88285: Each integration is its own package, and the story runner no longer knows alchemy. `@highalch/story` is the runner, world and rules, depending on effect only; its host interface has no Domain types (`Story.local()` hosts nothing, for clients that sync nothing). `Db` moves to `@highalch/tanstack-db`, `Machine` to `@highalch/xstate`, `Screen` to `@highalch/screen`, `Takumi` to `@highalch/takumi`, and `Form` with the `highalch()` Vite plugin to `@highalch/tanstack-form` (`./vite`). `@highalch/alchemy-domain` holds what knows alchemy: `Alchemy.memory` (the Domain in memory with LowAlch clients, formerly `LowAlchDb.memory`), `Alchemy.given`, `Alchemy.remote(ref, command)`, `Alchemy.from` (formerly `Story.alchemy`), and LowAlch's `reload`, feed entries, feed rules and view helpers. **Breaking:** the `@highalch/story/*` entries are gone; `Story.given`, `Story.memory`, `Story.alchemy` and `LowAlchDb` move to `Alchemy`; `Story.remote` keeps only its `(label, (api) => …)` form.
- 9479398: A command can be decided on the client before it is sent. Give the `Rows` entity `state: (row) => aggregateState` and the client `context` (`LowAlch.make({ ..., context })`, what the commands' middleware provides), and each call runs the aggregate's own `decide` through alchemy's `Aggregate.predict`: a rejection refuses the call at once with the Domain's typed rejection (no optimistic edit, nothing sent), and accepted events give the optimistic rows through the entity's own `on`. Without `state` nothing changes. `Writer`, `WriterInput` and `WriterPayload` are now exported from the root and `./server`, so a package that publishes declarations can export a `Rows` entity with its inferred type.
- be0fdd5: Screens take their engines as pipe steps, and can be laid out for rules. Breaking: `Screen.make({ css, width, height })` mounts and checks a component only; `.pipe(Takumi.frames({ baselines, output, update }))` gives it frames (replacing the `painter`, `baselines`, `output` and `update` options and `Takumi.layer()`), and `.pipe(Takumi.layout())` gives it a layout engine (the `LayoutOf` service, beside `PainterOf`). A screen has only the steps and readers its engines give: `shot` and `render(element, { every })` with frames, `Card.layout()` with a layout engine. `Card.layout()` is a rule reader of every element's box, and `Screen.overflowing(layout)` lists what spills out of its box, named by element (`section.card > h1.title: text "WWWW…" runs 788px past its right edge`), honouring `overflow` from the computed style. `Form.typing` now tries a string field's longest accepted value (`Schema.isMaxLength(n)`) before its seeded samples, so an exploration reaches a field's declared edge.
- 621faf5: Stories get one namespace per adapter and a runner that knows none of them. `@highalch/story` keeps the runner and the Domain's steps (`given`, `remote`, transport faults, time). Data steps move to `Db` (`@highalch/tanstack-db`), with `Db.then` replacing `shows` and `state`, and work on plain TanStack DB clients; `Alchemy` (`@highalch/alchemy-domain`) makes them LowAlch clients (`Alchemy.memory(...)`) and adds `reload(Rows)`, feed entries, the feed invariants and the view helpers. Adapters are Effect Layers built once per story run (`stage.use`). Screens take a painter Layer (`Takumi.layer()` from `@highalch/takumi`) and keep baselines per painter; the screen helpers are a `Screen` object.
- 912e879: Rules, explorations and forms. `Story.rule("a sentence", function* ({ step }) { … }, { at })` replaces invariants (`story.with({ rules })`, `Db.rules`, `Alchemy.rules`), checked after every step, at rest or at the end. A rule yields what it reads, when it gets there (`yield* Db.rows(list)`, `Db.commands`, `Machine.snapshot`, `Form.state`, `Form.all`; `yield* Story.before(reader)` for its value at the previous check), and a failure lists each read by name. `Explore.run` (`@highalch/explore`) tries every sequence of up to `depth` moves of its sources (then seeded walks), captures nothing while exploring, and on a failure shrinks the sequence and replays it once with a trace and frames, as a story to paste. `story.with({ trace: true })` keeps a reviewed text snapshot of a story. `@highalch/tanstack-form` (`Form`) types into and submits the app's own `formOptions` forms, found through the `highalch()` Vite plugin (`@highalch/tanstack-form/vite`) with no wiring in the app, and `Form.typing` makes typing an exploration's source. Commands the app sends itself are recorded like a story's own.
- d912805: `Committed` now means the loaded subsets hold the change. A command that no feed can confirm (a client with `live: false`, or a feed that failed for good) settles `Unconfirmed` at the server's reply and reloads the entity's loaded subsets itself, instead of settling `Committed` with stale rows. With no subset of the entity loaded it still settles `Committed`. **Changed behaviour:** `onCommitted`, `effect` and `result` of such a command receive `Unconfirmed` where they received `Committed`.

## 0.0.6

### Patch Changes

- c4c693e: `command.result(input)` is a promise again: await it for `Committed | Unconfirmed | E` where there is no Effect, such as a React transition or a form's submit. It never rejects for a typed error; a defect rejects, as does a call on a closing or closed client. Breaking: it is no longer an Effect, so drop the `Effect.runPromise` around it; Effect code uses `command.effect(input)`, with the typed error in the error channel.
- 0fafb1b: A `.where` or `.one` rule may read only what the entity's rows have. The feed gives a rule the entity's own rows, so a rule over rows that `.rows(...)` widened with extra fields compiled and then read `undefined`; it is now a type error on that declaration. A query whose answer is an array or `null` is accepted as a bare query.
- c683be6: Move the core to the LowAlch scope: `@highalch/db` is now `@lowalch/tanstack-db` (with the same `/server`, `/react`, `/xstate` and `/internal` entries), and its namespace and error messages say `LowAlch` instead of `HighAlch`. `@highalch/story` keeps its name. The API is otherwise unchanged.

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

- c5fd50a: Fix client shutdown so unanswered commands roll back at the deadline even if the endpoint
  keeps running, paced transactions roll back immediately, and new reads on a closing client
  fail with a `HighAlch.Defect`. A subscriber that throws during a rollback no longer stops the shutdown. Await the last feed's finalizer on subset cleanup. Run all
  endpoints in the configured runtime context and honor explicit reloads on non-live clients.

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

## 0.0.3

### Patch Changes

- 960b8fd: Stories reach the machine a mounted component reads through atoms: `Machine.mounted(atoms)` enters the actor of `createActorAtoms` as a running machine, `Screen.render` mounts under the story's atom registry, and the commands of machines there run on the story's client, recorded. `Screen.check(label, (container) => …)` asserts on the mounted DOM. Breaking: the XState peers are now `xstate` 6.0.0-beta.3 and `@xstate/effect` 1.0.0-beta.2, where an invoked command's `onError` receives an `EffectFailure`; read the typed rejection with the new `rejection(event.error)` from `@highalch/db/xstate`. `@highalch/story/screen` needs the new optional peer `@effect/atom-react`.

## 0.0.2

### Patch Changes

- 9831869: Paced updates send the row key and only the fields the merged calls changed, and a result whose field is an open record keeps its typed errors in `match`.
- 49d16de: Add `HighAlch.Suspend`, a `match` `Loading` handler that suspends a stock `useLiveQuery` read to the nearest `<Suspense>` while typed errors stay branches.

## 0.0.1

### Patch Changes

- First release published from CI: MIT licence, public access, and peer ranges for effect, React, happy-dom and takumi.
