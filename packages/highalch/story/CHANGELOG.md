# @highalch/story

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
