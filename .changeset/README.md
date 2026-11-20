# Changesets

Every change that should reach npm needs a changeset: run `vp run changeset`, pick the bump and
write one line for the changelog. `@lowalch/tanstack-db` and `@highalch/story` are versioned together.

Merging to `main` opens (or updates) a "Version Packages" pull request. Merging that pull request
publishes both packages. See the Releasing section of the root README.
