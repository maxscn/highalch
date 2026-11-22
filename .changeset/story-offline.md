---
"@highalch/tanstack-offline": minor
"@highalch/story": minor
"@highalch/tanstack-db": minor
"@highalch/alchemy-domain": minor
---

Offline in stories. The new `@highalch/tanstack-offline` (`Offline`) gives a story the stored queue, tabs and network of apps on TanStack DB's offline transactions: `Offline.memory()` in the story's `adapters`, `Offline.down()` and `Offline.up()`, the readers `Offline.queued()` and `Offline.online()`, and `Offline.rules`. `@highalch/story` takes `adapters` in a story's options, added to its host's. `Db.restart()` closes the scope's client as a reloading tab does; the next step opens a new one. `@highalch/alchemy-domain` makes its LowAlch clients with a durable queue on the story's devices when `Offline.memory()` is provided.
