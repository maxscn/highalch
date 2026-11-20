# @highalch/story

Stories for data synced with [`@highalch/tanstack-db`](../tanstack-db/README.md) and the XState machines over it:
given server history, when a client, another client or the world acts, then what each source
shows, its read state and how each command settled. Optional screen steps paint a filmstrip of a
mounted React component without a browser.

| Entry point              | What                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `@highalch/story`        | The story runner, data steps, invariants, view helpers; never imports XState             |
| `@highalch/story/xstate` | Machine steps and generated stories (`explore`) for the same runner; needs `xstate`      |
| `@highalch/story/screen` | Screen steps: a mounted component's frames vs reviewed baselines; needs takumi/happy-dom |

Peer dependencies: `@highalch/tanstack-db` and its peers; optional `xstate` and `@xstate/effect` (for
`/xstate`), `react-dom`, `happy-dom`, `takumi-js` 2.14.0 and `@effect/atom-react` (for `/screen`).

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
import * as Story from "@highalch/story"; // the runner and the data steps; never imports XState
import { explore, Machine } from "@highalch/story/xstate"; // machine steps and generated stories
import { invoke } from "@highalch/tanstack-db/xstate"; // production: how a machine invokes a command
```

`@highalch/tanstack-db` never imports the story kit. Only `@highalch/tanstack-db/xstate` and
`@highalch/story/xstate` import `xstate` and `@xstate/effect`, optional peer dependencies;
the repository's `vp run check:patterns` enforces both.

## Making a story

```ts
// Hosted: the consumer's Domain in memory, real HighAlch clients (one per scope) behind a wire the
// story controls, on a clock it controls. Data steps and machine steps.
const story = Story.make(
  Story.memory({ api: NotesApi, layer: handlers, services: stores, session: readerOf }),
  { scope: "acc-1" }, // and any client settings: settleTimeout, reloadDelay, retry, clock
);

// Hostless: no Domain, no client, nothing started. Machines stepped purely.
const pure = Story.make();

it("renames optimistically, then settles through the feed", () =>
  story.with({ invariants: Story.invariants })(
    Story.given(Note.ref(id), new NoteCreated({ note: ada })),
    Story.shows(notes.list({ account: "acc-1" }), [{ title: "Ada" }]),
    Story.when(notes.rename, { NoteId: "n1", title: "Ada 2" }),
    Story.shows(notes.list({ account: "acc-1" }), [{ title: "Ada 2", $hasPendingWrites: true }]),
    Story.settled("Committed"),
    Story.shows(notes.list({ account: "acc-1" }), [{ title: "Ada 2", $hasPendingWrites: false }]),
  ));
```

Each call of a hosted runner builds a fresh host and fresh clients and disposes them; nothing is
global. `Story.memory` hosts the Api's model on alchemy's in-memory platform: `layer` (a function,
so each story gets fresh state) is what the model's `layer` takes, `services` the stores those
handlers share with `check` steps (`world.host.service(Tag)`), and `session(scope)` the reader's
middleware when the Api's reads are guarded. Any other host is a `Hosting`: a function returning
`{ api, client(scope), dispose }` (plus optional `idle`, `seed`, `send`, `service`), for example
a deployed model's records over HTTP.

A hostless story runs any step that needs no Domain: machines stepped purely, and your own steps
built with `staged`. A data step or a running machine in it fails at once, naming itself:
`Step 2 (shows …) failed: "shows …" needs a host, and this story has none`. `pure.with(...)` is
refused (it has no clients, clock or invariants).

## The steps

Data steps (`Story.*`; they need a host):

| Step                                                     | What it does                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `given(ref, ...events)`                                  | history: events committed on an aggregate (seeded as alchemy's `Story.given` seeds them; projections see them)        |
| `remote(ref, command)` / `remote(label, (api) => eff)`   | another client writes: a command to an aggregate, or any call of the scope's Api client; it must be accepted          |
| `alchemy(Story.given(...))` / `alchemy(Story.when(...))` | alchemy's own `Given`/`When` step values, run on the story's host                                                     |
| `open(source, { as?, settle? })`                         | materialises a source in a client and keeps it observed, as a mounted `useLiveQuery` would                            |
| `shows(source, rows \| predicate, { as? })`              | what the source shows now, by key order, each row compared partially; `$hasPendingWrites` names a pending row         |
| `state(source, tag \| error, fields?, { single? })`      | the read state, by the same conversion `match` uses: `Loading`, `Retrying`, `Ready`, `Missing`, or the typed error    |
| `when(command, input)`                                   | the client calls a declared command with its input (`command.with({ client })(input)`)                                |
| `when(label, ({ client, activate }) => transaction)`     | anything that returns a transaction: `createOptimisticAction(command.options)`, `createPacedMutations(command.paced)` |
| `settled("Committed" \| "Unconfirmed"?)`                 | the last command (a `when`'s or a running machine's) settled so                                                       |
| `rejected(error)`                                        | the last command was rejected with this typed error (same class, same fields)                                         |
| `drop(error?)` / `resume()`                              | the feed fails (reconnecting fails too) / connects again: its retries run now                                         |
| `mute(on?)`                                              | the feed stays connected and delivers nothing (what it drops is lost to that connection)                              |
| `fail(name, error, times?)` / `recover(name)`            | a query or command fails with a typed error / answers again                                                           |
| `reload(source)` / `reload(Rows)`                        | what a `match` handler's `retry` does (`collection.reload()`) / `HighAlch.reload(db, Rows)`, its debounce passed      |
| `hold()` / `release()`                                   | queries answer with what they saw when asked, but only at `release` (a write racing a load)                           |
| `advance(ms)`                                            | time passes on the story's clock: retries, reload debounces and settle timeouts due within `ms` fire, in order        |
| `settle()` / `idle()`                                    | wait until nothing more happens by itself / until every command ended                                                 |
| `check(label, (world) => ...)`                           | anything else: the host's services, a client's wire (`sent`, `asked`), the runs, the feed's entries                   |
| `as(scope, ...steps)`                                    | the steps act as the client of another scope (two accounts in one story; a machine started inside runs there)         |

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
| `done(command, output?, { machine? })`                      | feeds `xstate.done.actor` for the command it asked for last    | an error: its commands settle by themselves (`Story.settled`)               |
| `failed(command, error, { machine? })`                      | feeds `xstate.error.actor` with the typed error                | an error: assert the real rejection with `Story.rejected`                   |

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
  themselves and `Story.settled`/`Story.rejected` assert them. It proves the machine and the data
  together: what is shown while a command is in flight, how it reacts to typed rejections, that
  rows roll back. Needs a host.

- **`Machine.mounted` — running, as a component reads it.** The actor the story's atom registry
  holds for the atoms `createActorAtoms` (from `@xstate/effect/atom`) made, which is the one a
  component under `Screen.render` reads through the same atoms. From then on it is a running
  machine: `when` sends to it, `then` and `asked` read it, and its commands run on the story's
  client, recorded. The story keeps the actor alive until it ends, so the step may come before or
  after the render. Needs a host. See [Machines in a screen](#machines-in-a-screen).

```ts
story(
  Story.given(n1, new NoteCreated({ note: ada })),
  Story.open(one),
  Story.remote(n1, new RenameNote({ NoteId: "n1", title: "Ada (theirs)" })),
  // A draft editor, stepped purely, beside the data: what would it save?
  Machine.given(editor, { input: { NoteId: "n1" } }, { name: "draft" }),
  Machine.when(async (read) => ({ type: "Edit", title: `${(await read(one))[0]?.title}, edited` })),
  Machine.when({ type: "Save" }),
  Machine.asked(notes.rename, { title: "Ada (theirs), edited" }),
  Story.shows(one, [{ title: "Ada (theirs)", $hasPendingWrites: false }]), // nothing was sent
  // A running editor: its rename really runs, is rejected and rolls back.
  Machine.start(editor, { input: { NoteId: "n1" }, name: "live" }),
  Machine.when({ type: "Edit", title: "locked" }, { machine: "live" }),
  Machine.when({ type: "Save" }, { machine: "live" }),
  Story.shows(one, [{ title: "locked", $hasPendingWrites: true }]),
  Story.rejected(new NoteLocked({ title: "locked" })),
  Machine.then({ state: "Failed" }, { machine: "live" }),
);
```

**Several machines.** `given`/`start` name a machine (`{ name }`, default its `id`; a second
machine of the same name is an error); every other machine step addresses one by
`{ machine: name }`, else the one introduced last. A failure names the machine and its mode:
`draft (stepped) is not in the expected state … expected "Saved" … observed "Saving" … asked since
its last event: rename {"NoteId":"n1","title":"Ada 2"}`.

**Invoking a command.** A machine invokes a command through `invoke(command)` from
`@highalch/tanstack-db/xstate` (production code imports it there, never from a testing entry;
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
Effect's cause; `rejection(event.error)` (from `@highalch/tanstack-db/xstate`) answers the typed rejection
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
`after`) with the invariants checked after every step. A failure is shrunk to a shorter failing
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
in flight, closing its clients (`HighAlch.close` waits for sent commands) lets the replies through
and runs the clock's waits, so a failure is reported instead of hanging.

**Invariants.** `story.with({ invariants })` checks invariants after every step and at the end.
`Story.invariants` are a collection's defaults:

- `noFlickerBack`: a source never shows a row of the feed older than one it already showed for that
  key, and once a command's optimistic row showed, never one older than the command's own change
  (no new → old → new when it settles).
- `nothingPending`: at rest (settled, every command ended, every feed live) no row is pending.
- `subsetsAgree`: at rest, every ready subset of an entity in one client agrees on a shared row.
- `rejectedRestores`: right after a rejection, each source shows the row it showed before the
  command (or a newer row of the feed), not pending.

They judge rows against the feed's own entries (read from the Domain, not through the wire).

## Screens: a filmstrip of a story

`@highalch/story/screen` adds steps that mount a real React component against the story's
own client and capture a frame after every later step, painted by takumi's WASM renderer without
a browser and compared with reviewed baselines. A story then yields a filmstrip: loading, ready,
pending, settled or rolled back, retrying.

```tsx
import * as Viewport from "@highalch/story/screen";

const Screen = Viewport.make({
  css, // the compiled stylesheet(s) the markup is painted with
  width: 360,
  height: 200,
  fonts, // optional: local font bytes; takumi's built-in font otherwise
  baselines: new URL("./baselines/", import.meta.url), // committed, reviewed PNGs
  output: new URL("../artifacts/stories/", import.meta.url), // the run's report (ignored)
  update: process.env.UPDATE_SCREENS === "1", // write baselines; never implicitly
});

await story.with({ name: "rename is rejected" })(
  Story.given(n1, new NoteCreated({ note: ada })),
  Screen.render(<NoteList account="acc-1" />), // mounted; frame 2
  Story.when(notes.rename, { NoteId: "n1", title: "locked" }), // frame 3: pending
  Story.rejected(new NoteLocked({ title: "locked" })), // frame 4: rolled back
);
```

- `Screen.render(element, { every? })` mounts the element with `react-dom/client` under the package's
  `Provider` with the story's client (of the step's scope), so stock `useLiveQuery` reads story
  data, and under the story's atom registry, so atoms read there are the story's; React is
  flushed with `act`. After this step and every later one, once the world is quiet
  (command replies still held, so a pending row stays pending) and React has flushed, the DOM is
  serialised and painted. `every: false` captures only at `Screen.shot(label?)` steps. One screen per
  story; it is unmounted when the story ends, passed or failed.
- `Screen.check(label, (container) => …)` asserts on the mounted DOM: it is given the container
  the element is mounted in, once the world is quiet and React has flushed, so it sees what a
  frame taken now would paint. Use it for what a picture does not say: that the title is an `h1`
  (`container.querySelector("h1")`), that a button is disabled, what a control's value is. The
  container is an ordinary DOM node, so a testing library's queries (`within(container)`) work on
  it; do not use such a library's own `render`, which mounts outside the story's client.
- A frame is named by the story's name and the step: `<story>/<step>-<label>.png`. A screen story
  needs `story.with({ name })`; without one, and in a hostless story, `render` fails naming
  itself. Screen steps compose with machine steps (a running editor's frames) like any other.
- Frames compare decoded pixels exactly, not PNG bytes. A missing or different baseline fails the
  step that captured it and writes the actual frame, the expected one and a diff (differing
  pixels red over the faded frame) to `output`. `update` writes baselines instead; review them
  before committing.
- `output` holds, per story, every frame (PNG and the HTML painted), `manifest.json` and a
  filmstrip page `index.html`, and an `index.html` of all stories. A story's folder starts afresh
  on each run.
- The happy-dom window is installed as the global DOM when `render` runs and removed exactly when
  the story ends, so other tests keep their environment. Only this entry imports `takumi-js`,
  `happy-dom` and `react-dom` (optional peer dependencies), checked by `vp run check:patterns`.

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
  Screen.render(<NoteEditor NoteId="n1" />), // Idle
  Machine.when({ type: "Edit", title: "locked" }), // Editing
  Machine.when({ type: "Save" }), // Saving
  Story.rejected(new NoteLocked({ title: "locked" })), // Failed
  Machine.then({ state: "Failed", context: { problem: "NoteLocked" } }),
);
```

- Each story run has its own atom registry (`Story.registry(stage)` in a step of your own), made
  on first use and disposed when the story ends. `Screen.render` mounts the element under it, and
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
  `Story.settled` and `Story.rejected` still assert it.
- Put `Machine.mounted` before `Screen.render` when the first frame matters: the step waits until
  the actor has started, so the first frame shows its state and not the component's own loading
  branch.
- A stepped machine (`Machine.given`) has no actor, so it has no frame: a screen shows running
  machines only.

**What the painter does and does not do.** Takumi paints HTML and CSS (flexbox, borders, radii,
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
"needs a host" failure naming the step) and `stage.slot(key, make)` (state your kind of step keeps
for the run, under a private symbol), `stage.after(run)` (runs after every later step, as a screen
captures its frames) and `stage.end(run)` (runs when the story ends, before its clients close).
`Story.step(label, (world) => …)` builds a data step;
`Story.staged(label, (stage) => …)` any other kind. The machine steps are built exactly so; the
runner knows nothing about XState. Throw a `Story.Mismatch(reason, detail)` for a readable failure.

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
and a running machine together with the data. Generated stories prove the invariants over every
modelled interleaving up to the bound; nothing outside the model or beyond the bound. They do not
test React rendering (use the view helpers), the websocket protocol (the wire is the Api client in
process, or whatever transport your `Hosting` uses), or orders the story does not try.

## View helpers

A presentational component takes plain props; its composition component renders
`match(useLiveQuery(...)).on(...)`. To render each branch without a server:

- `Story.Live` constructs every state `match` gives a live query (`Loading()`, `Retrying({ error,
  attempt, data })`, `Ready({ data, feed, retry })`, `Missing()`, `Disabled()`), and
  `Story.Settled` a command's settled value (`Committed(...)`, `Unconfirmed(...)`).
- `Story.view(source, state)` is a value shaped like a stock `useLiveQuery` result over `source` in
  that state (a `Live` state or one of the source's typed errors), which `match` accepts without
  casts and reads exactly as the real one, with the source's errors; `retried()` counts `retry`
  calls. It is for view tests only: it holds no collection.

## Seams in the core

The kit needs two small, behaviour-preserving seams in the core, published as the unstable
`@highalch/tanstack-db/internal` entry: `make({ timers })` (`Timers`:
where retries, reload debounces and settle timeouts wait; the default is `setTimeout`), and a
feed subscription's read-only `current` (caught up and not failed), which the kit reads to know a
feed is live. The constructors of `match`'s live states and of `Settled` are shared with it.
