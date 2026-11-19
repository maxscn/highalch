---
"@highalch/db": patch
---

Let queries decide subset membership by default. Add `HighAlch.all` for whole lists and make `entries` compose with membership helpers.

Breaking: A rule-less query now re-asks after every change of its entity, debounced across a burst of changes. Declare whole lists with `HighAlch.all(Query)`. Replace `entries(Query, select, rule)` with `where(entries(Query, select), rule)`. Replace `windowed(Query)` with `Query`, or `windowed(Query, select)` with `entries(Query, select)`.
