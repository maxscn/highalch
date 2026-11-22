---
"@lowalch/tanstack-db": patch
---

Durable offline command calls: `LowAlch.make({ ..., offline: offline() })` with `offline` from the new `@lowalch/tanstack-db/offline` entry, built on TanStack DB's `@tanstack/offline-transactions` 1.2.0 (an optional peer). A call is stored as data (declaration, target, encoded input, `commandId`) before it is sent, sent in order by the leader tab, retried while the transport fails and replayed with the same `commandId` after a reload, where its optimistic edit shows again on the subsets that load. A typed rejection is permanent and reaches `when("settled")` as the original instance. The entry also exports three collections of the client for stock `useLiveQuery`: `calls` (the queue), `status` (`online`, `queued`, `leader`, `durable`) and `rejected` (calls rejected while replayed after a reload). Without the option nothing changes.
