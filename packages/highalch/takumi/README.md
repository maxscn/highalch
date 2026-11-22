# @highalch/takumi

`Takumi`: takumi's WASM renderer as a [screen](../screen/README.md)'s engines, without a browser: `Takumi.frames({ baselines, output })` paints its frames, `Takumi.layout()` lays it out for rules. The same binary on every platform.

```ts
import { Takumi } from "@highalch/takumi";
```

Peer dependencies: `@highalch/screen`, `takumi-js` 2.14.0, `effect`. The guide to stories, with this package's steps in context, is
[`@highalch/story`'s README](../story/README.md#screens-a-filmstrip-of-a-story).
