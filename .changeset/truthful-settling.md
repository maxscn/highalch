---
"@lowalch/tanstack-db": minor
---

`Committed` now means the loaded subsets hold the change. A command that no feed can confirm (a client with `live: false`, or a feed that failed for good) settles `Unconfirmed` at the server's reply and reloads the entity's loaded subsets itself, instead of settling `Committed` with stale rows. With no subset of the entity loaded it still settles `Committed`. **Changed behaviour:** `onCommitted`, `effect` and `result` of such a command receive `Unconfirmed` where they received `Committed`.
