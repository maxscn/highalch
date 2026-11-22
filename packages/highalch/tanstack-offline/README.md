# @highalch/tanstack-offline

`Offline`: offline in [HighAlch stories](../story/README.md), for apps on TanStack DB's `@tanstack/offline-transactions`. The story owns what the browser owns: the stored queue, the tabs and the network. So it can take the network away (`Offline.down`), bring it back (`Offline.up`) and reload a tab over the same queue (`Db.restart`), with no DOM events.

```ts
import * as Story from "@highalch/story";
import { Alchemy } from "@highalch/alchemy-domain";
import { Db } from "@highalch/tanstack-db";
import { Offline } from "@highalch/tanstack-offline";

const story = Story.make(Alchemy.memory({ api, layer, services }), {
  scope: "acc-1",
  adapters: [Offline.memory()],
  rules: [...Db.rules, ...Offline.rules],
});

await story(
  exists,
  Db.then(one, [{ title: "Ada" }]),
  Offline.down(),
  Db.when(notes.rename, { NoteId: "n1", title: "Abel" }),
  Db.restart(), // the tab reloads: a new client over the same stored queue
  Db.then(one, [{ title: "Abel", $hasPendingWrites: true }]), // restored
  Offline.up(), // replayed with the same commandId
  Db.then(one, [{ title: "Abel", $hasPendingWrites: false }]),
);
```

- **`Offline.memory()`** goes in the story's `adapters`. It provides `Devices`: one device per scope, made of the library's own interfaces (an in-memory `StorageAdapter`, a `LeaderElection` per tab, an `OnlineDetector`). It outlives the clients, so a restart finds the queue.
- **LowAlch clients use it by themselves.** With it provided, `@highalch/alchemy-domain` makes its clients with `offline(...)` of `@lowalch/tanstack-db/offline` on the scope's device. Nothing else changes in the story, and without it the clients have no queue.
- **`Offline.down(options?)` and `Offline.up(options?)`** set what the browser reports. Down, the executor stores calls and sends none; up, it is told and sends the queue in order. They do not fail the app's reads: add the host's own fault steps for that.
- **`Offline.queued()` and `Offline.online()`** are readers for rules. **`Offline.rules`** holds "online at rest, nothing is queued".
- **A stored call keeps the world from rest,** as a pending command does.
- **`Db.restart()`** (in `@highalch/tanstack-db`) closes the scope's client; the next step opens a new one. A call the queue then sends is recorded as the app's (`by: "app"`), so `Db.settled` and `Db.rejected` read it.
- **With a plain `startOfflineExecutor`,** make a device with `Offline.device()` (or read the story's from `Devices`) and pass its `storage`, `network` and `tab()` to your executor's config.
- All of them are steps, so they work as an exploration's sources too.

Retry backoff is the library's own timer, which the story's clock does not drive: stories replay by going back online.

Peer dependencies: `@highalch/story`, `@highalch/tanstack-db`, `@tanstack/offline-transactions`, `effect`.
