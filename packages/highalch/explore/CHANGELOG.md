# @highalch/explore

## 0.0.7

### Patch Changes

- 64b1e69: Explorations are deterministic tests, with discovery as an explicit option. `Explore.run` replays a committed corpus first, then every sequence up to `depth` (checked) and fixed-seed walks (`sample`, renamed from `walks`); `discover` adds walks from a fresh seed and keeps what they find in the corpus. A failure is confirmed on two replays (else `ExploreFlaky`), a run that checked less than it says throws `ExploreIncomplete` unless `allow` names it, the real clock is refused, and the run returns its coverage and a report. Sampled form values are seeded by name.
- d717c4e: Explorations make stories. `Explore.stories(runner, { setup, sources, depth, … })` makes a story of every sequence of what can happen, on a named runner with its rules (`story.with({ name, rules })`); each is callable on its own and has a `name` from its moves, its `code` and a `prompt()` for a coding agent. `Explore.run(stories, { artifacts, shard, stream, allow })` runs them. An `ExploreFailure` carries the shortest failing story (`story`, runnable), its `code` and a `prompt` that asks a coding agent to pin it as a test and fix the app, also written beside the replay's trace and streamed. A source may `label` its values for stories' names (`Form.typing`: `title "Ada 2"`). **Breaking:** `Explore.run(exploration)` takes the stories `Explore.stories` made; `rules` come from the runner.
- 52b54c1: Explorations shard and stream. `shard: { index, total }` (or `HIGHALCH_SHARD=2/4`) runs every `total`-th sequence, numbered the same in every shard, so CI jobs split one exploration. With `HIGHALCH_STREAM_URL`, each exploration streams its attempts, steps, frames and outcome to an app, authenticated by a project's ingest token (exchanged for a session token) or GitHub OIDC; every shard streams to the same run. `@highalch/stream` holds the protocol's schemas for the receiving app and the client that sends it.
- 6fd88c3: Explorations and the stream leave the story kit. `@highalch/explore` holds `Explore.run`, `Explore.source`, shards and the failures (`ExploreFailure`, `ExploreFlaky`, `ExploreIncomplete`), and `./xstate` the model-based `explore`; `@highalch/stream` holds the protocol and its client and imports only effect. Rules stay with stories: `Explore.rule` and `Explore.before` are now `Story.rule` and `Story.before`, and a source's type is `Story.Source`. **Breaking:** import `Explore` from `@highalch/explore`, `explore` from `@highalch/explore/xstate`, and the stream from `@highalch/stream`.
- 912e879: Rules, explorations and forms. `Story.rule("a sentence", function* ({ step }) { … }, { at })` replaces invariants (`story.with({ rules })`, `Db.rules`, `Alchemy.rules`), checked after every step, at rest or at the end. A rule yields what it reads, when it gets there (`yield* Db.rows(list)`, `Db.commands`, `Machine.snapshot`, `Form.state`, `Form.all`; `yield* Story.before(reader)` for its value at the previous check), and a failure lists each read by name. `Explore.run` (`@highalch/explore`) tries every sequence of up to `depth` moves of its sources (then seeded walks), captures nothing while exploring, and on a failure shrinks the sequence and replays it once with a trace and frames, as a story to paste. `story.with({ trace: true })` keeps a reviewed text snapshot of a story. `@highalch/tanstack-form` (`Form`) types into and submits the app's own `formOptions` forms, found through the `highalch()` Vite plugin (`@highalch/tanstack-form/vite`) with no wiring in the app, and `Form.typing` makes typing an exploration's source. Commands the app sends itself are recorded like a story's own.
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
- Updated dependencies [f39d44a]
  - @highalch/story@0.0.7
  - @highalch/stream@0.0.7
