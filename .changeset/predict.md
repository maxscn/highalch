---
"@lowalch/tanstack-db": patch
---

A command can be decided on the client before it is sent. Give the `Rows` entity `state: (row) => aggregateState` and the client `context` (`LowAlch.make({ ..., context })`, what the commands' middleware provides), and each call runs the aggregate's own `decide` through alchemy's `Aggregate.predict`: a rejection refuses the call at once with the Domain's typed rejection (no optimistic edit, nothing sent), and accepted events give the optimistic rows through the entity's own `on`. Without `state` nothing changes. `Writer`, `WriterInput` and `WriterPayload` are now exported from the root and `./server`, so a package that publishes declarations can export a `Rows` entity with its inferred type.
