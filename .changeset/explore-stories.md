---
"@highalch/explore": patch
"@highalch/story": patch
"@highalch/stream": patch
---

Explorations make stories. `Explore.stories(runner, { setup, sources, depth, … })` makes a story of every sequence of what can happen, on a named runner with its rules (`story.with({ name, rules })`); each is callable on its own and has a `name` from its moves, its `code` and a `prompt()` for a coding agent. `Explore.run(stories, { artifacts, shard, stream, allow })` runs them. An `ExploreFailure` carries the shortest failing story (`story`, runnable), its `code` and a `prompt` that asks a coding agent to pin it as a test and fix the app, also written beside the replay's trace and streamed. A source may `label` its values for stories' names (`Form.typing`: `title "Ada 2"`). **Breaking:** `Explore.run(exploration)` takes the stories `Explore.stories` made; `rules` come from the runner.
