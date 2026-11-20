# @highalch/tanstack-db

Versions up to 0.0.5 were named `@highalch/db`.

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
