---
"@lowalch/tanstack-db": patch
"@highalch/story": patch
---

Move the core to the LowAlch scope: `@highalch/db` is now `@lowalch/tanstack-db` (with the same `/server`, `/react`, `/xstate` and `/internal` entries), and its namespace and error messages say `LowAlch` instead of `HighAlch`. `@highalch/story` keeps its name. The API is otherwise unchanged.
