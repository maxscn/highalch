# @highalch/xstate

`Machine`: XState machines in [HighAlch stories](../story/README.md), stepped purely (`Machine.given`, nothing runs) or running against the story's client (`Machine.start`), with `when`, `then`, `asked` and `Machine.snapshot` for rules. Machines invoke LowAlch commands (`invoke`, `mark`, re-exported from `@lowalch/tanstack-db/xstate`).

```ts
import { Machine } from "@highalch/xstate";
```

Peer dependencies: `@highalch/story`, `@lowalch/tanstack-db`, `xstate`, `@xstate/effect`, `effect`. A running machine's commands run on the story's data layer (`Data`, which `Db.data` or `Alchemy.memory` provides). The guide to stories, with this package's steps in context, is
[`@highalch/story`'s README](../story/README.md#pure-running-or-mounted-one-explicit-choice).
