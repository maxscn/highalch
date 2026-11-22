---
"@highalch/story": patch
"@highalch/tanstack-db": patch
"@highalch/screen": patch
"@highalch/xstate": patch
"@highalch/alchemy-domain": patch
---

Screens and machines reach the data layer through `Data`, an interface of `@highalch/story` (`connect`, `mount`, `run`, `runs`) a host provides through its `adapters`, instead of importing `@highalch/tanstack-db`. `Db.data` is TanStack DB's (`Story.local({ adapters: [Db.data] })`), and `Alchemy.memory` includes it. Without one, a screen mounts its element as is and a running machine fails naming its step. A host's adapters may now read the story's stage. **Breaking:** a machine step's `(read) => …` takes a reader, as a rule yields it: `read(Db.rows(source))` instead of `read(source)`.
