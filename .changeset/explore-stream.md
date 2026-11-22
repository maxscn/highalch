---
"@highalch/story": patch
---

Explorations shard and stream. `shard: { index, total }` (or `HIGHALCH_SHARD=2/4`) runs every `total`-th sequence, numbered the same in every shard, so CI jobs split one exploration. With `HIGHALCH_STREAM_URL`, each exploration streams its attempts, steps, frames and outcome to an app, authenticated by a project's ingest token (exchanged for a session token) or GitHub OIDC; every shard streams to the same run. `@highalch/story/stream` holds the protocol's schemas for the receiving app.
