import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { css, page } from "./page";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Schema } from "effect";
import {
  Envelope,
  framed,
  Open,
  subprotocol,
  tokenOf,
  unframed,
  type Opened,
  type Watched,
} from "@highalch/stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

/** The page a studio is viewed on: it connects to this machine, never to a server of ours. */
export const studio = "https://studio.highalch.dev";

/** How a relay listens and whom it lets in. */
export type Options = {
  /** The port on 127.0.0.1 (4983 by default; 0 picks a free one). */
  readonly port?: number;
  /** Origins whose pages may watch (`https://studio.highalch.dev` by default, and the relay's own). */
  readonly origins?: ReadonlyArray<string>;
};

/**
 * A running relay: where it listens, the two tokens it checks (`ingest` for the test processes
 * streaming to it, `view` for the pages watching), the link that opens the studio on it, and how
 * to stop it.
 */
export type Relay = {
  readonly url: string;
  readonly ingest: string;
  readonly view: string;
  /** `https://studio.highalch.dev/#connect=…&token=…`: the fragment never leaves the browser. */
  readonly link: string;
  readonly local: string;
  readonly close: () => Promise<void>;
};

/** A session as the relay keeps it, in memory, for viewers that open the studio late. */
type Kept = {
  readonly id: string;
  readonly token: string;
  readonly open: Open;
  readonly envelopes: Array<Envelope>;
  readonly seqs: Set<number>;
  /** The highest `seq` kept: what the relay acknowledges. */
  last: number;
  closed: boolean;
};

const secret = () => randomBytes(32).toString("base64url");

/** Whether `given` is `expected`, in time that does not depend on where they differ. */
const same = (given: string | undefined, expected: string) => {
  if (given === undefined) return false;

  const a = Buffer.from(given);
  const b = Buffer.from(expected);

  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
};

const bodyOf = async (request: IncomingMessage) => {
  const chunks: Array<Buffer> = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;

    if (size > 1024 * 1024) throw new Error("a session's request is small");

    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
};

const answer = (response: ServerResponse, status: number, json?: unknown) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });

  if (json === undefined) return response.end();

  response.end(JSON.stringify(json));
};

const refuse = (socket: Duplex, status: 401 | 403 | 404) => {
  socket.end(
    `HTTP/1.1 ${status} ${{ 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" }[status]}\r\n\r\n`,
  );
};

const bytesOf = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));

  if (data instanceof ArrayBuffer) return new Uint8Array(data);

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

const decodeEnvelope = Schema.decodeUnknownSync(Envelope);
const decodeOpen = Schema.decodeUnknownSync(Open);

/**
 * The studio's relay: the stream's receiving side, on this machine. Test processes open sessions
 * and stream to it as they would to the console (`HIGHALCH_STREAM_URL` and
 * `HIGHALCH_STREAM_TOKEN` set to its `url` and `ingest`); pages watch it over a WebSocket
 * (`/v1/watch`), and get everything kept so far, then everything as it arrives. Nothing leaves
 * this machine: the page at studio.highalch.dev connects here from the browser.
 *
 * It listens on 127.0.0.1 only, answers only requests addressed to it by that name or `localhost`
 * (a page can't reach it by rebinding another name to 127.0.0.1), lets only its origins watch, and
 * checks a token on every request: the ingest token to open a session, the session's token to
 * stream, the view token to watch.
 */
export const relay = async (options: Options = {}): Promise<Relay> => {
  const ingest = secret();
  const view = secret();
  const sessions = new Map<string, Kept>();
  /** Frames by their SHA-256, as the binary messages that carry them. */
  const frames = new Map<string, Uint8Array<ArrayBuffer>>();
  const watchers = new Set<WebSocket>();
  let port = options.port ?? 4983;

  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = () =>
    new Set([
      ...(options.origins ?? [studio]),
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]);

  const announce = (watched: Watched) => {
    const text = JSON.stringify(watched);

    for (const watcher of watchers) watcher.send(text);
  };

  const style = createHash("sha256").update(css).digest("base64");

  const server = createServer((request, response) => {
    if (!hosts().has(request.headers.host ?? "")) return answer(response, 403);

    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": [
          "default-src 'none'",
          "script-src 'self'",
          `style-src 'sha256-${style}'`,
          `connect-src ws://${request.headers.host}`,
          "img-src blob:",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
      });
      return response.end(page);
    }

    if (request.method === "GET" && request.url === "/studio.mjs") {
      void readFile(new URL("./browser.mjs", import.meta.url)).then(
        (script) => {
          response.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          });
          response.end(script);
        },
        () => answer(response, 404),
      );
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/sessions") return answer(response, 404);

    if (request.headers.origin !== undefined) return answer(response, 403);

    const authorization = request.headers.authorization ?? "";

    if (!same(authorization.replace(/^Bearer /, ""), ingest)) return answer(response, 401);

    void bodyOf(request).then(
      (text) => {
        let open: Open;
        try {
          open = decodeOpen(JSON.parse(text));
        } catch {
          return answer(response, 400);
        }
        const kept: Kept = {
          id: randomUUID(),
          token: secret(),
          open,
          envelopes: [],
          seqs: new Set(),
          last: 0,
          closed: false,
        };

        sessions.set(kept.id, kept);
        announce({ type: "session", session: kept.id, open });

        const opened: Opened = {
          session: kept.id,
          token: kept.token,
          expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };

        answer(response, 201, opened);
      },
      () => answer(response, 400),
    );
  });

  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 * 1024,
    // Only the stream's subprotocol is accepted: the bearer one only carried the token.
    handleProtocols: (offered) => {
      if (offered.has(subprotocol)) return subprotocol;

      return false;
    },
  });

  /** A test process streaming a session: events and frames, kept, acknowledged, passed on. */
  const stream = (socket: WebSocket, kept: Kept) => {
    const receive = (data: RawData, binary: boolean) => {
      if (binary) {
        const { image, png } = unframed(bytesOf(data));

        if (createHash("sha256").update(png).digest("hex") !== image)
          return socket.close(1008, "a frame's SHA-256 does not match it");

        if (frames.has(image)) return;

        const message = framed(image, png);

        frames.set(image, message);

        for (const watcher of watchers) watcher.send(message);

        return;
      }

      const fresh = Buffer.from(bytesOf(data))
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => decodeEnvelope(JSON.parse(line)))
        .filter((envelope) => !kept.seqs.has(envelope.seq));

      for (const envelope of fresh) {
        kept.seqs.add(envelope.seq);
        kept.envelopes.push(envelope);
        kept.last = Math.max(kept.last, envelope.seq);
      }

      if (fresh.length > 0) announce({ type: "events", session: kept.id, envelopes: fresh });

      socket.send(JSON.stringify({ type: "ack", seq: kept.last }));
    };

    socket.on("message", (data, binary) => {
      try {
        receive(data, binary);
      } catch {
        socket.close(1007, "not the stream's protocol");
      }
    });

    socket.on("close", (code) => {
      if (code !== 1000 || kept.closed) return;

      kept.closed = true;
      announce({ type: "closed", session: kept.id });
    });
  };

  /** A page watching: everything kept so far (frames before the events naming them), then live. */
  const watch = (socket: WebSocket) => {
    for (const message of frames.values()) socket.send(message);

    for (const kept of sessions.values()) {
      socket.send(JSON.stringify({ type: "session", session: kept.id, open: kept.open }));

      if (kept.envelopes.length > 0)
        socket.send(
          JSON.stringify({ type: "events", session: kept.id, envelopes: kept.envelopes }),
        );

      if (kept.closed) socket.send(JSON.stringify({ type: "closed", session: kept.id }));
    }

    watchers.add(socket);
    socket.on("close", () => watchers.delete(socket));
  };

  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    const token = tokenOf(request.headers["sec-websocket-protocol"]);

    if (!hosts().has(request.headers.host ?? "")) return refuse(socket, 403);

    if (request.url === "/v1/watch") {
      // A browser always says where the page came from; only the studio's pages may watch.
      if (origin !== undefined && !origins().has(origin)) return refuse(socket, 403);

      if (!same(token, view)) return refuse(socket, 401);

      return sockets.handleUpgrade(request, socket, head, watch);
    }

    const match = /^\/v1\/sessions\/([^/]+)\/socket$/.exec(request.url ?? "");
    const kept = sessions.get(decodeURIComponent(match?.[1] ?? ""));

    if (kept === undefined) return refuse(socket, 404);

    // Test processes stream; pages only watch.
    if (origin !== undefined) return refuse(socket, 403);

    if (!same(token, kept.token)) return refuse(socket, 401);

    sockets.handleUpgrade(request, socket, head, (ws) => stream(ws, kept));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (address !== null && typeof address === "object") port = address.port;

  const url = `http://127.0.0.1:${port}`;
  const fragment = new URLSearchParams({ connect: url, token: view });

  return {
    url,
    ingest,
    view,
    local: `${url}/#token=${view}`,
    link: `${studio}/#${fragment.toString()}`,
    close: async () => {
      for (const client of sockets.clients) client.terminate();

      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
