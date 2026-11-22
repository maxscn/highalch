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
  token from the environment once read, sends the ingest token only in the `Authorization` header of
  the request that opens a session (the socket carries the session's token), only over HTTPS (plain HTTP only to `localhost`), never follows a redirect, and never prints them.
  Without a stored secret, `HIGHALCH_STREAM_AUTH=github-oidc` sends the job's GitHub OIDC token
  instead (the job needs `permissions: id-token: write`), for the app to verify. Pull requests
  from forks get no secrets, so they stream nothing.
- **Frames.** Streaming paints a frame after every step (`HIGHALCH_STREAM_FRAMES=every`, the
  default), which slows a run down; `replay` sends only the failure's replay, `none` none. Each
  frame is sent once, named by its SHA-256; frames are dropped (the step is sent without one)
  while more than 32 MB wait on the socket.
- **Never a failure.** A stream that fails (a refused token, an app that is down) turns itself
  off with one warning; the tests run on.

## The receiving side

The console, or [`highalch studio`](../studio/README.md) on your machine, implements two
endpoints under the stream's URL:

| Endpoint                      | Credential                                           | What                                                           |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `POST /v1/sessions`           | `Authorization`: ingest token, or GitHub OIDC        | Opens a session for a run and shard (`Open`); answers `Opened` |
| `GET /v1/sessions/:id/socket` | subprotocols `highalch.v1`, `bearer.<session token>` | A WebSocket the process streams the session on                 |

On the socket the process sends text messages (batches of `Envelope`s, one JSON per line) and
binary messages (a frame: its PNG's SHA-256 as 32 bytes, then the PNG; `framed`/`unframed`), in
order, each frame before the first event naming it and once. The app answers `Ack`s
(`{ "type": "ack", "seq": 12 }`); what is not acknowledged is sent again when the socket
reconnects, and `seq` keeps a resent event from being kept twice. The process closes the socket
with code 1000 when the session ends. The token rides in a subprotocol because a browser can't
send headers on a WebSocket and a URL ends up in logs.

```ts
import { Envelope, Open, tokenOf, unframed } from "@highalch/stream";
import { Schema } from "effect";

const open = Schema.decodeUnknownSync(Open)(await request.json());
const token = tokenOf(request.headers.get("sec-websocket-protocol")); // then accept "highalch.v1"
const envelopes = text
  .split("\n")
  .filter(Boolean)
  .map((line) => Schema.decodeUnknownSync(Envelope)(JSON.parse(line)));
const { image, png } = unframed(bytes); // check that SHA-256(png) is image
```

The events: `exploration` (its sequences, numbered across every shard), `attempt` (a tile: a
sequence's moves and phase: `explore`, `shrink`, `confirm` or `replay`), `step` (with the frame
its screen showed), `attempt-end` and `exploration-end` (the shard's outcome, how often it judged
each rule, and a failure as a story to paste). A page watching the studio receives `Watched`
messages.
