# @highalch/db

Makes an [alchemy Domain](https://alchemy.run/domain) sync into TanStack DB 1.0 collections, with
typed errors taken from the Domain definitions and no plumbing at call sites. Reads are stock
TanStack DB `useLiveQuery`; writes are native TanStack DB transactions; states are rendered with
`match`. The package knows nothing about the application: the Api, its transport and the scope
(an account, say) are supplied by the app.

| Entry point             | What                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `@highalch/db`          | The whole client-side API, React-free. Import it as `HighAlch`.                         |
| `@highalch/db/server`   | `Feed`, `Rows`, `Projection`, `upserted`, `removed`: only alchemy Domain and Effect     |
| `@highalch/db/react`    | `Provider`: the scope's client for `useLiveQuery` and commands                          |
| `@highalch/db/xstate`   | `invoke(command)`, `mark`, `commandOf`, `Runner`; needs `xstate` and `@xstate/effect`   |
| `@highalch/db/internal` | Unstable seams for `@highalch/story` (clock, connection, state constructors); no semver |

```ts
import * as HighAlch from "@highalch/db";
```

Peer dependencies: `effect` 4.1.4, `@alchemy.run/domain` 2.0.0-beta.87, `@tanstack/db` and
`@tanstack/react-db` 1.0.0-rc.1.5, `react` 19.2.7; optional `xstate` 6.0.0-beta.3 and
`@xstate/effect` 1.0.0-beta.2 (only for `@highalch/db/xstate`).

## Server: one feed per scope, one entity per row type, one projection

The server side is alchemy's own primitives: a **`Domain.Stream`** per scope (for example per
account), a keyed, replayable, append-only log, written by exactly one **`Domain.Projection`**.
One feed carries the row changes of several entities.

```ts
import * as HighAlch from "@highalch/db/server";

// The feed: one stream per account. Its reads are guarded like any stream's.
export class RecordChanges extends HighAlch.Feed("RecordChanges", {
  scope: AccountKey, // a string Schema: the stream's (and its projection's) key
  middleware: [Session], // optional
  rejects: [NotMember], // optional: typed read rejections
}) {}

// A reader reads only its own scope: the feed's Layer (`validate`).
export const RecordChangesLive = RecordChanges.readers({
  scope: Effect.map(CurrentMember, (member) => member.account), // the reader's own scope
  reject: () => new NotMember(),
});

// One entity on the feed.
export class CustomerRows extends HighAlch.Rows("CustomerRows", {
  feed: RecordChanges,
  row: Customer, // the row schema
  key: "CustomerId", // its key field (a string)
  from: [CustomerRecord], // aggregates or views
  scope: ({ event }) => event.account, // the feed (scope) an event belongs to
  target: (key, scope) => JSON.stringify([scope, key]), // optional: the aggregate a row's commands address
  on: {
    CustomerCreated: (event) => HighAlch.upserted(event.customer),
    CustomerChanged: (event) => HighAlch.upserted(event.customer),
    CustomerDeleted: (event) => HighAlch.removed(event.CustomerId),
  },
}) {}

// The feed's one writer, built from its entities: adding an entity is one line here.
export class RecordChangesWriter extends HighAlch.Projection("RecordChanges", {
  feed: RecordChanges,
  entities: [CustomerRows, MessageRows],
}) {}

// The model lists the stream and the projection; its layer gets their Layers.
class App extends Domain.Model("App", {
  // …
  projections: [RecordChangesWriter],
  streams: [RecordChanges],
}) {}

App.layer(Layer.mergeAll(handlers, RecordChangesWriter.layer, RecordChangesLive));
```

- The feed's entries are `<feed>.Upserted { entity, row, cause? }` and
  `<feed>.Removed { entity, key, cause? }`. `entity` names the entity; `row` is the whole row as
  its row schema encodes it (the browser decodes it with the same schema, so rows stay typed per
  entity); `cause` is the command whose change the entry delivers, when the entity names one.
- `on` is keyed by event tag (or source name) and answers `upserted(row)`, `removed(key)`, an
  array of them, or nothing. The feed keeps no row, so **the event (or a source view's state,
  passed as the handler's second argument) must carry the whole row after it**: events carry the
  outcome.
- `scope(input)` returns the feed (the stream key) the event belongs to, or `undefined` to leave
  it out of every feed. Events without an `on` handler are routed nowhere.
- `target(key, scope)` gives the alchemy target (the aggregate instance) of a command that
  addresses the row with that key, in the client's scope. It is declared here because this is
  where the aggregate is known (for example, aggregates keyed by `[scope, key]` as JSON,
  which alchemy's types cannot reveal). Without it the target is the row key itself. Its return
  type is checked against every command of the entity's collection that uses it.
- `cause(event)` names the command whose change an event delivers when that is not the command
  that recorded it, for example a policy that settles a command's write after it persisted, under
  its own command id. The entry carries it (`cause`), and the browser settles that command with
  it. An entity that declares `cause` makes its commands settle only on delivery (or as
  `Unconfirmed` after `settleTimeout`), not when the feed passes the command's own receipt, since
  the change arrives later.
- `Projection` consumes every event an entity maps and routes it to that entity's scope (one
  named route per entity and source), then appends the entity's entries. Its `options` are the
  projection's (`batch`, `version`). Every entity of the projection must be on its feed (a type
  error otherwise). A feed has exactly one writer: list one `Projection` per feed.
- Serve the stream in the Api like any stream (`streams: ["RecordChanges"]`). A model's server
  code imports these from `@highalch/db/server`, which bundles no TanStack DB.

**Delivery.** Like every projection, it runs at least once per input, in order per scope; alchemy
drops a repeated append for the same input. Entries are whole rows (or removed keys), so a
redelivered entry is harmless, and the browser also drops any entry at or before the last `seq`
it applied.

**Hosting cost.** On Cloudflare a feed is **three Durable Object classes, however many entities
it carries**: `<feed>Stream` (the stream), and `<projection>Projection` and
`<projection>ProjectionRun` (the projection's keys and its backfill run). Projections cannot be
`lazy`.

**Backfill.** Every projection replays history: **added to a deployment that already has
history, it first receives every earlier event of its sources** (alchemy's backfill; for a feed
keyed by a scope rather than by its source aggregate, two passes with a global barrier). There is
no "start from now" option. On Cloudflare the deploy that adds it waits for that backfill (see
`DomainCloudflare.layerDurableObjects({ backfillTimeout })`, 30 minutes by default); where no
deploy-time backfill ran, the first Domain call in each isolate starts it. While it runs, live
changes of the feed are routed through the backfill, so the feed reaches the present only once it
completes. Bumping the projection's `version` (or changing the sources it reads) replays it again.

## Declaring (module level)

Declarations are module-level values. They are self-describing: their types come from the
Domain definitions, not from an Api object.

```ts
export const customers = HighAlch.collection(CustomerRows, {
  queries: {
    list: HighAlch.all(Customers),
    page: CustomersByName,
    get: HighAlch.one(Customer, (row, input) => row.CustomerId === input.CustomerId),
    byProject: HighAlch.where(
      CustomersByProject,
      (row, input) => row.ProjectId === input.ProjectId,
    ),
  },
  commands: {
    create: HighAlch.inserts(CreateCustomer, {
      row: (input, key) => ({ CustomerId: key, Comments: [], ...input }),
    }),
    update: HighAlch.updates(UpdateCustomer),
    remove: HighAlch.deletes(DeleteCustomer),
    addComment: HighAlch.edits(AddCustomerComment, {
      change: (draft, input) => {
        draft.Comments = [...draft.Comments, input.Comment];
      },
    }),
    registerEmail: RegisterCustomerEmail, // bare: no optimistic change
    // `{ CustomerId, IntoId }`: the row is `CustomerId`, the command addresses the other record.
    merge: HighAlch.sends(MergeCustomers, {
      target: (input, scope) => JSON.stringify([scope, input.IntoId]),
    }),
  },
});

export const summary = HighAlch.query(DashboardSummary); // not an entity: one row, no feed
export const refresh = HighAlch.command(RefreshSomething, {
  target: (_input, scope) => scope, // a command with no rows to edit declares its target
});
```

**Who decides which rows belong?** Use `all(Query)` for the whole list in the client's scope.
Use `where(Query, rule)` for a list whose membership can be tested against a feed row and the
query input, or `one(Query, rule)` for a single row read with `.findOne()`. Use a bare query when
the answer decides membership. For example, if `CustomersByName` sorts by name and then key,
`customers.page({ Offset: 0, Limit: 101 })` reads 100 rows and one lookahead row.

The query's answer supplies the rows as a `paged` query's `entries`, an array's elements, or one
row (none for `null`). Use `entries(Query, select)` when the answer wraps its rows, such as
`{ Items, Count }`. Compose it with a membership helper when the client can decide:

```ts
const projectRows = HighAlch.entries(WrappedCustomersByProject, (answer) => answer.Items);
const byProject = HighAlch.where(projectRows, (row, input) => row.ProjectId === input.ProjectId);
```

Use `projectRows` by itself when the query decides. `one` and `all` can also take an `entries`
declaration. Each query must return the entity's rows after selection. A `paged` query's accessor
takes its page as the second argument, for example `customers.search(input, { after, take })`.
`all` rejects paged queries at compile time and at declaration. Declare a Domain query with one
membership rule and row selector per `Rows` entity. Repeating the same declaration is allowed.
A conflicting declaration throws a HighAlch error naming the query and entity.

**Which row a command addresses, and which aggregate.** A call passes only the command's input;
the package resolves the rest from the declarations, in this order:

1. The row key: the input's field named like the row key (`CustomerId` above), or the command's
   `key: (input) => string` option. A command of an entity whose input has neither is a
   **compile error** at the `collection` declaration (`updates`, `deletes`, `edits`, `sends` and
   bare commands).
2. The target: the command's own `target: (input, scope) => Target` option when it addresses
   something else, else the `Rows` entity's `target(key, scope)` (by default the key). The entity's
   target type must be the command's target type (a branded target needs the command's own
   `target`), and a command's `target` must return it: both are compile errors otherwise.

| Declaration                                         | What it does                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `inserts(Cmd, { row, key?, target? })`              | a create: `row(input, key)` is the pending row (checked as a row)      |
| `updates(Cmd, { key?, target?, fields?, input? }?)` | the input's fields that are row fields replace the row's (not the key) |
| `deletes(Cmd, { key?, target? }?)`                  | the row leaves every subset                                            |
| `edits(Cmd, { change, key?, target? })`             | `change(draft, input)` edits a writable draft typed from the row       |
| `sends(Cmd, { key?, target? }?)` or a bare `Cmd`    | no optimistic change; the command settles through the feed             |
| `HighAlch.command(Cmd, { target })`                 | not an entity: no row key; `target(input, scope)` is required          |

**Nested inputs.** When a command's input holds the row fields under another field
(`{ value: { CustomerId, … } }`), `updates` declares `fields: (input) => input.value` (the fields a
call sets) and, for `paced`, `input: (row) => ({ value: row })` (the input sent for a merged row);
`key: (input) => input.value.CustomerId` names the row.

**Creates.** The pending row needs its key before the server answers, so `inserts` chooses it on
the client: `key(input)` when declared (a key the caller can predict from the input), otherwise a
fresh `crypto.randomUUID()`. The entity's `target(key, scope)` (or the command's
`target(input, scope, key)`) addresses the new aggregate, so the server's row has the same key and
the pending row is replaced in place.

**`HighAlch.command` targets.** A command outside an entity has no row key, so it declares
`target`. The one exception is a singleton aggregate whose target schema is one literal
(`target: Schema.Literal("settings")`): that literal is the only possible target, so `target` may
be omitted. Any other omission is a compile error (the declaration needs two arguments).

## Reads: stock `useLiveQuery`

`customers.list(input)` is a TanStack DB collection descriptor. Use it directly as a source:

```tsx
const res = useLiveQuery((q) =>
  q.from({ customer: customers.list({ account }) }).orderBy(({ customer }) => customer.Name),
);

return HighAlch.match(res).on({
  [HighAlch.anyOf("Loading", "Retrying")]: () => <Skeleton />,
  Ready: ({ data, feed }) => <List rows={data} stale={Option.isSome(feed)} />,
  NotMember: (error, { retry }) => <NoAccess onRetry={retry} />,
  RpcClientError: (_error, { retry }) => <Offline onRetry={retry} />,
});
```

There is no hook of ours: joins, `where`, `orderBy`, `limit`, `findOne` and `select` are
TanStack DB's. The descriptor is materialised by the provider's `DbClient`, so the same
module-level declaration serves every account.

### States

`match(res)` reads a stock live query result once and gives one of:

| State                                     | When                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Loading`                                 | the first load runs; nothing to show                                                                                |
| `Retrying { error, attempt, data }`       | the data was ready and a source lost its feed; it is retrying after `error` (`health.failureReason`; first retry 2) |
| `Ready { data, feed, retry }`             | the data is current; `feed` is `Some(error)` when a source's live updates stopped for good                          |
| `Missing`                                 | a single-result query (`.findOne()`) is ready and found no row                                                      |
| `Disabled`                                | the query function returned no query (only when it can)                                                             |
| each tagged error, as the original object | the first load failed (the original instance from `res.health`; there is no `res.error`)                            |

Every handler also receives `{ retry }` as its second argument; `Ready` carries it too. `retry`
calls `res.collection.reload()`, which reloads failed sources: a failed live query does not
recover by itself when its source does. Untagged failures (bugs, undecodable data, a server
defect) are defects: `match` throws them to the error boundary. `Retrying` also carries `data`
(an addition to the approved shape: after first readiness there is always data to keep showing).

Without `orElse`, name every live state and Domain error. Unknown and duplicate tags are type
errors. Use `anyOf(...)` to share a handler across tags.

### Suspense

`HighAlch.Suspend` is a `Loading` handler that suspends to the nearest `<Suspense>` instead of
rendering a placeholder. Everything else stays a branch: a typed rejection of the first load
renders its own handler (it never reaches an error boundary), `Retrying`, `Ready` and `Missing`
are unchanged, and a defect still throws to the error boundary.

```tsx
const res = useLiveQuery((q) => q.from({ note: notes.list({ account }) }));

return HighAlch.match(res).on({
  Loading: HighAlch.Suspend,
  QueryRefused: () => <Refused />,
  RpcClientError: (_error, { retry }) => <Offline onRetry={retry} />,
  Retrying: ({ data }) => <NoteList notes={data} reconnecting />,
  Ready: ({ data }) => <NoteList notes={data} />,
});
```

It is still the stock `useLiveQuery`. A suspended render never commits, so its subscription
never starts: `Suspend` observes the result's collection itself until the first load ends (ready,
a typed rejection, a crash or a cleanup) and throws one promise, shared by every render waiting
on the same source collections of the same client (another client's read of the same
declaration waits on its own load), that resolves then and never rejects. The retried render builds a new live
query over the loaded sources and is `Ready` (or the error) at once: a first mount renders twice
suspended (React pre-renders a suspended tree once more) and once with the data. `Suspend` is a
type error on any key but `Loading`.

- **Input change.** A reader that was ready and suspends on a new input (a subset not loaded
  yet) replaces its content with the fallback, as any suspending update does. Make the change in
  `startTransition`, or read the input through `useDeferredValue`, to keep the old list on
  screen until the new one is loaded.
- **React's reveal throttle.** Once React shows a fallback it keeps it about 300 ms before it
  reveals the content, however soon the data arrives.
- **Observer lifetime.** After the load ends, `Suspend` keeps observing the collection until a
  committed reader subscribes, or for 5 s (TanStack DB's suspense `gcTime`), so a retry that
  reuses it finds it loaded; an unmounted or discarded render's collection is released then.

### Errors without plumbing

Each subset's row type carries a type-only marker, `Row & { readonly [Errors]?: E }` (a unique
symbol no row holds). `E` is computed from the definitions: `Api.QueryError<Query>` (rejections,
middleware errors, `ConsistencyTimeout` for `waitsFor`, `RpcClientError`) and
`Api.ReadError<Feed["definition"]>` (the entity's feed: its rejections, middleware errors and
`RpcClientError`). `match` recovers the union from the result's
`data` type through `from`, `where`, `orderBy`, `limit`, joins, `findOne`, whole-row selects and
spread selects (`{ ...customer, extra }`).

A field projection (`select(({ c }) => ({ id: c.CustomerId }))`) drops the marker. For that
case the app declares a floor once, by module augmentation:

```ts
declare module "@highalch/db" {
  interface Register {
    readonly errors: HighAlch.ApiErrors<typeof AppApi>; // every read error of the Api
  }
}
```

Without a registered floor, a projection's errors are any tagged failure, so `match` then needs
`orElse`.

## Writes: TanStack DB transactions

A command is a callable that returns TanStack DB's own `Transaction`:

```ts
const tx = customers.update(
  { CustomerId: id, Name },
  {
    onCommitted: (settled) => toast.saved(),
    onRejected: { NotFound: () => toast.gone(), orElse: (error) => toast.failed(error) },
  },
);

await tx.when("settled"); // rejects with the original tagged rejection

customers.addComment({ CustomerId: id, Comment });
```

- A call takes the command's input only; a `target` at a call site is a type error. The package
  resolves the target from the declarations and sends plain, serialisable data,
  `{ target, input }`. The transaction's id is the Domain `commandId` (pass `id` to choose it), so
  a resend with the same id is idempotent.
- The client's scope is part of the target, so a call needs a client: with none registered it
  throws before anything is sent.
- It applies the optimistic change (`inserts`/`updates`/`deletes`/`edits`) to every
  materialised subset of the entity that shows the row (an insert goes where the subset's rule
  holds, or to subsets without a rule), sends the command, and **settles when the feed has
  delivered the change** caused by that command id: the waiter resolves right after the feed's
  sync `commit()`, so the optimistic value is replaced by the committed one in the same step
  (never back to the old one). A command whose change the feed does not carry (a no-op, or an
  event `on` ignores) settles once the feed passed the stream's cursor after the command
  (the latest entry's `seq` from `stream.peek(scope, { atLeast: receipt })`). A command with no
  row feed settles when it returns.
- A typed rejection rolls back and reaches `onRejected`, `when("settled")`, `effect` and
  `result` as the original instance. `onRejected` takes one handler per tag or `anyOf(...)` key,
  with `orElse` required unless every error is listed; it is checked against
  `Api.CommandClient`'s errors for that command.
- If the feed does not deliver within the client's `settleTimeout`, the command settles as
  `Unconfirmed` (the server accepted it) and the entity's subsets reload; it never hangs.
- `command.with({ client?, onCommitted?, onRejected? })` binds a client and default reactions.
- `command.effect(input)`: an `Effect<Settled, E>` with the typed error channel (state machines,
  tests). `command.result(input)` is an Effect that returns `Committed | Unconfirmed | E` for
  `match`. It puts typed rejections in the value channel. Both forms can use a bound client,
  the `HighAlch.Client` service, or the mounted provider. A sent transaction settles even if its
  Effect caller stops waiting.
- `command.options`: `{ onMutate, mutationFn }` for `createOptimisticAction`. A call that edits
  no loaded row runs the command beside the (empty) transaction, which TanStack completes at once.
  `onMutate` resolves the call (a create's key is chosen there) and `mutationFn` sends that same
  key and target.
- `updates` commands also have `command.paced`: `{ onMutate, mutationFn }` for
  `usePacedMutations` (add a `strategy`). Each call resolves its row key and target as a direct
  call does; the merged transaction sends one command per edited row to that target, with its
  input read from the row's key and the fields the merged calls changed (so the input fields
  must be row fields; `input(row)` receives that partial row), under the id
  `<transaction id>:<row key>` (paced transactions cannot take a caller id).

### The created key

An `inserts` call returns a `HighAlch.Created` transaction: its `metadata` holds the new row's key
under `HighAlch.createdKey`, set before the call returns. Read it with `HighAlch.created`, for
example to navigate to the new record without awaiting the server:

```ts
const tx = customers.create({ Name, Email });

navigate({ to: "/customers/$id", params: { id: HighAlch.created(tx) } });
```

`created` only accepts an `inserts` transaction (a type error otherwise). Every entity call's
transaction carries the addressed row's key under the same `metadata` key, including those made
by `createOptimisticAction(command.options)`.

Module-level commands cannot read React context: the `Provider` registers its client while it is
mounted. A command called with no registered client (during server rendering, outside the
provider) or with two different clients mounted throws; pass one with `command.with({ client })`.

Pending UI comes from TanStack DB: rows carry `$hasPendingWrites`. An action with no row to show
uses React's `useTransition` around `await command(input).when("settled")`.

Commands are designed so `@tanstack/offline-transactions` can be adopted later (idempotent on the
id, serialisable call); it is not integrated.

## Configuration

```tsx
import { Provider } from "@highalch/db/react";

const db = HighAlch.make({
  api: AppApi,
  layer: AppApi.layerClientWebSocket(url).pipe(Layer.provide(clients)), // or `runtime: ...`
  scope: accountKey, // the scope (stream key) every feed reads
  retry: HighAlch.transient, // optional; transport failures 3×, nothing else
  settleTimeout: 10_000, // optional
});

<Provider client={db}>{children}</Provider>;
```

`make` returns a TanStack `DbClient` holding the Domain connection as a dependency
(`client.requireDependency(...)`); `Provider` renders TanStack's `DbProvider` with it. Give the
client a `layer` (the connection builds and, on `HighAlch.close(db)`, disposes it) or a
`runtime` that already holds the Api client. Queries, commands, and stream `peek` and
`events` run in that runtime's Effect context. The `clock` setting overrides its Clock
for endpoint calls and supplies the clock for HighAlch's own waits.

Run `yield* HighAlch.close(db)` in an Effect or
`await Effect.runPromise(HighAlch.close(db))` at a JavaScript boundary. When close begins,
new commands and paced transactions still waiting for their strategy fail immediately with
`HighAlch client is closing or closed`. Pending optimistic edits roll back. A read that
starts syncing during or after close is a bug in the caller: its collection fails immediately
with a `HighAlch.Defect` whose cause says the client is closing or closed, which `match` throws
to the error boundary, and it registers no subset or feed. A subscriber that throws while its
transaction rolls back does not stop the shutdown; its error is logged. Every caller of `close`
waits for the same shutdown, so do not await `close` from inside a collection's own cleanup: it
would wait for itself.

Close keeps the collections and feeds available while admitted commands settle. A server
rejection rolls back with the original error. A reply received before the deadline gets the
full feed confirmation timeout and settles as `Committed` or `Unconfirmed`. A reply still
outstanding `settleTimeout` milliseconds after close began fails with
`HighAlch client closed before the server replied` and rolls back. HighAlch requests
interruption and ignores any later reply. Close waits for collection cleanup and feed
finalizers, then disposes the runtime it built. Concurrent and repeated calls share one
close operation. The caller owns a supplied runtime.

Use `HighAlch.layer(config)` to give an Effect application a client scoped to its layer.
It provides the TanStack client as `HighAlch.Client` and closes it when the scope exits,
including failure and interruption. HighAlch's own waits use the ambient Clock by default
in a scoped layer.
Pass the layer to `Atom.runtime` or compose it with your application's layers.

```ts
const customersLayer = HighAlch.layer({
  api: AppApi,
  layer: AppApi.layerClientWebSocket(url).pipe(Layer.provide(clients)),
  scope: accountKey,
});

const refresh = Effect.gen(function* () {
  const db = yield* HighAlch.Client;
  HighAlch.reload(db, CustomerRows);
}).pipe(Effect.provide(customersLayer));
```

`HighAlch.reload(db, Rows)` reloads every loaded subset of an entity in one client (one snapshot
transaction each, no flicker; calls within `reloadDelay` reload once). Use it for a change the
feed does not carry: a write through another path than the entity's commands, while that path
exists. A client with `live: false` loads subsets on observation and on explicit reload.
It opens no feed and never re-asks automatically. For server rendering, make one such client
per request, call `dehydrate()` on it, then `hydrate(state)` on the browser's client. The
collection ids match because both clients derive them from the declaration, query and input.

`retry` is an Effect `Schedule`. The default, `HighAlch.transient`, retries transport failures
after 250, 500 and 1,000 ms. Use `Schedule.while` to select which typed failures to retry.
Before a subset first becomes ready, exhausting the schedule fails the load. After readiness,
a retry reports `failureReason` (`Retrying`), and a stopped retry keeps the rows (`Ready.feed`).
A new reload request during retry backoff can re-ask after its debounce.

Retries, reload debounces and command settlement use Effect's `Clock`. The scoped layer
uses the ambient clock. Pass `clock` in the config to provide a clock directly to `make` or
override the layer's clock.

## The subset model and its trade-offs

An account can have too many rows to load a whole entity, so there is **one collection per
(query, input)**, a subset, created through a module-level descriptor that each `DbClient`
materialises. All subsets of all entities on one feed in one client listen to the **same**
subscription of that feed's stream for the client's scope: one subscription per feed per client,
started with the first subset of any of its entities and released with the last. It hands each
subset the entries of its own entity (an entry of an entity no subset reads passes by).

The subscription deduplicates entries by sequence and resumes from its last sequence after a
failure.

The declaration determines who places rows after a feed change:

- With `where`, `one` or `all`, the rule decides. An upsert inserts or updates a row when the rule
  holds and removes it when the rule stops holding. A removal deletes the row where present.
  `all` always includes the row. A load reads the feed cursor before sending the query and
  applies entries buffered after that cursor over the answer. These declarations only re-ask
  on explicit reload, so the rule must agree with the server query.
- Without a rule, the query decides. Every delivered entry patches the rows in place once
  regardless of the last query's cursor and requests a re-ask, including changes outside a page.

Query-decided subsets retain entries since the last clean answer and replay them over the next
answer. A removal deletes its key. An upsert replaces a row in the answer or keeps an omitted row
that the subset already shows, including a confirmed optimistic insert. The first load writes
with replay. A ready subset discards up to two consecutive answers overtaken by the feed, then
writes the next with replay so that other rows can refresh under continuous changes.

An answer is clean when replay leaves it unchanged and no entries arrived in flight. When replay
changes the answer, the subset can make up to three corrections with increasing delays. If the
third correction still disagrees, the query answer wins and the subset clears the retained entries.
A new feed entry resets the correction count. An explicit reload clears the count and starts with
the query answer, with entries received in flight handled by the same replay and discard rules.

While corrections run, a row the server has moved out of the subset stays visible, so a page can
briefly hold more rows than its limit. With the default `reloadDelay` of 50 ms the corrections
wait 100, 200 and 400 ms, about 750 ms in all plus the time each query takes, and further feed
entries extend it.

`reloadDelay` coalesces feed changes and explicit reloads into one request. Each subset can have
one query in flight and one waiting. A debounced feed change or explicit reload can preempt a
retry backoff. A ready subset writes each accepted answer in one snapshot transaction and
keeps its readiness. With `live: false`, the same debounce coalesces explicit reloads.

A read model that lags the feed longer than the corrections wait can still return stale rows.
A new row omitted by a lagging answer appears at the next change or reload. Domain's `waitsFor`
needs an `atLeast` receipt with the originating aggregate stream and version. The feed delivers
row changes with the feed's own cursor.

Each loaded cursor page re-asks with its own `after` and `take`. A change that shifts a boundary
can leave adjacent pages overlapping or with a gap until those pages are loaded again.

Creates use client-chosen keys. If the server uses another key, the row appears
through the rule or the reload.

## XState: `@highalch/db/xstate`

A machine invokes a command through `invoke(command)` from
`@highalch/db/xstate` (production code imports it there, never from a testing entry;
`story/xstate` re-exports it), registered as an actor and run with `@xstate/effect`'s
`createEffectActor`:

```ts
const editor = setupEffect({ actors: { rename: invoke(notes.rename) }, schemas }).createMachine({
  states: {
    Saving: {
      invoke: {
        src: "rename",
        input: ({ context }) => ({ NoteId: context.NoteId, title: context.draft }),
        onDone: () => ({ target: "Saved" }),
        onError: ({ event }) => ({
          target: isTagged(rejection(event.error), "NoteMissing") ? "Stale" : "Failed",
        }),
      },
    },
  },
});
```

It is `createEffectLogic` over `command.effect(input)`: the invoked actor's output is the
`Settled` value. Its error reaches `onError` as `@xstate/effect`'s `EffectFailure` around the
Effect's cause; `rejection(event.error)` (from `@highalch/db/xstate`) answers the typed rejection
inside, the original instance. The logic is marked with its command,
which is what makes "the command it asked for" observable: XState 6's pure `transition` returns,
for each invoked actor, an `@xstate.spawn` executable action holding the actor `logic`, its `id`
and resolved `input`; the story reads the mark from `logic`, and names the command by the key it
is registered under in `setup({ actors })`. Plain XState logic works the same once marked:
`mark(createAsyncLogic({ run: ({ input }) => Effect.runPromise(command.result(input)) }), command)`. In production
the invoked command runs on the client the `Provider` registered; for a running machine in a story
the `Runner` service the story provides runs it on the story's client.

## Seams for test kits: `@highalch/db/internal`

`@highalch/story` needs a few behaviour-preserving seams of the core, published as
`@highalch/db/internal` and **not covered by semver**. The story clock reads `waitKind` to
distinguish retries, reload debounces and settle timeouts. The test kit also uses `connectionOf` and
`Connection` (a client's feeds, each with a read-only `current`: caught up and not failed, and its
materialised subsets), the constructors of `match`'s live states (`Live`, `fromLive`) and of
`Settled`, and `keyOf`. Applications import `@highalch/db`.

## Deliberately not done

- On-demand loading (`syncMode: "on-demand"`, `loadSubset`): subsets are whole query answers.
- Offline: no persistence or queueing of transactions (the design leaves room for
  `@tanstack/offline-transactions`).
- Accumulating pages (infinite lists): each page is its own subset.
- Live refresh of `HighAlch.query` results: they have no feed; `retry` (or a remount after GC)
  reloads them.
- A command never edits a `HighAlch.query` row.
