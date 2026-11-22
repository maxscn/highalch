---
"@highalch/story": patch
"@highalch/explore": patch
"@highalch/stream": patch
---

Explorations and the stream leave the story kit. `@highalch/explore` holds `Explore.run`, `Explore.source`, shards and the failures (`ExploreFailure`, `ExploreFlaky`, `ExploreIncomplete`), and `./xstate` the model-based `explore`; `@highalch/stream` holds the protocol and its client and imports only effect. Rules stay with stories: `Explore.rule` and `Explore.before` are now `Story.rule` and `Story.before`, and a source's type is `Story.Source`. **Breaking:** import `Explore` from `@highalch/explore`, `explore` from `@highalch/explore/xstate`, and the stream from `@highalch/stream`.
