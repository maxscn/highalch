# @highalch/story

Stories for TanStack DB clients (plain, or synced with an alchemy Domain by
[`@lowalch/tanstack-db`](../tanstack-db/README.md)) and the XState machines over them:
given server history, when a client, another client or the world acts, then what each source
shows, its read state and how each command settled. Optional screen steps paint a filmstrip of a
mounted React component without a browser.

| Entry point                     | What                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@highalch/story`               | The story runner, the Domain's steps (history, other clients, transport faults, time)                              |
| `@highalch/story/tanstack-db`   | `Db`: a client's sources, its commands, their settling, readers and rules (plain TanStack DB)                      |
| `@highalch/story/tanstack-form` | `Form`: type into and submit the app's own forms, readers, `Form.typing` for explorations                          |
| `@highalch/story/vite`          | `highalch()`: the Vite plugin through which stories find the forms the app mounts                                  |
| `@highalch/story/lowalch`       | `LowAlchDb`: LowAlch clients for `Db` steps, `reload(Rows)`, feed entries, feed rules, view helpers                |
| `@highalch/story/xstate`        | Machine steps and generated stories (`explore`) for the same runner; needs `xstate`                                |
| `@highalch/story/screen`        | Screen steps: a mounted component, its frames vs reviewed baselines, its layout for rules; needs happy-dom         |
| `@highalch/story/takumi`        | `Takumi.frames()` and `Takumi.layout()`: takumi's WASM renderer as a screen's frames and layout; needs `takumi-js` |

Peer dependencies: `effect`, `@alchemy.run/domain`, `@tanstack/db` and `react`; optional
`@lowalch/tanstack-db` (for `/lowalch` and `/xstate`), `xstate` and `@xstate/effect` (for
`/xstate`), `react-dom`, `happy-dom`, `@tanstack/react-db` and `@effect/atom-react` (for
`/screen`) and `takumi-js` 2.14.0 (for `/takumi`).

A story tells a frontend's behaviour like Foldkit's: given a state, when something happens, then
the next state and what was asked for. There is **one runner** and one vocabulary: data steps (a
client, another client or the world acts; what each source shows; how each command settled) and
machine steps (an XState machine receives events; where it is; which commands it asked for)
compose freely in one story, in any order. Stories depend on no test runner: steps are plain
values and a story is a promise you await inside your own `it(...)`. A failed expectation throws a
`StoryFailure` whose message names the step, what it expected and what it observed (every state
each row key showed, in order; for a machine step the machine's name and mode, its state and the
commands it asked for), and lists the steps (✓ passed, ✗ failed, blank not run).

```ts
import * as Story from "@highalch/story"; // the runner and the Domain's steps; never imports XState
import { Db } from "@highalch/story/tanstack-db"; // data steps: what a client shows and its commands
import { LowAlchDb } from "@highalch/story/lowalch"; // LowAlch clients for the data steps
import { explore, Machine } from "@highalch/story/xstate"; // machine steps and generated stories
import { invoke } from "@lowalch/tanstack-db/xstate"; // production: how a machine invokes a command
```

`@lowalch/tanstack-db` never imports the story kit. Only `@lowalch/tanstack-db/xstate` and
`@highalch/story/xstate` import `xstate` and `@xstate/effect`, optional peer dependencies. The
story runner imports neither TanStack DB nor LowAlch: `Db` works on plain TanStack DB, and only
`@highalch/story/lowalch` (and the machine steps, which run LowAlch commands) import LowAlch. The
repository's `vp run check:patterns` enforces all of it.

## Making a story

In this example, the whole-list declaration for `notes.list` is `LowAlch.read(Notes).all()`.

```ts
// Hosted: the consumer's Domain in memory, real LowAlch clients (one per scope) behind a wire the
// story controls, on a clock it controls. Data steps and machine steps.
const story = Story.make(
  LowAlchDb.memory(
    { api: NotesApi, layer: handlers, services: stores, session: readerOf },
    { settleTimeout: 2_000 }, // the clients' settings: settleTimeout, reloadDelay, retry, live
  ),
  { scope: "acc-1" }, // and the clock: `clock: "real"`
);

// Hostless: no Domain, no client, nothing started. Machines stepped purely.
const pure = Story.make();

it("renames optimistically, then settles through the feed", () =>
  story.with({ rules: Db.rules })(
    Story.given(Note.ref(id), new NoteCreated({ note: ada })),
    Db.then(notes.list({ account: "acc-1" }), [{ title: "Ada" }]),
    Db.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
    Db.then(notes.list({ account: "acc-1" }), [{ title: "Ada 2", $hasPendingWrites: true }]),
    Db.settled("Committed"),
    Db.then(notes.list({ account: "acc-1" }), [{ title: "Ada 2", $hasPendingWrites: false }]),
  ));
```

Each call of a hosted runner builds a fresh host and fresh clients and disposes them; nothing is
global. `LowAlchDb.memory` is `Story.memory` with LowAlch clients: `Story.memory` alone hosts the
Domain and leaves `Db`'s clients plain TanStack DB (a bare `DbClient` per scope, the sources as
they are); `LowAlchDb.connect(settings)` adds LowAlch clients to any other host's `adapters`.
`Story.memory` hosts the Api's model on alchemy's in-memory platform: `layer` (a function,
so each story gets fresh state) is what the model's `layer` takes, `services` the stores those
handlers share with `check` steps (`world.host.service(Tag)`), and `session(scope)` the reader's
middleware when the Api's reads are guarded. Any other host is a `Hosting`: a function returning
`{ api, client(scope), dispose }` (plus optional `idle`, `seed`, `send`, `service`), for example
a deployed model's records over HTTP.

A hostless story runs any step that needs no Domain: machines stepped purely, and your own steps
built with `staged`. A data step or a running machine in it fails at once, naming itself:
`Step 2 (then …) failed: "then …" needs a host, and this story has none`. `pure.with(...)` is
refused (it has no clients, clock or rules).

## The steps

Story steps (`Story.*`, from `@highalch/story`): the Domain, its transport and time. All but
`flatten`/`staged` need a host:

| Step                                                   | What it does                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `given(ref, ...events)`                                | history: events committed on an aggregate (seeded as alchemy's `Story.given` seeds them; projections see them) |
| `remote(ref, command)` / `remote(label, (api) => eff)` | another client writes: a command to an aggregate, or any call of the scope's Api client; it must be accepted   |
| `alchemy(Story.given(...))` / `alchemy(Db.when(...))`  | alchemy's own `Given`/`When` step values, run on the story's host                                              |
| `drop(error?)` / `resume()`                            | the feed fails (reconnecting fails too) / connects again: its retries run now                                  |
| `mute(on?)`                                            | the feed stays connected and delivers nothing (what it drops is lost to that connection)                       |
| `fail(name, error, times?)` / `recover(name)`          | a query or command fails with a typed error / answers again                                                    |
| `hold()` / `release()`                                 | queries answer with what they saw when asked, but only at `release` (a write racing a load)                    |
| `advance(ms)`                                          | time passes on the story's clock: retries, reload debounces and settle timeouts due within `ms` fire, in order |
| `settle()` / `idle()`                                  | wait until nothing more happens by itself / until every command ended                                          |
| `check(label, (world) => ...)`                         | anything else of the Domain: the host's services, a scope's wire (`world.wire().sent`, `.asked`)               |
| `as(scope, ...steps)`                                  | the steps act as the client of another scope (two accounts in one story; a machine started inside runs there)  |

Data steps (`Db.*`, from `@highalch/story/tanstack-db`): what a client's sources show and the
commands it runs:

| Step                                                 | What it does                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `open(source, { as?, settle? })`                     | materialises a source in a client and keeps it observed, as a mounted `useLiveQuery` would                            |
| `then(source, rows \| predicate, { as? })`           | what the source shows now, by key order, each row compared partially; `$hasPendingWrites` names a pending row         |
| `then(source, { rows?, state?, fields?, single? })`  | its rows and its read state, by the conversion `match` uses: `Loading`, `Retrying`, `Ready`, `Missing`, a typed error |
| `when(command, input)`                               | the client calls a declared command with its input (`command.with({ client })(input)`)                                |
| `when(label, ({ client, activate }) => transaction)` | anything that returns a transaction: `createOptimisticAction(command.options)`, `createPacedMutations(command.paced)` |
| `settled("Committed" \| "Unconfirmed"?)`             | the last command (a `when`'s or a running machine's) settled so                                                       |
| `rejected(error)`                                    | the last command was rejected with this typed error (same class, same fields)                                         |
| `check(label, (db) => ...)`                          | anything else of the clients: their runs, observed sources, a `DbClient`, the feed's entries                          |
| `reload(source)`                                     | what a `match` handler's `retry` does (`collection.reload()`); `LowAlchDb.reload(Rows)` reloads an entity's subsets   |

Machine steps (`Machine.*`). Each addressing step takes a last `{ machine?: name }` (default: the
machine introduced last), as data steps take `{ as?: scope }`:

| Step                                                        | Stepped purely (`given`)                                       | Running (`start`)                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `given(machine, snapshot \| (read) => snapshot, { name? })` | enters from `{ state?, context?, input? }`; works hostless     | —                                                                           |
| `start(machine, { input?, name? })`                         | —                                                              | enters as an actor (`createEffectActor`) on the step's client; needs a host |
| `mounted(atoms, { name? })`                                 | —                                                              | enters as the actor a mounted component reads through these atoms           |
| `when(event \| (read) => event, { machine? })`              | XState's pure `transition`; nothing runs                       | sent to the actor; the commands it starts wait for a settling step          |
| `then({ state, context? }, { machine? })`                   | `snapshot.matches(state)`, context compared partially          | the same, on the actor's snapshot                                           |
| `asked(command, input?, { machine? })`                      | the last transition's spawn actions of `invoke(command)` logic | the commands the story's `Runner` ran for it since its last event           |
| `askedNothing({ machine? })`                                | the last transition spawned none                               | it ran none since its last event                                            |
| `done(command, output?, { machine? })`                      | feeds `xstate.done.actor` for the command it asked for last    | an error: its commands settle by themselves (`Db.settled`)                  |
| `failed(command, error, { machine? })`                      | feeds `xstate.error.actor` with the typed error                | an error: assert the real rejection with `Db.rejected`                      |

`(read) => …` computes a snapshot or an event from what the story's sources show when the step runs
(`read(source, { as? })` returns its rows, opening it first), so a stepped machine can be asked
what it _would_ do with the rows a collection shows now. It needs a host.

## Pure, running or mounted: one explicit choice

A machine enters a story once, and how it enters decides what every later step means for it;
nothing switches modes silently.

- **`Machine.given` — stepped purely.** No actor, no client: each step is XState's
  `transition(machine, snapshot, event)`. `asked` reads the commands the transition _would_ spawn;
  `done`/`failed` feed it their results. It proves the machine's decisions exactly, without
  timing. In a hosted story it sits beside the data: the rows it reads are real, and the commands
  it asks for are never sent.
- **`Machine.start` — running.** An actor on the story's client (of the step's scope). The
  commands it invokes run there and are recorded as its runs; their real outcomes arrive by
  themselves and `Db.settled`/`Db.rejected` assert them. It proves the machine and the data
  together: what is shown while a command is in flight, how it reacts to typed rejections, that
  rows roll back. Needs a host.

- **`Machine.mounted` — running, as a component reads it.** The actor the story's atom registry
  holds for the atoms `createActorAtoms` (from `@xstate/effect/atom`) made, which is the one a
  component under `List.render` reads through the same atoms. From then on it is a running
  machine: `when` sends to it, `then` and `asked` read it, and its commands run on the story's
  client, recorded. The story keeps the actor alive until it ends, so the step may come before or
  after the render. Needs a host. See [Machines in a screen](#machines-in-a-screen).

```ts
story(
  Story.given(n1, new NoteCreated({ note: ada })),
  Db.open(one),
  Story.remote(n1, new RenameNote({ NoteId: "n1", title: "Ada (theirs)" })),
  // A draft editor, stepped purely, beside the data: what would it save?
  Machine.given(editor, { input: { NoteId: "n1" } }, { name: "draft" }),
  Machine.when(async (read) => ({ type: "Edit", title: `${(await read(one))[0]?.title}, edited` })),
  Machine.when({ type: "Save" }),
  Machine.asked(notes.rename, { title: "Ada (theirs), edited" }),
  Db.then(one, [{ title: "Ada (theirs)", $hasPendingWrites: false }]), // nothing was sent
  // A running editor: its rename really runs, is rejected and rolls back.
  Machine.start(editor, { input: { NoteId: "n1" }, name: "live" }),
  Machine.when({ type: "Edit", title: "locked" }, { machine: "live" }),
  Machine.when({ type: "Save" }, { machine: "live" }),
  Db.then(one, [{ title: "locked", $hasPendingWrites: true }]),
  Db.rejected(new NoteLocked({ title: "locked" })),
  Machine.then({ state: "Failed" }, { machine: "live" }),
);
```

**Several machines.** `given`/`start` name a machine (`{ name }`, default its `id`; a second
machine of the same name is an error); every other machine step addresses one by
`{ machine: name }`, else the one introduced last. A failure names the machine and its mode:
`draft (stepped) is not in the expected state … expected "Saved" … observed "Saving" … asked since
its last event: rename {"NoteId":"n1","title":"Ada 2"}`.

**Invoking a command.** A machine invokes a command through `invoke(command)` from
`@lowalch/tanstack-db/xstate` (production code imports it there, never from a testing entry;
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
Effect's cause; `rejection(event.error)` (from `@lowalch/tanstack-db/xstate`) answers the typed rejection
inside, the original instance. The logic is marked with its command,
which is what makes "the command it asked for" observable: XState 6's pure `transition` returns,
for each invoked actor, an `@xstate.spawn` executable action holding the actor `logic`, its `id`
and resolved `input`; the story reads the mark from `logic`, and names the command by the key it
is registered under in `setup({ actors })`. Plain XState logic works the same once marked:
`mark(createAsyncLogic({ run: ({ input }) => command.result(input) }), command)`. In production
the invoked command runs on the client the `Provider` registered; for a running machine in a story
the `Runner` service the story provides runs it on the story's client.

## Generated stories

`explore` runs a model: a small XState machine models what can happen to an entity (its events,
guarded by what it tracks); `steps(event, index)` maps each event to story steps, data steps or
machine steps alike (an `EDIT` can be a running editor's `Machine.when(Edit)` and
`Machine.when(Save)`); `explore` enumerates paths with XState's own graph utilities
(`xstate/graph`'s `getShortestPaths` and `getSimplePaths`), keeps the longest of each prefix
(every step is checked, so prefixes are), at most `maxLength` events and `maxPaths` paths, in a
deterministic order, and runs each as a fresh story on the given runner (`before`, the events,
`after`) with the rules checked at their moments. A failure is shrunk to a shorter failing
path and reported as its event sequence (`A generated story failed (path 3 of 64): EDIT → DROP →
REMOTE`) with the story's report. The model must be finite (bound it with a counter) and must
record what distinguishes interleavings, since paths are simple paths through its states.

## How time and the network behave

Steps that let the world move (`given`, `remote`, `open`, `settled`, `rejected`, `advance`,
`drop`, `resume`, `release`, `reload`, `settle`, `idle`) end when it is quiet: the server is idle,
no request is in flight, and every live feed delivered the server's latest entry. A command's
reply reaches the client only while the world moves, so the steps after a `when` (or a running
machine's `when`) see the optimistic rows whatever the server already did, and `rejected` sees the
rollback. The clients wait on the story's clock (`clock: "manual"`, the default): a retry, a
reload debounce or a settle timeout fires only when `advance` (or `resume`, for retries) lets it,
so stories never sleep and never race the timer. `clock: "real"` uses `setTimeout`, still tracked.
A source records what a mounted live query renders: one state per key per change batch (a reload's
delete and insert of a row in one batch is one change). When a story ends, or fails, with a command
in flight, closing its clients (`LowAlch.close` waits for sent commands) lets the replies through
and runs the clock's waits, so a failure is reported instead of hanging.

**Rules.** `story.with({ rules })` checks rules, each at the moment it names. A rule is a sentence
for its name, which failures quote word for word, a generator that yields what it reads and returns
whether it holds, and its settings last:

```ts
import { Explore } from "@highalch/story";

const listMatchesEditor = Explore.rule(
  "the list matches the editor",
  function* () {
    const rows = yield* Db.rows(list);
    const editor = yield* Machine.snapshot();

    return rows.get("n1")?.title === editor?.context.draft;
  },
  { at: "rest" }, // "step" (default) | "rest" | "end"
);

const rejectionLeavesNothingPending = Explore.rule(
  "a rejection leaves nothing pending",
  function* ({ step }) {
    if (step._tag !== "Rejected") return true; // reads nothing on any other step

    const rows = yield* Db.rows(list);

    return [...rows.values()].every((row) => !row.$hasPendingWrites);
  },
);

const titleOnlyChangesOnWrites = Explore.rule(
  "a title changes only when something writes it",
  function* ({ step }) {
    const now = yield* Db.rows(list);
    const was = yield* Explore.before(Db.rows(list)); // its value at the rule's previous check

    return (
      now.get("n1")?.title === was.get("n1")?.title ||
      ["When", "Settled", "Remote"].includes(step._tag)
    );
  },
);

story.with({ rules: [...Db.rules, listMatchesEditor, rejectionLeavesNothingPending] });
```

- `at`: `"step"` after every step (and at the end); `"rest"` whenever nothing is in flight (settled,
  every command ended, no feed held down), the end included; `"end"` once the story ran its course:
  what was in flight arrives and every timer on its clock fires before the rule is checked.
- A rule reads what it yields, when it gets there: `yield* Db.rows(source, { as? })` (a source's
  rows by key, with `$hasPendingWrites`), `yield* Db.commands()`, `yield* Machine.snapshot({
  machine? })`, `yield* Form.state(form)`, `yield* Card.layout()`. A branch that returns first
  reads nothing after it, so a costly read (a layout) happens only when the rule needs it.
- It is given `step`, the step that just ran: its `_tag` (the verb of its label, such as `When`,
  `Rejected`, `Remote`, `Send`), number and label. It may return a boolean without yielding:
  `Explore.rule("…", ({ step }) => step._tag !== "Remote")`.
- `yield* Explore.before(reader)` is the reader's value at the rule's previous check, for a rule
  about a transition. From the first check that asks for it the reader is read at every check; at
  that first one, before is now. Readers are told apart by their name.
- The settings come last and are optional: `{ at }` (default `"step"`).
- A rule that does not hold fails the story after the step it broke at, quoting its name and each
  read it made, in order, by the reader's name:
  `After step 3 (when …), "the title stays Ada" does not hold / it read rows NoteRows/…: {…}`.
- An adapter's own reader is `reader(name, (stage) => …)` from `@highalch/story`.

**Exploring.** `Explore.run` tries what can happen instead of one hand-written order: every
sequence of up to `depth` moves of its sources (then seeded random walks), each a fresh story after
`setup`, with the rules checked at their moments.

```ts
const edit = Explore.source("edit", {
  values: ["Ada 2", "locked"],
  step: (title: string) => Machine.when({ type: "Edit", title }),
});
const save = Explore.source("save", { step: () => Machine.when({ type: "Save" }) });
const settle = Explore.source("settle", { step: () => Story.settle() });

await Explore.run({
  name: "rename editor",
  story,
  setup: [Story.given(n1, new NoteCreated({ note: ada })), Db.open(list), Machine.start(editor)],
  sources: [edit, save, settle],
  rules: [...Db.rules, savedMeansCommitted],
  depth: 3, // every sequence of up to 3 moves
  walks: { count: 50, length: 12, seed: 1 }, // optional: longer, seeded random sequences
});
```

- While exploring nothing is captured: no frames are painted and no trace is kept (`capture: "off"`).
- A failing sequence is shrunk to the shortest that fails the same way, then replayed once with
  everything captured: a text trace (`<artifacts>/<name>/trace.txt`, default
  `artifacts/explore`) and the screens' frames, recorded without comparing.
- It throws an `ExploreFailure`: the broken rule, the moves (`edit.step("locked")`, `save.step()`,
  `settle.step()`), the failure's detail, the same sequence as a story to paste into a test, and
  where the replay wrote. Runs are deterministic (the manual clock, the controlled wire, seeded
  walks), so the replay reproduces it.
- `Db.commands()` reads the commands the clients ran (label, who ran them, how they ended), for
  rules about outcomes: "an editor says Saved only after its save committed".

**Forms.** A form is the app's own `formOptions({...})` object, which its components spread into
stock `useForm`; the app wires nothing. Add the kit's plugin to the Vite (Vitest) config the stories
run with, `plugins: [highalch()]` from `@highalch/story/vite`: stories then see every mounted form,
in mount order (the plugin hands app imports of `@tanstack/react-form` a wrapper whose `useForm`
registers the form while its component is mounted; everything else is the stock module).

```ts
import { Form } from "@highalch/story/tanstack-form";

Form.when(renameForm, "title", "locked"), // types: the field's onChange validators run
Form.submit(renameForm), // its onSubmit runs; a command it sends is recorded like any other
Db.rejected(new NoteLocked({ title: "locked" })),
Form.then(renameForm, { values: { title: "locked" } }),
```

- A mounted form is an instance of a declared one when every option the declaration has (but its
  default values, which components often set per instance) is the very object in the mounted form's
  options. A step addressing a form with several mounted instances fails, listing them
  (`renameForm #1 (NoteId: "n1", title: "Ada"); renameForm #2 (…)`); pick one with
  `Form.where(renameForm, (values) => values.NoteId === "n1")`. It never guesses.
- Readers: `Form.state(target)` (one instance's state; `undefined` when none is mounted) and
  `Form.all(form)` (every instance's, for rules that must hold of each).
- `Form.typing(form, { fields?, values?, instances? })` is an exploration's source: every field
  (or `fields`) with every value, typed into the first mounted instance (or the first
  `instances`). Values come from `values`, or from the form's validator when it is an Effect
  Schema struct (`Schema.toStandardSchemaV1(Struct)`): a string field's boundary first (its
  longest accepted value, from `Schema.isMaxLength(n)`, as one unbreakable word), then values
  sampled from it (seeded, the same on every run). Random samples stay short, so the boundary is
  what reaches a field's declared edge. With any other validator the types require `values`.
  Forms no source names do not join.
- Commands the app sends itself (a form's `onSubmit`, a component's handler) are recorded as the
  app's, so `Db.rejected`, `Db.commands()` and rest see them: pending until their reply arrives,
  then `Committed` or `Rejected`.

**Traces.** `story.with({ name, trace: true, traces, update })` keeps a text snapshot of the story:
each step, then what every adapter shows after it (each observed source's rows, the commands and
how they ended, each machine's state and context, the mounted screen's HTML), in
`<traces>/<name>.trace.txt`. It is compared like a screen's baseline: a missing or different trace
fails the story (the actual is written beside it, `.actual.trace.txt`), and `update` writes it.
Opt-in; an exploration's replay writes the same trace without comparing.

`Db.rules` are the clients' defaults: `nothingPending` ("nothing is pending at rest"), and the rules
their connector adds (`Db.connected`, each checked at its own moment). With LowAlch clients those are
`LowAlchDb.rules`, judged against the feed's own entries (read from the Domain, not through the wire):

- `noFlickerBack` ("a row never flickers back"): a source never shows a row of the feed older than
  one it already showed for that key, and once a command's optimistic row showed, never one older
  than the command's own change (no new → old → new when it settles).
- `subsetsAgree` (at rest): every ready subset of an entity in one client agrees on a shared row.
- `rejectedRestores`: right after a rejection, each source shows the row it showed before the
  command (or a newer row of the feed), not pending.

## Screens: a filmstrip of a story

`@highalch/story/screen` adds steps that mount a real React component against the story's
own client. `Screen.make({ css, width, height })` mounts and checks it, and nothing more; a
screen is piped the engines its stories use:

- `Takumi.frames({ baselines, output, update?, fonts? })` captures a frame after every later step,
  painted by takumi's WASM renderer (no browser) and compared with reviewed baselines. A story
  then yields a filmstrip: loading, ready, pending, settled or rolled back, retrying. It adds
  `render(element, { every })` and `shot`.
- `Takumi.layout({ fonts? })` lays the screen out for rules that read it (`Card.layout()`, below).

A screen without an engine has no step or reader of it: `List.shot()` without frames, or
`Card.layout()` without a layout engine, does not compile. Another engine (a real browser) is a
Layer providing `PainterOf` or `LayoutOf`, piped with `Screen.frames(painter, settings)` or
`Screen.layout(engine)`.

```tsx
import { Screen } from "@highalch/story/screen";
import { Takumi } from "@highalch/story/takumi";

const List = Screen.make({
  css, // the compiled stylesheet(s) the markup is styled with
  width: 360,
  height: 200,
}).pipe(
  Takumi.frames({
    baselines: new URL("./baselines/", import.meta.url), // committed, reviewed PNGs
    output: new URL("../artifacts/stories/", import.meta.url), // the run's report (ignored)
    update: process.env.UPDATE_SCREENS === "1", // write baselines; never implicitly
    fonts, // optional: takumi's built-in font otherwise
  }),
);

await story.with({ name: "rename is rejected" })(
  Story.given(n1, new NoteCreated({ note: ada })),
  List.render(<NoteList account="acc-1" />), // mounted; frame 2
  Db.when(notes.rename, { NoteId: "n1", title: "locked" }), // frame 3: pending
  Db.rejected(new NoteLocked({ title: "locked" })), // frame 4: rolled back
);
```

- `List.render(element)` mounts the element with `react-dom/client` under the package's
  `Provider` with the story's client (of the step's scope), so stock `useLiveQuery` reads story
  data, and under the story's atom registry, so atoms read there are the story's; React is
  flushed with `act`. With frames, after this step and every later one, once the world is quiet
  (command replies still held, so a pending row stays pending) and React has flushed, the DOM is
  serialised and painted; `render(element, { every: false })` captures only at `List.shot(label?)`
  steps. One screen per story; it is unmounted when the story ends, passed or failed.
- `List.check(label, (container) => …)` asserts on the mounted DOM: it is given the container
  the element is mounted in, once the world is quiet and React has flushed, so it sees what a
  frame taken now would paint. Use it for what a picture does not say: that the title is an `h1`
  (`container.querySelector("h1")`), that a button is disabled, what a control's value is. The
  container is an ordinary DOM node, so a testing library's queries (`within(container)`) work on
  it; do not use such a library's own `render`, which mounts outside the story's client.
- A frame is named by its painter, the story's name and the step:
  `<painter>/<story>/<step>-<label>.png` under `baselines` (engines paint the same markup
  differently, so each painter has its own baselines). A story with frames
  needs `story.with({ name })`; without one `render` fails naming itself, as it does in a
  hostless story. Screen steps compose with machine steps (a running editor's frames) like any other.
- Frames compare decoded pixels exactly, not PNG bytes. A missing or different baseline fails the
  step that captured it and writes the actual frame, the expected one and a diff (differing
  pixels red over the faded frame) to `output`. `update` writes baselines instead; review them
  before committing.
- `output` holds, per story, every frame (PNG and the HTML painted), `manifest.json` and a
  filmstrip page `index.html`, and an `index.html` of all stories. A story's folder starts afresh
  on each run.
- The happy-dom window is installed as the global DOM when `render` runs and removed exactly when
  the story ends, so other tests keep their environment. Only this entry imports `happy-dom` and
  `react-dom`, and only `@highalch/story/takumi` imports `takumi-js` (optional peer dependencies),
  checked by `vp run check:patterns`.

### Machines in a screen

A component reads its machine through atoms with stock `@effect/atom-react` hooks, and a story
drives that same actor with machine steps. There are no click or type steps: the story sends the
event, and the frame shows what the component renders for the machine's state.

```tsx
// The application: one editor actor per note, as atoms.
const runtime = Atom.runtime(Layer.empty);

export const editing = Atom.family((NoteId: string) =>
  createActorAtoms(runtime, editor, { input: { NoteId } }),
);

export function NoteEditor({ NoteId }: { NoteId: string }) {
  const atoms = editing(NoteId);
  const result = useAtomValue(atoms.snapshot);
  const send = useAtomSet(atoms.send);
  // render from result; call send from handlers
}

// The story: a frame of every state the editor passes through.
await story.with({ name: "editor is rejected" })(
  Story.given(n1, new NoteCreated({ note: ada })),
  Machine.mounted(editing("n1")),
  List.render(<NoteEditor NoteId="n1" />), // Idle
  Machine.when({ type: "Edit", title: "locked" }), // Editing
  Machine.when({ type: "Save" }), // Saving
  Db.rejected(new NoteLocked({ title: "locked" })), // Failed
  Machine.then({ state: "Failed", context: { problem: "NoteLocked" } }),
);
```

- Each story run has its own atom registry (`await Story.registry(stage)` in a step of your own), made
  on first use and disposed when the story ends. `List.render` mounts the element under it, and
  `Machine.mounted` reads the actor from it, so the component and the story see one actor and no
  actor outlives its story.
- Loading `@highalch/story/xstate` adds one layer to `Atom.runtime` (`addGlobalLayer`): in a
  story's registry it provides the `Runner`, so the commands of every machine there run on the
  story's client and are recorded, whether or not a machine step introduced the machine. In any
  other registry it runs commands as `invoke` does without a runner. Runtimes made by another
  factory (`Atom.context()`) are not covered.
- A command is recorded as its machine's when the story introduced that machine with
  `Machine.mounted`; two actors of one machine are told apart by the input of the command each
  invokes. A command of a machine the story never introduced is recorded under `mounted`, and
  `Db.settled` and `Db.rejected` still assert it.
- Put `Machine.mounted` before `List.render` when the first frame matters: the step waits until
  the actor has started, so the first frame shows its state and not the component's own loading
  branch.
- A stepped machine (`Machine.given`) has no actor, so it has no frame: a screen shows running
  machines only.

### Layout: what spills out of its box

A screen piped a layout engine lets a rule read (yield) its layout: every element's box, laid out
by the engine once the world is quiet, the way a frame is painted. `Screen.overflowing(layout)`
lists what spills out of its box: an element's text running past its padding box, or a child
reaching past it, unless that element clips (`overflow: hidden`, `clip`, `auto` or `scroll`; a
form control scrolls its own text). The screen itself scrolls down, so only what runs off its
sides counts there.

```tsx
import { Explore } from "@highalch/story";
import { Screen } from "@highalch/story/screen";
import { Takumi } from "@highalch/story/takumi";

const Card = Screen.make({ css, width: 360, height: 240 }).pipe(
  Takumi.frames({ baselines, output }), // only if its stories compare frames
  Takumi.layout(), // the same engine as the frames: a rule judges what they show
);

const fits = Explore.rule("nothing on screen spills out of its box", function* () {
  const layout = yield* Card.layout(); // undefined until the screen renders

  return Screen.overflowing(layout).length === 0;
});
```

A failure names the element and the distance, not pixels:
`main.page > section.card > h1.title: text "WWWWWWWWWWWW…" (60 characters) runs 788px past its right edge`.
With `Form.typing` (whose values include a field's longest accepted value) an exploration finds
a layout that breaks on long input without a value of yours
(`packages/story/tests/layout.transition.test.tsx`, the `overflowing-title` example).

- The painter and the layout engine are separate services (`PainterOf`, `LayoutOf`), piped
  separately: a screen can paint with one engine and judge layout with another (a real
  browser's `Layouter`), or have either alone.
- Boxes are matched back to their elements through a `data-box` number on each element of the
  laid-out markup. Where the engine made boxes of its own (inline content wrapped among blocks,
  the text of an element laid out as a flex item, an inline-block), they belong to no element:
  their text counts as the nearest element's, and an inline box without text is checked against
  it. An element laid out inline has no box of its own.
- Clipping, borders and padding come from the element's computed style in the story's DOM (the
  screen's CSS is in the document); a length in anything but `px` counts as 0, so a missing
  length can hide an overflow but never invent one.
- Takumi sizes boxes by their border box (`box-sizing: border-box`), as its frames show.

**What the takumi painter does and does not do.** Takumi paints HTML and CSS (flexbox, borders, radii,
colours, text) and runs no script. Form controls are not painted, so `input`, `textarea` and
`select` are serialised as `span`s with their attributes, `data-control` naming the control, and
their current value as text (passwords masked, checkboxes ☑/☐); style them by class, not by tag.
No browser layout, focus rings, canvas, images from the network or fonts it is not given; the
renderer is the pinned WASM build on every platform, so a takumi upgrade means reviewing the
baselines. A read state that never shows (a query failing on its first load is `Loading` while it
retries; `Retrying` is a ready source whose feed retries) has no frame to capture.

## Your own steps

Every step carries its own interpretation: `{ label, run(stage) }`, where the `Stage` is one story
run: `stage.world` (the hosted world, `None` hostless), `stage.hosted(label)` (the world, or the
"needs a host" failure naming the step), `stage.use(adapter)` (an adapter's service for the run),
`stage.after(run)` (runs after every later step, as a screen captures its frames) and
`stage.end(run)` (runs when the story ends, before the adapters are released).
`Story.step(label, (world) => …)` builds a step of the Domain; `Story.staged(label, (stage) => …)`
any other kind. Throw a `Story.Mismatch(reason, detail)` for a readable failure.

**Adapters.** A kind of step keeps its state for a run in an adapter: `{ service, layer }`, an
Effect service and the Layer that builds it. The Layer may read the `Story.CurrentStage` (the run:
its world, `after`, `end`, its name) and use other adapters by providing their Layers to its own;
`stage.use(adapter)` builds it once per run, on first use, shares the Layers adapters build on,
and runs their finalizers when the story ends, before the host is disposed. The data steps keep
their clients in `Db.clients` (its service, `Db.Clients`, is what `Db.check(label, (db) => …)`
reads: `db.runs`, `db.observed()`, `db.connect()`; `LowAlchDb.entries(db)` the feed), the
machine steps their
machines, a screen its mounted component and the engines it was piped (`PainterOf` and
`LayoutOf`, provided by an engine entry's Layer). The runner knows nothing about TanStack DB, XState or React.

## Built on alchemy's `Story`?

Not on its runner: alchemy's steps are a closed union interpreted by a private `switch` inside
`Story.make`, which creates its own platform per run with manual scheduling (deliveries run only on
its `drain`) and replays the whole story once per order of concurrent work; there is no custom
step, no access to its host or Api client, and a client that runs concurrently cannot follow a
replayed scheduler. The kit reuses what it can: the vocabulary (`given`, `when`, `rejected`),
alchemy's in-memory platform and its `idle`, the same seeding seam for `given` (the model's
aggregate store `seed`), and alchemy's `Given`/`When` values through `alchemy(...)`. Server-side
decisions stay alchemy's stories; these stories are about what a client shows.

## What stories prove, and what not

They prove what a consumer's sources show and how its commands settle against the real model, the
real client and TanStack DB, through the same states `match` renders, including failures and
timing the story controls; a stepped machine's decisions and the commands it asks for, exactly;
and a running machine together with the data. Generated stories check the rules over every
modelled interleaving up to the bound; nothing outside the model or beyond the bound. They do not
test React rendering (use the view helpers), the websocket protocol (the wire is the Api client in
process, or whatever transport your `Hosting` uses), or orders the story does not try.

## View helpers

A presentational component takes plain props; its composition component renders
`match(useLiveQuery(...)).on(...)`. To render each branch without a server:

- `LowAlchDb.Live` constructs every state `match` gives a live query (`Loading()`, `Retrying({ error,
  attempt, data })`, `Ready({ data, feed, retry })`, `Missing()`, `Disabled()`), and
  `LowAlchDb.Settled` a command's settled value (`Committed(...)`, `Unconfirmed(...)`).
- `LowAlchDb.view(source, state)` is a value shaped like a stock `useLiveQuery` result over `source` in
  that state (a `Live` state or one of the source's typed errors), which `match` accepts without
  casts and reads exactly as the real one, with the source's errors; `retried()` counts `retry`
  calls. It is for view tests only: it holds no collection.

## Seams in the core

The kit provides its manual or real clock through Effect's `Clock` service. It uses
`waitKind` from the unstable `@lowalch/tanstack-db/internal` entry to tell retries, reload debounces and
settle timeouts apart. It also reads each feed subscription's `current` flag to check that the
feed has caught up and is healthy. The core shares the constructors of `match`'s live states
and of `Settled` with the kit.
