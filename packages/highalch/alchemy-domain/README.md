# @highalch/alchemy-domain

`Alchemy`: [HighAlch stories](../story/README.md) of apps on an alchemy Domain. `Alchemy.memory({ api, layer, services })` hosts the Domain in memory with LowAlch clients that sync it through the story's wires, on its clock; `Alchemy.given(ref, ...events)` seeds history, `Alchemy.remote(ref, command)` is another writer, and `Alchemy.from(…)` runs alchemy's own `Story.given`/`Story.when`. It adds what only LowAlch has: `reload(Rows)`, the feed's `entries`, the feed rules (also in `Db.rules`) and the view helpers.

```ts
import { Alchemy } from "@highalch/alchemy-domain";

const story = Story.make(Alchemy.memory({ api, layer, services }), { scope: "acc-1" });
```

Peer dependencies: `@highalch/story`, `@highalch/tanstack-db`, `@lowalch/tanstack-db`, `@alchemy.run/domain`, `@tanstack/db`, `effect`, `react`. The guide to stories, with this package's steps in context, is
[`@highalch/story`'s README](../story/README.md#making-a-story).
