# @highalch/db

## 0.0.2

### Patch Changes

- 9831869: Paced updates send the row key and only the fields the merged calls changed, and a result whose field is an open record keeps its typed errors in `match`.
- 49d16de: Add `HighAlch.Suspend`, a `match` `Loading` handler that suspends a stock `useLiveQuery` read to the nearest `<Suspense>` while typed errors stay branches.

## 0.0.1

### Patch Changes

- First release published from CI: MIT licence, public access, and peer ranges for effect, React, happy-dom and takumi.
