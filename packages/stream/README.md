# @highalch/stream

The stream [`@highalch/explore`](../explore/README.md) explorations send while they run, so an app
can show them live: one tile per sequence, every shard's in one grid. It holds the protocol's
schemas, which the receiving app decodes with, and the client that sends it. It imports only
`effect`, so an app can depend on it without the test kit.

With `HIGHALCH_STREAM_URL` set, each exploration streams as it runs: the
exploration (its sequences, numbered across shards), every attempt of a sequence (`explore`,
then `shrink`, `confirm` and `replay` for a failure), each step with the frame its screen
showed, and how it ended. Every shard of a CI run streams to the same run, so an app can show
one exploration from all its shards as one grid of tiles. Tests change nothing.

```yaml
strategy:
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - run: vp test
    env:
      HIGHALCH_SHARD: ${{ matrix.shard }}/4
      HIGHALCH_STREAM_URL: https://app.example/stream
      HIGHALCH_STREAM_TOKEN: ${{ secrets.HIGHALCH_STREAM_TOKEN }}
```

- **Auth.** The ingest token (one project's, write-only) is sent once, to open a session; the
  session's own short-lived token carries the events and frames. The kit removes the ingest
  token from the environment once read, sends tokens only in the `Authorization` header, only
  over HTTPS (plain HTTP only to `localhost`), never follows a redirect, and never prints them.
  Without a stored secret, `HIGHALCH_STREAM_AUTH=github-oidc` sends the job's GitHub OIDC token
  instead (the job needs `permissions: id-token: write`), for the app to verify. Pull requests
  from forks get no secrets, so they stream nothing.
- **Frames.** Streaming paints a frame after every step (`HIGHALCH_STREAM_FRAMES=every`, the
  default), which slows a run down; `replay` sends only the failure's replay, `none` none. Each
  frame is sent once, named by its SHA-256; frames are dropped (the step is sent without one)
  while more than 32 MB are in flight.
- **Never a failure.** A stream that fails (a refused token, an app that is down) turns itself
  off with one warning; the tests run on.

## The receiving side

The app implements four endpoints under the stream's URL:

| Endpoint                              | Credential                   | What                                                                        |
| ------------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `POST /v1/sessions`                   | ingest token, or GitHub OIDC | Opens a session for a run and shard (`Open`); answers `Opened`              |
| `POST /v1/sessions/:id/events`        | the session's token          | `application/x-ndjson`, one `Envelope` per line; `seq` makes resending safe |
| `PUT /v1/sessions/:id/frames/:sha256` | the session's token          | A PNG, sent once, before any event names it; the app checks its SHA-256     |
| `POST /v1/sessions/:id/close`         | the session's token          | Ends the session                                                            |

```ts
import { Envelope, Open } from "@highalch/stream";
import { Schema } from "effect";

const open = Schema.decodeUnknownSync(Open)(await request.json());
const envelopes = text
  .split("\n")
  .filter(Boolean)
  .map((line) => Schema.decodeUnknownSync(Envelope)(JSON.parse(line)));
```

The events: `exploration` (its sequences, numbered across every shard), `attempt` (a tile: a
sequence's moves and phase: `explore`, `shrink`, `confirm` or `replay`), `step` (with the frame
its screen showed), `attempt-end` and `exploration-end` (the shard's outcome, how often it judged
each rule, and a failure as a story to paste).
