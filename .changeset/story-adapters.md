---
"@lowalch/tanstack-db": patch
"@highalch/story": patch
---

Stories get one namespace per adapter and a runner that knows none of them. `@highalch/story` keeps the runner and the Domain's steps (`given`, `remote`, transport faults, time). Data steps move to `Db` (`@highalch/tanstack-db`), with `Db.then` replacing `shows` and `state`, and work on plain TanStack DB clients; `Alchemy` (`@highalch/alchemy-domain`) makes them LowAlch clients (`Alchemy.memory(...)`) and adds `reload(Rows)`, feed entries, the feed invariants and the view helpers. Adapters are Effect Layers built once per story run (`stage.use`). Screens take a painter Layer (`Takumi.layer()` from `@highalch/takumi`) and keep baselines per painter; the screen helpers are a `Screen` object.
