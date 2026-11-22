---
"@lowalch/tanstack-db": patch
"@highalch/story": patch
"@highalch/tanstack-db": patch
"@highalch/alchemy-domain": patch
---

A read can follow a served view or stream: `LowAlch.read(Query).follows(View, (input) => key)` asks the query again whenever that view changes at the key, so a subset can hold rows its entity's feed cannot place (shared with the reader, visible to a group) while the query's handler stays the one place that decides who may read. The story kit waits for a followed read to connect and to catch up (a wire counts a served `watch` until its first value), and a step now settles the world the first time it reads a source a rule's reader had opened.
