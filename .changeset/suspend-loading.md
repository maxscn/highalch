---
"@highalch/db": patch
"@highalch/story": patch
---

Add `HighAlch.Suspend`, a `match` `Loading` handler that suspends a stock `useLiveQuery` read to the nearest `<Suspense>` while typed errors stay branches.
