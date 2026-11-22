# @highalch/explore

Explorations of [`@highalch/story`](../story/README.md) stories: what can happen, tried in every
order up to a depth on a story runner, with the story's rules (`Story.rule`) checked at their
moments. Deterministic: every run tries the same sequences in the same order. A failure is shrunk
to the shortest sequence that fails the same way, confirmed, and replayed with everything
captured, as a story to paste.

| Entry point                | What                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `@highalch/explore`        | `Explore.run`, `Explore.source`, shards, and the failures (`ExploreFailure`, …)                 |
| `@highalch/explore/xstate` | `explore`: stories generated from a model, every path through an XState machine; needs `xstate` |

Peer dependencies: `@highalch/story` and `effect`; optional `xstate` (for `/xstate`). It streams
what it runs with [`@highalch/stream`](../stream/README.md) when `HIGHALCH_STREAM_URL` is set.

```ts
import * as Story from "@highalch/story";
import { Explore } from "@highalch/explore";
```

## Exploring

`Explore.run` tries what can happen instead of one hand-written order. It is a test,
not a fuzzer: every run tries the same sequences in the same order, so it passes or fails the same
way every time. Finding new cases is a separate, explicit mode (`discover`), and what it finds is
kept so every later run replays it.

```ts
const edit = Explore.source("edit", {
  values: ["Ada 2", "locked"],
  step: (title: string) => Machine.when({ type: "Edit", title }),
});
const save = Explore.source("save", { step: () => Machine.when({ type: "Save" }) });
const settle = Explore.source("settle", { step: () => Story.settle() });

const explored = await Explore.run({
  name: "rename editor",
  story,
  setup: [Story.given(n1, new NoteCreated({ note: ada })), Db.open(list), Machine.start(editor)],
  sources: [edit, save, settle],
  rules: [...Db.rules, savedMeansCommitted],
  depth: 3, // checked: every sequence of up to 3 moves
  sample: { count: 50, length: 12, seed: 1 }, // sampled: longer walks from a fixed seed
  corpus: new URL("./explore/", import.meta.url), // failing sequences found before, committed
  discover: false, // true (or { count, length, seed }) looks somewhere new: keep it out of CI
});
// explored.report:
// Explore "rename editor":
//   Checked: every one of the 84 sequence(s) of up to 3 move(s)
//   Sampled: 50 walk(s) (seed 1)
//   Corpus: 1 sequence(s) found before
//   Rules: "nothing is pending at rest" judged … time(s); …
```

- **What a run covers, in order:** the corpus's sequences, then the **checked** sequences (every
  sequence of up to `depth` moves, shortest first, within `budget`), then the **sampled** walks
  (from `sample.seed`, 1 by default). All of it is the same on every run. Each sequence is a fresh
  story after `setup`, on the story's manual clock: an exploration refuses `clock: "real"`, where
  timing would decide what happens.
- **Discovery** (`discover: true`, or `{ count, length, seed }`) adds walks from a fresh seed, which
  the report and any failure print. A failing sequence it finds is added to the corpus file
  (`<corpus>/<name>.explore.txt`, one sequence per line), so the deterministic runs replay it from
  then on. Pass the printed seed back (`discover: { count, seed }`) to rerun a discovery. Turn it on
  locally or in a scheduled job, not in the tests every change runs.
- **A failure must reproduce.** A failing sequence is shrunk to the shortest that fails the same
  way, then replayed twice more; if a replay passes or fails differently, the run throws
  `ExploreFlaky` with both outcomes: the app or the kit is not deterministic there, and that is
  reported, never retried away. Only a world that "did not settle" (a timing limit, not a rule) is
  tried once more before it counts.
- **No silent passes.** A run that checked less than it says throws `ExploreIncomplete`: checked
  sequences stopped at the budget, or a rule no sequence ever judged. `allow: { truncated: true,
  unjudged: ["…"] }` accepts them. The run returns its coverage (`checked`, `sampled`, `corpus`,
  `discovered`, how often each rule was judged, and `report`).
- While exploring nothing is captured: no frames are painted and no trace is kept (`capture: "off"`).
  The confirmed failure is replayed once with everything captured: a text trace
  (`<artifacts>/<name>/trace.txt`, default `artifacts/explore`) and the screens' frames, recorded
  without comparing. It throws an `ExploreFailure`: the broken rule, where the sequence came from
  (corpus, checked, sampled or discovered, with its seed), the moves (`edit.step("locked")`,
  `save.step()`, `settle.step()`), the failure's detail, the sequence as a story to paste into a
  test, and the coverage so far.
- **Shards.** `shard: { index: 2, total: 4 }` (or `HIGHALCH_SHARD=2/4`) runs every 4th sequence,
  starting with the 2nd. Every shard numbers the sequences the same way, so four CI jobs (or four
  local processes) cover them all once. A shard leaves "every rule was judged" to the shards
  together, and its report says what it ran.
- **Streaming.** With `HIGHALCH_STREAM_URL` set, each exploration streams as it runs: every
  attempt of a sequence, each step with the frame its screen showed, and how it ended, numbered
  across shards so an app shows one exploration from all its shards as one grid of tiles. Tests
  change nothing; see [`@highalch/stream`](../stream/README.md) for the settings and the auth.
- Values sampled from a form's schema (`Form.typing`) are seeded by the form's and the field's
  names, so adding a field changes no other field's values. Upgrading Effect may change them; the
  corpus keeps what was found.

## Stories generated from a model (`@highalch/explore/xstate`)

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
