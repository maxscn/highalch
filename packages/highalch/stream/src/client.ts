import { Option } from "effect";
import {
  bearer,
  framed,
  subprotocol,
  version,
  type Envelope,
  type Event,
  type Open,
  type Opened,
  type Origin,
  type Shard,
} from "./protocol";

/**
 * How a process proves it may stream to the app:
 *
 * - `token`: an ingest token the app issued for one project (a CI secret). It is sent once, to
 *   open a session, and the session's own short-lived token is used after that.
 * - `github-oidc`: GitHub Actions' OIDC token for this job, with the stream's origin as its
 *   audience, so no secret is stored (the job needs `permissions: id-token: write`). The app
 *   checks its signature and claims (repository, workflow) before opening a session.
 */
export type Auth =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "github-oidc" };

/** Which frames a stream carries: every step's (live tiles), the replays' only, or none. */
export type Frames = "every" | "replay" | "none";

/** Where and how a process streams its explorations. */
export type Settings = {
  /** The app's stream URL (`https://…`; `http://` only to `localhost`). */
  readonly url: string;
  readonly auth: Auth;
  /** The run every shard of this CI run (or this local run) streams to. */
  readonly run: string;
  readonly shard: Shard;
  readonly origin: Origin;
  readonly frames: Frames;
  /** The fetch to open sessions with (the global one by default). */
  readonly fetch?: typeof fetch;
  /** The WebSocket to stream with (the global one, as the process started, by default). */
  readonly WebSocket?: typeof WebSocket;
};

/**
 * Where an exploration streams to: `send` queues an event; `frame` sends a PNG once (named by its
 * SHA-256, which it returns, or `None` when frames are being dropped); `flush` waits until the
 * app acknowledged everything sent, or gave up. Never throws: a stream that fails turns itself
 * off.
 */
export interface Sink {
  readonly frames: Frames;
  readonly send: (event: Event) => void;
  readonly frame: (png: Uint8Array) => Promise<Option.Option<string>>;
  readonly flush: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** The environment a process reads its settings from. */
type Env = Readonly<Record<string, string | undefined>>;

const environment = (): Env => globalThis.process?.env ?? {};

/** Hosts a stream may be sent to over plain `http://`: this machine only. */
const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The stream's URL, checked: tokens go only over HTTPS (or to this machine), never in the URL
 * itself, and nothing follows a redirect elsewhere.
 */
export const checkedUrl = (text: string) => {
  const url = new URL(text);

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname)))
    throw new Error(
      `HighAlch stream: ${url.origin} is not HTTPS: tokens are sent only over HTTPS (or to localhost)`,
    );

  if (url.username !== "" || url.password !== "" || url.search !== "")
    throw new Error(
      "HighAlch stream: the stream URL carries no credentials or query: the token goes in HIGHALCH_STREAM_TOKEN",
    );

  // A base URL ends in `/`, so the endpoints resolve under it.
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;

  return url;
};

/** `"2/4"` as the 2nd of 4 shards; `None` when absent. Anything else is refused. */
export const shardOf = (text: string | undefined): Option.Option<Shard> =>
  Option.map(Option.fromUndefinedOr(text), (given) => {
    const match = /^(\d+)\/(\d+)$/.exec(given.trim());
    const index = Number(match?.[1]);
    const total = Number(match?.[2]);

    if (!match || total < 1 || index < 1 || index > total)
      throw new Error(
        `HIGHALCH_SHARD is "${given}": it is the shard's number and the number of shards, as "2/4"`,
      );

    return { index, total };
  });

/** What GitHub Actions says about the run, when the process runs there. */
const githubOf = (env: Env): Origin => {
  if (env.GITHUB_ACTIONS !== "true") return {};

  const pull = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "");
  const repository = env.GITHUB_REPOSITORY;
  const run = env.GITHUB_RUN_ID;

  return {
    ...Option.match(Option.fromUndefinedOr(repository), {
      onNone: () => ({}),
      onSome: (name) => ({ repository: name }),
    }),
    ...Option.match(Option.fromUndefinedOr(env.GITHUB_SHA), {
      onNone: () => ({}),
      onSome: (commit) => ({ commit }),
    }),
    ...Option.match(Option.fromUndefinedOr(env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME), {
      onNone: () => ({}),
      onSome: (branch) => ({ branch }),
    }),
    ...Option.match(Option.fromUndefinedOr(pull?.[1]), {
      onNone: () => ({}),
      onSome: (number) => ({ pullRequest: Number(number) }),
    }),
    ...Option.match(Option.fromUndefinedOr(run), {
      onNone: () => ({}),
      onSome: (id) => ({
        ci: {
          provider: "github",
          run: id,
          ...Option.match(Option.fromUndefinedOr(env.GITHUB_RUN_ATTEMPT), {
            onNone: () => ({}),
            onSome: (attempt) => ({ attempt }),
          }),
          ...Option.match(Option.fromUndefinedOr(env.GITHUB_JOB), {
            onNone: () => ({}),
            onSome: (job) => ({ job }),
          }),
          ...Option.match(Option.fromUndefinedOr(repository), {
            onNone: () => ({}),
            onSome: (name) => ({
              url: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${name}/actions/runs/${id}`,
            }),
          }),
        },
      }),
    }),
  };
};

/**
 * The run every shard streams to: `HIGHALCH_RUN`, else the GitHub Actions run and attempt (the
 * same for every job of it), else one of this process's own.
 */
const runOf = (env: Env) =>
  Option.getOrElse(
    Option.orElse(Option.fromUndefinedOr(env.HIGHALCH_RUN || undefined), () =>
      Option.map(
        Option.filter(
          Option.fromUndefinedOr(env.GITHUB_RUN_ID),
          () => env.GITHUB_ACTIONS === "true",
        ),
        (id) => `${env.GITHUB_REPOSITORY ?? "github"}/${id}/${env.GITHUB_RUN_ATTEMPT ?? "1"}`,
      ),
    ),
    () => globalThis.crypto.randomUUID(),
  );

const framesOf = (text: string | undefined): Frames => {
  if (text === undefined || text === "") return "every";

  if (text === "every" || text === "replay" || text === "none") return text;

  throw new Error(`HIGHALCH_STREAM_FRAMES is "${text}": it is every, replay or none`);
};

/**
 * The stream's settings from the environment, `None` without `HIGHALCH_STREAM_URL`:
 *
 * - `HIGHALCH_STREAM_URL`: the app's stream URL.
 * - `HIGHALCH_STREAM_TOKEN`: the project's ingest token; or `HIGHALCH_STREAM_AUTH=github-oidc`.
 * - `HIGHALCH_RUN`: the run every shard streams to (GitHub Actions' run by default).
 * - `HIGHALCH_SHARD`: this shard, as `2/4` (`1/1` by default).
 * - `HIGHALCH_STREAM_FRAMES`: `every` (default), `replay` or `none`.
 *
 * The ingest token is removed from the environment once read, so the code under test can't read
 * it afterwards.
 */
export const fromEnv = (env: Env = environment()): Option.Option<Settings> =>
  Option.map(Option.fromUndefinedOr(env.HIGHALCH_STREAM_URL || undefined), (url) => {
    checkedUrl(url);

    const token = env.HIGHALCH_STREAM_TOKEN;
    const oidc = env.HIGHALCH_STREAM_AUTH === "github-oidc";

    if (token === undefined && !oidc)
      throw new Error(
        "HighAlch stream: HIGHALCH_STREAM_URL is set without credentials: set HIGHALCH_STREAM_TOKEN, or HIGHALCH_STREAM_AUTH=github-oidc",
      );

    if (env === environment()) delete globalThis.process?.env.HIGHALCH_STREAM_TOKEN;

    const auth: Auth = Option.match(Option.fromUndefinedOr(token), {
      onNone: () => ({ kind: "github-oidc" }),
      onSome: (value) => ({ kind: "token", token: value }),
    });

    return {
      url,
      auth,
      run: runOf(env),
      shard: Option.getOrElse(shardOf(env.HIGHALCH_SHARD), () => ({ index: 1, total: 1 })),
      origin: githubOf(env),
      frames: framesOf(env.HIGHALCH_STREAM_FRAMES),
    };
  });

/** Lower-case hex SHA-256 of bytes. */
const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** A refusal that no retry changes: the stream turns off. */
class Refused extends Error {}

/** What went wrong, as a warning says it. */
const messageOf = (error: unknown) => {
  if (error instanceof Error) return error.message;

  return String(error);
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** The WebSocket as the process started, before a screen installs a DOM's globals. */
const Native = globalThis.WebSocket;

/** Frames waiting on the socket beyond this many bytes are dropped (the step is sent without one). */
const backlog = 32 * 1024 * 1024;

/** Events are sent at least this often, or as soon as this many are queued. */
const interval = 100;
const batch = 200;

/** How long `flush` waits for the app to acknowledge what was sent. */
const patience = 10_000;

/** A frame sent, kept until an event after it is acknowledged, to send again on a reconnect. */
type Sent = { readonly after: number; readonly message: Uint8Array<ArrayBuffer> };

/**
 * A sink streaming to the app at `settings.url`. It opens its session on the first event (an
 * HTTP request carrying the ingest token), then streams over one WebSocket authenticated by the
 * session's own token: events in batches, frames once each, in order. What the app has not
 * acknowledged is sent again when the socket reconnects (up to 3 tries). A refused session, or a
 * socket that can't reconnect, turns the stream off with one warning. Tokens are never put in a
 * URL and never printed.
 */
export const connect = (settings: Settings): Sink => {
  const base = checkedUrl(settings.url);
  const post = settings.fetch ?? globalThis.fetch;
  const Socket = settings.WebSocket ?? Native;
  const queue: Array<Envelope> = [];
  const unacked: Array<Envelope> = [];
  const frames: Array<Sent> = [];
  const known = new Set<string>();
  const waiting: Array<() => void> = [];
  let seq = 0;
  let acked = 0;
  let off = false;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let session: Promise<Opened> | undefined;
  let socket: Promise<WebSocket> | undefined;

  const settle = () => {
    for (const resolve of waiting.splice(0)) resolve();
  };

  const stop = (why: string) => {
    if (off) return;

    off = true;
    queue.length = 0;
    console.warn(`HighAlch stream: turned off: ${why}`);
    settle();
  };

  const failed = (error: unknown) => stop(messageOf(error));

  /** Opens the session: the one request that carries the ingest token (or OIDC token). */
  const request = async (init: RequestInit): Promise<Response> => {
    let last = "";

    for (const wait of [0, 250, 1000]) {
      if (wait > 0) await pause(wait);

      const response = await post(new URL("v1/sessions", base), {
        ...init,
        redirect: "error",
      }).catch((error: unknown) => {
        last = messageOf(error);

        return undefined;
      });

      if (response === undefined) continue;

      if (response.ok) return response;

      last = `POST /v1/sessions answered ${response.status}`;

      if (response.status !== 429 && response.status < 500) throw new Refused(last);
    }

    throw new Error(last);
  };

  const credential = async (): Promise<Record<string, string>> => {
    if (settings.auth.kind === "token") return { authorization: `Bearer ${settings.auth.token}` };

    const env = environment();
    const endpoint = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    if (endpoint === undefined || token === undefined)
      throw new Refused(
        "HIGHALCH_STREAM_AUTH=github-oidc needs a GitHub Actions job with `permissions: id-token: write`",
      );

    const url = new URL(endpoint);

    url.searchParams.set("audience", base.origin);

    const response = await post(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
    });

    if (!response.ok) throw new Refused(`GitHub refused an OIDC token (${response.status})`);

    const { value } = (await response.json()) as { readonly value?: string };

    if (typeof value !== "string") throw new Refused("GitHub answered no OIDC token");

    return { authorization: `Bearer ${value}`, "highalch-auth": "github-oidc" };
  };

  const open = () => {
    session ??= (async () => {
      const body: Open = {
        protocol: version,
        run: settings.run,
        shard: settings.shard,
        origin: settings.origin,
      };
      const response = await request({
        method: "POST",
        headers: { ...(await credential()), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const opened = (await response.json()) as Partial<Opened>;

      if (typeof opened.session !== "string" || typeof opened.token !== "string")
        throw new Refused("the app opened no session (no session or token in its answer)");

      return { session: opened.session, token: opened.token, expires: opened.expires ?? "" };
    })();

    return session;
  };

  /** The socket's URL: the stream's, as `ws:` or `wss:`. */
  const socketUrl = (id: string) => {
    const url = new URL(`v1/sessions/${encodeURIComponent(id)}/socket`, base);

    url.protocol = url.protocol.replace(/^http/, "ws");

    return url;
  };

  const lines = (envelopes: ReadonlyArray<Envelope>) =>
    `${envelopes.map((each) => JSON.stringify(each)).join("\n")}\n`;

  /** Sends again, on a fresh socket, what the app did not acknowledge: frames, then events. */
  const resend = (ws: WebSocket) => {
    for (const each of frames) ws.send(each.message);

    if (unacked.length > 0) ws.send(lines(unacked));
  };

  const acknowledged = (data: unknown) => {
    if (typeof data !== "string") return;

    const ack = JSON.parse(data) as { readonly type?: string; readonly seq?: number };

    if (ack.type !== "ack" || typeof ack.seq !== "number") return;

    acked = Math.max(acked, ack.seq);

    while (unacked.length > 0 && (unacked[0]?.seq ?? Infinity) <= acked) unacked.shift();
    while (frames.length > 0 && (frames[0]?.after ?? Infinity) < acked) frames.shift();

    if (acked >= seq) settle();
  };

  /** One socket, opened on first use and again (up to 3 tries) when it drops. */
  const connected = (): Promise<WebSocket> => {
    socket ??= (async () => {
      const opened = await open();
      let last = "";

      for (const wait of [0, 250, 1000]) {
        if (wait > 0) await pause(wait);

        const ws = new Socket(socketUrl(opened.session), [subprotocol, bearer(opened.token)]);

        ws.binaryType = "arraybuffer";

        const up = await new Promise<boolean>((resolve) => {
          ws.addEventListener("open", () => resolve(true), { once: true });
          ws.addEventListener("error", () => resolve(false), { once: true });
        });

        if (!up) {
          last = "the stream's socket did not open";
          continue;
        }

        ws.addEventListener("message", (event) => acknowledged(event.data));
        ws.addEventListener("close", (event) => {
          socket = undefined;

          if (closing || off || event.code === 1000) return;

          // Dropped: open it again and send what was not acknowledged.
          connected().then(
            (again) => resend(again),
            (error: unknown) => failed(error),
          );
        });

        return ws;
      }

      throw new Error(last);
    })();

    return socket;
  };

  const drain = async () => {
    if (off || queue.length === 0) return;

    const envelopes = queue.splice(0, queue.length);

    unacked.push(...envelopes);

    try {
      (await connected()).send(lines(envelopes));
    } catch (error) {
      failed(error);
    }
  };

  let chain: Promise<void> = Promise.resolve();

  const push = () => {
    if (timer !== undefined) clearTimeout(timer);

    timer = undefined;
    chain = chain.then(drain);

    return chain;
  };

  /** Waits until the app acknowledged everything sent, or `patience` ran out. */
  const flush = async () => {
    await push();

    if (off || acked >= seq) return;

    await new Promise<void>((resolve) => {
      const late = setTimeout(resolve, patience);

      late.unref?.();
      waiting.push(() => {
        clearTimeout(late);
        resolve();
      });
    });
  };

  return {
    frames: settings.frames,
    send: (event) => {
      if (off) return;

      seq += 1;
      queue.push({ seq, at: Date.now(), event });

      if (queue.length >= batch) {
        void push();

        return;
      }

      timer ??= setTimeout(() => void push(), interval);
      timer.unref?.();
    },
    frame: async (png) => {
      if (off) return Option.none();

      const image = await sha256(png);

      if (known.has(image)) return Option.some(image);

      // The events queued so far go first: the frame belongs to the next one.
      await push();

      if (off) return Option.none();

      try {
        const ws = await connected();

        if (ws.bufferedAmount + png.byteLength > backlog) return Option.none();

        const message = framed(image, png);

        known.add(image);
        frames.push({ after: seq, message });
        ws.send(message);

        return Option.some(image);
      } catch (error) {
        failed(error);

        return Option.none();
      }
    },
    flush,
    close: async () => {
      await flush();

      closing = true;

      if (socket !== undefined) (await socket.catch(() => undefined))?.close(1000, "done");

      off = true;
    },
  };
};

/** The process's stream, from its environment, opened once; `None` when it streams nothing. */
let streaming: Option.Option<Sink> | undefined;

export const streamed = (): Option.Option<Sink> => {
  streaming ??= Option.map(fromEnv(), connect);

  return streaming;
};
