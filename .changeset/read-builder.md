---
"@highalch/db": patch
"@highalch/story": patch
---

Declare entity reads with the typed `read(Query)` builder. A bare Domain query remains valid.

Breaking: Replace the standalone declaration helpers with these chains:

- `all(Q)` → `read(Q).all()`
- `where(Q, rule)` → `read(Q).where(rule)`
- `one(Q, rule)` → `read(Q).one(rule)`
- `entries(Q, select)` → `read(Q).rows(select)`
- `where(entries(Q, select), rule)` → `read(Q).rows(select).where(rule)`

The exported `Membership` and `Entries` classes are removed. Use the builder to create
declarations and `QuerySpec` to type a declaration value.
