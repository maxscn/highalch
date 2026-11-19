---
"@highalch/db": patch
"@highalch/story": patch
---

Let bare and `entries` queries decide subset membership and re-ask after a burst of feed changes.
Use `all(Query)` for a whole list that follows the feed directly. Use `where(entries(Query, select), rule)`
in place of `entries(Query, select, rule)`. Give each query one declaration per entity and use a
bare query or `entries` for a cursor page. Conflicting declarations and `all` on a paged query
now fail at declaration.

Subset loads, feed reconnects and command settlement run on Effect. Replace retry callbacks
with Effect schedules filtered by typed errors. Replace custom timers with an Effect `Clock`.
Run `HighAlch.close(db)` and `command.result(input)` as Effects. `HighAlch.layer(config)` provides
a scoped client under `HighAlch.Client`, and `HighAlch.make(config)` still returns the client
synchronously. The story kit's `retryTransport` is now a schedule.

Closing a client rejects new commands immediately. Commands with a server reply settle as usual.
If a reply is still outstanding after `settleTimeout` from the start of close, HighAlch interrupts
the call and rolls back the transaction with a HighAlch error.
