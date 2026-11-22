---
"@highalch/story": patch
"@highalch/tanstack-db": patch
"@highalch/alchemy-domain": patch
"@highalch/xstate": patch
"@highalch/screen": patch
"@highalch/takumi": patch
"@highalch/tanstack-form": patch
"@lowalch/tanstack-db": patch
---

Each integration is its own package, and the story runner no longer knows alchemy. `@highalch/story` is the runner, world and rules, depending on effect only; its host interface has no Domain types (`Story.local()` hosts nothing, for clients that sync nothing). `Db` moves to `@highalch/tanstack-db`, `Machine` to `@highalch/xstate`, `Screen` to `@highalch/screen`, `Takumi` to `@highalch/takumi`, and `Form` with the `highalch()` Vite plugin to `@highalch/tanstack-form` (`./vite`). `@highalch/alchemy-domain` holds what knows alchemy: `Alchemy.memory` (the Domain in memory with LowAlch clients, formerly `LowAlchDb.memory`), `Alchemy.given`, `Alchemy.remote(ref, command)`, `Alchemy.from` (formerly `Story.alchemy`), and LowAlch's `reload`, feed entries, feed rules and view helpers. **Breaking:** the `@highalch/story/*` entries are gone; `Story.given`, `Story.memory`, `Story.alchemy` and `LowAlchDb` move to `Alchemy`; `Story.remote` keeps only its `(label, (api) => …)` form.
