---
"@lowalch/tanstack-db": patch
"@highalch/story": patch
"@highalch/explore": patch
---

Explorations are deterministic tests, with discovery as an explicit option. `Explore.run` replays a committed corpus first, then every sequence up to `depth` (checked) and fixed-seed walks (`sample`, renamed from `walks`); `discover` adds walks from a fresh seed and keeps what they find in the corpus. A failure is confirmed on two replays (else `ExploreFlaky`), a run that checked less than it says throws `ExploreIncomplete` unless `allow` names it, the real clock is refused, and the run returns its coverage and a report. Sampled form values are seeded by name.
