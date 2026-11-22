# @highalch/screen

`Screen`: a mounted React component in [HighAlch stories](../story/README.md), in happy-dom under the client of the story's data layer, when its host has one. `check` asserts on its DOM; piped a painter (`@highalch/takumi`) it captures frames compared with reviewed baselines, and piped a layout engine it gives rules its layout (`Screen.overflowing`).

```ts
import { Screen } from "@highalch/screen";
import { Takumi } from "@highalch/takumi";

const Card = Screen.make({ css, width: 360, height: 240 }).pipe(
  Takumi.frames({ baselines, output }),
);
```

Peer dependencies: `@highalch/story`, `happy-dom`, `react`, `react-dom`, `@effect/atom-react`, `effect`. It mounts under the story's data layer (`Data`, which `Db.data` or `Alchemy.memory` provides), never a data package directly. The guide to stories, with this package's steps in context, is
[`@highalch/story`'s README](../story/README.md#screens-a-filmstrip-of-a-story).
