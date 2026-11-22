# @highalch/tanstack-offline

## 0.0.7

### Patch Changes

- 3f90ad8: Offline in stories. The new `@highalch/tanstack-offline` (`Offline`) gives a story the stored queue, tabs and network of apps on TanStack DB's offline transactions: `Offline.memory()` in the story's `adapters`, `Offline.down()` and `Offline.up()`, the readers `Offline.queued()` and `Offline.online()`, and `Offline.rules`. `@highalch/story` takes `adapters` in a story's options, added to its host's. `Db.restart()` closes the scope's client as a reloading tab does; the next step opens a new one. `@highalch/alchemy-domain` makes its LowAlch clients with a durable queue on the story's devices when `Offline.memory()` is provided.
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
  - @highalch/story@0.0.7
  - @highalch/tanstack-db@0.0.7
