# @highalch/tanstack-db

`Db`: data steps for [HighAlch stories](../story/README.md) on TanStack DB: what a client's sources show (`Db.then`), how its commands settle (`Db.when`, `Db.settled`, `Db.rejected`), readers for rules (`Db.rows`, `Db.commands`) and `Db.rules`. It works on plain TanStack DB; a host can give it other clients through a connector (`@highalch/alchemy-domain` gives LowAlch's). `Db.data` is the story's data layer on these clients, for screens and machines: `Story.local({ adapters: [Db.data] })` (`Alchemy.memory` includes it).

```ts
import { Db } from "@highalch/tanstack-db";
```

Peer dependencies: `@highalch/story`, `@tanstack/db`, `@tanstack/react-db`, `effect`, `react`. The guide to stories, with this package's steps in context, is
[`@highalch/story`'s README](../story/README.md#the-steps).
